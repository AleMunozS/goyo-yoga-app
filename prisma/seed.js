import 'dotenv/config';
import bcrypt from 'bcryptjs';
import dayjs from 'dayjs';
import { PrismaClient } from '@prisma/client';
import { makeBookingRef, hashToken, signPayload } from '../src/utils.js';
import { createDefaultLayout, describeSeatCodes, serializeLayout } from '../src/seats.js';

const prisma = new PrismaClient();
const QR_SECRET = process.env.QR_SECRET || 'local-qr-secret';
const DEMO_MANAGE_TOKEN = 'demo-manage-token';

async function resetDatabase() {
  await prisma.payment_webhooks.deleteMany();
  await prisma.checkins.deleteMany();
  await prisma.wallet_ledger.deleteMany();
  await prisma.reserved_seats.deleteMany();
  await prisma.magic_links.deleteMany();
  await prisma.payments.deleteMany();
  await prisma.bookings.deleteMany();
  await prisma.client_wallets.deleteMany();
  await prisma.ticket_products.deleteMany();
  await prisma.class_occurrences.deleteMany();
  await prisma.schedule_templates.deleteMany();
  await prisma.class_types.deleteMany();
  await prisma.clients.deleteMany();
  await prisma.staff_users.deleteMany();
  await prisma.locations.deleteMany();
  await prisma.audit_events.deleteMany();
}

async function createStaffUsers() {
  const [adminHash, trainerHash, opsHash] = await Promise.all([
    bcrypt.hash('admin1234', 10),
    bcrypt.hash('trainer1234', 10),
    bcrypt.hash('ops1234', 10),
  ]);

  const admin = await prisma.staff_users.create({
    data: { email: 'admin@tisa.local', passwordHash: adminHash, role: 'ADMIN', displayName: 'Admin TISA' },
  });
  const trainer1 = await prisma.staff_users.create({
    data: {
      email: 'sofia@tisa.local',
      passwordHash: trainerHash,
      role: 'TRAINER',
      displayName: 'Sofía Luna',
      trainerBio: 'Práctica suave, movilidad y respiración aplicada al cuerpo.',
    },
  });
  const trainer2 = await prisma.staff_users.create({
    data: {
      email: 'diego@tisa.local',
      passwordHash: trainerHash,
      role: 'TRAINER',
      displayName: 'Diego Sol',
      trainerBio: 'Fuerza serena, control y atención plena al movimiento.',
    },
  });
  const ops = await prisma.staff_users.create({
    data: { email: 'ops@tisa.local', passwordHash: opsHash, role: 'OPS', displayName: 'Operación TISA' },
  });

  return { admin, trainer1, trainer2, ops };
}

async function createClassCatalog() {
  const baseLayout = createDefaultLayout(20);
  const location = await prisma.locations.create({
    data: {
      name: 'TISA Torreón',
      slug: 'tisa-torreon',
      address: 'Torreón, Coahuila',
      layoutJson: serializeLayout(baseLayout),
    },
  });

  const classTypes = await Promise.all([
    prisma.class_types.create({
      data: {
        name: 'Flow Suave',
        slug: 'flow-suave',
        description: 'Práctica para bajar el ritmo, recuperar espacio y volver a la respiración.',
        durationMin: 55,
        intensity: 'Suave',
        colorHex: '#986d4f',
        layoutJson: serializeLayout(createDefaultLayout(18)),
      },
    }),
    prisma.class_types.create({
      data: {
        name: 'Movilidad Consciente',
        slug: 'movilidad-consciente',
        description: 'Secuencia guiada para soltar tensión y ordenar el cuerpo desde la base.',
        durationMin: 55,
        intensity: 'Media',
        colorHex: '#6a7346',
        layoutJson: serializeLayout(createDefaultLayout(20)),
      },
    }),
    prisma.class_types.create({
      data: {
        name: 'Respira y Regula',
        slug: 'respira-y-regula',
        description: 'Trabajo suave de respiración, pausa y presencia para recuperar equilibrio.',
        durationMin: 40,
        intensity: 'Baja',
        colorHex: '#828a91',
        layoutJson: serializeLayout(createDefaultLayout(18)),
      },
    }),
  ]);

  return { location, classTypes };
}

