import dayjs from 'dayjs';
import { PrismaClient } from '@prisma/client';
import { createDefaultLayout, serializeLayout } from '../src/seats.js';

const prisma = new PrismaClient();

const ACTIVE_BOOKING_STATUSES = ['PENDING_PAYMENT', 'PAYMENT_PENDING_ASYNC', 'PAID', 'CHECKED_IN'];

async function main() {
  const now = dayjs().startOf('day').toDate();
  const occurrences = await prisma.class_occurrences.findMany({
    where: { startsAt: { gte: now } },
    include: {
      reservedSeats: {
        include: { booking: true },
      },
    },
    orderBy: { startsAt: 'asc' },
  });

  let updated = 0;

  for (const occurrence of occurrences) {
    const capacity = Math.max(occurrence.capacity || 18, 1);
    const layout = createDefaultLayout(capacity);
    const seatByCode = new Map(layout.seats.map((seat) => [seat.code || seat.label, seat]));
    const activeSeatCodes = new Set(
      occurrence.reservedSeats
        .filter((seat) => ACTIVE_BOOKING_STATUSES.includes(seat.booking.status))
        .map((seat) => seat.seatCode),
    );

    for (const reservedSeat of occurrence.reservedSeats) {
      const layoutSeat = seatByCode.get(reservedSeat.seatCode);
      if (!layoutSeat) continue;
      await prisma.reserved_seats.update({
        where: { id: reservedSeat.id },
        data: {
          seatId: layoutSeat.id,
          seatLabelSnapshot: layoutSeat.label,
          zone: layoutSeat.zone,
        },
      });
    }

    await prisma.class_occurrences.update({
      where: { id: occurrence.id },
      data: {
        layoutJson: serializeLayout(layout),
        availableSlots: Math.max(capacity - activeSeatCodes.size, 0),
      },
    });
    updated += 1;
  }

  return { updated };
}

main()
  .then((result) => {
    console.log(JSON.stringify(result, null, 2));
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
