import express from 'express';
import session from 'express-session';
import morgan from 'morgan';
import dayjs from 'dayjs';
import bcrypt from 'bcryptjs';
import QRCode from 'qrcode';
import Stripe from 'stripe';
import { z } from 'zod';
import { renderLayout } from './views/layout.js';
import { config } from './config.js';
import { createToken, esc, hashToken, makeBookingRef, signPayload } from './utils.js';

const QR_SECRET = process.env.QR_SECRET || 'local-qr-secret';

function requireStaff(req, res, next) {
  if (!req.session.staffId) return res.redirect('/staff/login');
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.staffRole || !roles.includes(req.session.staffRole)) {
      return res.status(403).send('No autorizado');
    }
    next();
  };
}

function renderError(message) {
  return `<section class="section"><div class="card"><h2>Error</h2><p>${esc(message)}</p></div></section>`;
}

function startOfWeekMonday(value) {
  const d = dayjs(value).startOf('day');
  const weekday = d.day(); // 0 = Sunday
  const diff = (weekday + 6) % 7;
  return d.subtract(diff, 'day');
}

function getBaseUrl(req) {
  const envUrl = String(config.appUrl || '').trim();
  if (envUrl && !envUrl.includes('localhost')) return envUrl;
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http');
  const host = String(req.headers['x-forwarded-host'] || req.get('host') || '').trim();
  if (!host) return envUrl || 'http://localhost:3000';
  return `${proto}://${host}`;
}

