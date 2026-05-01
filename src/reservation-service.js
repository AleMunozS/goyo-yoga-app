import dayjs from 'dayjs';
import QRCode from 'qrcode';
import Stripe from 'stripe';
import { config } from './config.js';
import { sendBookingConfirmationEmail } from './mailer.js';
import { createToken, hashToken, signPayload, makeBookingRef } from './utils.js';
import {
  describeReservedSeats,
  formatSeatLabels,
  getLayoutCapacity,
  getOccurrenceLayoutJson,
  validateSeatSelection,
} from './seats.js';

const QR_SECRET = process.env.QR_SECRET || 'local-qr-secret';

export const stripeClient = !config.simulationMode && config.stripeSecretKey ? new Stripe(config.stripeSecretKey) : null;
export const RESERVATION_HOLD_MINUTES = 10;
export const ASYNC_RESERVATION_WINDOW_HOURS = 24;
export const OXXO_ENABLED = false;

const PENDING_BOOKING_STATUSES = ['PENDING_PAYMENT', 'PAYMENT_PENDING_ASYNC'];
const ACTIVE_BOOKING_STATUSES = ['PENDING_PAYMENT', 'PAYMENT_PENDING_ASYNC', 'PAID', 'CHECKED_IN'];
const FULFILLED_BOOKING_STATUSES = ['PAID', 'CHECKED_IN'];
const TERMINAL_BOOKING_STATUSES = ['EXPIRED', 'CANCELLED', 'NO_SHOW'];
const OPEN_PAYMENT_STATUSES = ['CREATED', 'PENDING_ASYNC'];

const reservationInclude = {
  client: true,
  reservedSeats: { orderBy: { seatCode: 'asc' } },
  classOccurrence: {
    include: {
      classType: true,
      trainer: true,
      location: true,
    },
  },
  payments: {
    orderBy: [{ createdAt: 'desc' }],
  },
};

export class ReservationError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'ReservationError';
    this.code = code;
    this.status = status;
  }
}

function paymentTypesForReservation(occurrence) {
  const paymentMethodTypes = ['card'];
  const paymentMethodOptions = {};

  if (isAsyncMethodEligible(occurrence.startsAt)) {
    paymentMethodTypes.push('customer_balance');
    paymentMethodOptions.customer_balance = {
      funding_type: 'bank_transfer',
      bank_transfer: {
        type: 'mx_bank_transfer',
      },
    };
  }

  return { paymentMethodTypes, paymentMethodOptions };
}

function normalizeSalesChannel(value) {
  return String(value || 'web').trim().toLowerCase() === 'whatsapp' ? 'whatsapp' : 'web';
}

function seatSummaryToJson(seats) {
  return JSON.stringify(
    seats.map((seat) => ({
      id: seat.id,
      label: seat.label,
      zone: seat.zone,
      zoneLabel: seat.zoneLabel,
      row: seat.row,
      order: seat.order,
    })),
  );
}

function aggregateByOccurrence(bookings) {
  const counts = new Map();
  for (const booking of bookings) {
    counts.set(booking.classOccurrenceId, (counts.get(booking.classOccurrenceId) || 0) + booking.quantity);
  }
  return counts;
}

function parseSeatSummary(booking) {
  return describeReservedSeats(booking.reservedSeats, getOccurrenceLayoutJson(booking.classOccurrence), booking.classOccurrence.capacity);
}

async function getReservationOrThrow(prisma, reservationId) {
  const reservation = await prisma.bookings.findUnique({
    where: { id: reservationId },
    include: reservationInclude,
  });

  if (!reservation) {
    throw new ReservationError('RESERVATION_NOT_FOUND', 'Reservación no encontrada.', 404);
  }

  return reservation;
}

export async function getActiveSeatCodes(prisma, occurrenceId, now = new Date()) {
  const activeSeats = await prisma.reserved_seats.findMany({
    where: {
      classOccurrenceId: occurrenceId,
      booking: {
        OR: [
          { status: { in: ['PAID', 'CHECKED_IN'] } },
          { status: { in: PENDING_BOOKING_STATUSES }, expiresAt: { gt: now } },
        ],
      },
    },
    select: { seatId: true, seatCode: true, seatLabelSnapshot: true },
    orderBy: { seatCode: 'asc' },
  });

  return activeSeats.map((seat) => seat.seatId || seat.seatLabelSnapshot || seat.seatCode);
}

