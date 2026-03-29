import express from 'express';
import session from 'express-session';
import morgan from 'morgan';
import dayjs from 'dayjs';
import bcrypt from 'bcryptjs';
import QRCode from 'qrcode';
import Stripe from 'stripe';
import { z } from 'zod';
import { fileURLToPath } from 'url';
import { renderLayout } from './views/layout.js';
import { config } from './config.js';
import { createToken, esc, hashToken, makeBookingRef, signPayload } from './utils.js';
import { sendBookingConfirmationEmail, sendMagicLinkEmail } from './mailer.js';
import {
  MAX_LAYOUT_CAPACITY,
  MAX_SEATS_PER_BOOKING,
  describeSeatCodes,
  formatSeatLabels,
  getSeatLayout,
  validateSeatSelection,
} from './seats.js';

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

function parseJson(value, fallback = null) {
  if (!value) return fallback;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function getMagicLinkContext(link) {
  return parseJson(link?.contextJson, {}) || {};
}

function getBookingStateLabel(status) {
  if (status === 'BOOKED') return 'Confirmada';
  if (status === 'CANCELLED') return 'Cancelada';
  if (status === 'CHECKED_IN') return 'Check-in completo';
  return status;
}

function buildSeatSelectionUrl(occurrenceId, params = {}) {
  const search = new URLSearchParams({ occurrenceId });
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, String(value));
  }
  return `/booking/seats?${search.toString()}`;
}

function renderSeatSelectionBody({ occurrence, occupiedSeatCodes, selectedSeatCodes = [], email = '', message = '', messageType = 'error' }) {
  const layout = getSeatLayout(occurrence.capacity);
  if (!layout.supported) {
    return `<section class="section"><div class="system-shell">${renderError(layout.error)}</div></section>`;
  }

  const selectedSet = new Set(selectedSeatCodes);
  const occupiedSet = new Set(occupiedSeatCodes);
  const enabledSeats = layout.seats.filter((seat) => seat.enabled);
  const availableCount = enabledSeats.filter((seat) => !occupiedSet.has(seat.code)).length;
  const selectedSummary = formatSeatLabels(selectedSeatCodes, occurrence.capacity);
  const zoneOrder = ['near', 'middle', 'back'];
  const zoneSections = zoneOrder
    .map((zone) => {
      const zoneRows = layout.rows.filter(({ seats }) => seats[0]?.zone === zone);
      if (!zoneRows.length) return '';

      return `
        <section class="seat-zone-section" data-seat-zone="${zone}">
          <p class="seat-zone-kicker">${zone === 'near' ? 'Frente' : zone === 'middle' ? 'Centro' : 'Parte trasera'}</p>
          ${zoneRows
            .map(
              ({ row, seats }) => `
                <div class="seat-row" data-seat-row="${row}" data-seat-count="${seats.length}" data-seat-zone="${zone}">
                  <span class="seat-row-label">${row}</span>
                  <div class="seat-row-seats">
                    ${seats
                      .map((seat) => {
                        const isOccupied = occupiedSet.has(seat.code);
                        const isSelected = selectedSet.has(seat.code);
                        const disabled = isOccupied || !seat.enabled;
                        const stateClass = isOccupied ? 'is-occupied' : !seat.enabled ? 'is-disabled' : isSelected ? 'is-selected' : 'is-available';
                        return `
                          <label class="seat-pill ${stateClass}" data-seat-option="${seat.code}">
                            <input
                              type="checkbox"
                              name="seatCodes"
                              value="${seat.code}"
                              data-seat-zone="${seat.zone}"
                              ${isSelected ? 'checked' : ''}
                              ${disabled ? 'disabled' : ''}
                            />
                            <span>${seat.label}</span>
                          </label>
                        `;
                      })
                      .join('')}
                  </div>
                </div>
              `
            )
            .join('')}
        </section>
      `;
    })
    .join('');

  return `
    <section class="section seat-selection-page">
      <div class="system-shell">
        <section class="system-hero scroll-hero" data-scroll-target="seat-selection-grid">
          <p class="concept-kicker">TISA / LUGARES</p>
          <h1>Elige tu lugar antes de pedir el acceso.</h1>
          <p>Selecciona uno o dos lugares exactos, revisa cuáles ya están ocupados y después deja tu correo para recibir el enlace privado y cerrar la reserva.</p>
        </section>
        <div class="system-grid seat-selection-grid" id="seat-selection-grid">
          <article class="system-panel system-panel-light">
            <h2>${esc(occurrence.classType.name)}</h2>
            <div class="system-detail-list">
              <div><span>Horario</span><strong>${dayjs(occurrence.startsAt).format('DD MMM · HH:mm')}</strong></div>
              <div><span>Guía</span><strong>${esc(occurrence.trainer.displayName)}</strong></div>
              <div><span>Estudio</span><strong>${esc(occurrence.location.name)}</strong></div>
              <div><span>Mapa</span><strong>${enabledSeats.length} lugares habilitados · ${availableCount} disponibles</strong></div>
            </div>
            <div class="seat-legend">
              <span class="legend seat-available">Disponible</span>
              <span class="legend seat-selected">Seleccionado</span>
              <span class="legend seat-occupied">Ocupado</span>
            </div>
            <div class="seat-zone-copy">
              <span>Cerca de la instructora</span>
              <span>Zona media</span>
              <span>Parte trasera</span>
            </div>
          </article>
          <article class="system-panel system-panel-dark">
            <form action="/magic-link/request" method="post" id="seat-selection-form" class="seat-selection-form">
              <input type="hidden" name="occurrenceId" value="${occurrence.id}" />
              <div class="seat-stage">
                <div class="seat-stage-guide">Instructora</div>
                <div class="seat-map">
                  ${zoneSections}
                </div>
              </div>
              <div class="ui-status-banner ${message ? `is-${messageType === 'success' ? 'success' : 'cancel'}` : 'is-muted'} seat-status-banner">
                <div>
                  <p class="concept-kicker">Selección</p>
                  <h3 id="seat-selection-count">${selectedSeatCodes.length} de ${MAX_SEATS_PER_BOOKING} lugares elegidos</h3>
                  <p id="seat-selection-summary">${selectedSummary || 'Selecciona uno o dos lugares para continuar.'}</p>
                  ${message ? `<p class="seat-inline-message">${esc(message)}</p>` : ''}
                </div>
              </div>
              <div class="form-row">
                <label>Correo para recibir tu acceso</label>
                <input type="email" name="email" value="${esc(email)}" placeholder="tu@correo.com" required />
              </div>
              <button class="btn" type="submit">Enviar enlace mágico</button>
              <a class="btn alt" href="/classes">Volver a la agenda</a>
            </form>
          </article>
        </div>
      </div>
    </section>
  `;
}

const publicDir = fileURLToPath(new URL('./public', import.meta.url));

