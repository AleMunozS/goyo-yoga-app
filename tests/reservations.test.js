import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import dayjs from 'dayjs';

process.env.SIMULATION_MODE = 'true';
process.env.APP_URL = 'http://127.0.0.1:3000';
process.env.SESSION_SECRET = 'test-session-secret';
process.env.QR_SECRET = 'test-qr-secret';

const { PrismaClient } = await import('@prisma/client');
const { createApp } = await import('../src/app.js');
const { createDefaultLayout, serializeLayout } = await import('../src/seats.js');
const {
  createCheckoutSessionForReservation,
  createDraftReservation,
  expireStaleReservations,
} = await import('../src/reservation-service.js');

const prisma = new PrismaClient();

const app = createApp({ prisma });
const server = app.listen(0);
const address = server.address();
const baseUrl = `http://127.0.0.1:${address.port}`;

const trainerPasswordHash = bcrypt.hashSync('trainer1234', 10);
const opsPasswordHash = bcrypt.hashSync('ops1234', 10);
const adminPasswordHash = bcrypt.hashSync('admin1234', 10);

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

async function seedBaseData() {
  const baseLayout = createDefaultLayout(20);
  const [trainer, ops, admin] = await Promise.all([
    prisma.staff_users.create({
      data: {
        email: 'trainer@test.local',
        passwordHash: trainerPasswordHash,
        role: 'TRAINER',
        displayName: 'Trainer Test',
      },
    }),
    prisma.staff_users.create({
      data: {
        email: 'ops@test.local',
        passwordHash: opsPasswordHash,
        role: 'OPS',
        displayName: 'Ops Test',
      },
    }),
    prisma.staff_users.create({
      data: {
        email: 'admin@test.local',
        passwordHash: adminPasswordHash,
        role: 'ADMIN',
        displayName: 'Admin Test',
      },
    }),
  ]);

  const location = await prisma.locations.create({
    data: {
      name: 'Test Studio',
      slug: 'test-studio',
      address: 'Torreón, Coahuila',
      layoutJson: serializeLayout(baseLayout),
    },
  });
  const classType = await prisma.class_types.create({
    data: {
      name: 'Flow Test',
      slug: 'flow-test',
      description: 'Clase para pruebas.',
      durationMin: 60,
      intensity: 'Media',
      colorHex: '#7a6a54',
    },
  });

  const soonOccurrence = await prisma.class_occurrences.create({
    data: {
      locationId: location.id,
      classTypeId: classType.id,
      trainerId: trainer.id,
      startsAt: dayjs().add(6, 'hour').toDate(),
      endsAt: dayjs().add(7, 'hour').toDate(),
      capacity: 18,
      availableSlots: 18,
      unitPriceCents: 35000,
      layoutJson: serializeLayout(createDefaultLayout(18)),
    },
  });
  const farOccurrence = await prisma.class_occurrences.create({
    data: {
      locationId: location.id,
      classTypeId: classType.id,
      trainerId: trainer.id,
      startsAt: dayjs().add(3, 'day').toDate(),
      endsAt: dayjs().add(3, 'day').add(1, 'hour').toDate(),
      capacity: 18,
      availableSlots: 18,
      unitPriceCents: 39000,
      layoutJson: serializeLayout(createDefaultLayout(18)),
    },
  });
  const checkinOccurrence = await prisma.class_occurrences.create({
    data: {
      locationId: location.id,
      classTypeId: classType.id,
      trainerId: trainer.id,
      startsAt: dayjs().add(10, 'minute').toDate(),
      endsAt: dayjs().add(70, 'minute').toDate(),
      capacity: 18,
      availableSlots: 18,
      unitPriceCents: 41000,
      layoutJson: serializeLayout(createDefaultLayout(18)),
    },
  });

  return { trainer, ops, admin, location, classType, soonOccurrence, farOccurrence, checkinOccurrence };
}

async function request(pathname, options = {}) {
  return fetch(`${baseUrl}${pathname}`, options);
}

function formBody(payload) {
  return new URLSearchParams(payload).toString();
}

async function loginAs(email, password) {
  const response = await request('/staff/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: formBody({ email, password }),
    redirect: 'manual',
  });

  assert.equal(response.status, 302);
  return response.headers.getSetCookie()[0].split(';')[0];
}

test.beforeEach(async () => {
  await resetDatabase();
});

test.after(async () => {
  await prisma.$disconnect();
  await new Promise((resolve) => server.close(resolve));
});