async function createManageLink(prisma, booking, baseUrl) {
  const token = createToken();
  await prisma.magic_links.create({
    data: {
      clientId: booking.clientId,
      tokenHash: hashToken(token),
      purpose: `BOOKING_ACCESS:${booking.id}`,
      expiresAt: dayjs().add(20, 'day').toDate(),
    },
  });

  return `${baseUrl}/booking/manage?token=${token}&bookingId=${booking.id}`;
}

async function ensureStripeCustomer(prisma, client) {
  if (!stripeClient) return null;
  if (client.stripeCustomerId) return client.stripeCustomerId;

  const stripeCustomer = await stripeClient.customers.create({
    email: client.email,
    name: client.fullName,
    phone: client.phone || undefined,
    metadata: {
      client_id: client.id,
    },
  });

  await prisma.clients.update({
    where: { id: client.id },
    data: { stripeCustomerId: stripeCustomer.id },
  });

  return stripeCustomer.id;
}

async function finalizePaidReservation(prisma, reservation, payment, baseUrl, paymentIntentId) {
  if (TERMINAL_BOOKING_STATUSES.includes(reservation.status)) {
    await prisma.payments.update({
      where: { id: payment.id },
      data: {
        status: 'PAID',
        stripePaymentId: paymentIntentId || payment.stripePaymentId,
        paidAt: new Date(),
      },
    });
    return { state: 'expired_after_payment', reservation, payment, manageUrl: null, qrDataUrl: null };
  }

  if (FULFILLED_BOOKING_STATUSES.includes(reservation.status)) {
    return { state: 'paid', reservation, payment, manageUrl: null, qrDataUrl: null };
  }

  const paidAt = new Date();
  const qrPayloadObj = {
    booking_ref: reservation.bookingRef,
    occurrence_id: reservation.classOccurrenceId,
    client_ref: reservation.clientId,
    expires_at: dayjs(reservation.classOccurrence.endsAt).toISOString(),
  };
  const qrPayload = JSON.stringify(qrPayloadObj);
  const qrSignature = signPayload(qrPayload, QR_SECRET);
  const seatLabels = formatSeatLabels(
    reservation.reservedSeats.map((seat) => seat.seatId || seat.seatLabelSnapshot || seat.seatCode),
    getOccurrenceLayoutJson(reservation.classOccurrence),
    reservation.classOccurrence.capacity,
  );

  const paidReservation = await prisma.$transaction(async (tx) => {
    const updatedBooking = await tx.bookings.update({
      where: { id: reservation.id },
      data: {
        status: 'PAID',
        qrPayload,
        qrSignature,
        paidAt,
        qrIssuedAt: paidAt,
        expiresAt: null,
      },
      include: reservationInclude,
    });

    await tx.payments.update({
      where: { id: payment.id },
      data: {
        status: 'PAID',
        stripePaymentId: paymentIntentId || payment.stripePaymentId,
        paidAt,
      },
    });

    return updatedBooking;
  });

  const manageUrl = await createManageLink(prisma, paidReservation, baseUrl);
  const qrDataUrl = await QRCode.toDataURL(JSON.stringify({ ...qrPayloadObj, signature: qrSignature }));

  await sendBookingConfirmationEmail({
    to: paidReservation.customerEmailSnapshot,
    bookingRef: paidReservation.bookingRef,
    bookingUrl: manageUrl,
    className: paidReservation.classOccurrence.classType.name,
    classDate: dayjs(paidReservation.classOccurrence.startsAt).format('DD MMM YYYY · HH:mm'),
    trainerName: paidReservation.classOccurrence.trainer.displayName,
    locationName: paidReservation.classOccurrence.location.name,
    seatLabels,
    quantity: paidReservation.quantity,
    qrDataUrl,
  });

  return { state: 'paid', reservation: paidReservation, payment, manageUrl, qrDataUrl };
}

async function markReservationExpired(prisma, reservation, payment) {
  const seatCount = reservation.reservedSeats.length;
  await prisma.$transaction(async (tx) => {
    await tx.bookings.update({
      where: { id: reservation.id },
      data: {
        status: 'EXPIRED',
        expiresAt: null,
      },
    });

    if (seatCount > 0) {
      await tx.reserved_seats.deleteMany({ where: { bookingId: reservation.id } });
      await tx.class_occurrences.update({
        where: { id: reservation.classOccurrenceId },
        data: { availableSlots: { increment: seatCount } },
      });
    }

    if (payment) {
      await tx.payments.update({
        where: { id: payment.id },
        data: { status: 'FAILED' },
      });
    }
  });
}