export function createApp({ prisma }) {
  const app = express();
  const stripe = config.stripeSecretKey ? new Stripe(config.stripeSecretKey) : null;

  app.use(morgan('dev'));
  app.use('/static', express.static(publicDir));
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

    const stats = {
      classTypes: types.length,
      upcoming: upcoming.length,
      bundles: bundles.length,
    };

    const typeCards = types
      .map(
        (t) => `
      <article class="card dune-card experience-card reveal">
        <span class="tag">${esc(t.intensity)}</span>
        <h3>${esc(t.name)}</h3>
        <p>${esc(t.description)}</p>
        <div class="experience-meta">
          <span class="status-pill">${t.durationMin} min</span>
          <span class="experience-detail">Diseñada para ritmo ${esc(t.intensity.toLowerCase())}</span>
        </div>
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

    const ritualCards = [
      {
        label: 'Explora',
        title: 'Agenda con lectura clara',
        text: 'Semana y mes con estados visibles para encontrar rápido una clase disponible.',
      },
      {
        label: 'Reserva',
        title: 'Magic link sin fricción',
        text: 'El cliente deja su email, confirma y recupera su acceso sin crear una cuenta compleja.',
      },
      {
        label: 'Entra',
        title: 'Check-in con QR',
        text: 'Operación valida acceso en segundos desde una superficie pensada para staff.',
      },
    ]
      .map(
        (item) => `
      <article class="card ritual-card reveal">
        <span class="ritual-step">${item.label}</span>
        <h3>${item.title}</h3>
        <p>${item.text}</p>
      </article>
    `
      )
      .join('');

    const proofCards = [
      `${stats.classTypes || 0}+ experiencias activas listas para reservar`,
      `${stats.upcoming || 0} clases destacadas cargadas en agenda`,
      `${stats.bundles || 0} paquetes visibles para compra rápida`,
    ]
      .map((item) => `<div class="proof-chip reveal">${item}</div>`)
      .join('');

    const body = `
      <section class="landing-intro" id="landing-intro" aria-label="Pantalla de bienvenida de TISA">
        <div class="intro-shell">
          <div class="intro-copy">
            <div class="intro-mobile-stage" aria-hidden="true"></div>
            <div class="intro-breathing" aria-label="Ritual de respiración guiada">
              <p class="intro-breathing-kicker">Respira con TISA</p>
              <div class="intro-breathing-core" aria-hidden="true">
                <span class="intro-breathing-aura intro-breathing-aura-primary"></span>
                <span class="intro-breathing-aura intro-breathing-aura-secondary"></span>
                <span class="intro-breathing-orb"></span>
              </div>
              <div class="intro-breathing-steps" aria-hidden="true">
                <span class="is-inhale">Inhala</span>
                <span class="is-hold">Sostén</span>
                <span class="is-exhale">Exhala</span>
              </div>
              <div class="intro-breathing-copy">
                <p class="is-inhale">Inhala calma</p>
                <p class="is-hold">Sostén presencia</p>
                <p class="is-exhale">Exhala tensión</p>
                <p class="is-center">Vuelve a tu centro</p>
              </div>
            </div>
            <div class="intro-actions">
              <button type="button" class="btn" id="intro-enter">Entrar a TISA</button>
            </div>
          </div>
        </div>
        <span class="sand-river river-a"></span>
        <span class="sand-river river-b"></span>
        <span class="sand-river river-c"></span>
      </section>

      <section class="story-root">
        <div class="ambient-lights" aria-hidden="true">
          <span class="light-orb orb-1"></span>
          <span class="light-orb orb-2"></span>
          <span class="light-orb orb-3"></span>
          <span class="light-orb orb-4"></span>
        </div>

        <section class="hero parallax dune-hero" id="landing-main-hero">
          <div class="hero-card hero-premium reveal">
            <div class="hero-grid">
              <div class="hero-copy">
                <p class="eyebrow">TISA · AGENDA · ACCESOS</p>
                <h1>Reserva tu práctica con claridad y entra con calma.</h1>
                <p>Consulta horarios, elige tu acceso y confirma tu entrada con QR dentro de una misma experiencia, sobria y precisa.</p>
                <div class="hero-actions">
                  <button type="button" class="btn" data-scroll-target="landing-overview">Descubrir el recorrido</button>
                  <a class="btn alt" href="/classes">Ir a la agenda</a>
                </div>
                <div class="proof-row">${proofCards}</div>
              </div>
              <div class="hero-aside">
                <div class="hero-aside-card">
                  <span>Reserva</span>
                  <strong>Explora horarios y elige tu lugar con criterio.</strong>
                  <p>La agenda presenta disponibilidad, guía y horario dentro de una lectura limpia y directa.</p>
                </div>
                <div class="hero-aside-card">
                  <span>Acceso</span>
                  <strong>Confirma por correo y llega con tu QR listo.</strong>
                  <p>Cliente, staff y operación comparten un mismo sistema visual de principio a fin.</p>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section class="section section-band reveal" id="landing-overview">
          <div class="band-shell">
            <div>
              <p class="eyebrow">LANDING · AGENDA · PRODUCTO</p>
              <h2>Un solo recorrido para descubrir, reservar y llegar al estudio.</h2>
            </div>
            <p>La home abre con una promesa clara y desciende hacia agenda, accesos y operación con una narrativa más serena, útil y deseable.</p>
          </div>
        </section>

        <section class="section split-section reveal">
          <article class="card split-left premium-copy">
              <h2>Donde el ritual y el producto encuentran el mismo tono</h2>
              <p>TISA toma la calma como punto de partida, pero la traduce a una experiencia digital que también sabe orientar, ordenar y resolver.</p>
              <p>La propuesta ya no se limita a vender una clase; presenta un sistema completo con relato, agenda legible y acceso cuidado.</p>
              <p class="quote">"Una experiencia que se siente íntima, exclusiva y sorprendentemente fácil de usar."</p>
          </article>
          <article class="card split-right premium-preview">
            <div class="clay-shape"></div>
            <div class="preview-caption">
              <strong>Una interfaz sobria, cálida y legible</strong>
              <p>Texturas minerales, superficies sólidas y un contraste pensado para reservar de verdad, no solo para verse bien.</p>
            </div>
          </article>
        </section>

        <section class="section">
          <div class="section-heading section-heading-surface reveal">
            <p class="eyebrow">CLASES</p>
            <h2>Prácticas pensadas para distintos ritmos</h2>
            <p>Cada clase se presenta con intención, duración y carácter propio para que elegir se sienta natural desde el primer vistazo.</p>
          </div>
          <div class="grid">${typeCards}</div>
        </section>

        <section class="section">
            <div class="section-heading section-heading-surface reveal">
              <p class="eyebrow">RITUAL DE RESERVA</p>
              <h2>El recorrido principal se entiende de inmediato</h2>
            <p>Explora la agenda, confirma por correo y llega con tu QR dentro de una secuencia continua, clara y confiable.</p>
          </div>
          <div class="grid ritual-grid">${ritualCards}</div>
        </section>

        <section class="section schedule-shell reveal">
          <div class="card schedule-board">
            <div class="section-heading section-heading-surface compact">
              <p class="eyebrow">AGENDA CLARA</p>
              <h2>Una agenda que invita a decidir con calma</h2>
              <p>Una lectura limpia del calendario, pensada para conservar claridad en escritorio y en móvil.</p>
            </div>
            <div class="timeline">${timeline}</div>
            <a class="btn" href="/classes">Explorar horarios</a>
          </div>
        </section>

        <section class="section">
          <div class="section-heading section-heading-surface reveal">
            <p class="eyebrow">ACCESOS · PAQUETES</p>
            <h2>Accesos visibles antes de reservar</h2>
            <p>Los paquetes aparecen desde la landing para que el valor de cada práctica se entienda antes del clic.</p>
          </div>
          <div class="grid">${bundleCards || '<div class="card">Próximamente habrá accesos disponibles.</div>'}</div>
        </section>

        <section class="section reveal">
          <div class="card ops-showcase">
            <div class="ops-copy">
              <p class="eyebrow">SUPERFICIES OPERATIVAS</p>
              <h2>La operación también forma parte de la experiencia TISA.</h2>
              <p>Administración, trainers y check-in comparten una estética más limpia, para que el backoffice se sienta preciso, rápido y confiable.</p>
            </div>
            <div class="ops-panels">
              <div class="ops-panel">
                <span>Panel admin</span>
                <strong>Indicadores clave, ocupación y seguimiento diario.</strong>
              </div>
              <div class="ops-panel">
                <span>Agenda trainer</span>
                <strong>Calendario, roster y control sobrio de sesiones.</strong>
              </div>
              <div class="ops-panel">
                <span>Ops check-in</span>
                <strong>QR visible, validación rápida y respuestas claras.</strong>
              </div>
            </div>
          </div>
        </section>

        <section class="section reveal">
          <div class="card final-manifesto">
            <h2>Cuando todo se ordena bien, solo queda elegir tu práctica.</h2>
            <p>La nueva experiencia reduce ruido, eleva la percepción de marca y acompaña la reserva con una sensación de calma, certeza y cuidado.</p>
            <a class="btn alt" href="/classes">Entrar a la agenda</a>
          </div>
        </section>
      </section>
    `;

    res.send(renderLayout({ title: 'Inicio', body, simulationMode: config.simulationMode }));
  });

  app.get(['/concept-tisa-01', '/concept-goyo'], async (req, res) => {
    const [types, upcoming, bundles] = await Promise.all([
      prisma.class_types.findMany({ orderBy: { name: 'asc' }, take: 3 }),
      prisma.class_occurrences.findMany({
        include: { classType: true, trainer: true },
        orderBy: { startsAt: 'asc' },
        take: 4,
        where: { startsAt: { gte: new Date(dayjs().startOf('day').toISOString()) } },
      }),
      prisma.ticket_products.findMany({
        include: { classType: true },
        orderBy: [{ bundleSize: 'desc' }, { priceCents: 'asc' }],
        take: 3,
        where: { active: true },
      }),
    ]);

    const scheduleCards = upcoming.length
      ? upcoming
          .map(
            (item, index) => `
          <article class="concept-schedule-card ${index === 0 ? 'is-featured' : ''}">
            <span>${dayjs(item.startsAt).format('ddd DD MMM · HH:mm').toUpperCase()}</span>
            <h3>${esc(item.classType.name)}</h3>
            <p>${esc(item.trainer.displayName)} · ${item.availableSlots} cupos</p>
          </article>
        `
          )
          .join('')
      : '<article class="concept-schedule-card is-featured"><span>PRONTO</span><h3>Nueva programación</h3><p>La agenda se está preparando.</p></article>';

    const ritualCards = [
      { step: '01', title: 'Descubre el ritmo', text: 'Una portada limpia, una voz de marca más precisa y una entrada sin fricción ni overlays frágiles.' },
      { step: '02', title: 'Reserva en un solo gesto', text: 'La agenda se siente más editorial y la reserva más dirigida, con mejor jerarquía visual.' },
      { step: '03', title: 'Llega con certeza', text: 'Accesos, QR y check-in viven dentro del mismo sistema visual y no como módulos separados.' },
    ]
      .map(
        (item) => `
        <article class="concept-ritual-card">
          <span>${item.step}</span>
          <h3>${item.title}</h3>
          <p>${item.text}</p>
        </article>
      `
      )
      .join('');

    const bundleCards = bundles
      .map(
        (bundle) => `
        <article class="concept-bundle-card">
          <p>${esc(bundle.classType.name)}</p>
          <strong>${bundle.bundleSize} tickets</strong>
          <span>MXN ${(bundle.priceCents / 100).toLocaleString('es-MX')}</span>
        </article>
      `
      )
      .join('');

    const typeList = types
      .map(
        (type) => `
        <li>
          <strong>${esc(type.name)}</strong>
          <span>${esc(type.description)}</span>
        </li>
      `
      )
      .join('');

    const body = `
      <section class="concept-shell">
        <section class="concept-hero">
          <div class="concept-noise" aria-hidden="true"></div>
          <div class="concept-hero-grid">
            <div class="concept-headline">
              <p class="concept-label">TISA / CONCEPTO 01</p>
              <h1>Una identidad más precisa para un estudio que debe sentirse sereno, deseable e inmediato.</h1>
              <p class="concept-copy">Esta propuesta abandona la estética anterior y cambia el tono completo: más contraste, más composición editorial, menos bloques repetidos y una agenda que se siente parte de una marca, no de un panel operativo genérico.</p>
              <div class="concept-actions">
                <a class="btn" href="/classes">Abrir agenda actual</a>
                <a class="btn alt" href="/">Comparar con home actual</a>
              </div>
            </div>
            <div class="concept-poster">
              <div class="concept-poster-card">
                <span>TISA Studio System</span>
                <strong>Respiración, calor, foco y pausa.</strong>
                <p>Un sistema visual creado para convertir mejor y sentirse más valioso, especialmente en móvil.</p>
              </div>
              <div class="concept-poster-aside">
                <p>Reserva con intención</p>
                <p>Ritmo editorial</p>
                <p>Operación más clara</p>
              </div>
            </div>
          </div>
        </section>

        <section class="concept-section concept-split">
          <article class="concept-panel dark">
            <p class="concept-label">POR QUÉ CAMBIA</p>
            <h2>La primera impresión ya no depende de una intro frágil.</h2>
            <p>El acceso principal ya no depende de una intro animada que puede fallar. La primera impresión viene de una hero estable con dirección visual más fuerte.</p>
          </article>
          <article class="concept-panel light">
            <p class="concept-label">SISTEMA VISUAL</p>
            <ul class="concept-list">
              <li>Tipografía editorial con más contraste</li>
              <li>Capas oscuras con acentos arena y marfil</li>
              <li>Bloques asimétricos en lugar de tarjetas repetidas</li>
              <li>Ritmo visual pensado primero para mobile</li>
            </ul>
          </article>
        </section>

        <section class="concept-section">
          <div class="concept-section-heading">
            <p class="concept-label">DIRECCIÓN DE AGENDA</p>
            <h2>La reserva debe sentirse curada, no genérica.</h2>
          </div>
          <div class="concept-schedule-grid">
            ${scheduleCards}
          </div>
        </section>

        <section class="concept-section concept-rituals">
          <div class="concept-section-heading">
            <p class="concept-label">RECORRIDO</p>
            <h2>Un viaje de tres momentos con una intención más clara.</h2>
          </div>
          <div class="concept-ritual-grid">
            ${ritualCards}
          </div>
        </section>

        <section class="concept-section concept-dual-grid">
          <article class="concept-panel light">
            <p class="concept-label">MENÚ DE PRÁCTICAS</p>
            <h2>Programas con una jerarquía más serena.</h2>
            <ul class="concept-program-list">
              ${typeList}
            </ul>
          </article>
          <article class="concept-panel accent">
            <p class="concept-label">ACCESOS</p>
            <h2>El valor del acceso visible antes del clic.</h2>
            <div class="concept-bundle-grid">
              ${bundleCards}
            </div>
          </article>
        </section>

        <section class="concept-section">
          <div class="concept-final-card">
            <p class="concept-label">SIGUIENTE PASO</p>
            <h2>Si apruebas esta dirección, se traduce a Figma y luego reemplaza las superficies reales.</h2>
          </div>
        </section>
      </section>
    `;

    res.send(renderLayout({ title: 'Concept TISA 01', body, simulationMode: config.simulationMode }));
  });

  app.get(['/concept-tisa-02', '/concept-goyo-02'], async (req, res) => {
    const [upcoming, bundles] = await Promise.all([
      prisma.class_occurrences.findMany({
        include: { classType: true, trainer: true, location: true },
        orderBy: { startsAt: 'asc' },
        take: 6,
        where: { startsAt: { gte: new Date(dayjs().startOf('day').toISOString()) } },
      }),
      prisma.ticket_products.findMany({
        include: { classType: true },
        orderBy: [{ bundleSize: 'desc' }, { priceCents: 'asc' }],
        take: 3,
        where: { active: true },
      }),
    ]);

    const featured = upcoming[0];
    const scheduleRows = upcoming
      .map(
        (item, index) => `
        <article class="concept2-schedule-row ${index === 0 ? 'is-active' : ''}">
          <div>
                    <strong>${esc(item.classType.name)}</strong>
                    <p>${esc(item.trainer.displayName)} · TISA Central</p>
          </div>
          <div class="concept2-row-meta">
            <span>${dayjs(item.startsAt).format('HH:mm')}</span>
            <small>${item.availableSlots} cupos</small>
          </div>
        </article>
      `
      )
      .join('');

    const bundleRows = bundles
      .map(
        (bundle) => `
        <article class="concept2-bundle-row">
          <div>
            <p>${esc(bundle.classType.name)}</p>
            <strong>${bundle.bundleSize} tickets</strong>
          </div>
          <span>MXN ${(bundle.priceCents / 100).toLocaleString('es-MX')}</span>
        </article>
      `
      )
      .join('');

    const body = `
      <section class="concept2-shell">
        <section class="concept2-hero">
          <div class="concept2-copy">
            <p class="concept-label">TISA / CONCEPTO 02</p>
            <h1>La agenda y la reserva como una experiencia serena, clara y deseable.</h1>
            <p>Este concepto lleva la calma visual de TISA al momento más importante: elegir una práctica, entender el valor de cada acceso y cerrar la reserva dentro de una superficie cálida, simple y precisa.</p>
          </div>
          <div class="concept2-chip-row">
            <span>Agenda contemplativa</span>
            <span>Reserva sin fricción</span>
            <span>Créditos visibles</span>
          </div>
        </section>

        <section class="concept2-board">
          <article class="concept2-panel concept2-agenda-panel">
            <div class="concept2-panel-head">
              <div>
                <p class="concept-label">AGENDA</p>
                <h2>Una vista semanal pensada para decidir con calma.</h2>
              </div>
              <span class="concept2-status">Disponibilidad en tiempo real</span>
            </div>
            <div class="concept2-schedule-list">
              ${scheduleRows}
            </div>
          </article>

          <article class="concept2-panel concept2-booking-panel">
            <p class="concept-label">RESERVA</p>
            <h2>${featured ? esc(featured.classType.name) : 'Práctica seleccionada'}</h2>
            <div class="concept2-detail-stack">
              <div><span>Horario</span><strong>${featured ? dayjs(featured.startsAt).format('ddd DD MMM · HH:mm') : 'Por definir'}</strong></div>
              <div><span>Guía</span><strong>${featured ? esc(featured.trainer.displayName) : 'Por definir'}</strong></div>
              <div><span>Ubicación</span><strong>TISA Central</strong></div>
            </div>
            <div class="concept2-action-box">
              <button class="btn" type="button">Continuar con créditos</button>
              <button class="btn alt" type="button">Explorar accesos</button>
            </div>
          </article>
        </section>

        <section class="concept2-secondary-grid">
          <article class="concept2-panel concept2-wallet-panel">
            <p class="concept-label">ACCESOS</p>
            <h2>Los créditos deben sentirse claros, presentes y tranquilos.</h2>
            <div class="concept2-wallet-card">
              <span>Disponible ahora</span>
              <strong>08</strong>
              <p>Accesos Flow Suave</p>
            </div>
            <div class="concept2-bundle-list">
              ${bundleRows}
            </div>
          </article>

          <article class="concept2-panel concept2-qr-panel">
            <p class="concept-label">CONFIRMACIÓN</p>
            <h2>La confirmación y el QR viven dentro del mismo lenguaje visual.</h2>
            <div class="concept2-qr-card">
              <div class="concept2-qr-mock"></div>
              <div>
                <strong>Reserva / TISA-2841</strong>
                <p>La confirmación deja de sentirse técnica. Ahora acompaña el cierre del recorrido con la misma calma que el resto de la experiencia.</p>
              </div>
            </div>
          </article>
        </section>

        <section class="concept2-final">
          <p class="concept-label">DIRECCIÓN</p>
          <h2>Este concepto conserva la sensibilidad editorial de TISA, pero la acerca más al producto real: agenda, accesos y reserva dentro de una experiencia coherente.</h2>
        </section>
      </section>
    `;

    res.send(renderLayout({ title: 'Concept TISA 02', body, simulationMode: config.simulationMode }));
  });

  app.get('/concept-tisa-mobile', async (req, res) => {
    const upcoming = await prisma.class_occurrences.findMany({
      include: { classType: true, trainer: true, location: true },
      orderBy: { startsAt: 'asc' },
      take: 4,
      where: { startsAt: { gte: new Date(dayjs().startOf('day').toISOString()) } },
    });

    const featured = upcoming[0];
    const cards = upcoming
      .map(
        (item, index) => `
        <article class="mobile-concept-class ${index === 0 ? 'is-active' : ''}">
          <div class="mobile-concept-class-top">
            <span>${dayjs(item.startsAt).format('ddd DD MMM').toUpperCase()}</span>
            <strong>${dayjs(item.startsAt).format('HH:mm')}</strong>
          </div>
          <h3>${esc(item.classType.name)}</h3>
          <p>${esc(item.trainer.displayName)} · ${item.availableSlots} cupos</p>
        </article>
      `
      )
      .join('');

    const body = `
      <section class="mobile-concept-shell">
        <div class="mobile-device-frame">
          <div class="mobile-device-inner">
            <div class="mobile-hero-card">
              <p class="concept-label">TISA / CONCEPTO MÓVIL</p>
              <h1>Reservar desde el móvil debe sentirse simple, íntimo y natural.</h1>
              <p>Este concepto reúne agenda, selección, accesos y confirmación en una experiencia más cálida, pensada para moverse con una mano y decidir sin esfuerzo.</p>
            </div>

            <div class="mobile-card-stack">
              <section class="mobile-schedule-card">
                <div class="mobile-section-head">
                  <div>
                    <p class="concept-label">HOY</p>
                    <h2>Elige tu práctica</h2>
                  </div>
                  <span>En vivo</span>
                </div>
                <div class="mobile-class-list">
                  ${cards}
                </div>
              </section>

              <section class="mobile-booking-card">
                <p class="concept-label">RESERVA</p>
                <h2>${featured ? esc(featured.classType.name) : 'Práctica seleccionada'}</h2>
                <div class="mobile-booking-meta">
                  <div><span>Horario</span><strong>${featured ? dayjs(featured.startsAt).format('HH:mm') : '--:--'}</strong></div>
                  <div><span>Guía</span><strong>${featured ? esc(featured.trainer.displayName) : 'Por definir'}</strong></div>
                  <div><span>Accesos</span><strong>08 créditos</strong></div>
                </div>
                <button class="btn" type="button">Reservar con crédito</button>
                <button class="btn alt" type="button">Ver accesos</button>
              </section>

              <section class="mobile-confirm-card">
                <p class="concept-label">CONFIRMACIÓN</p>
                <div class="mobile-confirm-row">
                  <div class="mobile-qr-mock"></div>
                  <div>
                    <strong>TISA-2481</strong>
                    <p>El QR aparece dentro del mismo lenguaje visual, como una continuación natural de la reserva.</p>
                  </div>
                </div>
              </section>
            </div>
          </div>
        </div>
      </section>
    `;

    res.send(renderLayout({ title: 'Concept TISA Móvil', body, simulationMode: config.simulationMode }));
  });

  app.get('/concept-tisa-calendar', async (req, res) => {
    const weekdayShort = ['DOM', 'LUN', 'MAR', 'MIÉ', 'JUE', 'VIE', 'SÁB'];
    const monthShort = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];
    const shortDayLabel = (d) => weekdayShort[d.day()];
    const shortDateLabel = (d) => `${String(d.date()).padStart(2, '0')} ${monthShort[d.month()]}`;
    const detailDateLabel = (d) => `${shortDayLabel(d)} ${shortDateLabel(d)} · ${d.format('HH:mm')}`;
    const requestedStart = dayjs();
    const periodStart = startOfWeekMonday(requestedStart);
    const periodEnd = dayjs(periodStart).add(7, 'day');
    const classes = await prisma.class_occurrences.findMany({
      include: { classType: true, trainer: true, location: true },
      orderBy: { startsAt: 'asc' },
      take: 18,
      where: {
        startsAt: {
          gte: new Date(periodStart.startOf('day').toISOString()),
          lt: new Date(periodEnd.endOf('day').toISOString()),
        },
      },
    });

    const days = Array.from({ length: 7 }, (_, i) => startOfWeekMonday(periodStart).add(i, 'day'));
    const grouped = days
      .map((d) => {
        const items = classes
          .filter((c) => dayjs(c.startsAt).isSame(d, 'day'))
          .slice(0, 3)
          .map(
            (c, index) => `
            <article class="calendar-concept-event ${index === 0 ? 'is-featured' : ''}">
              <span>${dayjs(c.startsAt).format('HH:mm')}</span>
              <strong>${esc(c.classType.name)}</strong>
              <p>${esc(c.trainer.displayName)} · ${c.availableSlots} cupos</p>
            </article>
          `
          )
          .join('');

        return `
          <section class="calendar-concept-day">
            <header>
              <span>${shortDayLabel(d)}</span>
              <strong>${shortDateLabel(d)}</strong>
            </header>
            <div class="calendar-concept-events">
              ${items || '<div class="calendar-concept-empty">Sin prácticas</div>'}
            </div>
          </section>
        `;
      })
      .join('');

    const monthStrip = Array.from({ length: 14 }, (_, i) => periodStart.add(i, 'day'))
      .map(
        (d, index) => `
        <article class="calendar-month-card ${index === 4 ? 'is-selected' : ''}">
          <span>${shortDayLabel(d)}</span>
          <strong>${d.format('DD')}</strong>
          <p>${monthShort[d.month()]}</p>
        </article>
      `
      )
      .join('');

    const featured = classes[0];
    const body = `
      <section class="system-shell">
        <section class="system-hero scroll-hero" data-scroll-target="calendar-week">
          <div>
            <p class="concept-label">TISA / CALENDARIO</p>
            <h1>Un calendario que invita a reservar con claridad, no a descifrar bloques.</h1>
            <p>Esta versión transforma la agenda en una superficie editorial: semana clara, mes legible y una reserva contextual que no rompe el ritmo visual de TISA.</p>
          </div>
          <div class="system-chip-row">
            <button class="system-chip-button" type="button" data-scroll-target="calendar-week">Semana serena</button>
            <button class="system-chip-button" type="button" data-scroll-target="calendar-month">Vista mes utilitaria</button>
            <button class="system-chip-button" type="button" data-scroll-target="calendar-booking">Reserva integrada</button>
          </div>
        </section>

        <section class="system-grid calendar-concept-grid">
          <article class="system-panel system-panel-light" id="calendar-week">
            <p class="concept-label">SEMANA</p>
            <h2>Decidir desde una vista semanal limpia.</h2>
            <div class="calendar-concept-week">
              ${grouped}
            </div>
          </article>

          <article class="system-panel system-panel-dark" id="calendar-booking">
            <p class="concept-label">RESERVA RÁPIDA</p>
            <h2>${featured ? esc(featured.classType.name) : 'Práctica seleccionada'}</h2>
            <div class="system-detail-list">
              <div><span>Horario</span><strong>${featured ? detailDateLabel(dayjs(featured.startsAt)) : 'Por definir'}</strong></div>
              <div><span>Guía</span><strong>${featured ? esc(featured.trainer.displayName) : 'Por definir'}</strong></div>
              <div><span>Estudio</span><strong>TISA Central</strong></div>
            </div>
            <div class="system-action-stack">
              <button class="btn" type="button">Abrir acceso</button>
              <button class="btn alt" type="button">Ver créditos</button>
            </div>
          </article>
        </section>

        <section class="system-grid calendar-concept-grid">
          <article class="system-panel system-panel-light" id="calendar-month">
            <p class="concept-label">MES</p>
            <h2>Una lectura mensual más compacta y humana.</h2>
            <div class="calendar-month-strip">
              ${monthStrip}
            </div>
          </article>

          <article class="system-panel system-panel-soft">
            <p class="concept-label">DETALLE</p>
            <h2>La clase elegida vive dentro del mismo recorrido.</h2>
            <div class="calendar-modal-mock">
              <strong>${featured ? esc(featured.classType.name) : 'Meditación Guiada'}</strong>
              <p>${featured ? esc(featured.trainer.displayName) : 'Sofía Luna'} · ${featured ? dayjs(featured.startsAt).format('HH:mm') : '07:00'} · ${featured ? featured.availableSlots : 18} cupos</p>
              <small>No se siente como un modal genérico, sino como una capa natural de la agenda.</small>
            </div>
          </article>
        </section>
      </section>
    `;

    res.send(renderLayout({ title: 'Concept TISA Calendario', body, simulationMode: config.simulationMode }));
  });

  app.get('/concept-tisa-access', async (req, res) => {
    const weekdayShort = ['DOM', 'LUN', 'MAR', 'MIÉ', 'JUE', 'VIE', 'SÁB'];
    const monthShort = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];
    const shortDateLabel = (d) => `${String(d.date()).padStart(2, '0')} ${monthShort[d.month()]} · ${d.format('HH:mm')}`;
    const occurrence = await prisma.class_occurrences.findFirst({
      include: { classType: true, trainer: true, location: true },
      orderBy: { startsAt: 'asc' },
      where: { startsAt: { gte: new Date(dayjs().startOf('day').toISOString()) } },
    });
    const products = await prisma.ticket_products.findMany({
      include: { classType: true },
      orderBy: [{ bundleSize: 'desc' }, { priceCents: 'asc' }],
      take: 3,
      where: { active: true },
    });

    const accessCards = products
      .map(
        (product) => `
        <article class="access-product-row">
          <div>
            <p>${esc(product.classType.name)}</p>
            <strong>${product.bundleSize} accesos</strong>
          </div>
          <span>MXN ${(product.priceCents / 100).toLocaleString('es-MX')}</span>
        </article>
      `
      )
      .join('');

    const body = `
      <section class="system-shell">
        <section class="system-hero scroll-hero" data-scroll-target="access-entry">
          <div>
            <p class="concept-label">TISA / ACCESO Y RESERVA</p>
            <h1>El acceso por correo, la confirmación y el QR deben sentirse parte del mismo ritual.</h1>
            <p>Este board ordena el tramo más sensible del producto: entrar desde el correo, decidir con qué acceso reservar y llegar con una confirmación que inspire calma y certeza.</p>
          </div>
          <div class="system-chip-row">
            <button class="system-chip-button" type="button" data-scroll-target="access-entry">Acceso por correo</button>
            <button class="system-chip-button" type="button" data-scroll-target="access-bundles">Compra contextual</button>
            <button class="system-chip-button" type="button" data-scroll-target="access-qr">QR sereno</button>
          </div>
        </section>

        <section class="system-grid access-grid">
          <article class="system-panel system-panel-light" id="access-entry">
            <p class="concept-label">ACCESO POR CORREO</p>
            <h2>Confirmar tu lugar en menos de un minuto.</h2>
            <div class="system-detail-list">
              <div><span>Práctica</span><strong>${occurrence ? esc(occurrence.classType.name) : 'Meditación Guiada'}</strong></div>
              <div><span>Horario</span><strong>${occurrence ? shortDateLabel(dayjs(occurrence.startsAt)) : '06 MAR · 07:00'}</strong></div>
              <div><span>Guía</span><strong>${occurrence ? esc(occurrence.trainer.displayName) : 'Sofía Luna'}</strong></div>
            </div>
            <div class="mail-chip">alemunozpro80@gmail.com</div>
            <button class="btn" type="button">Consumir 1 crédito y reservar</button>
          </article>

          <article class="system-panel system-panel-dark" id="access-bundles">
            <p class="concept-label">SIN ACCESOS</p>
            <h2>Comprar sin salir del flujo.</h2>
            <div class="access-product-list">
              ${accessCards}
            </div>
          </article>
        </section>

        <section class="system-grid access-grid">
          <article class="system-panel system-panel-dark" id="access-qr">
            <p class="concept-label">CONFIRMACIÓN</p>
            <h2>Reserva lista para abrir la puerta.</h2>
            <div class="access-qr-card">
              <div class="concept2-qr-mock"></div>
              <div>
                <strong>TISA-2841</strong>
                <p>Tu reserva queda visible, compartible y alineada con el tono completo de la marca.</p>
              </div>
            </div>
          </article>

          <article class="system-panel system-panel-soft">
            <p class="concept-label">GESTIONAR</p>
            <h2>Cancelar o revisar sin romper la confianza.</h2>
            <div class="system-detail-list">
              <div><span>Correo</span><strong>alemunozpro80@gmail.com</strong></div>
              <div><span>Estado</span><strong>Confirmada</strong></div>
              <div><span>Ventana</span><strong>Cancelación válida hasta 2 horas antes</strong></div>
            </div>
            <div class="system-action-stack">
              <button class="btn alt" type="button">Cancelar reserva</button>
            </div>
          </article>
        </section>
      </section>
    `;

    res.send(renderLayout({ title: 'Concept TISA Acceso', body, simulationMode: config.simulationMode }));
  });

  app.get('/concept-tisa-admin', async (req, res) => {
    const [bookings, clients, paid, classes, trainerClasses] = await Promise.all([
      prisma.bookings.count({ where: { status: 'BOOKED' } }),
      prisma.clients.count(),
      prisma.payments.count({ where: { status: 'PAID' } }),
      prisma.class_occurrences.count({ where: { startsAt: { gte: new Date(dayjs().startOf('day').toISOString()) } } }),
      prisma.class_occurrences.findMany({
        include: { classType: true, trainer: true, location: true },
        orderBy: { startsAt: 'asc' },
        take: 5,
        where: { startsAt: { gte: new Date(dayjs().startOf('day').toISOString()) } },
      }),
    ]);

    const trainerRows = trainerClasses
      .map(
        (item) => `
        <article class="admin-list-row">
          <div>
            <strong>${esc(item.classType.name)}</strong>
            <p>${esc(item.trainer.displayName)} · TISA Central</p>
          </div>
          <span>${dayjs(item.startsAt).format('DD MMM · HH:mm')}</span>
        </article>
      `
      )
      .join('');

    const body = `
      <section class="system-shell">
        <section class="system-hero scroll-hero" data-scroll-target="admin-login">
          <div>
            <p class="concept-label">TISA / ADMIN Y STAFF</p>
            <h1>La operación también debe sentirse precisa, elegante y fácil de usar.</h1>
            <p>Este board reúne ingreso staff, métricas, agenda de trainers y check-in operativo dentro de una misma familia visual. La meta es quitar sensación de backoffice improvisado.</p>
          </div>
          <div class="system-chip-row">
            <button class="system-chip-button" type="button" data-scroll-target="admin-login">Login limpio</button>
            <button class="system-chip-button" type="button" data-scroll-target="admin-dashboard">Métricas legibles</button>
            <button class="system-chip-button" type="button" data-scroll-target="admin-checkin">Check-in veloz</button>
          </div>
        </section>

        <section class="system-grid admin-grid">
          <article class="system-panel system-panel-light" id="admin-login">
            <p class="concept-label">INGRESO STAFF</p>
            <h2>Una entrada sobria para administración, trainers y ops.</h2>
            <div class="admin-login-mock">
              <div class="admin-input">correo@tisa.mx</div>
              <div class="admin-input">••••••••••</div>
              <button class="btn" type="button">Entrar</button>
            </div>
          </article>

          <article class="system-panel system-panel-dark" id="admin-dashboard">
            <p class="concept-label">DASHBOARD</p>
            <h2>Señales principales del día.</h2>
            <div class="admin-metric-grid">
              <div><span>Reservas</span><strong>${bookings}</strong></div>
              <div><span>Clientes</span><strong>${clients}</strong></div>
              <div><span>Pagos</span><strong>${paid}</strong></div>
              <div><span>Clases</span><strong>${classes}</strong></div>
            </div>
          </article>
        </section>

        <section class="system-grid admin-grid">
          <article class="system-panel system-panel-soft">
            <p class="concept-label">PLANNER TRAINER</p>
            <h2>Agenda y control de sesiones.</h2>
            <div class="admin-list">
              ${trainerRows}
            </div>
          </article>

          <article class="system-panel system-panel-dark" id="admin-checkin">
            <p class="concept-label">CHECK-IN OPS</p>
            <h2>Validar acceso con rapidez y certeza.</h2>
            <div class="ops-mock">
              <div class="ops-camera">Escáner QR</div>
              <div class="admin-input tall">Payload QR o JSON</div>
              <button class="btn" type="button">Validar acceso</button>
            </div>
          </article>
        </section>
      </section>
    `;

    res.send(renderLayout({ title: 'Concept TISA Admin', body, simulationMode: config.simulationMode }));
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
              <a
                class="month-class-chip ${isCancelled ? 'is-cancelled' : ''} ${c.availableSlots <= 0 ? 'is-full' : ''}"
                href="${disabled ? '#' : buildSeatSelectionUrl(c.id)}"
                ${disabled ? 'aria-disabled="true"' : ''}
              >
                <span>${start.format('HH:mm')}</span>
                <strong>${esc(c.classType.name)}</strong>
              </a>
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
            <a
              class="calendar-class-block ${isCancelled ? 'is-cancelled' : ''} ${c.availableSlots <= 0 ? 'is-full' : ''}"
              style="top:${top}px;height:${height}px;"
              href="${disabled ? '#' : buildSeatSelectionUrl(c.id)}"
              ${disabled ? 'aria-disabled="true"' : ''}
            >
              <strong>${esc(c.classType.name)}</strong>
              <small>${start.format('HH:mm')} · ${esc(c.trainer.displayName)}</small>
              <small>${isCancelled ? 'Clase cancelada' : `${c.availableSlots} lugares disponibles`}</small>
            </a>
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

    const classCount = classes.length;
    const availableCount = classes.filter((c) => c.status !== 'CANCELLED' && c.availableSlots > 0).length;
    const firstClass = classes[0];

    const body = `<section class="section page-shell">
      <div class="page-hero page-hero-grid reveal scroll-hero" data-scroll-target="classes-calendar">
        <div class="page-hero-copy">
          <p class="page-kicker">TISA · AGENDA · RESERVA CLARA</p>
          <h1>Una agenda viva para elegir con calma y reservar sin fricción.</h1>
          <p class="page-lede">Explora la semana o el mes, detecta disponibilidad al instante y abre la reserva desde el mismo bloque de clase. Todo el flujo está pensado para que el estudio se sienta sobrio, intuitivo y preciso.</p>
          <div class="system-chip-row">
            <button type="button" class="system-chip-button" data-scroll-target="classes-calendar">Ver agenda</button>
            <button type="button" class="system-chip-button" data-scroll-target="classes-toolbar">Cambiar vista</button>
          </div>
          <div class="mini-stat-grid">
            <article class="mini-stat"><span>Clases en rango</span><strong>${classCount}</strong></article>
            <article class="mini-stat"><span>Disponibles</span><strong>${availableCount}</strong></article>
            <article class="mini-stat"><span>Primera salida</span><strong>${firstClass ? dayjs(firstClass.startsAt).format('DD MMM · HH:mm') : 'Sin clases'}</strong></article>
          </div>
        </div>
        <aside class="page-hero-side">
          <div class="spotlight-card">
            <span>Cómo funciona</span>
            <strong>Elige un bloque, selecciona tus lugares y luego deja tu correo.</strong>
            <p>El enlace mágico ya lleva los lugares elegidos para que confirmes o compres accesos sin volver a empezar.</p>
          </div>
          <div class="spotlight-card muted">
            <span>Ventaja</span>
            <strong>Ahora también ves los lugares ocupados antes de pedir tu QR.</strong>
          </div>
        </aside>
      </div>

      <div class="calendar-toolbar page-toolbar" id="classes-toolbar">
        <h2>Agenda de clases</h2>
        <div class="calendar-toolbar-actions">
          <a class="btn alt" href="/classes?view=${view}&start=${prevStart.format('YYYY-MM-DD')}">Anterior</a>
          <span class="calendar-range">${titleRange}</span>
          <a class="btn alt" href="/classes?view=${view}&start=${nextStart.format('YYYY-MM-DD')}">Siguiente</a>
          <a class="btn ${view === 'week' ? '' : 'alt'}" href="/classes?view=week&start=${periodStart.format('YYYY-MM-DD')}">Semana</a>
          <a class="btn ${view === 'month' ? '' : 'alt'}" href="/classes?view=month&start=${periodStart.format('YYYY-MM-DD')}">Mes</a>
        </div>
      </div>
      ${req.query.error ? `<div class="ui-status-banner is-cancel"><div><p class="concept-kicker">Disponibilidad</p><h2>El mapa cambió antes de confirmar.</h2><p>${esc(String(req.query.error))}</p></div></div>` : ''}
      <p class="calendar-subtitle">Selecciona cualquier bloque para reservar. Las clases canceladas aparecen claramente marcadas.</p>
      <div class="calendar-shell reveal" id="classes-calendar">
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
    </section>`;
    res.send(renderLayout({ title: 'Clases', body, simulationMode: config.simulationMode }));
  });

  app.get('/booking/seats', async (req, res) => {
    const occurrenceId = String(req.query.occurrenceId || '');
    if (!occurrenceId) return res.status(400).send(renderError('Falta la clase a reservar.'));

    const occurrence = await prisma.class_occurrences.findUnique({
      where: { id: occurrenceId },
      include: { classType: true, trainer: true, location: true },
    });
    if (!occurrence) return res.status(404).send(renderError('Clase no encontrada.'));
    if (occurrence.status === 'CANCELLED') return res.status(409).send(renderError('La clase fue cancelada por el trainer.'));

    const occupiedSeatCodes = (
      await prisma.reserved_seats.findMany({
        where: { classOccurrenceId: occurrence.id },
        select: { seatCode: true },
        orderBy: { seatCode: 'asc' },
      })
    ).map((seat) => seat.seatCode);

    const body = renderSeatSelectionBody({
      occurrence,
      occupiedSeatCodes,
      message: req.query.error ? String(req.query.error) : '',
      messageType: 'error',
    });

    res.send(renderLayout({ title: 'Elegir lugares', body, simulationMode: config.simulationMode }));
  });

  app.post('/magic-link/request', async (req, res) => {
    const schema = z.object({ email: z.string().email(), occurrenceId: z.string().min(8) });
    const parsed = schema.safeParse(req.body);
    const seatCodes = Array.isArray(req.body.seatCodes) ? req.body.seatCodes : req.body.seatCodes ? [req.body.seatCodes] : [];

    if (!parsed.success) return res.status(400).send(renderError('Datos inválidos para crear magic link.'));

    const { email, occurrenceId } = parsed.data;
    const occurrence = await prisma.class_occurrences.findUnique({
      where: { id: occurrenceId },
      include: { classType: true, trainer: true, location: true },
    });
    if (!occurrence) return res.status(404).send(renderError('Clase no encontrada.'));
    if (occurrence.status === 'CANCELLED') return res.status(409).send(renderError('Esta clase fue cancelada por el trainer.'));

    const occupiedSeatCodes = (
      await prisma.reserved_seats.findMany({
        where: { classOccurrenceId: occurrence.id },
        select: { seatCode: true },
      })
    ).map((seat) => seat.seatCode);

    const validation = validateSeatSelection({ seatCodes, capacity: occurrence.capacity, occupiedSeatCodes });
    if (!validation.ok) {
      const body = renderSeatSelectionBody({
        occurrence,
        occupiedSeatCodes,
        selectedSeatCodes: Array.isArray(seatCodes) ? seatCodes : [seatCodes],
        email,
        message: validation.message,
      });
      return res.status(409).send(renderLayout({ title: 'Elegir lugares', body, simulationMode: config.simulationMode }));
    }

    if (occurrence.availableSlots < validation.seats.length) {
      const body = renderSeatSelectionBody({
        occurrence,
        occupiedSeatCodes,
        selectedSeatCodes: validation.seats.map((seat) => seat.code),
        email,
        message: 'La clase ya no tiene suficientes lugares libres para esa selección.',
      });
      return res.status(409).send(renderLayout({ title: 'Elegir lugares', body, simulationMode: config.simulationMode }));
    }

    const client = await prisma.clients.upsert({
      where: { email },
      update: {},
      create: { email, fullName: email.split('@')[0] },
    });

    const token = createToken();
    const tokenHash = hashToken(token);
    const expiresAt = dayjs().add(30, 'minute').toDate();
    const contextJson = JSON.stringify({
      occurrenceId,
      quantity: validation.seats.length,
      seatCodes: validation.seats.map((seat) => seat.code),
    });

    await prisma.magic_links.create({
      data: {
        clientId: client.id,
        tokenHash,
        purpose: `BOOK:${occurrenceId}`,
        contextJson,
        expiresAt,
      },
    });

    const baseUrl = getBaseUrl(req);
    const url = `${baseUrl}/booking/start?token=${token}`;
    const seatLabels = formatSeatLabels(validation.seats.map((seat) => seat.code), occurrence.capacity);

    console.log(`[magic-link] send to ${email}: ${url}`);
    await sendMagicLinkEmail({
      to: email,
      bookingUrl: url,
      className: occurrence.classType.name,
      classDate: dayjs(occurrence.startsAt).format('DD MMM YYYY · HH:mm'),
      trainerName: occurrence.trainer.displayName,
      locationName: occurrence.location.name,
      seatLabels,
    });

    const body = `
      <section class="section">
        <div class="system-shell">
          <section class="system-hero scroll-hero" data-scroll-target="magic-link-detail">
            <p class="concept-kicker">TISA / ACCESO</p>
            <h1>Tu acceso temporal ya está listo.</h1>
            <p>Guardamos tu selección y enviamos un enlace privado para continuar la reserva sin perder los lugares elegidos.</p>
          </section>
          <div class="system-grid" id="magic-link-detail">
            <article class="system-panel system-panel-light">
              <h2>Resumen</h2>
              <div class="system-detail-list">
                <div><span>Correo</span><strong>${esc(email)}</strong></div>
                <div><span>Lugares</span><strong>${esc(seatLabels)}</strong></div>
                <div><span>Vigencia</span><strong>30 minutos</strong></div>
                <div><span>Modo</span><strong>${config.simulationMode ? 'Simulación con enlace visible' : 'Correo real enviado'}</strong></div>
              </div>
            </article>
            <article class="system-panel system-panel-dark">
              <h2>Continúa tu recorrido</h2>
              <div class="system-action-stack">
                <a class="btn" href="${url}">Abrir enlace mágico</a>
                <a class="btn alt" href="/classes">Volver a la agenda</a>
              </div>
            </article>
          </div>
        </div>
      </section>
    `;
    res.send(renderLayout({ title: 'Magic Link', body, simulationMode: config.simulationMode }));
  });

  app.get('/booking/start', async (req, res) => {
    const token = String(req.query.token || '');
    const found = await prisma.magic_links.findUnique({ where: { tokenHash: hashToken(token) }, include: { client: true } });
    if (!found || found.usedAt || dayjs(found.expiresAt).isBefore(dayjs())) {
      return res.status(400).send(renderLayout({ title: 'Token inválido', body: renderError('Token expirado o usado.'), simulationMode: config.simulationMode }));
    }

    const context = getMagicLinkContext(found);
    const occurrenceId = String(context.occurrenceId || '');
    const selectedSeatCodes = Array.isArray(context.seatCodes) ? context.seatCodes : [];
    if (!occurrenceId) return res.status(400).send(renderError('Este enlace no tiene una clase asociada.'));

    const occurrence = await prisma.class_occurrences.findUnique({
      where: { id: occurrenceId },
      include: { classType: true, trainer: true, location: true },
    });
    if (!occurrence) return res.status(404).send(renderError('Clase no encontrada'));
    if (occurrence.status === 'CANCELLED') return res.status(409).send(renderError('La clase fue cancelada por el trainer.'));

    const occupiedSeatCodes = (
      await prisma.reserved_seats.findMany({
        where: { classOccurrenceId: occurrence.id },
        select: { seatCode: true },
      })
    ).map((seat) => seat.seatCode);
    const validation = validateSeatSelection({ seatCodes: selectedSeatCodes, capacity: occurrence.capacity, occupiedSeatCodes });
    if (!validation.ok || occurrence.availableSlots < selectedSeatCodes.length) {
      return res.redirect(buildSeatSelectionUrl(occurrence.id, { error: validation.ok ? 'La clase ya no tiene suficientes lugares libres para esa selección.' : validation.message }));
    }

    const wallet = await prisma.client_wallets.findUnique({ where: { clientId_classTypeId: { clientId: found.clientId, classTypeId: occurrence.classTypeId } } });
    const quantity = validation.seats.length;
    const seatLabels = formatSeatLabels(validation.seats.map((seat) => seat.code), occurrence.capacity);
    const availableCredits = wallet?.credits || 0;
    const hasEnoughCredits = availableCredits >= quantity;

    const body = `
      <section class="section">
        <div class="system-shell">
          <section class="system-hero scroll-hero" data-scroll-target="booking-start-grid">
            <p class="concept-kicker">TISA / RESERVA</p>
            <h1>Confirma tus lugares con serenidad.</h1>
            <p>Tu acceso ya validó tu identidad. Desde aquí puedes usar ${quantity} ${quantity === 1 ? 'crédito' : 'créditos'} o comprar accesos sin perder el mapa que elegiste.</p>
          </section>
          <div class="system-grid" id="booking-start-grid">
            <article class="system-panel system-panel-light">
              <h2>${esc(occurrence.classType.name)}</h2>
              <div class="system-detail-list">
                <div><span>Horario</span><strong>${dayjs(occurrence.startsAt).format('DD MMM · HH:mm')}</strong></div>
                <div><span>Guía</span><strong>${esc(occurrence.trainer.displayName)}</strong></div>
                <div><span>Estudio</span><strong>${esc(occurrence.location.name)}</strong></div>
                <div><span>Cliente</span><strong>${esc(found.client.email)}</strong></div>
                <div><span>Lugares</span><strong>${esc(seatLabels)}</strong></div>
                <div><span>Personas</span><strong>${quantity}</strong></div>
              </div>
            </article>
            <article class="system-panel system-panel-soft">
              <h2>Tus accesos</h2>
              <div class="system-detail-list">
                <div><span>Créditos disponibles</span><strong>${availableCredits}</strong></div>
                <div><span>Accesos necesarios</span><strong>${quantity}</strong></div>
                <div><span>Siguiente paso</span><strong>Confirmar reserva para ${esc(seatLabels)}</strong></div>
              </div>
              <form action="/bookings" method="post" class="system-action-stack">
                <input type="hidden" name="token" value="${esc(token)}" />
                <button class="btn" type="submit" ${hasEnoughCredits ? '' : 'disabled aria-disabled="true"'}>Confirmar con ${quantity} ${quantity === 1 ? 'acceso' : 'accesos'}</button>
              </form>
              ${hasEnoughCredits ? '' : `<p class="system-inline-note">Te faltan ${quantity - availableCredits} ${quantity - availableCredits === 1 ? 'acceso' : 'accesos'} para cerrar esta reserva.</p>`}
            </article>
            <article class="system-panel system-panel-dark">
              <h2>Si necesitas accesos</h2>
              <p>Compra el paquete adecuado para esta práctica y vuelve al mismo recorrido con los lugares todavía vinculados a este enlace.</p>
              <form action="/checkout/session" method="post" class="system-action-stack">
                <input type="hidden" name="clientId" value="${found.clientId}" />
                <input type="hidden" name="classTypeId" value="${occurrence.classTypeId}" />
                <input type="hidden" name="token" value="${esc(token)}" />
                <button class="btn alt" type="submit">Explorar accesos</button>
              </form>
            </article>
          </div>
        </div>
      </section>`;

    res.send(renderLayout({ title: 'Booking', body, simulationMode: config.simulationMode }));
  });

  app.post('/checkout/session', async (req, res) => {
    const schema = z.object({ clientId: z.string().min(8), classTypeId: z.string().min(8), token: z.string().min(10).optional() });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).send(renderError('Datos de checkout inválidos'));

    const { clientId, classTypeId, token } = parsed.data;
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

    const tokenQuery = token ? `&token=${encodeURIComponent(token)}` : '';

    if (stripe && product.stripePriceId) {
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        line_items: [{ price: product.stripePriceId, quantity: 1 }],
        success_url: `${config.appUrl}/checkout/success?paymentId=${payment.id}${tokenQuery}`,
        cancel_url: `${config.appUrl}/checkout/cancel?paymentId=${payment.id}${tokenQuery}`,
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

    res.redirect(`/checkout/success?paymentId=${payment.id}${tokenQuery}`);
  });

  app.get('/checkout/success', async (req, res) => {
    const paymentId = String(req.query.paymentId || '');
    const token = String(req.query.token || '');
    const payment = await prisma.payments.findUnique({ where: { id: paymentId }, include: { ticketProduct: true, client: true } });
    if (!payment) return res.status(404).send(renderError('Pago no encontrado'));
    const returnHref = token ? `/booking/start?token=${encodeURIComponent(token)}` : '/classes';
    const returnLabel = token ? 'Volver a la confirmación de lugares' : 'Volver a la agenda';
    const body = `<section class="section"><div class="system-shell">
      <section class="system-hero">
        <p class="concept-kicker">TISA / PAGO</p>
        <h1>Tu acceso quedó acreditado correctamente.</h1>
        <p>${esc(payment.client.email)} adquirió ${esc(payment.ticketProduct.name)} y ya puede volver al flujo para cerrar su reserva.</p>
      </section>
      <div class="system-grid">
        <article class="system-panel system-panel-dark">
          <h2>Compra confirmada</h2>
          <div class="system-action-stack"><a class="btn" href="${returnHref}">${returnLabel}</a></div>
        </article>
      </div>
    </div></section>`;
    res.send(renderLayout({ title: 'Pago exitoso', body, simulationMode: config.simulationMode }));
  });

  app.get('/checkout/cancel', (req, res) => {
    const token = String(req.query.token || '');
    const returnHref = token ? `/booking/start?token=${encodeURIComponent(token)}` : '/classes';
    const returnLabel = token ? 'Volver a tus lugares' : 'Regresar a la agenda';
    const body = `<section class="section"><div class="system-shell">
      <section class="system-hero">
        <p class="concept-kicker">TISA / PAGO</p>
        <h1>No se realizó ningún cargo.</h1>
        <p>Puedes volver al flujo y retomar la reserva cuando te resulte conveniente.</p>
      </section>
      <div class="system-grid">
        <article class="system-panel system-panel-soft">
          <h2>Tu reserva sigue pendiente</h2>
          <div class="system-action-stack"><a class="btn alt" href="${returnHref}">${returnLabel}</a></div>
        </article>
      </div>
    </div></section>`;
    res.send(renderLayout({ title: 'Pago cancelado', body, simulationMode: config.simulationMode }));
  });

  app.post('/bookings', async (req, res) => {
    const schema = z.object({ token: z.string().min(10) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).send(renderError('Request de booking inválido'));

    const { token } = parsed.data;
    const link = await prisma.magic_links.findUnique({ where: { tokenHash: hashToken(token) }, include: { client: true } });
    if (!link || link.usedAt || dayjs(link.expiresAt).isBefore(dayjs())) return res.status(400).send(renderError('Magic link inválido'));

    const context = getMagicLinkContext(link);
    const occurrenceId = String(context.occurrenceId || '');
    const selectedSeatCodes = Array.isArray(context.seatCodes) ? context.seatCodes : [];
    if (!occurrenceId) return res.status(400).send(renderError('El enlace no tiene una clase asociada.'));

    const occurrence = await prisma.class_occurrences.findUnique({
      where: { id: occurrenceId },
      include: { classType: true, trainer: true, location: true },
    });
    if (!occurrence) return res.status(404).send(renderError('Clase no encontrada'));
    if (occurrence.status === 'CANCELLED') return res.status(409).send(renderError('La clase fue cancelada por el trainer.'));

    const occupiedSeatCodes = (
      await prisma.reserved_seats.findMany({
        where: { classOccurrenceId: occurrence.id },
        select: { seatCode: true },
      })
    ).map((seat) => seat.seatCode);
    const validation = validateSeatSelection({ seatCodes: selectedSeatCodes, capacity: occurrence.capacity, occupiedSeatCodes });
    if (!validation.ok) {
      return res.redirect(buildSeatSelectionUrl(occurrence.id, { error: validation.message }));
    }

    const quantity = validation.seats.length;
    if (occurrence.availableSlots < quantity) {
      return res.redirect(buildSeatSelectionUrl(occurrence.id, { error: 'La clase ya no tiene suficientes lugares libres para esa selección.' }));
    }

    const bookingRef = makeBookingRef();
    const qrPayloadObj = {
      booking_ref: bookingRef,
      occurrence_id: occurrence.id,
      client_ref: link.clientId,
      expires_at: dayjs(occurrence.endsAt).toISOString(),
    };
    const qrPayload = JSON.stringify(qrPayloadObj);
    const qrSignature = signPayload(qrPayload, QR_SECRET);
    const seatSummaryJson = JSON.stringify(describeSeatCodes(validation.seats.map((seat) => seat.code), occurrence.capacity));

    let booking;
    try {
      booking = await prisma.$transaction(async (tx) => {
        const freshOccurrence = await tx.class_occurrences.findUnique({ where: { id: occurrence.id } });
        if (!freshOccurrence || freshOccurrence.status === 'CANCELLED') throw new Error('CLASS_CANCELLED');

        const activeSeatCodes = (
          await tx.reserved_seats.findMany({
            where: { classOccurrenceId: occurrence.id },
            select: { seatCode: true },
          })
        ).map((seat) => seat.seatCode);

        const seatValidation = validateSeatSelection({ seatCodes: selectedSeatCodes, capacity: freshOccurrence.capacity, occupiedSeatCodes: activeSeatCodes });
        if (!seatValidation.ok) throw new Error(`SEAT_CONFLICT:${seatValidation.message}`);
        if (freshOccurrence.availableSlots < quantity) throw new Error('NOT_ENOUGH_SLOTS');

        const wallet = await tx.client_wallets.findUnique({
          where: { clientId_classTypeId: { clientId: link.clientId, classTypeId: freshOccurrence.classTypeId } },
        });
        if (!wallet || wallet.credits < quantity) throw new Error('NO_CREDITS');

        const already = await tx.bookings.findFirst({
          where: { clientId: link.clientId, classOccurrenceId: freshOccurrence.id, status: 'BOOKED' },
        });
        if (already) throw new Error('ALREADY_BOOKED');

        const created = await tx.bookings.create({
          data: {
            bookingRef,
            clientId: link.clientId,
            classOccurrenceId: freshOccurrence.id,
            qrPayload,
            qrSignature,
            quantity,
            seatSummaryJson,
            status: 'BOOKED',
          },
        });

        await tx.reserved_seats.createMany({
          data: seatValidation.seats.map((seat) => ({
            bookingId: created.id,
            classOccurrenceId: freshOccurrence.id,
            seatCode: seat.code,
            zone: seat.zone,
          })),
        });

        await tx.client_wallets.update({ where: { id: wallet.id }, data: { credits: { decrement: quantity } } });
        await tx.wallet_ledger.create({
          data: {
            walletId: wallet.id,
            type: 'DEBIT',
            amount: -quantity,
            reason: `Reserva confirmada (${quantity} ${quantity === 1 ? 'lugar' : 'lugares'})`,
            bookingId: created.id,
          },
        });
        await tx.class_occurrences.update({ where: { id: freshOccurrence.id }, data: { availableSlots: { decrement: quantity } } });
        await tx.magic_links.update({ where: { id: link.id }, data: { usedAt: new Date() } });
        return created;
      });
    } catch (error) {
      if (error.code === 'P2002' || String(error.message || '').startsWith('SEAT_CONFLICT:')) {
        const message = error.code === 'P2002' ? 'Uno de los lugares ya fue ocupado por otra reserva.' : String(error.message).replace('SEAT_CONFLICT:', '');
        return res.redirect(buildSeatSelectionUrl(occurrence.id, { error: message }));
      }
      if (String(error.message) === 'NOT_ENOUGH_SLOTS') {
        return res.redirect(buildSeatSelectionUrl(occurrence.id, { error: 'La clase ya no tiene suficientes lugares libres para esa selección.' }));
      }
      if (String(error.message) === 'NO_CREDITS') return res.status(409).send(renderError('No hay créditos suficientes para confirmar esos lugares.'));
      if (String(error.message) === 'ALREADY_BOOKED') return res.status(409).send(renderError('Ya existe una reserva activa para esta clase con este correo.'));
      if (String(error.message) === 'CLASS_CANCELLED') return res.status(409).send(renderError('La clase fue cancelada por el trainer.'));
      throw error;
    }

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

    const baseUrl = getBaseUrl(req);
    const bookingUrl = `${baseUrl}/booking/manage?token=${bookingUrlToken}&bookingId=${booking.id}`;
    const seatLabels = formatSeatLabels(selectedSeatCodes, occurrence.capacity);

    await sendBookingConfirmationEmail({
      to: link.client.email,
      bookingRef: booking.bookingRef,
      bookingUrl,
      className: occurrence.classType.name,
      classDate: dayjs(occurrence.startsAt).format('DD MMM YYYY · HH:mm'),
      trainerName: occurrence.trainer.displayName,
      locationName: occurrence.location.name,
      seatLabels,
      quantity,
      qrDataUrl,
    });

    const body = `<section class="section"><div class="system-shell">
      <section class="system-hero scroll-hero" data-scroll-target="booking-confirm-detail">
        <p class="concept-kicker">TISA / CONFIRMACIÓN</p>
        <h1>Tu reserva ya quedó confirmada.</h1>
        <p>Referencia <strong>${booking.bookingRef}</strong>. Guarda este QR y revisa el detalle de tus lugares cuando quieras.</p>
      </section>
      <div class="system-grid" id="booking-confirm-detail">
        <article class="system-panel system-panel-light">
          <h2>Resumen</h2>
          <div class="system-detail-list">
            <div><span>Correo</span><strong>${esc(link.client.email)}</strong></div>
            <div><span>Lugares</span><strong>${esc(seatLabels)}</strong></div>
            <div><span>Personas</span><strong>${quantity}</strong></div>
          </div>
        </article>
        <article class="system-panel system-panel-dark">
          <h2>Acceso al estudio</h2>
          <img class="qr" src="${qrDataUrl}" alt="QR" />
          <div class="system-action-stack">
            <a class="btn" href="${bookingUrl}">Ver detalle de la reserva</a>
            <a class="btn alt" href="/classes">Reservar otra práctica</a>
          </div>
        </article>
      </div>
    </div></section>`;
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
    const qrDataUrl = await QRCode.toDataURL(JSON.stringify({ ...parseJson(booking.qrPayload, {}), signature: booking.qrSignature }));
    const seatSummary = describeSeatCodes(parseJson(booking.seatSummaryJson, []).map((seat) => seat.code || seat.label), booking.classOccurrence.capacity);
    const seatLabels = seatSummary.map((seat) => seat.label).join(', ');

    const body = `<section class="section">
      <div class="system-shell">
        <section class="system-hero scroll-hero" data-scroll-target="manage-booking-grid">
          <p class="concept-kicker">TISA / RESERVA</p>
          <h1>Tu reserva permanece contigo hasta el momento de entrar.</h1>
          <p>Consulta el estado, presenta el QR al llegar y cancela si todavía estás dentro de la ventana permitida.</p>
        </section>
        <div class="system-grid" id="manage-booking-grid">
          <article class="system-panel system-panel-light">
            <h2>${esc(booking.classOccurrence.classType.name)}</h2>
            <div class="system-detail-list">
              <div><span>Correo</span><strong>${esc(booking.client.email)}</strong></div>
              <div><span>Guía</span><strong>${esc(booking.classOccurrence.trainer.displayName)}</strong></div>
              <div><span>Espacio</span><strong>${esc(booking.classOccurrence.location.name)}</strong></div>
              <div><span>Lugares</span><strong>${esc(seatLabels || 'Sin lugares asignados')}</strong></div>
              <div><span>Personas</span><strong>${booking.quantity}</strong></div>
              <div><span>Estado</span><strong>${getBookingStateLabel(booking.status)}</strong></div>
            </div>
            ${booking.status === 'BOOKED' ? `<form method="post" action="/bookings/${booking.id}/cancel" class="system-action-stack"><button class="btn alt" type="submit">Cancelar reserva</button></form>` : ''}
          </article>
          <article class="system-panel system-panel-dark">
            <h2>Tu QR de acceso</h2>
            <p>Presenta este código al llegar al estudio para completar tu entrada del grupo completo.</p>
            <img class="qr" src="${qrDataUrl}" alt="QR" />
          </article>
        </div>
      </div>
    </section>`;
    res.send(renderLayout({ title: 'Gestionar reserva', body, simulationMode: config.simulationMode }));
  });

  app.post('/bookings/:id/cancel', async (req, res) => {
    const booking = await prisma.bookings.findUnique({ where: { id: req.params.id }, include: { classOccurrence: true } });
    if (!booking || booking.status !== 'BOOKED') return res.status(404).send(renderError('Booking no cancelable'));

    const cutoff = dayjs(booking.classOccurrence.startsAt).subtract(2, 'hour');
    const eligibleRefund = dayjs().isBefore(cutoff);

    await prisma.$transaction(async (tx) => {
      await tx.bookings.update({ where: { id: booking.id }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
      await tx.reserved_seats.deleteMany({ where: { bookingId: booking.id } });
      await tx.class_occurrences.update({ where: { id: booking.classOccurrenceId }, data: { availableSlots: { increment: booking.quantity } } });

      if (eligibleRefund) {
        const wallet = await tx.client_wallets.findUnique({ where: { clientId_classTypeId: { clientId: booking.clientId, classTypeId: booking.classOccurrence.classTypeId } } });
        if (wallet) {
          await tx.client_wallets.update({ where: { id: wallet.id }, data: { credits: { increment: booking.quantity } } });
          await tx.wallet_ledger.create({
            data: {
              walletId: wallet.id,
              type: 'REFUND',
              amount: booking.quantity,
              reason: 'Cancelación en ventana válida',
              bookingId: booking.id,
            },
          });
        }
      }
    });

    res.redirect('/classes');
  });

  app.get('/staff/login', (req, res) => {
    const body = `<section class="section">
      <div class="system-shell">
        <section class="system-hero">
          <p class="concept-kicker">TISA / STAFF</p>
          <h1>La operación merece una entrada clara, sobria y confiable.</h1>
          <p>Administración, trainers y check-in comparten el mismo lenguaje visual, mientras cada rol conserva un flujo preciso.</p>
        </section>
        <div class="system-grid">
          <article class="system-panel system-panel-light">
            <h2>Acceso staff</h2>
            <form method="post" action="/staff/login" class="admin-login-mock">
              <label class="form-row"><span>Email</span><input class="admin-input" type="email" name="email" required /></label>
              <label class="form-row"><span>Password</span><input class="admin-input" type="password" name="password" required /></label>
              <button class="btn" type="submit">Entrar</button>
            </form>
          </article>
          <article class="system-panel system-panel-dark">
            <h2>Superficies operativas</h2>
            <div class="admin-list">
              <div class="admin-list-row"><div><strong>Admin</strong><p>Indicadores, pagos y lectura diaria del estudio.</p></div></div>
              <div class="admin-list-row"><div><strong>Trainer</strong><p>Agenda, sesiones y control fino de cada práctica.</p></div></div>
              <div class="admin-list-row"><div><strong>Ops</strong><p>Check-in ágil y validación QR con certeza.</p></div></div>
            </div>
          </article>
        </div>
      </div>
    </section>`;
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

    const body = `<section class="section">
      <div class="system-shell">
        <section class="system-hero scroll-hero" data-scroll-target="admin-metrics">
          <p class="concept-kicker">TISA / ADMIN</p>
          <h1>La operación también debe sentirse precisa, elegante y confiable.</h1>
          <p>Lectura clara de métricas, seguimiento de ocupación y acceso directo a la agenda activa del estudio dentro de una sola superficie.</p>
          <div class="system-chip-row">
            <button type="button" class="system-chip-button" data-scroll-target="admin-metrics">Métricas</button>
            <button type="button" class="system-chip-button" data-scroll-target="admin-occupancy">Ocupación</button>
          </div>
        </section>
        <div class="system-grid">
          <article class="system-panel system-panel-dark" id="admin-metrics">
            <h2>Señales principales del día</h2>
            <div class="admin-metric-grid">
              <div><span>Reservas activas</span><strong>${bookings}</strong></div>
              <div><span>Clientes</span><strong>${clients}</strong></div>
              <div><span>Pagos aprobados</span><strong>${paid}</strong></div>
              <div><span>Prácticas próximas</span><strong>${classes}</strong></div>
            </div>
          </article>
          <article class="system-panel system-panel-light" id="admin-occupancy">
            <h2>Lectura de ocupación</h2>
            <div class="admin-list">${topClasses.map((c) => `<div class="admin-list-row"><div><strong>${esc(c.classType.name)}</strong><p>${esc(c.trainer.displayName)}</p></div><strong>${c.capacity - c.availableSlots}/${c.capacity}</strong></div>`).join('')}</div>
          </article>
        </div>
      </div>
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
      <div class="system-shell">
      <section class="system-hero scroll-hero" data-scroll-target="trainer-calendar">
        <p class="concept-kicker">TISA / TRAINER</p>
        <h1>Tu agenda debe sentirse tan clara como tu práctica.</h1>
        <p>Programa sesiones, revisa reservas y cancela clases desde una vista pensada para leerse con rapidez, en semana o en mes.</p>
      </section>
      <div class="calendar-toolbar" id="trainer-calendar">
        <h2>Agenda del trainer</h2>
        <div class="calendar-toolbar-actions">
          <a class="btn alt" href="/trainer/classes?view=${view}&start=${prevStart.format('YYYY-MM-DD')}">Anterior</a>
          <span class="calendar-range">${titleRange}</span>
          <a class="btn alt" href="/trainer/classes?view=${view}&start=${nextStart.format('YYYY-MM-DD')}">Siguiente</a>
          <a class="btn ${view === 'week' ? '' : 'alt'}" href="/trainer/classes?view=week&start=${periodStart.format('YYYY-MM-DD')}">Semana</a>
          <a class="btn ${view === 'month' ? '' : 'alt'}" href="/trainer/classes?view=month&start=${periodStart.format('YYYY-MM-DD')}">Mes</a>
        </div>
      </div>
      <div class="card trainer-create-card">
        <h3>Programar nueva práctica</h3>
        <form method="post" action="/trainer/classes">
          <div class="grid">
            <div class="form-row"><label>Tipo de clase</label><select name="classTypeId" required>${classTypeOptions}</select></div>
            <div class="form-row"><label>Sede</label><select name="locationId" required>${locationOptions}</select></div>
            <div class="form-row"><label>Fecha</label><input type="date" name="date" required /></div>
            <div class="form-row"><label>Hora inicio</label><input type="time" name="startTime" required /></div>
            <div class="form-row"><label>Duración (min)</label><input type="number" name="durationMin" min="30" max="180" value="60" required /></div>
            <div class="form-row"><label>Cupo</label><input type="number" name="capacity" min="1" max="80" value="18" required /></div>
          </div>
          <button class="btn" type="submit">Guardar en agenda</button>
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
      </div>
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
    if (capacity > MAX_LAYOUT_CAPACITY) {
      return res.status(400).send(renderError(`La capacidad máxima para el mapa fijo actual es ${MAX_LAYOUT_CAPACITY} lugares.`));
    }

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
        await tx.reserved_seats.deleteMany({ where: { classOccurrenceId: occurrence.id } });

        for (const booking of occurrence.bookings) {
          const wallet = await tx.client_wallets.findUnique({
            where: { clientId_classTypeId: { clientId: booking.clientId, classTypeId: occurrence.classTypeId } },
          });
          if (wallet) {
            await tx.client_wallets.update({ where: { id: wallet.id }, data: { credits: { increment: booking.quantity } } });
            await tx.wallet_ledger.create({
              data: {
                walletId: wallet.id,
                type: 'REFUND',
                amount: booking.quantity,
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
    const body = `<section class="section">
      <div class="system-shell">
        <section class="system-hero scroll-hero" data-scroll-target="ops-checkin-grid">
          <p class="concept-kicker">TISA / CHECK-IN</p>
          <h1>Validar accesos debe sentirse inmediato y seguro.</h1>
          <p>Escanea un QR o pega el payload manual y recibe una respuesta clara dentro de la misma superficie operativa.</p>
        </section>
        <div class="system-grid" id="ops-checkin-grid">
          <article class="system-panel system-panel-dark">
            <h2>Escáner</h2>
            <div id="reader" class="ops-camera" style="width:100%;max-width:420px">Esperando cámara</div>
          </article>
          <article class="system-panel system-panel-light">
            <h2>Validación manual</h2>
            <form method="post" action="/ops/checkin/scan" class="admin-login-mock">
              <label class="form-row"><span>Payload QR o JSON</span><textarea class="admin-input tall" name="payload" rows="5" required></textarea></label>
              <button class="btn" type="submit">Validar acceso</button>
            </form>
          </article>
        </div>
      </div>
      <script src="https://unpkg.com/html5-qrcode"></script>
      <script>
        const out = document.querySelector('textarea[name="payload"]');
        if (window.Html5QrcodeScanner) {
          const scanner = new Html5QrcodeScanner('reader', { fps: 10, qrbox: 220 });
          scanner.render((text) => { out.value = text; }, () => {});
        }
      </script>
    </section>`;
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

    const booking = await prisma.bookings.findUnique({
      where: { bookingRef: booking_ref },
      include: { classOccurrence: true, client: true },
    });
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

    const seatLabels = describeSeatCodes(parseJson(booking.seatSummaryJson, []).map((seat) => seat.code || seat.label), booking.classOccurrence.capacity)
      .map((seat) => seat.label)
      .join(', ');

    const body = `<section class="section"><div class="system-shell">
      <section class="system-hero">
        <p class="concept-kicker">TISA / CHECK-IN</p>
        <h1>Acceso autorizado.</h1>
        <p>La referencia ${booking.bookingRef} ya quedó validada para ${esc(booking.client.email)} y puede entrar al estudio.</p>
      </section>
      <div class="system-grid">
        <article class="system-panel system-panel-light">
          <h2>Reserva validada</h2>
          <div class="system-detail-list">
            <div><span>Personas</span><strong>${booking.quantity}</strong></div>
            <div><span>Lugares</span><strong>${esc(seatLabels || 'Sin lugares asignados')}</strong></div>
          </div>
        </article>
        <article class="system-panel system-panel-light">
          <h2>Siguiente validación</h2>
          <div class="system-action-stack"><a class="btn" href="/ops/checkin">Validar otro acceso</a></div>
        </article>
      </div>
    </div></section>`;
    res.send(renderLayout({ title: 'Check-in OK', body, staff: req.session.staffName, simulationMode: config.simulationMode }));
  });

  app.get('/health', (req, res) => res.json({ status: 'ok', app: 'tisa-studio' }));

  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).send(renderLayout({ title: 'Error', body: renderError(err.message || 'Error interno'), simulationMode: config.simulationMode }));
  });

  return app;
}