async function createUpcomingOccurrences({ location, classTypes, trainer1, trainer2 }) {
  const occurrences = [];
  const prices = [32000, 35000, 42000];

  for (let index = 0; index < 10; index += 1) {
    const day = dayjs().add(index, 'day');
    const morning = await prisma.class_occurrences.create({
      data: {
        locationId: location.id,
        classTypeId: classTypes[index % classTypes.length].id,
        trainerId: index % 2 === 0 ? trainer1.id : trainer2.id,
        startsAt: day.hour(7).minute(0).second(0).millisecond(0).toDate(),
        endsAt: day.hour(7).minute(55).second(0).millisecond(0).toDate(),
        capacity: 18,
        availableSlots: 18,
        unitPriceCents: prices[index % prices.length],
        layoutJson: serializeLayout(createDefaultLayout(18)),
      },
    });
    occurrences.push(morning);

    const evening = await prisma.class_occurrences.create({
      data: {
        locationId: location.id,
        classTypeId: classTypes[(index + 1) % classTypes.length].id,
        trainerId: index % 2 === 0 ? trainer2.id : trainer1.id,
        startsAt: day.hour(19).minute(0).second(0).millisecond(0).toDate(),
        endsAt: day.hour(19).minute(55).second(0).millisecond(0).toDate(),
        capacity: 20,
        availableSlots: 20,
        unitPriceCents: prices[(index + 1) % prices.length],
        layoutJson: serializeLayout(createDefaultLayout(20)),
      },
    });
    occurrences.push(evening);
  }

  return occurrences;
}

