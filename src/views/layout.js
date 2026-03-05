import { esc } from '../utils.js';

export function renderLayout({ title, body, staff = null, simulationMode = true }) {
  const isLandingIntro = title === 'Inicio' && !staff;
  const nav = staff
    ? `
      <nav class="top-nav">
        <a href="/admin/dashboard">Admin</a>
        <a href="/trainer/classes">Trainer</a>
        <a href="/ops/checkin">Check-in</a>
        <form action="/staff/logout" method="post"><button type="submit">Salir</button></form>
      </nav>
    `
    : '<nav class="top-nav"><a href="/">Inicio</a><a href="/classes">Clases</a><a href="/staff/login">Staff</a></nav>';

  const intro = isLandingIntro
    ? `
    <section id="landing-intro" class="landing-intro" aria-label="Introducción GOYO">
      <div class="intro-core">
        <div class="intro-logo-mark">GY</div>
        <h1>GOYO YOGA</h1>
        <p>Reserva sin cuenta. Tickets por clase. Acceso con QR.</p>
        <button type="button" class="btn" id="intro-enter">Entrar</button>
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
    <title>${esc(title)} | Goyo Yoga</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;600;700&family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="/static/style.css" />
  </head>
  <body class="${isLandingIntro ? 'has-landing-intro' : ''}">
    ${intro}
    ${simulationMode ? '<div class="sim-banner">Modo simulación activo (no producción)</div>' : ''}
    <header class="site-header">
      <div class="brand">GOYO YOGA</div>
      ${nav}
    </header>
    <main>${body}</main>
    <script src="/static/app.js"></script>
  </body>
  </html>`;
}
