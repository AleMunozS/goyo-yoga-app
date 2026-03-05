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
    const types = await prisma.class_types.findMany({ orderBy: { name: 'asc' }, take: 4 });
    const typeCards = types.map((t) => `
      <article class="card reveal">
        <h3>${esc(t.name)}</h3>
        <p>${esc(t.description)}</p>
        <span class="status-pill">${esc(t.intensity)} · ${t.durationMin} min</span>
      </article>
    `).join('');

    const body = `
      <section class="hero parallax">
        <div class="hero-card reveal">
          <h1>Tu energía, tu ritmo, tu clase.</h1>
          <p>Compra tickets por tipo de clase, reserva en segundos y llega con tu QR listo.</p>
          <div style="display:flex;gap:.7rem;flex-wrap:wrap;margin-top:.9rem;">
            <a class="btn" href="/classes">Explorar clases</a>
            <a class="btn alt" href="/staff/login">Portal staff</a>
          </div>
        </div>
      </section>
      <section class="section">
        <h2 class="reveal">Experiencias GOYO</h2>
        <div class="grid">${typeCards}</div>
      </section>
    `;

    res.send(renderLayout({ title: 'Inicio', body, simulationMode: config.simulationMode }));
  });

  app.get('/classes', async (req, res) => {
    const classes = await prisma.class_occurrences.findMany({
      include: { classType: true, trainer: true, location: true },
      orderBy: { startsAt: 'asc' },
      take: 30,
      where: { startsAt: { gte: new Date(dayjs().startOf('day').toISOString()) } },
    });
    const items = classes.map((c) => {
      const start = dayjs(c.startsAt).format('DD MMM HH:mm');
      return `
      <article class="card reveal">
        <h3>${esc(c.classType.name)}</h3>
        <p>${esc(c.location.name)} · ${esc(c.trainer.displayName)}</p>
        <p><strong>${start}</strong></p>
        <p>Cupos disponibles: <span class="metric">${c.availableSlots}</span></p>
        <form action="/magic-link/request" method="post">
          <input type="hidden" name="occurrenceId" value="${c.id}" />
          <div class="form-row">
            <label>Email cliente</label>
            <input type="email" name="email" required />
          </div>
          <button class="btn" type="submit">Reservar con email mágico</button>
        </form>
      </article>`;
    }).join('');

    const body = `<section class="section"><h2>Agenda de clases</h2><div class="grid">${items || '<div class="card">No hay clases próximas.</div>'}</div></section>`;
    res.send(renderLayout({ title: 'Clases', body, simulationMode: config.simulationMode }));
  });

  app.post('/magic-link/request', async (req, res) => {
    const schema = z.object({ email: z.string().email(), occurrenceId: z.string().min(8) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).send(renderError('Datos inválidos para crear magic link.'));

    const { email, occurrenceId } = parsed.data;
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

    const url = `${config.appUrl}/booking/start?token=${token}&occurrenceId=${occurrenceId}`;
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
    const classes = await prisma.class_occurrences.findMany({
      where: { trainerId: req.session.staffId, startsAt: { gte: new Date(dayjs().subtract(1, 'day').toISOString()) } },
      include: { classType: true, bookings: { where: { status: 'BOOKED' }, include: { client: true } } },
      orderBy: { startsAt: 'asc' },
      take: 20,
    });

    const cards = classes.map((c) => {
      const attendees = c.bookings.map((b) => `<li>${esc(b.client.fullName)} (${esc(b.client.email)})</li>`).join('');
      return `<article class="card"><h3>${esc(c.classType.name)} · ${dayjs(c.startsAt).format('DD MMM HH:mm')}</h3><p>Asistencia prevista: ${c.bookings.length}</p><ul>${attendees || '<li>Sin reservas</li>'}</ul></article>`;
    }).join('');

    const body = `<section class="section"><h2>Mis clases</h2>${cards || '<div class="card">No tienes clases asignadas.</div>'}</section>`;
    res.send(renderLayout({ title: 'Trainer', body, staff: req.session.staffName, simulationMode: config.simulationMode }));
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
