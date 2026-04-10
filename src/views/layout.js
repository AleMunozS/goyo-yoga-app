import { esc } from '../utils.js';
import { brand } from '../brand.js';

export function renderLayout({
  title,
  body,
  staff = null,
  staffRole = null,
  simulationMode = true,
  bodyClass = '',
  mainClass = '',
  hideDefaultHeader = false,
  customHeaderHtml = '',
  customFooterHtml = '',
}) {
  const isConceptBoard = title.startsWith('Concept') && !staff;
  const isHome = title === 'Inicio' && !staff;
  const appName = brand.name;
  const assetVersion = '20260409-classes-editorial';
  const canAccessAssistedSales = staffRole === 'ADMIN' || staffRole === 'OPS';
  const nav = staff
    ? `
      <nav class="top-nav staff-nav">
        <a href="/admin/dashboard">Admin</a>
        ${canAccessAssistedSales ? '<a href="/admin/assisted-sales">Ventas WhatsApp</a>' : ''}
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
        <a class="nav-cta" href="/classes">Reservar</a>
        <a href="/staff/login">Staff</a>
      </nav>
    `;
  const bodyClasses = [
    'theme-tisa',
    staff ? 'is-staff' : 'is-public',
    isConceptBoard ? 'is-concept-board' : '',
    isHome ? 'is-home has-landing-intro' : '',
    bodyClass,
  ]
    .filter(Boolean)
    .join(' ');
  const defaultHeader = hideDefaultHeader
    ? ''
    : `
    <header class="site-header ${isConceptBoard ? 'concept-header' : ''}">
      <a class="brand" href="/">
        <img
          class="brand-lockup"
          src="${brand.assets.headerLogo}"
          alt="${esc(brand.name)}"
          width="1130"
          height="384"
        />
      </a>
      ${nav}
    </header>
  `;
  const mainClassAttr = mainClass ? ` class="${mainClass}"` : '';

  return `<!doctype html>
  <html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta name="description" content="${esc(brand.metaDescription)}" />
    <meta name="theme-color" content="#f4eee6" />
    <title>${esc(title)} | ${appName}</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;600;700&family=Manrope:wght@400;500;600;700;800&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="/static/style.css?v=${assetVersion}" />
  </head>
  <body
    class="${bodyClasses}"
    style="--landing-side-emblem:url('${brand.assets.landingSideEmblem}');"
  >
    ${simulationMode && !isConceptBoard ? '<div class="sim-banner">Modo simulación activo (no producción)</div>' : ''}
    ${defaultHeader}
    ${customHeaderHtml}
    <main${mainClassAttr}>${body}</main>
    ${customFooterHtml}
    <script src="/static/app.js?v=${assetVersion}"></script>
  </body>
  </html>`;
}