function latestPayment(reservation) {
  return reservation.payments[0] || null;
}

function buildReservationJson(reservation, baseUrl, manageUrl = null) {
  const payment = latestPayment(reservation);
  return {
    id: reservation.id,
    bookingRef: reservation.bookingRef,
    status: reservation.status,
    expiresAt: reservation.expiresAt,
    paidAt: reservation.paidAt,
    salesChannel: reservation.salesChannel,
    quantity: reservation.quantity,
    customer: {
      name: reservation.customerNameSnapshot,
      email: reservation.customerEmailSnapshot,
      phone: reservation.customerPhoneSnapshot,
    },
    pricing: {
      unitPriceCents: reservation.unitPriceCents,
      subtotalCents: reservation.subtotalCents,
      feesCents: reservation.feesCents,
      totalCents: reservation.totalCents,
      currency: payment?.currency || 'mxn',
    },
    seats: reservation.reservedSeats.map((seat) => ({
      id: seat.seatId || null,
      code: seat.seatLabelSnapshot || seat.seatCode,
      label: seat.seatLabelSnapshot || seat.seatCode,
      zone: seat.zone,
    })),
    schedule: {
      id: reservation.classOccurrenceId,
      startsAt: reservation.classOccurrence.startsAt,
      endsAt: reservation.classOccurrence.endsAt,
      className: reservation.classOccurrence.classType.name,
      trainerName: reservation.classOccurrence.trainer.displayName,
      locationName: reservation.classOccurrence.location.name,
    },
    payment: payment
      ? {
          id: payment.id,
          status: payment.status,
          stripeSessionId: payment.stripeSessionId,
          stripePaymentId: payment.stripePaymentId,
          paymentMethodType: payment.paymentMethodType,
          salesChannel: payment.salesChannel,
        }
      : null,
    manageUrl,
    qrPayload: reservation.status === 'PAID' || reservation.status === 'CHECKED_IN' ? reservation.qrPayload : null,
    qrImageUrl: null,
  };
}

export function getBookingStateLabel(status) {
  if (status === 'DRAFT') return 'Borrador';
  if (status === 'PENDING_PAYMENT') return 'Pendiente de pago';
  if (status === 'PAYMENT_PENDING_ASYNC') return 'Pago en confirmación';
  if (status === 'PAID') return 'Pagada';
  if (status === 'EXPIRED') return 'Expirada';
  if (status === 'CANCELLED') return 'Cancelada';
  if (status === 'CHECKED_IN') return 'Check-in completo';
  if (status === 'NO_SHOW') return 'No show';
  return status;
}

export function isAsyncMethodEligible(startsAt, now = new Date()) {
  return dayjs(startsAt).isAfter(dayjs(now).add(ASYNC_RESERVATION_WINDOW_HOURS, 'hour'));
}

export async function expireStaleReservations(prisma, now = new Date()) {
  const staleReservations = await prisma.bookings.findMany({
    where: {
      status: { in: PENDING_BOOKING_STATUSES },
      expiresAt: { lte: now },
    },
    select: {
      id: true,
      quantity: true,
      classOccurrenceId: true,
    },
  });

  if (staleReservations.length === 0) {
    return { expiredCount: 0 };
  }

  const reservationIds = staleReservations.map((reservation) => reservation.id);
  const occurrenceTotals = aggregateByOccurrence(staleReservations);

  await prisma.$transaction(async (tx) => {
    await tx.bookings.updateMany({
      where: { id: { in: reservationIds } },
      data: {
        status: 'EXPIRED',
        expiresAt: null,
      },
    });

    await tx.reserved_seats.deleteMany({
      where: { bookingId: { in: reservationIds } },
    });

    for (const [occurrenceId, count] of occurrenceTotals.entries()) {
      await tx.class_occurrences.update({
        where: { id: occurrenceId },
        data: { availableSlots: { increment: count } },
      });
    }

    await tx.payments.updateMany({
      where: {
        bookingId: { in: reservationIds },
        status: { in: OPEN_PAYMENT_STATUSES },
      },
      data: { status: 'EXPIRED' },
    });
  });

  return { expiredCount: staleReservations.length };
}

