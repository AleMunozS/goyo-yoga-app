import { esc } from '../utils.js';

export function renderLayout({ title, body, staff = null, simulationMode = true }) {
  const isConceptBoard = title.startsWith('Concept') && !staff;
  const isHome = title === 'Inicio' && !staff;
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
  <body class="${staff ? 'is-staff' : 'is-public'} ${isConceptBoard ? 'is-concept-board' : ''} ${isHome ? 'is-home has-landing-intro' : ''}">
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