export function createApp({ prisma }) {
  const app = express();
  const stripe = config.stripeSecretKey ? new Stripe(config.stripeSecretKey) : null;

  app.use(morgan('dev'));
  app.use('/static', express.static(new URL('./public', import.meta.url).pathname));
  app.use(session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax' },
  }));

  app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
      let event;
      if (stripe && config.stripeWebhookSecret) {
        const sig = req.headers['stripe-signature'];
        event = stripe.webhooks.constructEvent(req.body, sig, config.stripeWebhookSecret);
      } else {
        event = JSON.parse(req.body.toString('utf8'));
      }

      const existing = await prisma.payment_webhooks.findUnique({ where: { stripeEventId: event.id } });
      if (existing) return res.json({ received: true, duplicate: true });

      let paymentId = null;
      if (event.type === 'checkout.session.completed') {
        const sessionObj = event.data.object;
        const payment = await prisma.payments.findFirst({ where: { stripeSessionId: sessionObj.id } });
        if (payment) {
          paymentId = payment.id;
          await prisma.payments.update({ where: { id: payment.id }, data: { status: 'PAID', stripePaymentId: sessionObj.payment_intent ? String(sessionObj.payment_intent) : null } });

          const product = await prisma.ticket_products.findUnique({ where: { id: payment.ticketProductId } });
          const wallet = await prisma.client_wallets.upsert({
            where: { clientId_classTypeId: { clientId: payment.clientId, classTypeId: product.classTypeId } },
            update: { credits: { increment: product.bundleSize } },
            create: { clientId: payment.clientId, classTypeId: product.classTypeId, credits: product.bundleSize },
          });

          await prisma.wallet_ledger.create({
            data: {
              walletId: wallet.id,
              type: 'CREDIT',
              amount: product.bundleSize,
              reason: 'Compra Stripe checkout.session.completed',
              paymentId: payment.id,
            },
          });
        }
      }

      await prisma.payment_webhooks.create({
        data: {
          stripeEventId: event.id,
          type: event.type,
          payload: JSON.stringify(event),
          processed: true,
          paymentId,
        },
      });
      res.json({ received: true });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());

  app.get('/', async (req, res) => {
    const [types, upcoming, bundles] = await Promise.all([
      prisma.class_types.findMany({ orderBy: { name: 'asc' }, take: 4 }),
      prisma.class_occurrences.findMany({
        include: { classType: true, trainer: true },
        orderBy: { startsAt: 'asc' },
        take: 3,
        where: { startsAt: { gte: new Date(dayjs().startOf('day').toISOString()) } },
      }),
      prisma.ticket_products.findMany({
        include: { classType: true },
        orderBy: [{ bundleSize: 'desc' }, { priceCents: 'asc' }],
        take: 4,
        where: { active: true },
      }),
    ]);

    const typeCards = types
      .map(
        (t) => `
      <article class="card dune-card reveal">
        <span class="tag">${esc(t.intensity)}</span>
        <h3>${esc(t.name)}</h3>
        <p>${esc(t.description)}</p>
        <span class="status-pill">${t.durationMin} min</span>
      </article>
    `
      )
      .join('');

    const timeline = upcoming.length
      ? upcoming
          .map(
            (c) => `
        <div class="timeline-row reveal">
          <div>
            <strong>${esc(c.classType.name)}</strong>
            <p>${esc(c.trainer.displayName)}</p>
          </div>
          <div class="timeline-right">
            <span>${dayjs(c.startsAt).format('HH:mm')}</span>
            <small>${c.availableSlots} cupos</small>
          </div>
        </div>
      `
          )
          .join('')
      : '<div class="timeline-row"><p>Agenda en actualización</p></div>';

    const bundleCards = bundles
      .map(
        (b) => `
      <article class="card reveal">
        <h3>${esc(b.classType.name)}</h3>
        <p>${esc(b.name)}</p>
        <div class="metric">${b.bundleSize} tickets</div>
        <p>MXN ${(b.priceCents / 100).toLocaleString('es-MX')}</p>
        <a class="btn" href="/classes">Comprar y reservar</a>
      </article>
    `
      )
      .join('');

    const body = `
      <section class="story-root">
        <div class="ambient-lights" aria-hidden="true">
          <span class="light-orb orb-1"></span>
          <span class="light-orb orb-2"></span>
          <span class="light-orb orb-3"></span>
          <span class="light-orb orb-4"></span>
        </div>

        <section class="hero parallax dune-hero">
          <div class="hero-card reveal">
            <p class="eyebrow">ORIGEN · EQUILIBRIO · BIOMODULACIÓN</p>
            <h1>Encuentra tu equilibrio en el origen.</h1>
            <p>Compra bundles por tipo de clase, reserva en segundos y llega con QR listo para acceso.</p>
            <div class="hero-actions">
              <a class="btn" href="/classes">Agendar experiencia</a>
              <a class="btn alt" href="/staff/login">Portal staff</a>
            </div>
          </div>
        </section>

        <section class="section split-section reveal">
          <article class="card split-left">
            <h2>El equilibrio perfecto</h2>
            <p>Inspirado por ciclos de luz y sombra, GOYO integra movimiento, respiración y foco mental.</p>
            <p class="quote">"Una práctica que se siente viva en cada sesión."</p>
          </article>
          <article class="card split-right">
            <div class="clay-shape"></div>
          </article>
        </section>

        <section class="section">
          <h2 class="reveal">Experiencias GOYO</h2>
          <div class="grid">${typeCards}</div>
        </section>

        <section class="section schedule-shell reveal">
          <div class="card schedule-board">
            <h2>Agenda destacada</h2>
            <div class="timeline">${timeline}</div>
            <a class="btn" href="/classes">Ver horarios completos</a>
          </div>
        </section>

        <section class="section">
          <h2 class="reveal">Bundles de tickets</h2>
          <div class="grid">${bundleCards || '<div class="card">Próximamente bundles activos.</div>'}</div>
        </section>

        <section class="section reveal">
          <div class="card final-manifesto">
            <h2>Al final del recorrido, solo queda enfoque.</h2>
            <p>Desliza, reserva y entra a clase con una experiencia fluida para cliente, trainer y operación.</p>
            <a class="btn alt" href="/classes">Comenzar ahora</a>
          </div>
        </section>
      </section>
    `;

    res.send(renderLayout({ title: 'Inicio', body, simulationMode: config.simulationMode }));
  });

  app.get('/classes', async (req, res) => {
    const view = String(req.query.view || 'week') === 'month' ? 'month' : 'week';
    const requestedStart = req.query.start ? dayjs(String(req.query.start)) : dayjs();
    const periodStart = view === 'month' ? dayjs(requestedStart).startOf('month') : startOfWeekMonday(requestedStart);
    const periodEnd = view === 'month' ? dayjs(periodStart).endOf('month').add(7, 'day') : dayjs(periodStart).add(7, 'day');

    const classes = await prisma.class_occurrences.findMany({
      include: { classType: true, trainer: true, location: true },
      orderBy: { startsAt: 'asc' },
      take: 500,
      where: {
        startsAt: {
          gte: new Date(periodStart.startOf('day').toISOString()),
          lt: new Date(periodEnd.endOf('day').toISOString()),
        },
      },
    });
    const days =
      view === 'month'
        ? Array.from({ length: 42 }, (_, i) => startOfWeekMonday(periodStart).add(i, 'day'))
        : Array.from({ length: 7 }, (_, i) => startOfWeekMonday(periodStart).add(i, 'day'));

    const prevStart = view === 'month' ? periodStart.subtract(1, 'month') : periodStart.subtract(7, 'day');
    const nextStart = view === 'month' ? periodStart.add(1, 'month') : periodStart.add(7, 'day');
    const titleRange =
      view === 'month'
        ? periodStart.format('MMMM YYYY')
        : `${periodStart.format('DD MMM')} - ${periodStart.add(6, 'day').format('DD MMM YYYY')}`;

    const startHour = 6;
    const endHour = 22;
    const totalSlots = endHour - startHour;
    const rowHeight = 78;
    const trackHeight = totalSlots * rowHeight;

    const dayHeaders = days
      .map(
        (d) => `
      <div class="calendar-day-head">
        <span>${d.format('ddd').toUpperCase()}</span>
        <strong>${d.format(view === 'month' ? 'DD' : 'DD MMM')}</strong>
      </div>`
      )
      .join('');

    const timeLabels = Array.from({ length: totalSlots }, (_, idx) => startHour + idx)
      .map((hour) => `<div class="calendar-time-label">${String(hour).padStart(2, '0')}:00</div>`)
      .join('');

    const dayColumns = days
      .map((d) => {
        const dayClasses = classes.filter((c) => dayjs(c.startsAt).isSame(d, 'day'));
        if (view === 'month') {
          const monthEvents = dayClasses
            .map((c) => {
              const start = dayjs(c.startsAt);
              const isCancelled = c.status === 'CANCELLED';
              const disabled = isCancelled || c.availableSlots <= 0;
              return `
              <button
                type="button"
                class="month-class-chip ${isCancelled ? 'is-cancelled' : ''} ${c.availableSlots <= 0 ? 'is-full' : ''}"
                data-occurrence-id="${c.id}"
                data-class-name="${esc(c.classType.name)}"
                data-trainer="${esc(c.trainer.displayName)}"
                data-location="${esc(c.location.name)}"
                data-start="${start.format('DD MMM HH:mm')}"
                data-cupos="${c.availableSlots}"
                data-status="${c.status}"
                ${disabled ? 'disabled' : ''}
              >
                <span>${start.format('HH:mm')}</span>
                <strong>${esc(c.classType.name)}</strong>
              </button>
              `;
            })
            .join('');

          return `
          <div class="calendar-month-day ${!d.isSame(periodStart, 'month') ? 'is-out-month' : ''}">
            <div class="month-day-number">${d.format('D')}</div>
            <div class="month-day-events">${monthEvents || '<span class="month-empty">Sin clases</span>'}</div>
          </div>
          `;
        }

        const blocks = dayClasses
          .map((c) => {
            const start = dayjs(c.startsAt);
            const end = dayjs(c.endsAt);
            const startMinutes = (start.hour() - startHour) * 60 + start.minute();
            const durationMinutes = Math.max(end.diff(start, 'minute'), 30);
            const top = (startMinutes / 60) * rowHeight;
            const height = Math.max((durationMinutes / 60) * rowHeight, 36);
            const isCancelled = c.status === 'CANCELLED';
            const disabled = isCancelled || c.availableSlots <= 0;
            return `
            <button
              type="button"
              class="calendar-class-block ${isCancelled ? 'is-cancelled' : ''} ${c.availableSlots <= 0 ? 'is-full' : ''}"
              style="top:${top}px;height:${height}px;"
              data-occurrence-id="${c.id}"
              data-class-name="${esc(c.classType.name)}"
              data-trainer="${esc(c.trainer.displayName)}"
              data-location="${esc(c.location.name)}"
              data-start="${start.format('DD MMM HH:mm')}"
              data-cupos="${c.availableSlots}"
              data-status="${c.status}"
              ${disabled ? 'disabled' : ''}
            >
              <strong>${esc(c.classType.name)}</strong>
              <small>${start.format('HH:mm')} · ${esc(c.trainer.displayName)}</small>
              <small>${isCancelled ? 'Clase cancelada' : `${c.availableSlots} cupos`}</small>
            </button>
          `;
          })
          .join('');

        return `
        <div class="calendar-day-column">
          <div class="calendar-day-track" style="height:${trackHeight}px;">
            ${Array.from({ length: totalSlots }, () => '<div class="calendar-hour-line"></div>').join('')}
            ${blocks}
          </div>
        </div>`;
      })
      .join('');

    const body = `<section class="section">
      <div class="calendar-toolbar">
        <h2>Agenda de clases</h2>
        <div class="calendar-toolbar-actions">
          <a class="btn alt" href="/classes?view=${view}&start=${prevStart.format('YYYY-MM-DD')}">Anterior</a>
          <span class="calendar-range">${titleRange}</span>
          <a class="btn alt" href="/classes?view=${view}&start=${nextStart.format('YYYY-MM-DD')}">Siguiente</a>
          <a class="btn ${view === 'week' ? '' : 'alt'}" href="/classes?view=week&start=${periodStart.format('YYYY-MM-DD')}">Semana</a>
          <a class="btn ${view === 'month' ? '' : 'alt'}" href="/classes?view=month&start=${periodStart.format('YYYY-MM-DD')}">Mes</a>
        </div>
      </div>
      <p class="calendar-subtitle">Selecciona cualquier bloque para reservar. Las clases canceladas aparecen bloqueadas.</p>
      <div class="calendar-shell reveal">
        ${
          view === 'month'
            ? `<div class="calendar-month-grid">${dayColumns}</div>`
            : `<div class="calendar-grid-header">
                <div class="calendar-time-head">Hora</div>
                ${dayHeaders}
              </div>
              <div class="calendar-grid-body">
                <div class="calendar-time-col">${timeLabels}</div>
                ${dayColumns || '<div class="card">No hay clases próximas.</div>'}
              </div>`
        }
      </div>

      <dialog id="booking-modal" class="booking-modal">
        <div class="booking-modal-card">
          <button type="button" class="booking-close" data-close-booking>&times;</button>
          <h3 id="booking-title">Reservar clase</h3>
          <p id="booking-meta"></p>
          <p id="booking-seats"></p>
          <form action="/magic-link/request" method="post" id="booking-form">
            <input type="hidden" name="occurrenceId" id="booking-occurrence-id" />
            <div class="form-row">
              <label>Email cliente</label>
              <input type="email" name="email" required />
            </div>
            <button class="btn" type="submit">Reservar con email mágico</button>
          </form>
        </div>
      </dialog>
    </section>`;
    res.send(renderLayout({ title: 'Clases', body, simulationMode: config.simulationMode }));
  });

  app.post('/magic-link/request', async (req, res) => {
    const schema = z.object({ email: z.string().email(), occurrenceId: z.string().min(8) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).send(renderError('Datos inválidos para crear magic link.'));

    const { email, occurrenceId } = parsed.data;
    const occurrence = await prisma.class_occurrences.findUnique({ where: { id: occurrenceId } });
    if (!occurrence) return res.status(404).send(renderError('Clase no encontrada.'));
    if (occurrence.status === 'CANCELLED') return res.status(409).send(renderError('Esta clase fue cancelada por el trainer.'));
    if (occurrence.availableSlots <= 0) return res.status(409).send(renderError('Clase sin cupo disponible.'));

    const client = await prisma.clients.upsert({
      where: { email },
      update: {},
      create: { email, fullName: email.split('@')[0] },
    });

    const token = createToken();
    const tokenHash = hashToken(token);
    const expiresAt = dayjs().add(30, 'minute').toDate();
    await prisma.magic_links.create({
      data: {
        clientId: client.id,
        tokenHash,
        purpose: `BOOK:${occurrenceId}`,
        expiresAt,
      },
    });

    const baseUrl = getBaseUrl(req);
    const url = `${baseUrl}/booking/start?token=${token}&occurrenceId=${occurrenceId}`;
    console.log(`[magic-link] send to ${email}: ${url}`);

    const body = `
      <section class="section">
        <div class="card">
          <h2>Link enviado</h2>
          <p>Se generó un magic link. En simulación, úsalo directo:</p>
          <p><a class="btn" href="${url}">Abrir enlace mágico</a></p>
        </div>
      </section>
    `;
    res.send(renderLayout({ title: 'Magic Link', body, simulationMode: config.simulationMode }));
  });

  app.get('/booking/start', async (req, res) => {
    const token = String(req.query.token || '');
    const occurrenceId = String(req.query.occurrenceId || '');
    const found = await prisma.magic_links.findUnique({ where: { tokenHash: hashToken(token) }, include: { client: true } });
    if (!found || found.usedAt || dayjs(found.expiresAt).isBefore(dayjs())) {
      return res.status(400).send(renderLayout({ title: 'Token inválido', body: renderError('Token expirado o usado.'), simulationMode: config.simulationMode }));
    }

    const occurrence = await prisma.class_occurrences.findUnique({ where: { id: occurrenceId }, include: { classType: true, trainer: true, location: true } });
    if (!occurrence) return res.status(404).send(renderError('Clase no encontrada'));
    if (occurrence.status === 'CANCELLED') return res.status(409).send(renderError('La clase fue cancelada por el trainer.'));
    if (occurrence.availableSlots <= 0) return res.status(409).send(renderError('La clase ya no tiene cupos disponibles.'));

    const wallet = await prisma.client_wallets.findUnique({ where: { clientId_classTypeId: { clientId: found.clientId, classTypeId: occurrence.classTypeId } } });

    const body = `
      <section class="section"><div class="card">
      <h2>Confirmar reserva</h2>
      <p>Cliente: ${esc(found.client.email)}</p>
      <p>Clase: ${esc(occurrence.classType.name)} · ${dayjs(occurrence.startsAt).format('DD MMM HH:mm')}</p>
      <p>Créditos disponibles: <strong>${wallet?.credits || 0}</strong></p>
      <form action="/bookings" method="post">
        <input type="hidden" name="token" value="${esc(token)}" />
        <input type="hidden" name="occurrenceId" value="${occurrence.id}" />
        <button class="btn" type="submit">Consumir 1 ticket y reservar</button>
      </form>
      <hr />
      <h3>¿Sin créditos?</h3>
      <form action="/checkout/session" method="post">
        <input type="hidden" name="clientId" value="${found.clientId}" />
        <input type="hidden" name="classTypeId" value="${occurrence.classTypeId}" />
        <button class="btn alt" type="submit">Comprar bundle</button>
      </form>
      </div></section>`;

    res.send(renderLayout({ title: 'Booking', body, simulationMode: config.simulationMode }));
  });

  app.post('/checkout/session', async (req, res) => {
    const schema = z.object({ clientId: z.string().min(8), classTypeId: z.string().min(8) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).send(renderError('Datos de checkout inválidos'));

    const { clientId, classTypeId } = parsed.data;
    const product = await prisma.ticket_products.findFirst({ where: { classTypeId, active: true }, orderBy: { bundleSize: 'desc' } });
    if (!product) return res.status(404).send(renderError('No hay bundle activo para este tipo de clase'));

    const payment = await prisma.payments.create({
      data: {
        clientId,
        ticketProductId: product.id,
        amountCents: product.priceCents,
        status: 'CREATED',
      },
    });

    if (stripe && product.stripePriceId) {
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        line_items: [{ price: product.stripePriceId, quantity: 1 }],
        success_url: `${config.appUrl}/checkout/success?paymentId=${payment.id}`,
        cancel_url: `${config.appUrl}/checkout/cancel?paymentId=${payment.id}`,
      });
      await prisma.payments.update({ where: { id: payment.id }, data: { stripeSessionId: session.id } });
      return res.redirect(session.url);
    }

    const wallet = await prisma.client_wallets.upsert({
      where: { clientId_classTypeId: { clientId, classTypeId } },
      update: { credits: { increment: product.bundleSize } },
      create: { clientId, classTypeId, credits: product.bundleSize },
    });

    await prisma.payments.update({ where: { id: payment.id }, data: { status: 'PAID', stripeSessionId: `sim_${payment.id}` } });
    await prisma.wallet_ledger.create({
      data: { walletId: wallet.id, type: 'CREDIT', amount: product.bundleSize, reason: 'Compra simulada', paymentId: payment.id },
    });

    res.redirect(`/checkout/success?paymentId=${payment.id}`);
  });

  app.get('/checkout/success', async (req, res) => {
    const paymentId = String(req.query.paymentId || '');
    const payment = await prisma.payments.findUnique({ where: { id: paymentId }, include: { ticketProduct: true, client: true } });
    if (!payment) return res.status(404).send(renderError('Pago no encontrado'));
    const body = `<section class="section"><div class="card"><h2>Pago exitoso</h2><p>${esc(payment.client.email)} compró ${esc(payment.ticketProduct.name)}</p><p><a class="btn" href="/classes">Volver a clases</a></p></div></section>`;
    res.send(renderLayout({ title: 'Pago exitoso', body, simulationMode: config.simulationMode }));
  });

  app.get('/checkout/cancel', (req, res) => {
    const body = `<section class="section"><div class="card"><h2>Pago cancelado</h2><p>No se aplicaron cambios.</p></div></section>`;
    res.send(renderLayout({ title: 'Pago cancelado', body, simulationMode: config.simulationMode }));
  });

  app.post('/bookings', async (req, res) => {
    const schema = z.object({ token: z.string().min(10), occurrenceId: z.string().min(8) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).send(renderError('Request de booking inválido'));

    const { token, occurrenceId } = parsed.data;
    const link = await prisma.magic_links.findUnique({ where: { tokenHash: hashToken(token) }, include: { client: true } });
    if (!link || link.usedAt || dayjs(link.expiresAt).isBefore(dayjs())) return res.status(400).send(renderError('Magic link inválido'));

    const occurrence = await prisma.class_occurrences.findUnique({ where: { id: occurrenceId } });
    if (!occurrence) return res.status(404).send(renderError('Clase no encontrada'));
    if (occurrence.status === 'CANCELLED') return res.status(409).send(renderError('La clase fue cancelada por el trainer.'));
    if (occurrence.availableSlots <= 0) return res.status(409).send(renderError('Clase sin cupo'));

    const wallet = await prisma.client_wallets.findUnique({ where: { clientId_classTypeId: { clientId: link.clientId, classTypeId: occurrence.classTypeId } } });
    if (!wallet || wallet.credits <= 0) return res.status(409).send(renderError('No hay tickets disponibles para esta clase'));

    const already = await prisma.bookings.findFirst({ where: { clientId: link.clientId, classOccurrenceId: occurrence.id, status: 'BOOKED' } });
    if (already) return res.status(409).send(renderError('Ya existe booking activo para esta clase'));

    const bookingRef = makeBookingRef();
    const qrPayloadObj = {
      booking_ref: bookingRef,
      occurrence_id: occurrence.id,
      client_ref: link.clientId,
      expires_at: dayjs(occurrence.endsAt).toISOString(),
    };
    const qrPayload = JSON.stringify(qrPayloadObj);
    const qrSignature = signPayload(qrPayload, QR_SECRET);

    const booking = await prisma.$transaction(async (tx) => {
      const created = await tx.bookings.create({
        data: {
          bookingRef,
          clientId: link.clientId,
          classOccurrenceId: occurrence.id,
          qrPayload,
          qrSignature,
          status: 'BOOKED',
        },
      });
      await tx.client_wallets.update({ where: { id: wallet.id }, data: { credits: { decrement: 1 } } });
      await tx.wallet_ledger.create({ data: { walletId: wallet.id, type: 'DEBIT', amount: -1, reason: 'Reserva confirmada', bookingId: created.id } });
      await tx.class_occurrences.update({ where: { id: occurrence.id }, data: { availableSlots: { decrement: 1 } } });
      await tx.magic_links.update({ where: { id: link.id }, data: { usedAt: new Date() } });
      return created;
    });

    const qrDataUrl = await QRCode.toDataURL(JSON.stringify({ ...qrPayloadObj, signature: qrSignature }));
    const bookingUrlToken = createToken();
    await prisma.magic_links.create({
      data: {
        clientId: link.clientId,
        tokenHash: hashToken(bookingUrlToken),
        purpose: `BOOKING_ACCESS:${booking.id}`,
        expiresAt: dayjs().add(20, 'day').toDate(),
      },
    });

    const bookingUrl = `${config.appUrl}/booking/manage?token=${bookingUrlToken}&bookingId=${booking.id}`;

    const body = `<section class="section"><div class="card"><h2>Reserva confirmada</h2><p>Referencia: <strong>${booking.bookingRef}</strong></p><img class="qr" src="${qrDataUrl}" alt="QR" /><p><a class="btn" href="${bookingUrl}">Ver detalle de reserva</a></p></div></section>`;
    res.send(renderLayout({ title: 'Reserva confirmada', body, simulationMode: config.simulationMode }));
  });

  app.get('/booking/manage', async (req, res) => {
    const token = String(req.query.token || '');
    const bookingId = String(req.query.bookingId || '');
    const link = await prisma.magic_links.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!link || dayjs(link.expiresAt).isBefore(dayjs())) return res.status(400).send(renderError('Acceso inválido'));
    if (!link.purpose.includes(bookingId)) return res.status(403).send(renderError('Token no corresponde a la reserva'));

    const booking = await prisma.bookings.findUnique({
      where: { id: bookingId },
      include: { classOccurrence: { include: { classType: true, trainer: true, location: true } }, client: true },
    });

    if (!booking) return res.status(404).send(renderError('Reserva no encontrada'));
    const qrDataUrl = await QRCode.toDataURL(JSON.stringify({ ...JSON.parse(booking.qrPayload), signature: booking.qrSignature }));

    const body = `<section class="section"><div class="card"><h2>Tu booking</h2>
      <p>${esc(booking.client.email)}</p>
      <p>${esc(booking.classOccurrence.classType.name)} con ${esc(booking.classOccurrence.trainer.displayName)}</p>
      <p>Estado: ${booking.status}</p>
      <img class="qr" src="${qrDataUrl}" alt="QR" />
      ${booking.status === 'BOOKED' ? `<form method="post" action="/bookings/${booking.id}/cancel"><button class="btn alt" type="submit">Cancelar reserva</button></form>` : ''}
    </div></section>`;
    res.send(renderLayout({ title: 'Gestionar reserva', body, simulationMode: config.simulationMode }));
  });

  app.post('/bookings/:id/cancel', async (req, res) => {
    const booking = await prisma.bookings.findUnique({ where: { id: req.params.id }, include: { classOccurrence: true } });
    if (!booking || booking.status !== 'BOOKED') return res.status(404).send(renderError('Booking no cancelable'));

    const cutoff = dayjs(booking.classOccurrence.startsAt).subtract(2, 'hour');
    const eligibleRefund = dayjs().isBefore(cutoff);

    await prisma.$transaction(async (tx) => {
      await tx.bookings.update({ where: { id: booking.id }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
      await tx.class_occurrences.update({ where: { id: booking.classOccurrenceId }, data: { availableSlots: { increment: 1 } } });

      if (eligibleRefund) {
        const wallet = await tx.client_wallets.findUnique({ where: { clientId_classTypeId: { clientId: booking.clientId, classTypeId: booking.classOccurrence.classTypeId } } });
        if (wallet) {
          await tx.client_wallets.update({ where: { id: wallet.id }, data: { credits: { increment: 1 } } });
          await tx.wallet_ledger.create({ data: { walletId: wallet.id, type: 'REFUND', amount: 1, reason: 'Cancelación en ventana válida', bookingId: booking.id } });
        }
      }
    });

    res.redirect('/classes');
  });

  app.get('/staff/login', (req, res) => {
    const body = `<section class="section"><div class="card"><h2>Ingreso staff</h2>
      <form method="post" action="/staff/login">
        <div class="form-row"><label>Email</label><input type="email" name="email" required /></div>
        <div class="form-row"><label>Password</label><input type="password" name="password" required /></div>
        <button class="btn" type="submit">Entrar</button>
      </form>
    </div></section>`;
    res.send(renderLayout({ title: 'Staff Login', body, simulationMode: config.simulationMode }));
  });

  app.post('/staff/login', async (req, res) => {
    const schema = z.object({ email: z.string().email(), password: z.string().min(4) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).send(renderError('Credenciales inválidas'));

    const staff = await prisma.staff_users.findUnique({ where: { email: parsed.data.email } });
    if (!staff) return res.status(401).send(renderError('Usuario no encontrado'));
    const ok = await bcrypt.compare(parsed.data.password, staff.passwordHash);
    if (!ok) return res.status(401).send(renderError('Password incorrecto'));

    req.session.staffId = staff.id;
    req.session.staffRole = staff.role;
    req.session.staffName = staff.displayName;

    if (staff.role === 'TRAINER') return res.redirect('/trainer/classes');
    if (staff.role === 'OPS') return res.redirect('/ops/checkin');
    return res.redirect('/admin/dashboard');
  });

  app.post('/staff/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/'));
  });

  app.get('/admin/dashboard', requireStaff, requireRole('ADMIN'), async (req, res) => {
    const [bookings, clients, paid, classes] = await Promise.all([
      prisma.bookings.count({ where: { status: 'BOOKED' } }),
      prisma.clients.count(),
      prisma.payments.count({ where: { status: 'PAID' } }),
      prisma.class_occurrences.count({ where: { startsAt: { gte: new Date(dayjs().startOf('day').toISOString()) } } }),
    ]);

    const topClasses = await prisma.class_occurrences.findMany({
      take: 6,
      include: { classType: true, trainer: true },
      orderBy: { startsAt: 'asc' },
    });

    const rows = topClasses.map((c) => `<tr><td>${esc(c.classType.name)}</td><td>${esc(c.trainer.displayName)}</td><td>${c.capacity - c.availableSlots}/${c.capacity}</td></tr>`).join('');

    const body = `<section class="section"><div class="grid">
      <div class="card"><h3>Bookings activos</h3><div class="metric">${bookings}</div></div>
      <div class="card"><h3>Clientes</h3><div class="metric">${clients}</div></div>
      <div class="card"><h3>Pagos aprobados</h3><div class="metric">${paid}</div></div>
      <div class="card"><h3>Clases próximas</h3><div class="metric">${classes}</div></div>
    </div>
    <div class="card"><h3>Ocupación</h3><table class="table"><thead><tr><th>Clase</th><th>Trainer</th><th>Ocupación</th></tr></thead><tbody>${rows}</tbody></table></div>
    </section>`;

    res.send(renderLayout({ title: 'Admin Dashboard', body, staff: req.session.staffName, simulationMode: config.simulationMode }));
  });

  app.get('/trainer/classes', requireStaff, requireRole('TRAINER'), async (req, res) => {
    const view = String(req.query.view || 'week') === 'month' ? 'month' : 'week';
    const requestedStart = req.query.start ? dayjs(String(req.query.start)) : dayjs();
    const periodStart = view === 'month' ? dayjs(requestedStart).startOf('month') : startOfWeekMonday(requestedStart);
    const periodEnd = view === 'month' ? dayjs(periodStart).endOf('month').add(7, 'day') : dayjs(periodStart).add(7, 'day');

    const [classes, classTypes, locations] = await Promise.all([
      prisma.class_occurrences.findMany({
        where: {
          trainerId: req.session.staffId,
          startsAt: {
            gte: new Date(periodStart.startOf('day').toISOString()),
            lt: new Date(periodEnd.endOf('day').toISOString()),
          },
        },
        include: { classType: true, location: true, bookings: { where: { status: 'BOOKED' }, include: { client: true } } },
        orderBy: { startsAt: 'asc' },
        take: 200,
      }),
      prisma.class_types.findMany({ orderBy: { name: 'asc' } }),
      prisma.locations.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } }),
    ]);

    const days =
      view === 'month'
        ? Array.from({ length: 42 }, (_, i) => startOfWeekMonday(periodStart).add(i, 'day'))
        : Array.from({ length: 7 }, (_, i) => startOfWeekMonday(periodStart).add(i, 'day'));
    const prevStart = view === 'month' ? periodStart.subtract(1, 'month') : periodStart.subtract(7, 'day');
    const nextStart = view === 'month' ? periodStart.add(1, 'month') : periodStart.add(7, 'day');
    const titleRange =
      view === 'month'
        ? periodStart.format('MMMM YYYY')
        : `${periodStart.format('DD MMM')} - ${periodStart.add(6, 'day').format('DD MMM YYYY')}`;

    const startHour = 6;
    const endHour = 22;
    const totalSlots = endHour - startHour;
    const rowHeight = 78;
    const trackHeight = totalSlots * rowHeight;

    const dayHeaders = days
      .map((d) => `<div class="calendar-day-head"><span>${d.format('ddd').toUpperCase()}</span><strong>${d.format(view === 'month' ? 'DD' : 'DD MMM')}</strong></div>`)
      .join('');
    const timeLabels = Array.from({ length: totalSlots }, (_, idx) => startHour + idx)
      .map((hour) => `<div class="calendar-time-label">${String(hour).padStart(2, '0')}:00</div>`)
      .join('');

    const trainerColumns = days
      .map((d) => {
        const dayClasses = classes.filter((c) => dayjs(c.startsAt).isSame(d, 'day'));
        if (view === 'month') {
          const events = dayClasses
            .map((c) => {
              const start = dayjs(c.startsAt);
              return `<button type="button" class="month-class-chip trainer-chip ${c.status === 'CANCELLED' ? 'is-cancelled' : ''}"
                data-trainer-occurrence-id="${c.id}"
                data-trainer-class="${esc(c.classType.name)}"
                data-trainer-time="${start.format('DD MMM HH:mm')}"
                data-trainer-status="${c.status}"
                data-trainer-bookings="${c.bookings.length}"
                data-trainer-cancelable="${(c.status !== 'CANCELLED' && start.isAfter(dayjs())) ? '1' : '0'}"
              >
                <span>${start.format('HH:mm')}</span>
                <strong>${esc(c.classType.name)}</strong>
              </button>`;
            })
            .join('');
          return `<div class="calendar-month-day ${!d.isSame(periodStart, 'month') ? 'is-out-month' : ''}">
            <div class="month-day-number">${d.format('D')}</div>
            <div class="month-day-events">${events || '<span class="month-empty">Sin clases</span>'}</div>
          </div>`;
        }

        const blocks = dayClasses
          .map((c) => {
            const start = dayjs(c.startsAt);
            const end = dayjs(c.endsAt);
            const top = (((start.hour() - startHour) * 60 + start.minute()) / 60) * rowHeight;
            const height = Math.max((Math.max(end.diff(start, 'minute'), 30) / 60) * rowHeight, 36);
            return `<button type="button"
              class="calendar-class-block trainer-chip ${c.status === 'CANCELLED' ? 'is-cancelled' : ''}"
              style="top:${top}px;height:${height}px;"
              data-trainer-occurrence-id="${c.id}"
              data-trainer-class="${esc(c.classType.name)}"
              data-trainer-time="${start.format('DD MMM HH:mm')}"
              data-trainer-status="${c.status}"
              data-trainer-bookings="${c.bookings.length}"
              data-trainer-cancelable="${(c.status !== 'CANCELLED' && start.isAfter(dayjs())) ? '1' : '0'}"
            >
              <strong>${esc(c.classType.name)}</strong>
              <small>${start.format('HH:mm')} · ${c.bookings.length} reservas</small>
              <small>${c.status === 'CANCELLED' ? 'Cancelada' : 'Programada'}</small>
            </button>`;
          })
          .join('');

        return `<div class="calendar-day-column"><div class="calendar-day-track" style="height:${trackHeight}px;">
          ${Array.from({ length: totalSlots }, () => '<div class="calendar-hour-line"></div>').join('')}
          ${blocks}
        </div></div>`;
      })
      .join('');

    const classTypeOptions = classTypes.map((t) => `<option value="${t.id}">${esc(t.name)} (${t.durationMin} min)</option>`).join('');
    const locationOptions = locations.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('');

    const body = `<section class="section">
      <div class="calendar-toolbar">
        <h2>Mis clases</h2>
        <div class="calendar-toolbar-actions">
          <a class="btn alt" href="/trainer/classes?view=${view}&start=${prevStart.format('YYYY-MM-DD')}">Anterior</a>
          <span class="calendar-range">${titleRange}</span>
          <a class="btn alt" href="/trainer/classes?view=${view}&start=${nextStart.format('YYYY-MM-DD')}">Siguiente</a>
          <a class="btn ${view === 'week' ? '' : 'alt'}" href="/trainer/classes?view=week&start=${periodStart.format('YYYY-MM-DD')}">Semana</a>
          <a class="btn ${view === 'month' ? '' : 'alt'}" href="/trainer/classes?view=month&start=${periodStart.format('YYYY-MM-DD')}">Mes</a>
        </div>
      </div>
      <div class="card trainer-create-card">
        <h3>Crear nueva clase</h3>
        <form method="post" action="/trainer/classes">
          <div class="grid">
            <div class="form-row"><label>Tipo de clase</label><select name="classTypeId" required>${classTypeOptions}</select></div>
            <div class="form-row"><label>Sede</label><select name="locationId" required>${locationOptions}</select></div>
            <div class="form-row"><label>Fecha</label><input type="date" name="date" required /></div>
            <div class="form-row"><label>Hora inicio</label><input type="time" name="startTime" required /></div>
            <div class="form-row"><label>Duración (min)</label><input type="number" name="durationMin" min="30" max="180" value="60" required /></div>
            <div class="form-row"><label>Cupo</label><input type="number" name="capacity" min="1" max="80" value="18" required /></div>
          </div>
          <button class="btn" type="submit">Crear clase</button>
        </form>
      </div>
      <div class="calendar-shell reveal">
        ${
          view === 'month'
            ? `<div class="calendar-month-grid">${trainerColumns}</div>`
            : `<div class="calendar-grid-header"><div class="calendar-time-head">Hora</div>${dayHeaders}</div>
               <div class="calendar-grid-body"><div class="calendar-time-col">${timeLabels}</div>${trainerColumns}</div>`
        }
      </div>
      <dialog id="trainer-class-modal" class="booking-modal">
        <div class="booking-modal-card">
          <button type="button" class="booking-close" data-close-trainer-modal>&times;</button>
          <h3 id="trainer-modal-title">Clase</h3>
          <p id="trainer-modal-meta"></p>
          <p id="trainer-modal-status"></p>
          <form method="post" id="trainer-cancel-form">
            <button class="btn alt" type="submit" id="trainer-cancel-btn">Cancelar clase</button>
          </form>
        </div>
      </dialog>
    </section>`;
    res.send(renderLayout({ title: 'Trainer', body, staff: req.session.staffName, simulationMode: config.simulationMode }));
  });

  app.post('/trainer/classes', requireStaff, requireRole('TRAINER'), async (req, res) => {
    const schema = z.object({
      classTypeId: z.string().min(8),
      locationId: z.string().min(8),
      date: z.string().min(10),
      startTime: z.string().min(4),
      durationMin: z.coerce.number().int().min(30).max(180),
      capacity: z.coerce.number().int().min(1).max(80),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).send(renderError('Datos inválidos para crear clase.'));

    const { classTypeId, locationId, date, startTime, durationMin, capacity } = parsed.data;
    const startsAt = dayjs(`${date}T${startTime}`);
    if (!startsAt.isValid()) return res.status(400).send(renderError('Fecha u hora inválida.'));
    if (startsAt.isBefore(dayjs().subtract(5, 'minute'))) return res.status(400).send(renderError('No se puede crear una clase en el pasado.'));

    const endsAt = startsAt.add(durationMin, 'minute');
    await prisma.class_occurrences.create({
      data: {
        locationId,
        classTypeId,
        trainerId: req.session.staffId,
        startsAt: startsAt.toDate(),
        endsAt: endsAt.toDate(),
        capacity,
        availableSlots: capacity,
        status: 'SCHEDULED',
      },
    });

    res.redirect('/trainer/classes');
  });

  app.post('/trainer/classes/:id/cancel', requireStaff, requireRole('TRAINER'), async (req, res) => {
    const occurrence = await prisma.class_occurrences.findUnique({
      where: { id: req.params.id },
      include: { bookings: { where: { status: 'BOOKED' } } },
    });
    if (!occurrence || occurrence.trainerId !== req.session.staffId) {
      return res.status(404).send(renderError('Clase no encontrada para este trainer.'));
    }
    if (occurrence.status === 'CANCELLED') return res.redirect('/trainer/classes');

    await prisma.$transaction(async (tx) => {
      await tx.class_occurrences.update({
        where: { id: occurrence.id },
        data: { status: 'CANCELLED', availableSlots: 0 },
      });

      if (occurrence.bookings.length > 0) {
        await tx.bookings.updateMany({
          where: { classOccurrenceId: occurrence.id, status: 'BOOKED' },
          data: { status: 'CANCELLED', cancelledAt: new Date() },
        });

        for (const booking of occurrence.bookings) {
          const wallet = await tx.client_wallets.findUnique({
            where: { clientId_classTypeId: { clientId: booking.clientId, classTypeId: occurrence.classTypeId } },
          });
          if (wallet) {
            await tx.client_wallets.update({ where: { id: wallet.id }, data: { credits: { increment: 1 } } });
            await tx.wallet_ledger.create({
              data: {
                walletId: wallet.id,
                type: 'REFUND',
                amount: 1,
                reason: 'Clase cancelada por trainer',
                bookingId: booking.id,
              },
            });
          }
        }
      }
    });

    res.redirect('/trainer/classes');
  });

  app.get('/ops/checkin', requireStaff, requireRole('OPS', 'ADMIN'), (req, res) => {
    const body = `<section class="section"><div class="card"><h2>Check-in operativo</h2>
      <p>Escanea QR con cámara o pega payload manual.</p>
      <div id="reader" style="width:100%;max-width:420px"></div>
      <form method="post" action="/ops/checkin/scan">
        <div class="form-row"><label>Payload QR o JSON</label><textarea name="payload" rows="5" required></textarea></div>
        <button class="btn" type="submit">Validar acceso</button>
      </form>
      <script src="https://unpkg.com/html5-qrcode"></script>
      <script>
        const out = document.querySelector('textarea[name="payload"]');
        if (window.Html5QrcodeScanner) {
          const scanner = new Html5QrcodeScanner('reader', { fps: 10, qrbox: 220 });
          scanner.render((text) => { out.value = text; }, () => {});
        }
      </script>
    </div></section>`;
    res.send(renderLayout({ title: 'Ops Check-in', body, staff: req.session.staffName, simulationMode: config.simulationMode }));
  });

  app.post('/ops/checkin/scan', requireStaff, requireRole('OPS', 'ADMIN'), async (req, res) => {
    let payload;
    try {
      payload = JSON.parse(String(req.body.payload || '{}'));
    } catch {
      return res.status(400).send(renderError('El payload no es JSON válido'));
    }

    const { booking_ref, occurrence_id, client_ref, expires_at, signature } = payload;
    if (!booking_ref || !occurrence_id || !client_ref || !signature) {
      return res.status(400).send(renderError('Payload incompleto para check-in'));
    }

    const signedContent = JSON.stringify({ booking_ref, occurrence_id, client_ref, expires_at });
    const expected = signPayload(signedContent, QR_SECRET);
    if (signature !== expected) return res.status(400).send(renderError('Firma QR inválida'));

    if (dayjs(expires_at).isBefore(dayjs())) return res.status(400).send(renderError('QR expirado'));

    const booking = await prisma.bookings.findUnique({ where: { bookingRef: booking_ref }, include: { classOccurrence: true } });
    if (!booking || booking.classOccurrenceId !== occurrence_id || booking.clientId !== client_ref) {
      return res.status(404).send(renderError('Booking no coincide con payload'));
    }
    if (booking.status === 'CHECKED_IN') return res.status(409).send(renderError('Cliente ya ingresó'));
    if (booking.status !== 'BOOKED') return res.status(409).send(renderError('Booking no está activo'));

    const classStart = dayjs(booking.classOccurrence.startsAt);
    const classEnd = dayjs(booking.classOccurrence.endsAt);
    const now = dayjs();
    if (now.isBefore(classStart.subtract(30, 'minute')) || now.isAfter(classEnd.add(20, 'minute'))) {
      return res.status(409).send(renderError('Fuera de ventana de check-in'));
    }

    await prisma.$transaction(async (tx) => {
      await tx.bookings.update({ where: { id: booking.id }, data: { status: 'CHECKED_IN', checkedInAt: new Date() } });
      await tx.checkins.create({ data: { bookingId: booking.id, staffId: req.session.staffId, method: 'QR_CAMERA_OR_MANUAL' } });
    });

    const body = `<section class="section"><div class="card"><h2>Acceso autorizado</h2><p>Ref: ${booking.bookingRef}</p><a class="btn" href="/ops/checkin">Validar otro</a></div></section>`;
    res.send(renderLayout({ title: 'Check-in OK', body, staff: req.session.staffName, simulationMode: config.simulationMode }));
  });

  app.get('/health', (req, res) => res.json({ status: 'ok', app: 'goyo-yoga-app' }));

  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).send(renderLayout({ title: 'Error', body: renderError(err.message || 'Error interno'), simulationMode: config.simulationMode }));
  });

  return app;
}
