import { esc } from '../utils.js';

export function renderLayout({ title, body, staff = null, simulationMode = true }) {
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
  <body>
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
