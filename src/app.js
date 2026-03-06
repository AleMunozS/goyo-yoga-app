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
      `${stats.bundles || 0} bundles visibles para compra rápida`,
    ]
      .map((item) => `<div class="proof-chip reveal">${item}</div>`)
      .join('');

    const body = `
      <section class="story-root">
        <div class="ambient-lights" aria-hidden="true">
          <span class="light-orb orb-1"></span>
          <span class="light-orb orb-2"></span>
          <span class="light-orb orb-3"></span>
          <span class="light-orb orb-4"></span>
        </div>

        <section class="landing-banner scroll-hero reveal" data-scroll-target="landing-main-hero">
          <div class="landing-banner-card">
            <p class="eyebrow">TISA</p>
            <h1>Respira. Elige tu práctica. Reserva en segundos.</h1>
            <p>Haz click y baja directo a la experiencia del estudio.</p>
          </div>
        </section>

        <section class="hero parallax dune-hero scroll-hero" id="landing-main-hero" data-scroll-target="landing-overview">
          <div class="hero-card hero-premium reveal">
            <div class="hero-grid">
              <div class="hero-copy">
                <p class="eyebrow">TISA · AGENDA · ACCESOS</p>
                <h1>Reserva tu clase sin vueltas.</h1>
                <p>Consulta horarios, usa tus accesos y confirma tu entrada con QR desde una sola experiencia clara.</p>
                <div class="hero-actions">
                  <button type="button" class="btn" data-scroll-target="landing-overview">Ver cómo funciona</button>
                  <a class="btn alt" href="/classes">Ir a la agenda</a>
                </div>
                <div class="proof-row">${proofCards}</div>
              </div>
              <div class="hero-aside">
                <div class="hero-aside-card">
                  <span>Reserva</span>
                  <strong>Explora horarios y aparta tu lugar.</strong>
                  <p>La agenda muestra disponibilidad, guía y horario sin pasos innecesarios.</p>
                </div>
                <div class="hero-aside-card">
                  <span>Acceso</span>
                  <strong>Confirma por correo y entra con QR.</strong>
                  <p>Cliente, staff y operación comparten el mismo flujo visual.</p>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section class="section section-band reveal" id="landing-overview">
          <div class="band-shell">
            <div>
              <p class="eyebrow">LANDING · AGENDA · PRODUCTO</p>
              <h2>Un mismo recorrido para descubrir, reservar y entrar al estudio.</h2>
            </div>
            <p>La landing ahora arranca directo en el hero principal y baja a una historia clara del producto: inspiración, agenda, accesos y operación.</p>
          </div>
        </section>

        <section class="section split-section reveal">
          <article class="card split-left premium-copy">
              <h2>El equilibrio entre ritual y producto</h2>
              <p>Inspirado por ciclos de luz y sombra, TISA integra movimiento, respiración y foco mental sin perder claridad operacional.</p>
              <p>La propuesta nueva no solo vende una clase; presenta una plataforma con storytelling, agenda robusta y acceso controlado.</p>
              <p class="quote">"Una practica que se siente exclusiva y una operacion que no se siente pesada."</p>
          </article>
          <article class="card split-right premium-preview">
            <div class="clay-shape"></div>
            <div class="preview-caption">
              <strong>Interfaz cálida y clara</strong>
              <p>Texturas minerales, paneles suaves y contraste suficiente para una reserva real.</p>
            </div>
          </article>
        </section>

        <section class="section">
          <div class="section-heading reveal">
            <p class="eyebrow">CLASES</p>
            <h2>Experiencias TISA</h2>
            <p>Las clases dejan de verse como tarjetas genéricas y se presentan como experiencias con tono, duración y promesa clara.</p>
          </div>
          <div class="grid">${typeCards}</div>
        </section>

        <section class="section">
          <div class="section-heading reveal">
            <p class="eyebrow">RITUAL DE RESERVA</p>
            <h2>El flujo principal ya se entiende mejor</h2>
            <p>Antes faltaban secciones que explicaran como funciona el producto. Ahora la home cuenta la historia completa del usuario.</p>
          </div>
          <div class="grid ritual-grid">${ritualCards}</div>
        </section>

        <section class="section schedule-shell reveal">
          <div class="card schedule-board">
            <div class="section-heading compact">
              <p class="eyebrow">AGENDA RESPONSIVE</p>
              <h2>Agenda destacada</h2>
              <p>Una muestra del calendario que debe sentirse util tanto en escritorio como en movil.</p>
            </div>
            <div class="timeline">${timeline}</div>
            <a class="btn" href="/classes">Ver horarios completos</a>
          </div>
        </section>

        <section class="section">
          <div class="section-heading reveal">
            <p class="eyebrow">WALLET · BUNDLES</p>
            <h2>Bundles de tickets</h2>
            <p>La home ahora anticipa el wallet del cliente y enmarca mejor el valor de compra antes de reservar.</p>
          </div>
          <div class="grid">${bundleCards || '<div class="card">Próximamente bundles activos.</div>'}</div>
        </section>

        <section class="section reveal">
          <div class="card ops-showcase">
            <div class="ops-copy">
              <p class="eyebrow">STAFF SURFACES</p>
              <h2>Admin, trainer y ops entran al mismo lenguaje visual.</h2>
              <p>Tambien faltaba representar la parte operativa. Esta seccion adelanta dashboards, gestion de clases y un check-in pensado para velocidad y certeza.</p>
            </div>
            <div class="ops-panels">
              <div class="ops-panel">
                <span>Admin dashboard</span>
                <strong>KPIs, ocupacion y seguimiento.</strong>
              </div>
              <div class="ops-panel">
                <span>Trainer planner</span>
                <strong>Calendario, roster y control de sesiones.</strong>
              </div>
              <div class="ops-panel">
                <span>Ops check-in</span>
                <strong>QR visible, validacion rapida y errores claros.</strong>
              </div>
            </div>
          </div>
        </section>

        <section class="section reveal">
          <div class="card final-manifesto">
            <h2>Al final del recorrido, solo queda enfoque.</h2>
            <p>Desliza, reserva y entra a clase con una experiencia mas completa: intro previo, landing reforzado y secciones suficientes para vender el producto entero.</p>
            <a class="btn alt" href="/classes">Comenzar ahora</a>
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
      { step: '01', title: 'Discover the rhythm', text: 'Una portada limpia, una voz de marca más precisa y una entrada sin fricción ni overlays frágiles.' },
      { step: '02', title: 'Book in one gesture', text: 'La agenda se siente más editorial y el booking más dirigido, con mejor jerarquía visual.' },
      { step: '03', title: 'Arrive with certainty', text: 'Wallet, QR y check-in viven dentro del mismo sistema visual y no como módulos separados.' },
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
              <p class="concept-label">TISA / CONCEPT 01</p>
              <h1>A sharper identity for a studio that should feel calm, expensive and immediate.</h1>
              <p class="concept-copy">Esta propuesta abandona la estética anterior y cambia el tono completo: más contraste, más composición editorial, menos bloques repetidos y una agenda que se siente parte de una marca, no de un panel administrativo.</p>
              <div class="concept-actions">
                <a class="btn" href="/classes">Abrir agenda actual</a>
                <a class="btn alt" href="/">Comparar con home actual</a>
              </div>
            </div>
            <div class="concept-poster">
              <div class="concept-poster-card">
                <span>TISA Studio System</span>
                <strong>Breath, heat, focus, reset.</strong>
                <p>Un sistema visual hecho para convertir mejor y sentirse más premium en móvil.</p>
              </div>
              <div class="concept-poster-aside">
                <p>Intentional booking flow</p>
                <p>Editorial pacing</p>
                <p>Cleaner operations</p>
              </div>
            </div>
          </div>
        </section>

        <section class="concept-section concept-split">
          <article class="concept-panel dark">
            <p class="concept-label">WHY THIS IS DIFFERENT</p>
            <h2>No more intro dependency.</h2>
            <p>El acceso principal ya no depende de una intro animada que puede fallar. La primera impresión viene de una hero estable con dirección visual más fuerte.</p>
          </article>
          <article class="concept-panel light">
            <p class="concept-label">VISUAL SYSTEM</p>
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
            <p class="concept-label">LIVE SCHEDULE DIRECTION</p>
            <h2>The booking surface should feel curated, not generic.</h2>
          </div>
          <div class="concept-schedule-grid">
            ${scheduleCards}
          </div>
        </section>

        <section class="concept-section concept-rituals">
          <div class="concept-section-heading">
            <p class="concept-label">FLOW</p>
            <h2>A three-part journey with cleaner intent.</h2>
          </div>
          <div class="concept-ritual-grid">
            ${ritualCards}
          </div>
        </section>

        <section class="concept-section concept-dual-grid">
          <article class="concept-panel light">
            <p class="concept-label">PRACTICE MENU</p>
            <h2>Programs with a quieter hierarchy.</h2>
            <ul class="concept-program-list">
              ${typeList}
            </ul>
          </article>
          <article class="concept-panel accent">
            <p class="concept-label">BUNDLES</p>
            <h2>Membership value visible before the click.</h2>
            <div class="concept-bundle-grid">
              ${bundleCards}
            </div>
          </article>
        </section>

        <section class="concept-section">
          <div class="concept-final-card">
            <p class="concept-label">NEXT STEP</p>
            <h2>If you approve this direction, I turn this into frames in Figma and then replace the real surfaces.</h2>
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
              <p>Créditos Flow Suave</p>
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

    const classCount = classes.length;
    const availableCount = classes.filter((c) => c.status !== 'CANCELLED' && c.availableSlots > 0).length;
    const firstClass = classes[0];

    const body = `<section class="section page-shell">
      <div class="page-hero page-hero-grid reveal scroll-hero" data-scroll-target="classes-calendar">
        <div class="page-hero-copy">
          <p class="page-kicker">TISA · AGENDA · RESERVA CLARA</p>
          <h1>Agenda viva para reservar sin fricción.</h1>
          <p class="page-lede">Explora la semana o el mes, detecta disponibilidad al instante y abre la reserva desde el mismo bloque de clase. Todo el flujo está pensado para que el estudio se sienta premium y claro.</p>
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
            <span>Como funciona</span>
            <strong>Toca cualquier bloque, deja tu email y sigue el magic link.</strong>
            <p>Si ya tienes créditos, confirmas en un paso. Si no, compras bundle y vuelves al flujo.</p>
          </div>
          <div class="spotlight-card muted">
            <span>Ventaja</span>
            <strong>La disponibilidad, el trainer y la ubicación viven en la misma vista.</strong>
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
      <p class="calendar-subtitle">Selecciona cualquier bloque para reservar. Las clases canceladas aparecen bloqueadas.</p>
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

      <dialog id="booking-modal" class="booking-modal">
        <div class="booking-modal-card">
          <button type="button" class="booking-close" data-close-booking>&times;</button>
          <p class="page-kicker compact">RESERVA RAPIDA</p>
          <h3 id="booking-title">Reservar clase</h3>
          <p id="booking-meta" class="modal-support"></p>
          <p id="booking-seats" class="modal-support"></p>
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
        <div class="system-shell">
          <section class="system-hero scroll-hero" data-scroll-target="magic-link-detail">
            <p class="concept-kicker">TISA / ACCESO</p>
            <h1>Tu enlace ya está listo.</h1>
            <p>Generamos un acceso temporal para continuar la reserva sin contraseña. En simulación puedes abrirlo de inmediato y seguir dentro del mismo flujo.</p>
            <div class="system-chip-row">
              <button type="button" class="system-chip-button" data-scroll-target="magic-link-detail">Abrir detalle</button>
              <button type="button" class="system-chip-button" data-scroll-target="magic-link-actions">Ir a acciones</button>
            </div>
          </section>
          <div class="system-grid" id="magic-link-detail">
            <article class="system-panel system-panel-light">
              <h2>Acceso temporal</h2>
              <div class="system-detail-list">
                <div><span>Correo</span><strong>${esc(email)}</strong></div>
                <div><span>Ventana</span><strong>30 minutos</strong></div>
                <div><span>Propósito</span><strong>Continuar la reserva sin fricción</strong></div>
              </div>
            </article>
            <article class="system-panel system-panel-dark" id="magic-link-actions">
              <h2>Continúa el flujo</h2>
              <div class="system-action-stack">
                <a class="btn" href="${url}">Abrir enlace mágico</a>
                <a class="btn alt" href="/classes">Volver a agenda</a>
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
      <section class="section">
        <div class="system-shell">
          <section class="system-hero scroll-hero" data-scroll-target="booking-start-grid">
            <p class="concept-kicker">TISA / RESERVA</p>
            <h1>Confirma tu lugar con calma.</h1>
            <p>Tu enlace validó la identidad. Desde aquí puedes usar un crédito o comprar un acceso sin salir del mismo flujo.</p>
            <div class="system-chip-row">
              <button type="button" class="system-chip-button" data-scroll-target="booking-start-grid">Ver opciones</button>
              <button type="button" class="system-chip-button" data-scroll-target="booking-start-class">Clase</button>
            </div>
          </section>
          <div class="system-grid" id="booking-start-grid">
            <article class="system-panel system-panel-light" id="booking-start-class">
              <h2>${esc(occurrence.classType.name)}</h2>
              <div class="system-detail-list">
                <div><span>Horario</span><strong>${dayjs(occurrence.startsAt).format('DD MMM · HH:mm')}</strong></div>
                <div><span>Guía</span><strong>${esc(occurrence.trainer.displayName)}</strong></div>
                <div><span>Estudio</span><strong>${esc(occurrence.location.name)}</strong></div>
                <div><span>Cliente</span><strong>${esc(found.client.email)}</strong></div>
              </div>
            </article>
            <article class="system-panel system-panel-soft">
              <h2>Tu saldo</h2>
              <div class="system-detail-list">
                <div><span>Créditos disponibles</span><strong>${wallet?.credits || 0}</strong></div>
                <div><span>Siguiente paso</span><strong>Usa un crédito y asegura tu espacio</strong></div>
              </div>
              <form action="/bookings" method="post" class="system-action-stack">
                <input type="hidden" name="token" value="${esc(token)}" />
                <input type="hidden" name="occurrenceId" value="${occurrence.id}" />
                <button class="btn" type="submit">Consumir 1 ticket y reservar</button>
              </form>
            </article>
            <article class="system-panel system-panel-dark">
              <h2>Sin créditos</h2>
              <p>Compra un acceso para esta práctica y vuelve al flujo sin perder contexto.</p>
              <form action="/checkout/session" method="post" class="system-action-stack">
                <input type="hidden" name="clientId" value="${found.clientId}" />
                <input type="hidden" name="classTypeId" value="${occurrence.classTypeId}" />
                <button class="btn alt" type="submit">Comprar acceso</button>
              </form>
            </article>
          </div>
        </div>
      </section>`;

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
    const body = `<section class="section"><div class="system-shell">
      <section class="system-hero">
        <p class="concept-kicker">TISA / PAGO</p>
        <h1>Acceso acreditado correctamente.</h1>
        <p>${esc(payment.client.email)} compró ${esc(payment.ticketProduct.name)} y ya puede volver a la agenda para completar su reserva.</p>
      </section>
      <div class="system-grid">
        <article class="system-panel system-panel-dark">
          <h2>Compra confirmada</h2>
          <div class="system-action-stack"><a class="btn" href="/classes">Volver a clases</a></div>
        </article>
      </div>
    </div></section>`;
    res.send(renderLayout({ title: 'Pago exitoso', body, simulationMode: config.simulationMode }));
  });

  app.get('/checkout/cancel', (req, res) => {
    const body = `<section class="section"><div class="system-shell">
      <section class="system-hero">
        <p class="concept-kicker">TISA / PAGO</p>
        <h1>No se aplicaron cambios.</h1>
        <p>Puedes volver a la agenda y continuar la reserva cuando quieras.</p>
      </section>
      <div class="system-grid">
        <article class="system-panel system-panel-soft">
          <h2>Reserva pendiente</h2>
          <div class="system-action-stack"><a class="btn alt" href="/classes">Regresar a agenda</a></div>
        </article>
      </div>
    </div></section>`;
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

    const body = `<section class="section"><div class="system-shell">
      <section class="system-hero scroll-hero" data-scroll-target="booking-confirm-detail">
        <p class="concept-kicker">TISA / CONFIRMACIÓN</p>
        <h1>Tu acceso ya está listo.</h1>
        <p>Referencia <strong>${booking.bookingRef}</strong>. Guarda este QR o abre el detalle de la reserva cuando lo necesites.</p>
      </section>
      <div class="system-grid" id="booking-confirm-detail">
        <article class="system-panel system-panel-dark">
          <h2>Ingreso al estudio</h2>
          <img class="qr" src="${qrDataUrl}" alt="QR" />
          <div class="system-action-stack">
            <a class="btn" href="${bookingUrl}">Ver detalle de reserva</a>
            <a class="btn alt" href="/classes">Reservar otra clase</a>
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
    const qrDataUrl = await QRCode.toDataURL(JSON.stringify({ ...JSON.parse(booking.qrPayload), signature: booking.qrSignature }));

    const body = `<section class="section">
      <div class="system-shell">
        <section class="system-hero scroll-hero" data-scroll-target="manage-booking-grid">
          <p class="concept-kicker">TISA / RESERVA</p>
          <h1>Tu reserva sigue a mano.</h1>
          <p>Consulta el estado, presenta el QR al llegar y cancela si todavía estás dentro de la ventana válida.</p>
        </section>
        <div class="system-grid" id="manage-booking-grid">
          <article class="system-panel system-panel-light">
            <h2>${esc(booking.classOccurrence.classType.name)}</h2>
            <div class="system-detail-list">
              <div><span>Correo</span><strong>${esc(booking.client.email)}</strong></div>
              <div><span>Guía</span><strong>${esc(booking.classOccurrence.trainer.displayName)}</strong></div>
              <div><span>Espacio</span><strong>${esc(booking.classOccurrence.location.name)}</strong></div>
              <div><span>Estado</span><strong>${booking.status}</strong></div>
            </div>
            ${booking.status === 'BOOKED' ? `<form method="post" action="/bookings/${booking.id}/cancel" class="system-action-stack"><button class="btn alt" type="submit">Cancelar reserva</button></form>` : ''}
          </article>
          <article class="system-panel system-panel-dark">
            <h2>Acceso QR</h2>
            <p>Presenta este código al llegar al estudio.</p>
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
    const body = `<section class="section">
      <div class="system-shell">
        <section class="system-hero">
          <p class="concept-kicker">TISA / STAFF</p>
          <h1>La operación entra por una puerta clara.</h1>
          <p>Admin, trainer y check-in comparten el mismo lenguaje visual, pero cada rol conserva su flujo operativo.</p>
        </section>
        <div class="system-grid">
          <article class="system-panel system-panel-light">
            <h2>Ingreso staff</h2>
            <form method="post" action="/staff/login" class="admin-login-mock">
              <label class="form-row"><span>Email</span><input class="admin-input" type="email" name="email" required /></label>
              <label class="form-row"><span>Password</span><input class="admin-input" type="password" name="password" required /></label>
              <button class="btn" type="submit">Entrar</button>
            </form>
          </article>
          <article class="system-panel system-panel-dark">
            <h2>Roles disponibles</h2>
            <div class="admin-list">
              <div class="admin-list-row"><div><strong>Admin</strong><p>Métricas, pagos y ocupación.</p></div></div>
              <div class="admin-list-row"><div><strong>Trainer</strong><p>Agenda, roster y control de clases.</p></div></div>
              <div class="admin-list-row"><div><strong>Ops</strong><p>Check-in rápido y validación QR.</p></div></div>
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
          <h1>La operación también debe sentirse precisa.</h1>
          <p>Lectura clara de métricas, seguimiento de ocupación y acceso directo a la agenda activa del estudio.</p>
          <div class="system-chip-row">
            <button type="button" class="system-chip-button" data-scroll-target="admin-metrics">Métricas</button>
            <button type="button" class="system-chip-button" data-scroll-target="admin-occupancy">Ocupación</button>
          </div>
        </section>
        <div class="system-grid">
          <article class="system-panel system-panel-dark" id="admin-metrics">
            <h2>Resumen del estudio</h2>
            <div class="admin-metric-grid">
              <div><span>Bookings activos</span><strong>${bookings}</strong></div>
              <div><span>Clientes</span><strong>${clients}</strong></div>
              <div><span>Pagos aprobados</span><strong>${paid}</strong></div>
              <div><span>Clases próximas</span><strong>${classes}</strong></div>
            </div>
          </article>
          <article class="system-panel system-panel-light" id="admin-occupancy">
            <h2>Ocupación</h2>
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
        <h1>Tu agenda se mueve con precisión.</h1>
        <p>Programa sesiones, revisa reservas y cancela clases desde una vista pensada para leer rápido en semana o mes.</p>
      </section>
      <div class="calendar-toolbar" id="trainer-calendar">
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
    const body = `<section class="section">
      <div class="system-shell">
        <section class="system-hero scroll-hero" data-scroll-target="ops-checkin-grid">
          <p class="concept-kicker">TISA / CHECK-IN</p>
          <h1>Validar accesos debe sentirse inmediato.</h1>
          <p>Escanea un QR o pega el payload manual y recibe una respuesta clara dentro de la misma superficie operativa.</p>
        </section>
        <div class="system-grid" id="ops-checkin-grid">
          <article class="system-panel system-panel-dark">
            <h2>Cámara</h2>
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

    const body = `<section class="section"><div class="system-shell">
      <section class="system-hero">
        <p class="concept-kicker">TISA / CHECK-IN</p>
        <h1>Acceso autorizado.</h1>
        <p>La referencia ${booking.bookingRef} ya quedó validada para entrar al estudio.</p>
      </section>
      <div class="system-grid"><article class="system-panel system-panel-light"><h2>Siguiente validación</h2><div class="system-action-stack"><a class="btn" href="/ops/checkin">Validar otro acceso</a></div></article></div>
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