test('classes page renders the editorial shell in week and month views with live booking links', { concurrency: false }, async () => {
  const { soonOccurrence } = await seedBaseData();

  const weekResponse = await request('/classes');
  assert.equal(weekResponse.status, 200);
  const weekHtml = await weekResponse.text();
  assert.match(weekHtml, /classes-site-header/);
  assert.match(weekHtml, /classes-week-grid/);
  assert.match(weekHtml, new RegExp(`/booking/seats\\?occurrenceId=${soonOccurrence.id}`));

  const monthResponse = await request('/classes?view=month');
  assert.equal(monthResponse.status, 200);
  const monthHtml = await monthResponse.text();
  assert.match(monthHtml, /classes-month-grid/);
});

test('reservation API creates a draft hold without QR', { concurrency: false }, async () => {
  const { soonOccurrence } = await seedBaseData();
  const response = await request('/api/reservations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      occurrenceId: soonOccurrence.id,
      seatCodes: ['A1'],
      customerName: 'Ana Test',
      customerEmail: 'ana@test.local',
      customerPhone: '+525500000001',
      salesChannel: 'web',
    }),
  });

  assert.equal(response.status, 201);
  const payload = await response.json();
  assert.equal(payload.status, 'PENDING_PAYMENT');
  assert.equal(payload.payment, null);
  assert.equal(payload.qrPayload, null);
  assert.equal(payload.pricing.totalCents, 35000);
  assert.ok(payload.expiresAt);
});

test('simulated checkout fulfillment marks the reservation as paid and emits QR', { concurrency: false }, async () => {
  const { soonOccurrence } = await seedBaseData();
  const reservationResponse = await request('/api/reservations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      occurrenceId: soonOccurrence.id,
      seatCodes: ['A2'],
      customerName: 'Leo Test',
      customerEmail: 'leo@test.local',
      customerPhone: '+525500000002',
      salesChannel: 'web',
    }),
  });
  const reservation = await reservationResponse.json();

  const checkoutResponse = await request('/api/payments/checkout-session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      reservationId: reservation.id,
      salesChannel: 'web',
    }),
  });
  assert.equal(checkoutResponse.status, 201);
  const checkout = await checkoutResponse.json();
  const checkoutUrl = new URL(checkout.checkoutUrl);

  const successResponse = await request(`${checkoutUrl.pathname}${checkoutUrl.search}`);
  const successHtml = await successResponse.text();
  assert.equal(successResponse.status, 200);
  assert.match(successHtml, /Pago confirmado/i);

  const refreshedResponse = await request(`/api/reservations/${reservation.id}`);
  const refreshed = await refreshedResponse.json();
  assert.equal(refreshed.status, 'PAID');
  assert.equal(refreshed.payment.status, 'PAID');
  assert.ok(refreshed.qrPayload);
});

test('active holds reject duplicate seats until they expire, then free them again', { concurrency: false }, async () => {
  const { soonOccurrence } = await seedBaseData();
  const firstReservation = await createDraftReservation(prisma, {
    occurrenceId: soonOccurrence.id,
    seatCodes: ['B1'],
    customerName: 'First Client',
    customerEmail: 'first@test.local',
    customerPhone: '+525500000003',
    salesChannel: 'web',
  });

  const conflictingResponse = await request('/api/reservations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      occurrenceId: soonOccurrence.id,
      seatCodes: ['B1'],
      customerName: 'Second Client',
      customerEmail: 'second@test.local',
      customerPhone: '+525500000004',
      salesChannel: 'web',
    }),
  });
  assert.equal(conflictingResponse.status, 409);

  await prisma.bookings.update({
    where: { id: firstReservation.id },
    data: { expiresAt: dayjs().subtract(1, 'minute').toDate() },
  });
  await expireStaleReservations(prisma);

  const retryResponse = await request('/api/reservations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      occurrenceId: soonOccurrence.id,
      seatCodes: ['B1'],
      customerName: 'Third Client',
      customerEmail: 'third@test.local',
      customerPhone: '+525500000005',
      salesChannel: 'web',
    }),
  });
  assert.equal(retryResponse.status, 201);

  const expiredBooking = await prisma.bookings.findUnique({ where: { id: firstReservation.id } });
  assert.equal(expiredBooking.status, 'EXPIRED');
});