export async function createDraftReservation(prisma, input) {
  const now = input.now || new Date();
  const salesChannel = normalizeSalesChannel(input.salesChannel);

  await expireStaleReservations(prisma, now);

  const created = await prisma.$transaction(async (tx) => {
    const occurrence = await tx.class_occurrences.findUnique({
      where: { id: input.occurrenceId },
      include: {
        classType: true,
        trainer: true,
        location: true,
      },
    });

    if (!occurrence) {
      throw new ReservationError('OCCURRENCE_NOT_FOUND', 'Clase no encontrada.', 404);
    }

    if (occurrence.status === 'CANCELLED') {
      throw new ReservationError('CLASS_CANCELLED', 'La clase fue cancelada.', 409);
    }

    const occurrenceLayoutJson = getOccurrenceLayoutJson(occurrence);
    const occupiedSeatCodes = await getActiveSeatCodes(tx, occurrence.id, now);
    const validation = validateSeatSelection({
      seatCodes: input.seatCodes,
      layoutJson: occurrenceLayoutJson,
      occupiedSeatIds: occupiedSeatCodes,
      fallbackCapacity: occurrence.capacity,
    });

    if (!validation.ok) {
      throw new ReservationError('INVALID_SEAT_SELECTION', validation.message, 409);
    }

    const derivedCapacity = getLayoutCapacity(occurrenceLayoutJson, occurrence.capacity);
    if (occurrence.capacity !== derivedCapacity || occurrence.availableSlots > derivedCapacity) {
      await tx.class_occurrences.update({
        where: { id: occurrence.id },
        data: {
          capacity: derivedCapacity,
          availableSlots: Math.min(occurrence.availableSlots, derivedCapacity),
        },
      });
      occurrence.capacity = derivedCapacity;
      occurrence.availableSlots = Math.min(occurrence.availableSlots, derivedCapacity);
    }

    if (occurrence.availableSlots < validation.seats.length) {
      throw new ReservationError('NOT_ENOUGH_SLOTS', 'La clase ya no tiene suficientes lugares libres para esa selección.', 409);
    }

    const client = await tx.clients.upsert({
      where: { email: input.customerEmail },
      update: {
        fullName: input.customerName,
        phone: input.customerPhone || null,
      },
      create: {
        email: input.customerEmail,
        fullName: input.customerName,
        phone: input.customerPhone || null,
      },
    });

    const duplicate = await tx.bookings.findFirst({
      where: {
        clientId: client.id,
        classOccurrenceId: occurrence.id,
        OR: [
          { status: { in: ['PAID', 'CHECKED_IN'] } },
          { status: { in: PENDING_BOOKING_STATUSES }, expiresAt: { gt: now } },
        ],
      },
    });

    if (duplicate) {
      throw new ReservationError(
        'DUPLICATE_RESERVATION',
        'Ya existe una reservación activa para esta clase con este correo.',
        409,
      );
    }

    const quantity = validation.seats.length;
    const subtotalCents = occurrence.unitPriceCents * quantity;
    const expiresAt = dayjs(now).add(RESERVATION_HOLD_MINUTES, 'minute').toDate();

    const booking = await tx.bookings.create({
      data: {
        bookingRef: makeBookingRef(),
        clientId: client.id,
        classOccurrenceId: occurrence.id,
        status: 'PENDING_PAYMENT',
        quantity,
        seatSummaryJson: seatSummaryToJson(validation.seats),
        expiresAt,
        salesChannel,
        customerNameSnapshot: input.customerName,
        customerEmailSnapshot: input.customerEmail,
        customerPhoneSnapshot: input.customerPhone || null,
        unitPriceCents: occurrence.unitPriceCents,
        subtotalCents,
        feesCents: 0,
        totalCents: subtotalCents,
      },
    });

    await tx.reserved_seats.createMany({
      data: validation.seats.map((seat) => ({
        bookingId: booking.id,
        classOccurrenceId: occurrence.id,
        seatId: seat.id,
        seatCode: seat.label,
        seatLabelSnapshot: seat.label,
        zone: seat.zone,
      })),
    });

    await tx.class_occurrences.update({
      where: { id: occurrence.id },
      data: { availableSlots: { decrement: quantity } },
    });

    return tx.bookings.findUnique({
      where: { id: booking.id },
      include: reservationInclude,
    });
  });

  return created;
}