async function main() {
  await resetDatabase();

  const { admin, trainer1, trainer2, ops } = await createStaffUsers();
  const { location, classTypes } = await createClassCatalog();
  const occurrences = await createUpcomingOccurrences({ location, classTypes, trainer1, trainer2 });

  const ana = await prisma.clients.create({
    data: { email: 'ana@example.com', fullName: 'Ana Serrano', phone: '+525511111111' },
  });
  const leo = await prisma.clients.create({
    data: { email: 'leo@example.com', fullName: 'Leo Martínez', phone: '+525522222222' },
  });

  const paidOccurrence = occurrences[2];
  const paidBookingRef = makeBookingRef();
  const paidAt = dayjs().subtract(20, 'minute').toDate();
  const paidQrPayload = JSON.stringify({
    booking_ref: paidBookingRef,
    occurrence_id: paidOccurrence.id,
    client_ref: ana.id,
    expires_at: dayjs(paidOccurrence.endsAt).toISOString(),
  });
  const paidQrSignature = signPayload(paidQrPayload, QR_SECRET);
  const paidBooking = await prisma.bookings.create({
    data: {
      bookingRef: paidBookingRef,
      clientId: ana.id,
      classOccurrenceId: paidOccurrence.id,
      status: 'PAID',
      qrPayload: paidQrPayload,
      qrSignature: paidQrSignature,
      quantity: 1,
      seatSummaryJson: JSON.stringify(describeSeatCodes(['A1'], paidOccurrence.layoutJson, paidOccurrence.capacity)),
      salesChannel: 'web',
      customerNameSnapshot: ana.fullName,
      customerEmailSnapshot: ana.email,
      customerPhoneSnapshot: ana.phone,
      unitPriceCents: paidOccurrence.unitPriceCents,
      subtotalCents: paidOccurrence.unitPriceCents,
      feesCents: 0,
      totalCents: paidOccurrence.unitPriceCents,
      paidAt,
      qrIssuedAt: paidAt,
    },
  });
  await prisma.reserved_seats.create({
    data: {
      bookingId: paidBooking.id,
      classOccurrenceId: paidOccurrence.id,
      seatId: 'seat-a1',
      seatCode: 'A1',
      seatLabelSnapshot: 'A1',
      zone: 'near',
    },
  });
  await prisma.payments.create({
    data: {
      clientId: ana.id,
      bookingId: paidBooking.id,
      stripeSessionId: 'sim_seed_paid',
      stripePaymentId: 'sim_pi_seed_paid',
      amountCents: paidOccurrence.unitPriceCents,
      currency: 'mxn',
      paymentMethodType: 'card',
      salesChannel: 'web',
      status: 'PAID',
      paidAt,
    },
  });
  await prisma.magic_links.create({
    data: {
      clientId: ana.id,
      tokenHash: hashToken(DEMO_MANAGE_TOKEN),
      purpose: `BOOKING_ACCESS:${paidBooking.id}`,
      expiresAt: dayjs().add(14, 'day').toDate(),
    },
  });
  await prisma.class_occurrences.update({
    where: { id: paidOccurrence.id },
    data: { availableSlots: { decrement: 1 } },
  });

  const pendingOccurrence = occurrences[5];
  const pendingExpiresAt = dayjs().add(8, 'minute').toDate();
  const pendingBooking = await prisma.bookings.create({
    data: {
      bookingRef: makeBookingRef(),
      clientId: leo.id,
      classOccurrenceId: pendingOccurrence.id,
      status: 'PENDING_PAYMENT',
      quantity: 2,
      seatSummaryJson: JSON.stringify(describeSeatCodes(['B1', 'B2'], pendingOccurrence.layoutJson, pendingOccurrence.capacity)),
      expiresAt: pendingExpiresAt,
      salesChannel: 'whatsapp',
      customerNameSnapshot: leo.fullName,
      customerEmailSnapshot: leo.email,
      customerPhoneSnapshot: leo.phone,
      unitPriceCents: pendingOccurrence.unitPriceCents,
      subtotalCents: pendingOccurrence.unitPriceCents * 2,
      feesCents: 0,
      totalCents: pendingOccurrence.unitPriceCents * 2,
    },
  });
  await prisma.reserved_seats.createMany({
    data: ['B1', 'B2'].map((seatCode) => ({
      bookingId: pendingBooking.id,
      classOccurrenceId: pendingOccurrence.id,
      seatId: `seat-${seatCode.toLowerCase()}`,
      seatCode,
      seatLabelSnapshot: seatCode,
      zone: 'middle',
    })),
  });
  await prisma.payments.create({
    data: {
      clientId: leo.id,
      bookingId: pendingBooking.id,
      stripeSessionId: 'sim_seed_pending',
      amountCents: pendingOccurrence.unitPriceCents * 2,
      currency: 'mxn',
      paymentMethodType: 'card',
      salesChannel: 'whatsapp',
      status: 'CREATED',
    },
  });
  await prisma.class_occurrences.update({
    where: { id: pendingOccurrence.id },
    data: { availableSlots: { decrement: 2 } },
  });

  const asyncOccurrence = occurrences.find((occurrence) => dayjs(occurrence.startsAt).isAfter(dayjs().add(2, 'day')));
  if (asyncOccurrence) {
    const asyncBooking = await prisma.bookings.create({
      data: {
        bookingRef: makeBookingRef(),
        clientId: leo.id,
        classOccurrenceId: asyncOccurrence.id,
        status: 'PAYMENT_PENDING_ASYNC',
        quantity: 1,
        seatSummaryJson: JSON.stringify(describeSeatCodes(['C1'], asyncOccurrence.layoutJson, asyncOccurrence.capacity)),
        expiresAt: dayjs().add(2, 'day').toDate(),
        salesChannel: 'web',
        customerNameSnapshot: leo.fullName,
        customerEmailSnapshot: leo.email,
        customerPhoneSnapshot: leo.phone,
        unitPriceCents: asyncOccurrence.unitPriceCents,
        subtotalCents: asyncOccurrence.unitPriceCents,
        feesCents: 0,
        totalCents: asyncOccurrence.unitPriceCents,
      },
    });
    await prisma.reserved_seats.create({
      data: {
        bookingId: asyncBooking.id,
        classOccurrenceId: asyncOccurrence.id,
        seatId: 'seat-c1',
        seatCode: 'C1',
        seatLabelSnapshot: 'C1',
        zone: 'back',
      },
    });
    await prisma.payments.create({
      data: {
        clientId: leo.id,
        bookingId: asyncBooking.id,
        stripeSessionId: 'sim_seed_async',
        stripePaymentId: 'sim_pi_seed_async',
        amountCents: asyncOccurrence.unitPriceCents,
        currency: 'mxn',
        paymentMethodType: 'mx_bank_transfer',
        salesChannel: 'web',
        status: 'PENDING_ASYNC',
      },
    });
    await prisma.class_occurrences.update({
      where: { id: asyncOccurrence.id },
      data: { availableSlots: { decrement: 1 } },
    });
  }

  await prisma.audit_events.create({
    data: {
      actorType: 'system',
      actorId: 'seed',
      action: 'SEED_COMPLETED',
      entityType: 'environment',
      entityId: 'dev',
      metadata: JSON.stringify({
        staff: [admin.email, trainer1.email, trainer2.email, ops.email],
        demoClients: [ana.email, leo.email],
        manageLinkHint: `/booking/manage?token=${DEMO_MANAGE_TOKEN}&bookingId=${paidBooking.id}`,
      }),
    },
  });

  console.log('Seed completed. Demo logins:');
  console.log('admin@tisa.local / admin1234');
  console.log('sofia@tisa.local / trainer1234');
  console.log('ops@tisa.local / ops1234');
  console.log(`Manage booking demo: /booking/manage?token=${DEMO_MANAGE_TOKEN}&bookingId=${paidBooking.id}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