test('admin class layout save recalculates capacity when the class has no active reservations', { concurrency: false }, async () => {
  const { soonOccurrence } = await seedBaseData();
  const sessionCookie = await loginAs('admin@test.local', 'admin1234');
  const nextLayout = JSON.parse(serializeLayout(createDefaultLayout(18)));
  nextLayout.seats = nextLayout.seats.map((seat) => (seat.id === 'seat-e3' ? { ...seat, enabled: false } : seat));

  const response = await request(`/admin/class-layouts/${soonOccurrence.id}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: sessionCookie,
    },
    body: formBody({ layoutJson: JSON.stringify(nextLayout) }),
    redirect: 'manual',
  });

  assert.equal(response.status, 302);
  const updatedOccurrence = await prisma.class_occurrences.findUnique({ where: { id: soonOccurrence.id } });
  assert.equal(updatedOccurrence.capacity, 17);
  assert.equal(updatedOccurrence.availableSlots, 17);
});

test('admin class layout save blocks structural seat edits after an active reservation exists', { concurrency: false }, async () => {
  const { soonOccurrence } = await seedBaseData();
  await createDraftReservation(prisma, {
    occurrenceId: soonOccurrence.id,
    seatCodes: ['A1'],
    customerName: 'Layout Lock',
    customerEmail: 'layout-lock@test.local',
    customerPhone: '+525500000099',
    salesChannel: 'web',
  });
  const sessionCookie = await loginAs('admin@test.local', 'admin1234');
  const nextLayout = JSON.parse(serializeLayout(createDefaultLayout(18)));
  nextLayout.seats = nextLayout.seats.map((seat) => (seat.id === 'seat-a2' ? { ...seat, x: seat.x + 96 } : seat));

  const response = await request(`/admin/class-layouts/${soonOccurrence.id}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: sessionCookie,
    },
    body: formBody({ layoutJson: JSON.stringify(nextLayout) }),
  });

  assert.equal(response.status, 409);
  const html = await response.text();
  assert.match(html, /Solo puedes mover la instructora/i);
});

test('async method eligibility only enables mx bank transfer for far-future reservations', { concurrency: false }, async () => {
  const { soonOccurrence, farOccurrence } = await seedBaseData();

  const nearReservation = await createDraftReservation(prisma, {
    occurrenceId: soonOccurrence.id,
    seatCodes: ['C1'],
    customerName: 'Near Client',
    customerEmail: 'near@test.local',
    customerPhone: '+525500000006',
    salesChannel: 'web',
  });
  const farReservation = await createDraftReservation(prisma, {
    occurrenceId: farOccurrence.id,
    seatCodes: ['C2'],
    customerName: 'Far Client',
    customerEmail: 'far@test.local',
    customerPhone: '+525500000007',
    salesChannel: 'web',
  });

  const nearCheckout = await createCheckoutSessionForReservation(prisma, {
    reservationId: nearReservation.id,
    salesChannel: 'web',
    baseUrl,
  });
  const farCheckout = await createCheckoutSessionForReservation(prisma, {
    reservationId: farReservation.id,
    salesChannel: 'web',
    baseUrl,
  });

  assert.deepEqual(nearCheckout.paymentMethodTypes, ['card']);
  assert.deepEqual(farCheckout.paymentMethodTypes, ['card', 'customer_balance']);
});

test('ops check-in only works for paid reservations with a valid QR payload', { concurrency: false }, async () => {
  const { checkinOccurrence } = await seedBaseData();
  const reservation = await createDraftReservation(prisma, {
    occurrenceId: checkinOccurrence.id,
    seatCodes: ['A3'],
    customerName: 'Checkin Client',
    customerEmail: 'checkin@test.local',
    customerPhone: '+525500000008',
    salesChannel: 'web',
  });
  const checkout = await createCheckoutSessionForReservation(prisma, {
    reservationId: reservation.id,
    salesChannel: 'web',
    baseUrl,
  });
  const checkoutUrl = new URL(checkout.checkoutUrl);
  await request(`${checkoutUrl.pathname}${checkoutUrl.search}`);

  const paidBooking = await prisma.bookings.findUnique({
    where: { id: reservation.id },
  });

  const loginResponse = await request('/staff/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: formBody({
      email: 'ops@test.local',
      password: 'ops1234',
    }),
    redirect: 'manual',
  });

  assert.equal(loginResponse.status, 302);
  const sessionCookie = loginResponse.headers.getSetCookie()[0].split(';')[0];
  const qrPayload = JSON.parse(paidBooking.qrPayload);
  qrPayload.signature = paidBooking.qrSignature;

  const checkinResponse = await request('/ops/checkin/scan', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: sessionCookie,
    },
    body: formBody({
      payload: JSON.stringify(qrPayload),
    }),
  });

  assert.equal(checkinResponse.status, 200);
  const checkedInBooking = await prisma.bookings.findUnique({ where: { id: reservation.id } });
  assert.equal(checkedInBooking.status, 'CHECKED_IN');
});