export async function createCheckoutSessionForReservation(prisma, input) {
  const salesChannel = normalizeSalesChannel(input.salesChannel);
  const now = input.now || new Date();

  await expireStaleReservations(prisma, now);

  const reservation = await getReservationOrThrow(prisma, input.reservationId);
  const payment = latestPayment(reservation);

  if (FULFILLED_BOOKING_STATUSES.includes(reservation.status)) {
    throw new ReservationError('ALREADY_PAID', 'Esta reservación ya fue pagada.', 409);
  }

  if (reservation.status === 'EXPIRED') {
    throw new ReservationError('RESERVATION_EXPIRED', 'La reservación ya expiró.', 409);
  }

  if (reservation.status === 'CANCELLED') {
    throw new ReservationError('RESERVATION_CANCELLED', 'La reservación fue cancelada.', 409);
  }

  if (!reservation.expiresAt || dayjs(reservation.expiresAt).isBefore(dayjs(now))) {
    throw new ReservationError('RESERVATION_EXPIRED', 'Tu apartado expiró. Puedes intentar de nuevo.', 409);
  }

  if (payment && payment.status === 'PAID') {
    throw new ReservationError('ALREADY_PAID', 'Esta reservación ya fue pagada.', 409);
  }

  const stripeCustomerId = await ensureStripeCustomer(prisma, reservation.client);
  const { paymentMethodTypes, paymentMethodOptions } = paymentTypesForReservation(reservation.classOccurrence);
  const seatCodes = reservation.reservedSeats.map((seat) => seat.seatId || seat.seatLabelSnapshot || seat.seatCode);
  const paymentRecord = await prisma.payments.create({
    data: {
      clientId: reservation.clientId,
      bookingId: reservation.id,
      amountCents: reservation.totalCents,
      currency: 'mxn',
      salesChannel,
      status: 'CREATED',
    },
  });

  if (!stripeClient) {
    const simulatedSessionId = `sim_${paymentRecord.id}`;
    await prisma.payments.update({
      where: { id: paymentRecord.id },
      data: {
        stripeSessionId: simulatedSessionId,
      },
    });
    return {
      payment: await prisma.payments.findUnique({ where: { id: paymentRecord.id } }),
      checkoutUrl: `${input.baseUrl}/checkout/success?session_id=${encodeURIComponent(simulatedSessionId)}`,
      paymentMethodTypes,
    };
  }

  const session = await stripeClient.checkout.sessions.create({
    mode: 'payment',
    customer: stripeCustomerId || undefined,
    customer_email: stripeCustomerId ? undefined : reservation.customerEmailSnapshot,
    payment_method_types: paymentMethodTypes,
    payment_method_options: Object.keys(paymentMethodOptions).length ? paymentMethodOptions : undefined,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'mxn',
          unit_amount: reservation.totalCents,
          product_data: {
            name: `${reservation.classOccurrence.classType.name} · ${dayjs(reservation.classOccurrence.startsAt).format('DD MMM · HH:mm')}`,
            description: `Lugares ${formatSeatLabels(seatCodes, getOccurrenceLayoutJson(reservation.classOccurrence), reservation.classOccurrence.capacity)}`,
          },
        },
      },
    ],
    metadata: {
      reservation_id: reservation.id,
      schedule_id: reservation.classOccurrenceId,
      seat_ids: seatCodes.join(','),
      sales_channel: salesChannel,
      customer_email: reservation.customerEmailSnapshot,
    },
    payment_intent_data: {
      metadata: {
        reservation_id: reservation.id,
        schedule_id: reservation.classOccurrenceId,
        seat_ids: seatCodes.join(','),
        sales_channel: salesChannel,
        customer_email: reservation.customerEmailSnapshot,
      },
    },
    success_url: `${input.baseUrl}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${input.baseUrl}/checkout/cancel?reservation_id=${reservation.id}`,
  });

  await prisma.payments.update({
    where: { id: paymentRecord.id },
    data: {
      stripeSessionId: session.id,
    },
  });

  return {
    payment: await prisma.payments.findUnique({ where: { id: paymentRecord.id } }),
    checkoutUrl: session.url,
    paymentMethodTypes,
  };
}

