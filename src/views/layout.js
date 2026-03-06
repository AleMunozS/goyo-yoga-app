import { esc } from '../utils.js';

export function renderLayout({ title, body, staff = null, simulationMode = true }) {
  const isLandingIntro = title === 'Inicio' && !staff;
  const isConceptBoard = title.startsWith('Concept') && !staff;
  const appName = 'TISA';
  const nav = staff
    ? `
      <nav class="top-nav staff-nav">
        <a href="/admin/dashboard">Admin</a>
        <a href="/trainer/classes">Trainer</a>
        <a href="/ops/checkin">Check-in</a>
        <form action="/staff/logout" method="post"><button type="submit">Salir</button></form>
      </nav>
    `
    : isConceptBoard
    ? `
      <nav class="top-nav concept-nav">
        <a href="/concept-tisa-01">01</a>
        <a href="/concept-tisa-02">02</a>
        <a href="/concept-tisa-mobile">Móvil</a>
        <a href="/concept-tisa-calendar">Calendario</a>
        <a href="/concept-tisa-access">Acceso</a>
        <a href="/concept-tisa-admin">Admin</a>
        <a href="/classes">Agenda</a>
      </nav>
    `
    : `
      <nav class="top-nav public-nav">
        <a href="/">Inicio</a>
        <a href="/classes">Agenda</a>
        <a href="/staff/login">Staff</a>
        <a class="nav-cta" href="/classes">Reservar</a>
      </nav>
    `;

  const intro = isLandingIntro
    ? `
    <section id="landing-intro" class="landing-intro" aria-label="Introducción TISA">
      <div class="intro-shell">
        <div class="intro-copy">
          <div class="intro-logo-mark">TI</div>
          <p class="intro-kicker">MOVIMIENTO · RESPIRACION · CALMA</p>
          <h1>TISA</h1>
          <p class="intro-text">Una llegada serena a un estudio pensado para reservar fluido, comprar accesos claros y entrar con QR sin fricción.</p>
          <div class="intro-mobile-points" aria-label="Resumen compacto">
            <span>Agenda viva</span>
            <span>Wallet simple</span>
            <span>Check-in QR</span>
          </div>
          <div class="intro-actions">
            <button type="button" class="btn" id="intro-enter">Entrar</button>
            <a class="btn alt intro-link" href="/classes">Ver agenda</a>
          </div>
        </div>
        <aside class="intro-panel" aria-label="Resumen de experiencia">
          <div class="intro-panel-card">
            <span>Studio pulse</span>
            <strong>Reserva y confirma en segundos.</strong>
          </div>
          <div class="intro-panel-card">
            <span>Wallet</span>
            <strong>Bundles por tipo de práctica y créditos visibles.</strong>
          </div>
          <div class="intro-panel-card">
            <span>Operations</span>
            <strong>Staff, trainer y check-in bajo el mismo lenguaje visual.</strong>
          </div>
        </aside>
      </div>
      <div class="sand-river river-a" aria-hidden="true"></div>
      <div class="sand-river river-b" aria-hidden="true"></div>
      <div class="sand-river river-c" aria-hidden="true"></div>
    </section>
  `
    : '';

  return `<!doctype html>
  <html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${esc(title)} | ${appName}</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;600;700&family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="/static/style.css" />
    <script src="https://mcp.figma.com/mcp/html-to-design/capture.js" async></script>
  </head>
  <body class="${isLandingIntro ? 'has-landing-intro' : ''} ${staff ? 'is-staff' : 'is-public'} ${isConceptBoard ? 'is-concept-board' : ''}">
    ${intro}
    ${simulationMode && !isConceptBoard ? '<div class="sim-banner">Modo simulación activo (no producción)</div>' : ''}
    <header class="site-header ${isConceptBoard ? 'concept-header' : ''}">
      <a class="brand" href="/">
        <span>TISA</span>
        <small>Studio System</small>
      </a>
      ${nav}
    </header>
    <main>${body}</main>
    <script src="/static/app.js"></script>
  </body>
  </html>`;
}
