import { esc } from '../utils.js';
import { brand } from '../brand.js';
import { config } from '../config.js';

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
  canonicalPath = null,
}) {
  const isConceptBoard = title.startsWith('Concept') && !staff;
  const isHome = title === 'Inicio' && !staff;
  const isStaffLogin = title === 'Staff Login' && !staff;
  const showPrivacyNotice = !staff && !isConceptBoard;
  const appName = brand.name;
  const assetVersion = '20260717-redesign-v28';
  const canonicalUrl = canonicalPath
    ? new URL(canonicalPath, `${config.appUrl.replace(/\/+$/, '')}/`).toString()
    : null;
  const socialImageUrl = new URL(brand.assets.editorialGrid, `${config.appUrl.replace(/\/+$/, '')}/`).toString();
  const fullTitle = `${title} | ${appName}`;
  const canAccessAssistedSales = staffRole === 'ADMIN' || staffRole === 'OPS';
  const canAccessLayouts = staffRole === 'ADMIN' || staffRole === 'OPS';
  const canAccessAdmin = staffRole === 'ADMIN';
  const canAccessTrainer = staffRole === 'TRAINER';
  const canAccessCheckin = staffRole === 'ADMIN' || staffRole === 'OPS';
  const nav = staff
    ? `
      <nav class="top-nav staff-nav" id="site-top-nav" data-nav-menu>
        <div class="top-nav__cluster">
          ${canAccessAdmin ? '<a href="/admin/dashboard">Admin</a>' : ''}
          ${canAccessAssistedSales ? '<a href="/admin/assisted-sales">Ventas WhatsApp</a>' : ''}
          ${canAccessLayouts ? '<a href="/admin/layouts">Layouts</a>' : ''}
          ${canAccessTrainer ? '<a href="/trainer/classes">Trainer</a>' : ''}
          ${canAccessCheckin ? '<a href="/ops/checkin">Check-in</a>' : ''}
        </div>
        <div class="top-nav__utility">
          <span class="top-nav__badge">Studio Staff</span>
          <form action="/staff/logout" method="post"><button type="submit">Salir</button></form>
        </div>
      </nav>
    `
    : isConceptBoard
    ? `
      <nav class="top-nav concept-nav" id="site-top-nav" data-nav-menu>
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
      <nav class="top-nav public-nav" id="site-top-nav" data-nav-menu>
        <a class="${isHome ? 'is-active' : ''}" href="/">Inicio</a>
        <a class="${title === 'Clases' ? 'is-active' : ''}" href="/classes">Agenda</a>
        <a class="nav-cta" href="/classes">Reservar</a>
        <a class="${isStaffLogin ? 'is-active' : ''}" href="/staff/login">Staff</a>
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
      <div class="site-header__inner">
        <a class="brand" href="/">
          <img
            class="brand-lockup"
            src="${brand.assets.headerLogo}"
            alt="${esc(brand.name)}"
            width="1130"
            height="384"
          />
        </a>
        <button
          class="site-menu-toggle"
          type="button"
          aria-label="Abrir menú"
          aria-expanded="false"
          aria-controls="site-top-nav"
          data-nav-menu-toggle
        >
          <span></span>
          <span></span>
          <span></span>
        </button>
        ${nav}
      </div>
    </header>
  `;
  const mainClassAttr = mainClass ? ` class="${mainClass}"` : '';

  return `<!doctype html>
  <html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta name="description" content="${esc(brand.metaDescription)}" />
    <meta name="theme-color" content="#F1EFE9" />
    ${canonicalUrl ? `<meta name="robots" content="index, follow" />
    <link rel="canonical" href="${esc(canonicalUrl)}" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="${esc(appName)}" />
    <meta property="og:title" content="${esc(fullTitle)}" />
    <meta property="og:description" content="${esc(brand.metaDescription)}" />
    <meta property="og:url" content="${esc(canonicalUrl)}" />
    <meta property="og:image" content="${esc(socialImageUrl)}" />
    <meta name="twitter:card" content="summary_large_image" />` : ''}
    <title>${esc(fullTitle)}</title>
    <link rel="icon" href="${brand.assets.favicon || brand.assets.headerLogo}" type="image/png" />
    <script>
      document.documentElement.classList.add('js');
      try {
        if (window.localStorage.getItem('tisa.privacy-notice.v1') === 'acknowledged') {
          document.documentElement.classList.add('privacy-notice-seen');
        }
      } catch (error) {
        // El aviso sigue visible si el navegador bloquea el almacenamiento local.
      }
    </script>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;600;700&family=DM+Mono:wght@300;400;500&family=Manrope:wght@400;500;600;700&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="/static/style.css?v=${assetVersion}" />
    <link rel="stylesheet" href="/static/tisa-redesign.css?v=${assetVersion}" />
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
    ${showPrivacyNotice ? `
      <aside class="cookie-notice" data-cookie-notice aria-labelledby="cookie-notice-title">
        <div class="cookie-notice__mark" aria-hidden="true"><span></span></div>
        <div class="cookie-notice__copy">
          <p class="cookie-notice__eyebrow">PRIVACIDAD EN TISA</p>
          <h2 id="cookie-notice-title">Solo lo necesario para tu recorrido.</h2>
          <p>Usamos una cookie técnica para mantener segura tu sesión y tu reserva. No usamos cookies publicitarias.</p>
        </div>
        <div class="cookie-notice__actions">
          <a href="/privacy">Conocer detalles</a>
          <button type="button" data-cookie-notice-dismiss>Entendido</button>
        </div>
      </aside>
    ` : ''}
    <script src="/static/app.js?v=${assetVersion}"></script>
  </body>
  </html>`;
}