export async function fulfillCheckout(prisma, input) {
  const eventType = input.eventType || null;
  const sessionId = String(input.sessionId || '').trim();

  if (!sessionId) {
    throw new ReservationError('CHECKOUT_SESSION_REQUIRED', 'Falta el Checkout Session.', 400);
  }

  let session;
  if (sessionId.startsWith('sim_')) {
    session = {
      id: sessionId,
      payment_status: 'paid',
      payment_intent: `sim_pi_${sessionId}`,
      payment_method_types: ['card'],
    };
  } else {
    if (!stripeClient) {
      throw new ReservationError('STRIPE_NOT_CONFIGURED', 'Stripe no está configurado.', 500);
    }

    session = await stripeClient.checkout.sessions.retrieve(sessionId);
  }

  const payment = await prisma.payments.findFirst({
    where: { stripeSessionId: session.id },
    include: {
      booking: {
        include: reservationInclude,
      },
    },
  });

  if (!payment || !payment.booking) {
    throw new ReservationError('PAYMENT_NOT_FOUND', 'Pago no encontrado para esta sesión.', 404);
  }

  const reservation = payment.booking;

  if (eventType === 'checkout.session.async_payment_failed') {
    await markReservationExpired(prisma, reservation, payment);
    const expiredReservation = await getReservationOrThrow(prisma, reservation.id);
    return { state: 'failed', reservation: expiredReservation, payment };
  }

  if (session.payment_status === 'paid' || eventType === 'checkout.session.async_payment_succeeded') {
    return finalizePaidReservation(
      prisma,
      reservation,
      payment,
      input.baseUrl,
      session.payment_intent ? String(session.payment_intent) : payment.stripePaymentId,
    );
  }

  if (reservation.status === 'EXPIRED') {
    return { state: 'expired', reservation, payment, manageUrl: null, qrDataUrl: null };
  }

  const pendingPayment = await prisma.payments.update({
    where: { id: payment.id },
    data: {
      status: 'PENDING_ASYNC',
      paymentMethodType: session.payment_method_types?.includes('customer_balance') ? 'mx_bank_transfer' : 'card',
    },
  });

  const pendingReservation = await prisma.bookings.update({
    where: { id: reservation.id },
    data: {
      status: 'PAYMENT_PENDING_ASYNC',
    },
    include: reservationInclude,
  });

  return { state: 'pending_async', reservation: pendingReservation, payment: pendingPayment, manageUrl: null, qrDataUrl: null };
}

export async function markPaymentIntentFailed(prisma, paymentIntentId) {
  if (!paymentIntentId) return;

  const payment = await prisma.payments.findFirst({
    where: { stripePaymentId: String(paymentIntentId) },
    include: { booking: { include: reservationInclude } },
  });

  if (!payment) return;

  if (payment.status === 'PAID') return;

  await prisma.payments.update({
    where: { id: payment.id },
    data: { status: 'FAILED' },
  });
}

export async function markChargeRefunded(prisma, chargeObject) {
  const paymentIntentId = chargeObject?.payment_intent ? String(chargeObject.payment_intent) : null;
  if (!paymentIntentId) return;

  const payment = await prisma.payments.findFirst({
    where: { stripePaymentId: paymentIntentId },
    include: {
      booking: {
        include: reservationInclude,
      },
    },
  });

  if (!payment) return;

  await prisma.payments.update({
    where: { id: payment.id },
    data: { status: 'REFUNDED' },
  });

  if (!payment.booking || payment.booking.status === 'CHECKED_IN') {
    return;
  }

  const seatCount = payment.booking.reservedSeats.length;
  await prisma.$transaction(async (tx) => {
    await tx.bookings.update({
      where: { id: payment.booking.id },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
      },
    });

    if (seatCount > 0) {
      await tx.reserved_seats.deleteMany({ where: { bookingId: payment.booking.id } });
      await tx.class_occurrences.update({
        where: { id: payment.booking.classOccurrenceId },
        data: {
          availableSlots: { increment: seatCount },
        },
      });
    }
  });
}

export async function getReservationResponse(prisma, reservationId, baseUrl, options = {}) {
  const reservation = await getReservationOrThrow(prisma, reservationId);
  let manageUrl = null;

  if ((reservation.status === 'PAID' || reservation.status === 'CHECKED_IN') && options.createManageLink) {
    manageUrl = await createManageLink(prisma, reservation, baseUrl);
  }

  return buildReservationJson(reservation, baseUrl, manageUrl);
}
