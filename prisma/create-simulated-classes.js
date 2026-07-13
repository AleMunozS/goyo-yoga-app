import dayjs from 'dayjs';
import { PrismaClient } from '@prisma/client';
import { createDefaultLayout, describeSeatCodes, serializeLayout } from '../src/seats.js';
import { makeBookingRef } from '../src/utils.js';

const prisma = new PrismaClient();

async function main() {
  const now = dayjs();
  const existingFutureCount = await prisma.class_occurrences.count({
    where: { startsAt: { gte: now.toDate() } },
  });

  if (existingFutureCount > 0) {
    return {
      created: 0,
      skipped: true,
      reason: 'future classes already exist',
      futureCount: existingFutureCount,
    };
  }

  const [location, classTypes, trainers] = await Promise.all([
    prisma.locations.findFirst({ where: { isActive: true }, orderBy: { createdAt: 'asc' } }),
    prisma.class_types.findMany({ orderBy: { name: 'asc' } }),
    prisma.staff_users.findMany({ where: { role: 'TRAINER' }, orderBy: { displayName: 'asc' } }),
  ]);

  if (!location || classTypes.length === 0 || trainers.length === 0) {
    throw new Error('Missing location, class types, or trainers to create simulated classes.');
  }

  const prices = [32000, 35000, 42000];
  const occurrences = [];

  for (let dayOffset = 1; dayOffset <= 10; dayOffset += 1) {
    const baseDay = now.add(dayOffset, 'day');
    const slots = [
      { hour: 8, minute: 0, duration: 50 },
      { hour: 19, minute: 0, duration: 55 },
    ];

    for (let slotIndex = 0; slotIndex < slots.length; slotIndex += 1) {
      const classType = classTypes[(dayOffset + slotIndex) % classTypes.length];
      const trainer = trainers[(dayOffset + slotIndex) % trainers.length];
      const slot = slots[slotIndex];
      const startsAt = baseDay.hour(slot.hour).minute(slot.minute).second(0).millisecond(0);
      const capacity = classType.durationMin <= 45 ? 18 : 20;
      const layoutJson = serializeLayout(createDefaultLayout(capacity));

      const occurrence = await prisma.class_occurrences.create({
        data: {
          locationId: location.id,
          classTypeId: classType.id,
          trainerId: trainer.id,
          startsAt: startsAt.toDate(),
          endsAt: startsAt.add(slot.duration, 'minute').toDate(),
          capacity,
          availableSlots: capacity,
          unitPriceCents: prices[(dayOffset + slotIndex) % prices.length],
          status: 'SCHEDULED',
          layoutJson,
        },
        include: { classType: true, trainer: true, location: true },
      });

      occurrences.push(occurrence);
    }
  }

  const firstOccurrence = occurrences[0];
  const demoClient = await prisma.clients.upsert({
    where: { email: 'demo.reserva@tisa.local' },
    update: { fullName: 'Reserva Simulada', phone: '5550000000' },
    create: { email: 'demo.reserva@tisa.local', fullName: 'Reserva Simulada', phone: '5550000000' },
  });

  const occupiedSeatCodes = ['A1', 'B2'];
  const describedSeats = describeSeatCodes(occupiedSeatCodes, firstOccurrence.layoutJson, firstOccurrence.capacity);
  const booking = await prisma.bookings.create({
    data: {
      bookingRef: makeBookingRef(),
      clientId: demoClient.id,
      classOccurrenceId: firstOccurrence.id,
      status: 'PAID',
      quantity: describedSeats.length,
      seatSummaryJson: JSON.stringify(describedSeats),
      salesChannel: 'web',
      customerNameSnapshot: demoClient.fullName,
      customerEmailSnapshot: demoClient.email,
      customerPhoneSnapshot: demoClient.phone,
      unitPriceCents: firstOccurrence.unitPriceCents,
      subtotalCents: firstOccurrence.unitPriceCents * describedSeats.length,
      feesCents: 0,
      totalCents: firstOccurrence.unitPriceCents * describedSeats.length,
      paidAt: now.toDate(),
      qrIssuedAt: now.toDate(),
    },
  });

  for (const seat of describedSeats) {
    await prisma.reserved_seats.create({
      data: {
        bookingId: booking.id,
        classOccurrenceId: firstOccurrence.id,
        seatId: seat.id,
        seatCode: seat.code,
        seatLabelSnapshot: seat.label,
        zone: seat.zone,
      },
    });
  }

  await prisma.class_occurrences.update({
    where: { id: firstOccurrence.id },
    data: { availableSlots: { decrement: describedSeats.length } },
  });

  return {
    created: occurrences.length,
    firstOccurrenceId: firstOccurrence.id,
    firstStartsAt: firstOccurrence.startsAt,
    occupiedDemoSeats: occupiedSeatCodes,
  };
}

main()
  .then((result) => {
    console.log(JSON.stringify(result, null, 2));
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
