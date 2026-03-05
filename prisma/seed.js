import 'dotenv/config';
import bcrypt from 'bcryptjs';
import dayjs from 'dayjs';
import { PrismaClient } from '@prisma/client';
import { signPayload, makeBookingRef } from '../src/utils.js';

const prisma = new PrismaClient();
const QR_SECRET = process.env.QR_SECRET || 'local-qr-secret';

async function main() {
  await prisma.payment_webhooks.deleteMany();
  await prisma.checkins.deleteMany();
  await prisma.wallet_ledger.deleteMany();
  await prisma.bookings.deleteMany();
  await prisma.magic_links.deleteMany();
  await prisma.class_occurrences.deleteMany();
  await prisma.schedule_templates.deleteMany();
  await prisma.payments.deleteMany();
  await prisma.client_wallets.deleteMany();
  await prisma.ticket_products.deleteMany();
  await prisma.class_types.deleteMany();
  await prisma.clients.deleteMany();
  await prisma.staff_users.deleteMany();
  await prisma.locations.deleteMany();
  await prisma.audit_events.deleteMany();

  const [adminHash, trainerHash, opsHash] = await Promise.all([
    bcrypt.hash('admin1234', 10),
    bcrypt.hash('trainer1234', 10),
    bcrypt.hash('ops1234', 10),
  ]);

  const admin = await prisma.staff_users.create({ data: { email: 'admin@goyo.local', passwordHash: adminHash, role: 'ADMIN', displayName: 'Admin GOYO' } });
  const trainer1 = await prisma.staff_users.create({ data: { email: 'sofia@goyo.local', passwordHash: trainerHash, role: 'TRAINER', displayName: 'Sofia Luna', trainerBio: 'Vinyasa y movilidad' } });
  const trainer2 = await prisma.staff_users.create({ data: { email: 'diego@goyo.local', passwordHash: trainerHash, role: 'TRAINER', displayName: 'Diego Sol', trainerBio: 'Power flow' } });
  const ops = await prisma.staff_users.create({ data: { email: 'ops@goyo.local', passwordHash: opsHash, role: 'OPS', displayName: 'Operaciones GOYO' } });

  const location = await prisma.locations.create({
    data: { name: 'GOYO Central', slug: 'goyo-central', address: 'Col. Centro, CDMX' },
  });

  const classTypes = await Promise.all([
    prisma.class_types.create({ data: { name: 'Flow Suave', slug: 'flow-suave', description: 'Respiración y movilidad restaurativa.', durationMin: 50, intensity: 'Suave', colorHex: '#986d4f' } }),
    prisma.class_types.create({ data: { name: 'Power Yoga', slug: 'power-yoga', description: 'Secuencia activa de fuerza y control.', durationMin: 55, intensity: 'Media/Alta', colorHex: '#6a7346' } }),
    prisma.class_types.create({ data: { name: 'Meditación Guiada', slug: 'meditacion-guiada', description: 'Aterrizar mente y cuerpo.', durationMin: 40, intensity: 'Baja', colorHex: '#828a91' } }),
  ]);

  for (const t of classTypes) {
    await prisma.ticket_products.createMany({ data: [
      { classTypeId: t.id, name: `${t.name} x5`, bundleSize: 5, priceCents: 250000, currency: 'mxn' },
      { classTypeId: t.id, name: `${t.name} x10`, bundleSize: 10, priceCents: 450000, currency: 'mxn' },
    ] });
  }

  const ana = await prisma.clients.create({ data: { email: 'ana@example.com', fullName: 'Ana Serrano', phone: '+525511111111' } });
  const leo = await prisma.clients.create({ data: { email: 'leo@example.com', fullName: 'Leo Martínez', phone: '+525522222222' } });

  for (const ct of classTypes) {
    await prisma.client_wallets.create({ data: { clientId: ana.id, classTypeId: ct.id, credits: ct.slug === 'power-yoga' ? 4 : 2 } });
    await prisma.client_wallets.create({ data: { clientId: leo.id, classTypeId: ct.id, credits: ct.slug === 'flow-suave' ? 3 : 1 } });
  }

  const upcoming = [];
  for (let i = 0; i < 10; i++) {
    const day = dayjs().add(i, 'day');
    const slot1 = await prisma.class_occurrences.create({
      data: {
        locationId: location.id,
        classTypeId: classTypes[i % classTypes.length].id,
        trainerId: i % 2 === 0 ? trainer1.id : trainer2.id,
        startsAt: day.hour(7).minute(0).second(0).toDate(),
        endsAt: day.hour(7).minute(55).second(0).toDate(),
        capacity: 18,
        availableSlots: 18,
      },
    });
    upcoming.push(slot1);

    await prisma.class_occurrences.create({
      data: {
        locationId: location.id,
        classTypeId: classTypes[(i + 1) % classTypes.length].id,
        trainerId: i % 2 === 0 ? trainer2.id : trainer1.id,
        startsAt: day.hour(19).minute(0).second(0).toDate(),
        endsAt: day.hour(19).minute(55).second(0).toDate(),
        capacity: 20,
        availableSlots: 20,
      },
    });
  }

  const classForAna = upcoming[1];
  const bookingRef = makeBookingRef();
  const qrPayloadObj = {
    booking_ref: bookingRef,
    occurrence_id: classForAna.id,
    client_ref: ana.id,
    expires_at: dayjs(classForAna.endsAt).toISOString(),
  };
  const qrPayload = JSON.stringify(qrPayloadObj);
  const qrSignature = signPayload(qrPayload, QR_SECRET);

  const booking = await prisma.bookings.create({
    data: {
      bookingRef,
      clientId: ana.id,
      classOccurrenceId: classForAna.id,
      status: 'BOOKED',
      qrPayload,
      qrSignature,
    },
  });

  const wallet = await prisma.client_wallets.findUnique({ where: { clientId_classTypeId: { clientId: ana.id, classTypeId: classForAna.classTypeId } } });
  await prisma.client_wallets.update({ where: { id: wallet.id }, data: { credits: { decrement: 1 } } });
  await prisma.wallet_ledger.create({ data: { walletId: wallet.id, type: 'DEBIT', amount: -1, reason: 'Reserva demo', bookingId: booking.id } });
  await prisma.class_occurrences.update({ where: { id: classForAna.id }, data: { availableSlots: { decrement: 1 } } });

  const paidProduct = await prisma.ticket_products.findFirst({ where: { classTypeId: classTypes[0].id } });
  const paidPayment = await prisma.payments.create({ data: { clientId: leo.id, ticketProductId: paidProduct.id, amountCents: paidProduct.priceCents, status: 'PAID', stripeSessionId: 'sim_seed_paid' } });
  const leoWallet = await prisma.client_wallets.findUnique({ where: { clientId_classTypeId: { clientId: leo.id, classTypeId: classTypes[0].id } } });
  await prisma.client_wallets.update({ where: { id: leoWallet.id }, data: { credits: { increment: paidProduct.bundleSize } } });
  await prisma.wallet_ledger.create({ data: { walletId: leoWallet.id, type: 'CREDIT', amount: paidProduct.bundleSize, reason: 'Compra demo', paymentId: paidPayment.id } });

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
      }),
    },
  });

  console.log('Seed completed. Demo logins:');
  console.log('admin@goyo.local / admin1234');
  console.log('sofia@goyo.local / trainer1234');
  console.log('ops@goyo.local / ops1234');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
