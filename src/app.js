import express from 'express';
import session from 'express-session';
import morgan from 'morgan';
import dayjs from 'dayjs';
import bcrypt from 'bcryptjs';
import QRCode from 'qrcode';
import { z } from 'zod';
import formidable from 'formidable';
import { imageSize } from 'image-size';
import { randomUUID } from 'crypto';
import { copyFile, mkdir, readFile, rename, unlink } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { brand, getCheckoutStateCopy } from './brand.js';
import { renderLayout } from './views/layout.js';
import { config } from './config.js';
import { esc, hashToken, isWithinCheckinWindow, signPayload } from './utils.js';
import {
  MAX_SEATS_PER_BOOKING,
  cloneLayout,
  createDefaultLayout,
  describeReservedSeats,
  formatSeatLabels,
  getLayoutCapacity,
  getSeatLayout,
  hasStructuralSeatChanges,
  parseLayoutJson,
  serializeLayout,
} from './seats.js';
import {
  ReservationError,
  createDraftReservation,
  createCheckoutSessionForReservation,
  expireStaleReservations,
  fulfillCheckout,
  getActiveSeatCodes,
  getBookingStateLabel,
  getReservationResponse,
  isAsyncMethodEligible,
  markChargeRefunded,
  markPaymentIntentFailed,
  stripeClient,
} from './reservation-service.js';

const QR_SECRET = process.env.QR_SECRET || 'local-qr-secret';
const ACTIVE_RESERVATION_STATUSES = ['PENDING_PAYMENT', 'PAYMENT_PENDING_ASYNC', 'PAID', 'CHECKED_IN'];
const CONFIRMED_RESERVATION_STATUSES = ['PAID', 'CHECKED_IN'];
const OPEN_RESERVATION_STATUSES = ['PENDING_PAYMENT', 'PAYMENT_PENDING_ASYNC'];
const LAYOUT_BACKGROUND_MAX_BYTES = 8 * 1024 * 1024;
const LAYOUT_BACKGROUND_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const LAYOUT_BACKGROUND_EXTENSIONS = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

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
  return `<section class="section page-shell">
    <div class="status-card status-card-error">
      <p class="page-kicker">${brand.name} · ESTADO</p>
      <h1>Algo necesita atención.</h1>
      <p>${esc(message)}</p>
    </div>
  </section>`;
}

function getLayoutBackgroundDestination(mimetype, originalFilename = '') {
  const originalExt = path.extname(String(originalFilename || '')).toLowerCase();
  const fallbackExt = LAYOUT_BACKGROUND_EXTENSIONS[mimetype] || '.img';
  const safeExt = originalExt && /^[.][a-z0-9]+$/.test(originalExt) ? originalExt : fallbackExt;
  return {
    filename: `${randomUUID()}${safeExt}`,
    extension: safeExt,
  };
}

async function parseBackgroundUpload(req, uploadDir) {
  const form = formidable({
    multiples: false,
    maxFiles: 1,
    maxFileSize: LAYOUT_BACKGROUND_MAX_BYTES,
    allowEmptyFiles: false,
    filter: ({ mimetype }) => LAYOUT_BACKGROUND_MIME_TYPES.has(String(mimetype || '')),
  });

  const [, files] = await form.parse(req);
  const file = Array.isArray(files.backgroundImage) ? files.backgroundImage[0] : files.backgroundImage;
  if (!file?.filepath) {
    throw new Error('Selecciona una imagen JPG, PNG o WebP para continuar.');
  }

  if (!LAYOUT_BACKGROUND_MIME_TYPES.has(String(file.mimetype || ''))) {
    await unlink(file.filepath).catch(() => {});
    throw new Error('Solo se aceptan imágenes JPG, PNG o WebP.');
  }

  const size = imageSize(await readFile(file.filepath));
  if (!size.width || !size.height) {
    await unlink(file.filepath).catch(() => {});
    throw new Error('No pudimos leer las dimensiones de la imagen.');
  }

  await mkdir(uploadDir, { recursive: true });
  const { filename } = getLayoutBackgroundDestination(file.mimetype, file.originalFilename);
  const destination = path.join(uploadDir, filename);
  try {
    await rename(file.filepath, destination);
  } catch (error) {
    // Docker uploads may land on /tmp while the target is a bind mount on another device.
    if (error?.code !== 'EXDEV') throw error;
    await copyFile(file.filepath, destination);
    await unlink(file.filepath).catch(() => {});
  }

  return {
    assetUrl: `/static/uploads/layouts/${filename}`,
    assetWidth: size.width,
    assetHeight: size.height,
  };
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

function buildSeatSelectionUrl(occurrenceId, params = {}) {
  const search = new URLSearchParams({ occurrenceId });
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, String(value));
  }
  return `/booking/seats?${search.toString()}`;
}

function formatCurrency(cents, currency = 'MXN') {
  return `${String(currency || 'MXN').toUpperCase()} ${(Number(cents || 0) / 100).toLocaleString('es-MX')}`;
}

function parseSeatCodesInput(value) {
  return Array.from(
    new Set(
      String(value || '')
        .split(/[\s,]+/)
        .map((item) => item.trim().toUpperCase())
        .filter(Boolean),
    ),
  ).slice(0, MAX_SEATS_PER_BOOKING);
}

function safeJsonForHtml(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function createOccurrenceLayoutSnapshot(layoutJson, requestedCapacity) {
  const baseLayout = cloneLayout(parseLayoutJson(layoutJson, requestedCapacity));
  const seatLimit = Number(requestedCapacity || getLayoutCapacity(baseLayout, baseLayout.seats.length));
  const bookableSeats = baseLayout.seats.filter((seat) => seat.bookable);
  if (seatLimit > bookableSeats.length) {
    throw new Error(`El layout base solo soporta ${bookableSeats.length} lugares habilitables.`);
  }

  let enabledCount = 0;
  baseLayout.seats = baseLayout.seats.map((seat) => {
    if (!seat.bookable) return { ...seat, enabled: false };
    enabledCount += 1;
    return { ...seat, enabled: enabledCount <= seatLimit };
  });

  return baseLayout;
}

function renderSeatMapMarkup({
  layoutJson,
  fallbackCapacity,
  occupiedSeatIds = [],
  selectedSeatCodes = [],
  inputName = 'seatCodes',
  interactive = true,
}) {
  const layout = getSeatLayout(layoutJson, fallbackCapacity);
  const occupiedSet = new Set((occupiedSeatIds || []).map((value) => String(value)));
  const selectedSet = new Set((selectedSeatCodes || []).map((value) => String(value)));
  const backgroundMarkup = layout.background
    ? `
      <div
        class="seat-map-background"
        style="left:${layout.background.x}px;top:${layout.background.y}px;width:${layout.background.assetWidth * layout.background.scale}px;height:${layout.background.assetHeight * layout.background.scale}px;opacity:${layout.background.opacity};"
        aria-hidden="true"
      >
        <img src="${layout.background.assetUrl}" alt="" />
      </div>
    `
    : '';
  const seatNodes = layout.seats
    .map((seat) => {
      const isOccupied = occupiedSet.has(seat.id);
      const isSelected = selectedSet.has(seat.id) || selectedSet.has(seat.label);
      const disabled = isOccupied || !seat.enabled || !seat.bookable || !interactive;
      const stateClass = isOccupied
        ? 'is-occupied'
        : !seat.enabled || !seat.bookable
        ? 'is-disabled'
        : isSelected
        ? 'is-selected'
        : 'is-available';
      const seatStyle = `left:${seat.x}px;top:${seat.y}px;transform:translate(-50%, -50%) rotate(${seat.rotation}deg);`;

      if (!interactive) {
        return `
          <div class="seat-node seat-mat ${stateClass}" style="${seatStyle}">
            <span class="seat-mat__mark" aria-hidden="true"><img src="${brand.assets.matMark}" alt="" /></span>
            <span class="seat-mat__label">${seat.label}</span>
          </div>
        `;
      }

      return `
        <label class="seat-node seat-mat ${stateClass}" data-seat-option="${seat.id}" style="${seatStyle}">
          <input
            type="checkbox"
            name="${inputName}"
            value="${seat.id}"
            data-seat-zone="${seat.zone}"
            data-seat-label="${seat.label}"
            ${isSelected ? 'checked' : ''}
            ${disabled ? 'disabled' : ''}
          />
          <span class="seat-mat__mark" aria-hidden="true"><img src="${brand.assets.matMark}" alt="" /></span>
          <span class="seat-mat__label">${seat.label}</span>
        </label>
      `;
    })
    .join('');

  return `
    <div class="seat-stage">
      <div class="seat-stage-guide">${esc(layout.instructor.label || 'Instructora')}</div>
      <div class="seat-stage-screen" aria-hidden="true"></div>
      <div class="seat-map-viewport" data-seat-viewport>
        <div class="seat-map-canvas" data-seat-canvas>
          <div
            class="seat-map seat-map-freeform ${layout.background ? 'seat-map--with-background' : ''}"
            style="width:${layout.canvas.width}px;height:${layout.canvas.height}px;--seat-grid:${layout.canvas.grid}px;"
          >
            ${backgroundMarkup}
            <div
              class="seat-instructor-marker"
              style="left:${layout.instructor.x}px;top:${layout.instructor.y}px;transform:translate(-50%, -50%) rotate(${layout.instructor.rotation}deg);"
            >${esc(layout.instructor.label || 'Instructora')}</div>
            ${seatNodes}
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderStudioWorkspace({
  activeKey = 'dashboard',
  staffRole = null,
  eyebrow = 'Studio Workspace',
  title = '',
  subtitle = '',
  content = '',
  sidebarContent = '',
  footerActionLabel = 'Abrir agenda',
  footerActionHref = '/classes',
}) {
  const canAccessDashboard = staffRole === 'ADMIN';
  const canAccessSales = staffRole === 'ADMIN' || staffRole === 'OPS';
  const canAccessLayouts = staffRole === 'ADMIN' || staffRole === 'OPS';
  const canAccessTrainer = staffRole === 'TRAINER';
  const canAccessCheckin = staffRole === 'ADMIN' || staffRole === 'OPS';
  const items = [
    canAccessDashboard ? { key: 'dashboard', href: '/admin/dashboard', label: 'Dashboard' } : null,
    canAccessSales ? { key: 'sales', href: '/admin/assisted-sales', label: 'Ventas' } : null,
    canAccessLayouts ? { key: 'layouts', href: '/admin/layouts', label: 'Layouts' } : null,
    canAccessTrainer ? { key: 'trainer', href: '/trainer/classes', label: 'Trainer' } : null,
    canAccessCheckin ? { key: 'checkin', href: '/ops/checkin', label: 'Check-in' } : null,
  ].filter(Boolean);

  const nav = items
    .map((item) => `<a class="${item.key === activeKey ? 'is-active' : ''}" href="${item.href}">${item.label}</a>`)
    .join('');

  return `<section class="studio-workspace">
    <aside class="studio-workspace__sidebar">
      <div class="studio-workspace__brand">
        <p>${esc(eyebrow)}</p>
        <h2>Main Wing</h2>
        <span>Operational floor</span>
      </div>
      <nav class="studio-workspace__nav" aria-label="Studio navigation">${nav}</nav>
      ${sidebarContent ? `<div class="studio-workspace__sidebar-content">${sidebarContent}</div>` : ''}
      <div class="studio-workspace__footer">
        <a class="btn" href="${footerActionHref}">${footerActionLabel}</a>
      </div>
    </aside>
    <div class="studio-workspace__main">
      <header class="studio-workspace__header">
        <div>
          <p class="concept-kicker">${esc(eyebrow)}</p>
          <h1>${esc(title)}</h1>
        </div>
        <p>${esc(subtitle)}</p>
      </header>
      ${content}
    </div>
  </section>`;
}

function renderSeatSelectionHeader() {
  return `
    <header class="seat-floorplan-header">
      <div class="seat-floorplan-header__inner">
        <a class="seat-floorplan-header__brand" href="/">
          <img
            class="brand-lockup"
            src="${brand.assets.headerLogo}"
            alt="${esc(brand.name)}"
            width="1130"
            height="384"
          />
        </a>
        <nav class="seat-floorplan-header__nav" aria-label="Reserva">
          <a href="/classes">Agenda</a>
          <a class="is-active" href="/classes">Reservar</a>
          <a href="/staff/login">Staff</a>
        </nav>
      </div>
    </header>
  `;
}

function renderLayoutsIndexBody({ locations, occurrences, staffRole = null }) {
  const locationRows = locations
    .map((location) => {
      const capacity = getLayoutCapacity(location.layoutJson, 18);
      return `<div class="admin-list-row layout-list-row">
        <div class="admin-list-row__meta">
          <span class="admin-list-row__eyebrow">Layout base</span>
          <strong>${esc(location.name)}</strong>
          <p>${esc(location.address)} · ${capacity} lugares habilitados en base</p>
        </div>
        <div class="admin-list-row__action">
          <a class="btn alt" href="/admin/layouts/${location.id}">Editar layout base</a>
        </div>
      </div>`;
    })
    .join('');

  const classRows = occurrences
    .map((occurrence) => {
      const capacity = getLayoutCapacity(occurrence.layoutJson, occurrence.capacity);
      return `<div class="admin-list-row layout-list-row">
        <div class="admin-list-row__meta">
          <span class="admin-list-row__eyebrow">Override activo</span>
          <strong>${esc(occurrence.classType.name)}</strong>
          <p>${dayjs(occurrence.startsAt).format('DD MMM YYYY · HH:mm')} · ${esc(occurrence.location.name)} · ${capacity} lugares</p>
        </div>
        <div class="admin-list-row__action">
          <a class="btn alt" href="/admin/class-layouts/${occurrence.id}">Editar layout de clase</a>
        </div>
      </div>`;
    })
    .join('');

  const content = `<div class="system-grid layout-admin-grid" id="layout-admin-grid">
        <article class="system-panel system-panel-light layout-admin-panel">
          <p class="concept-kicker">Sedes activas</p>
          <h2>Layouts base por sede</h2>
          <div class="admin-list">${locationRows || '<div class="admin-list-row"><div><strong>Sin sedes</strong><p>No hay sedes activas todavía.</p></div></div>'}</div>
        </article>
        <article class="system-panel system-panel-dark layout-admin-panel">
          <p class="concept-kicker">Próximas clases</p>
          <h2>Overrides por clase</h2>
          <div class="admin-list">${classRows || '<div class="admin-list-row"><div><strong>Sin clases próximas</strong><p>No hay clases programadas para ajustar layout.</p></div></div>'}</div>
        </article>
      </div>`;

  return `<section class="section studio-workspace-section">
    ${renderStudioWorkspace({
      activeKey: 'layouts',
      staffRole,
      eyebrow: 'TISA / LAYOUTS',
      title: 'El salón ya no depende de un mapa fijo.',
      subtitle: 'Admin y operación pueden mantener layouts base por sede y preparar overrides por clase antes de abrir ventas o check-in.',
      content,
      footerActionLabel: 'Ventas asistidas',
      footerActionHref: '/admin/assisted-sales',
    })}
  </section>`;
}

function renderLayoutEditorBody({
  title,
  kicker,
  subtitle,
  staffRole = null,
  details,
  savePath,
  backPath,
  layout,
  baseLayout = null,
  structureLocked = false,
  canResetToBase = false,
}) {
  const payload = {
    layout,
    baseLayout,
    structureLocked,
    matMarkAsset: brand.assets.matMark,
  };
  const inspectorMarkup = `<article class="system-panel system-panel-dark layout-inspector-panel layout-inspector-panel--sidebar">
      <p class="concept-kicker">Ajustes finos</p>
      <h2>Inspector</h2>
      <div class="layout-inspector-fields">
        <div class="layout-inspector-section">
          <span class="layout-inspector-section__title">Lienzo</span>
          <div class="layout-inspector-inline-grid">
            <label class="form-row">
              <span>Ancho</span>
              <input class="admin-input" type="number" min="640" max="2400" step="20" data-layout-input="canvas-width" value="${Number(layout.canvas?.width || 1200)}" ${structureLocked ? 'disabled' : ''} />
            </label>
            <label class="form-row">
              <span>Alto</span>
              <input class="admin-input" type="number" min="480" max="1800" step="20" data-layout-input="canvas-height" value="${Number(layout.canvas?.height || 800)}" ${structureLocked ? 'disabled' : ''} />
            </label>
          </div>
          <label class="form-row">
            <span>Retícula</span>
            <input class="admin-input" type="number" min="12" max="64" step="2" data-layout-input="canvas-grid" value="${Number(layout.canvas?.grid || 24)}" ${structureLocked ? 'disabled' : ''} />
          </label>
        </div>
        <div class="layout-inspector-section">
          <span class="layout-inspector-section__title">Selección</span>
          <label class="form-row">
            <span>Selección actual</span>
            <input class="admin-input" type="text" data-layout-output="selection" value="Instructora" readonly />
          </label>
          <label class="form-row">
            <span>Etiqueta</span>
            <input class="admin-input" type="text" data-layout-input="label" ${structureLocked ? 'disabled' : ''} />
          </label>
          <div class="layout-inspector-inline-grid">
            <label class="form-row">
              <span>Fila</span>
              <input class="admin-input" type="text" maxlength="2" data-layout-input="row" ${structureLocked ? 'disabled' : ''} />
            </label>
            <label class="form-row">
              <span>Orden</span>
              <input class="admin-input" type="number" min="1" data-layout-input="order" ${structureLocked ? 'disabled' : ''} />
            </label>
          </div>
          <label class="form-row">
            <span>Zona</span>
            <select class="admin-input" data-layout-input="zone" ${structureLocked ? 'disabled' : ''}>
              <option value="near">Cerca</option>
              <option value="middle">Media</option>
              <option value="back">Trasera</option>
            </select>
          </label>
          <label class="form-row checkbox-row">
            <span>Reservable</span>
            <input type="checkbox" data-layout-input="bookable" ${structureLocked ? 'disabled' : ''} />
          </label>
          <label class="form-row checkbox-row">
            <span>Habilitado</span>
            <input type="checkbox" data-layout-input="enabled" ${structureLocked ? 'disabled' : ''} />
          </label>
        </div>
        <div class="layout-inspector-section layout-background-tools">
          <div class="layout-background-tools__header">
            <span>Foto del salón</span>
            <p data-layout-output="background-status">${layout.background ? 'Foto cargada y lista para ajustar.' : 'Aún no hay foto cargada.'}</p>
          </div>
          <input
            type="file"
            id="layout-background-file"
            class="layout-background-file"
            accept="image/jpeg,image/png,image/webp"
            ${structureLocked ? 'disabled' : ''}
          />
          <div class="layout-background-tools__actions">
            <button class="btn alt" type="button" data-layout-action="upload-background" ${structureLocked ? 'disabled' : ''}>Subir foto</button>
            <button class="btn alt" type="button" data-layout-action="replace-background" ${structureLocked ? 'disabled' : ''}>Reemplazar</button>
            <button class="btn alt" type="button" data-layout-action="clear-background" ${structureLocked ? 'disabled' : ''}>Quitar fondo</button>
          </div>
          <div class="layout-inspector-inline-grid">
            <label class="form-row">
              <span>Fondo X</span>
              <input class="admin-input" type="number" data-layout-input="background-x" ${structureLocked ? 'disabled' : ''} />
            </label>
            <label class="form-row">
              <span>Fondo Y</span>
              <input class="admin-input" type="number" data-layout-input="background-y" ${structureLocked ? 'disabled' : ''} />
            </label>
          </div>
          <div class="layout-inspector-inline-grid">
            <label class="form-row">
              <span>Escala fondo</span>
              <input class="admin-input" type="number" min="0.1" max="4" step="0.05" data-layout-input="background-scale" ${structureLocked ? 'disabled' : ''} />
            </label>
            <label class="form-row">
              <span>Opacidad fondo</span>
              <input class="admin-input" type="number" min="0.1" max="1" step="0.05" data-layout-input="background-opacity" ${structureLocked ? 'disabled' : ''} />
            </label>
          </div>
        </div>
      </div>
    </article>`;

  const content = `<form method="post" action="${savePath}" class="layout-editor-form" id="layout-editor-form">
        <input type="hidden" name="layoutJson" id="layout-editor-json" value="${esc(serializeLayout(layout))}" />
        <div class="layout-editor-workspace">
          <article class="system-panel system-panel-light layout-editor-canvas-shell">
            <div class="layout-editor-shell-head">
              <div class="layout-editor-panel__head">
                <p class="concept-kicker">Canvas editorial</p>
                <h2>Lienzo del salón</h2>
                <p>Editor de escritorio para ajustar el salón con más espacio y menos paneles encima del lienzo.</p>
              </div>
              <div class="system-detail-list">${details}</div>
            </div>
            <div class="layout-editor-toolbar-row">
              <div class="layout-editor-toolbar">
                <button class="btn alt" type="button" data-layout-action="select-instructor">Mover instructora</button>
                <button class="btn alt" type="button" data-layout-action="select-background">Seleccionar fondo</button>
                <button class="btn alt" type="button" data-layout-action="add-seat" ${structureLocked ? 'disabled' : ''}>Agregar asiento</button>
                <button class="btn alt" type="button" data-layout-action="delete-seat" ${structureLocked ? 'disabled' : ''}>Eliminar asiento</button>
                <button class="btn alt" type="button" data-layout-action="renumber-rows" ${structureLocked ? 'disabled' : ''}>Renumerar filas</button>
                <button class="btn alt" type="button" data-layout-action="reorder-rows" ${structureLocked ? 'disabled' : ''}>Reordenar filas</button>
                ${canResetToBase ? `<button class="btn alt" type="button" data-layout-action="reset-base" ${structureLocked ? 'disabled' : ''}>Resetear al base</button>` : ''}
              </div>
              <div class="layout-editor-viewport-tools" aria-label="Zoom del lienzo">
                <button class="btn alt" type="button" data-layout-action="zoom-out">-</button>
                <output class="layout-editor-viewport-scale" data-layout-output="viewport-scale">100%</output>
                <button class="btn alt" type="button" data-layout-action="zoom-in">+</button>
                <button class="btn alt" type="button" data-layout-action="zoom-reset">Centrar</button>
              </div>
            </div>
            <div class="layout-editor-canvas-wrap">
              <div class="layout-editor-stage-viewport">
                <div id="layout-editor-stage" class="layout-editor-stage" aria-label="Editor del layout"></div>
              </div>
            </div>
            <p class="system-inline-note layout-editor-note">
              ${structureLocked
                ? 'Esta clase ya tiene reservas activas. Solo puedes mover la instructora; la estructura del salón y el fondo quedan congelados.'
                : 'El lienzo ocupa el área principal. Usa el panel izquierdo para tamaño, retícula y ajustes del fondo.'}
            </p>
          </article>
        </div>
      </form>`;

  return `<section class="section studio-workspace-section">
    ${renderStudioWorkspace({
      activeKey: 'layouts',
      staffRole,
      eyebrow: kicker,
      title,
      subtitle,
      content,
      sidebarContent: inspectorMarkup,
      footerActionLabel: 'Volver a layouts',
      footerActionHref: backPath,
    })}
    <script src="/vendor/konva/konva.min.js"></script>
    <script type="application/json" id="layout-editor-payload">${safeJsonForHtml(payload)}</script>
  </section>`;
}

const SPANISH_DAY_NAMES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const SPANISH_DAY_NAMES_SHORT = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const SPANISH_MONTH_NAMES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const SPANISH_MONTH_NAMES_SHORT = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const AGENDA_INTENSITY_ORDER = ['Suave', 'Baja', 'Media/Alta'];

function capitalizeLabel(value) {
  if (!value) return '';
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function normalizeAgendaIntensity(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'media' || raw === 'media/alta' || raw === 'media alta' || raw === 'alta') return 'Media/Alta';
  if (raw === 'baja') return 'Baja';
  return 'Suave';
}

function getAgendaIntensityMeta(value) {
  const label = normalizeAgendaIntensity(value);
  const tones = {
    Suave: {
      label,
      className: 'is-suave',
      description: 'Pausa y regulación',
    },
    Baja: {
      label,
      className: 'is-baja',
      description: 'Movimiento accesible',
    },
    'Media/Alta': {
      label,
      className: 'is-media-alta',
      description: 'Foco y energía',
    },
  };
  return tones[label] || tones.Suave;
}

function formatAgendaDayName(value) {
  const date = dayjs(value);
  return capitalizeLabel(SPANISH_DAY_NAMES[date.day()]);
}

function formatAgendaDayNameShort(value) {
  const date = dayjs(value);
  return capitalizeLabel(SPANISH_DAY_NAMES_SHORT[date.day()]);
}

function formatAgendaDateLabel(value) {
  const date = dayjs(value);
  return `${String(date.date()).padStart(2, '0')} ${SPANISH_MONTH_NAMES_SHORT[date.month()]}`;
}

function formatAgendaMonthLabel(value) {
  const date = dayjs(value);
  return `${capitalizeLabel(SPANISH_MONTH_NAMES[date.month()])} ${date.year()}`;
}

function formatAgendaRangeLabel(periodStart, view) {
  if (view === 'month') return formatAgendaMonthLabel(periodStart);
  const rangeEnd = dayjs(periodStart).add(6, 'day');
  return `${formatAgendaDateLabel(periodStart)} - ${formatAgendaDateLabel(rangeEnd)} ${rangeEnd.year()}`;
}

function renderClassesCustomHeader() {
  return `
    <header class="classes-site-header">
      <div class="classes-site-header__inner">
        <div class="classes-site-header__lead">
          <a class="classes-site-brand" href="/">
            <img
              class="classes-site-brand__lockup"
              src="${brand.assets.headerLogo}"
              alt="${esc(brand.name)}"
              width="1130"
              height="384"
            />
          </a>
          <div class="classes-site-header__meta">
            <span>Agenda Editorial</span>
            <strong>Reserva clase y lugar desde una sola lectura visual.</strong>
          </div>
        </div>
        <nav class="classes-site-nav" aria-label="Agenda TISA">
          <a href="/">Inicio</a>
          <a class="is-active" href="/classes">Agenda</a>
          <button type="button" data-scroll-target="classes-editorial-grid">Reservar</button>
          <a href="/staff/login">Staff</a>
        </nav>
      </div>
    </header>
  `;
}

function renderClassesCustomFooter({ view, periodStart }) {
  const weekHref = `/classes?view=week&start=${startOfWeekMonday(periodStart).format('YYYY-MM-DD')}`;
  const prevHref = `/classes?view=${view}&start=${(view === 'month' ? dayjs(periodStart).subtract(1, 'month') : dayjs(periodStart).subtract(7, 'day')).format('YYYY-MM-DD')}`;
  const nextHref = `/classes?view=${view}&start=${(view === 'month' ? dayjs(periodStart).add(1, 'month') : dayjs(periodStart).add(7, 'day')).format('YYYY-MM-DD')}`;
  const prevLabel = view === 'month' ? 'Mes anterior' : 'Semana anterior';
  const nextLabel = view === 'month' ? 'Mes siguiente' : 'Semana siguiente';
  return `
    <div class="classes-mobile-dock" aria-label="Controles móviles de agenda">
      <a class="classes-mobile-nav-arrow" href="${prevHref}" aria-label="${prevLabel}">
        <span aria-hidden="true">&larr;</span>
      </a>
      <div class="classes-mobile-dock__sheet">
        <div class="classes-mobile-dock__meta">
          <span>${view === 'month' ? 'Vista mes' : 'Vista semana'}</span>
          <strong>${formatAgendaRangeLabel(periodStart, view)}</strong>
        </div>
        <nav class="classes-mobile-nav" aria-label="Agenda móvil">
          <a href="/">
            <span>Inicio</span>
          </a>
          <a class="${view === 'week' ? 'is-active' : ''}" href="${weekHref}">
            <span>Semana</span>
          </a>
          <a href="/staff/login">
            <span>Staff</span>
          </a>
        </nav>
      </div>
      <a class="classes-mobile-nav-arrow" href="${nextHref}" aria-label="${nextLabel}">
        <span aria-hidden="true">&rarr;</span>
      </a>
    </div>
    <footer class="classes-site-footer">
      <div class="classes-site-footer__brand">
        <strong>${esc(brand.name)}</strong>
        <p>${esc(brand.descriptorLong)}</p>
      </div>
      <div class="classes-site-footer__links">
        <a href="/">Inicio</a>
        <a href="/classes">Agenda</a>
        <a href="/staff/login">Staff</a>
      </div>
      <p class="classes-site-footer__caption">© ${dayjs().year()} ${esc(brand.name)}. Agenda editorial con disponibilidad real.</p>
    </footer>
  `;
}

function renderClassesEditorialEventCard(occurrence, { compact = false } = {}) {
  const startsAt = dayjs(occurrence.startsAt);
  const intensity = getAgendaIntensityMeta(occurrence.classType.intensity);
  const isCancelled = occurrence.status === 'CANCELLED';
  const isFull = occurrence.availableSlots <= 0;
  const disabled = isCancelled || isFull;
  const stateLabel = isCancelled ? 'Cancelada' : isFull ? 'Completa' : `${occurrence.availableSlots} cupos`;
  const ctaLabel = isCancelled ? 'No disponible' : isFull ? 'Lista llena' : 'Reservar';

  if (compact) {
    return `
      <a
        class="classes-mini-event ${intensity.className} ${isCancelled ? 'is-cancelled' : ''} ${isFull ? 'is-full' : ''}"
        href="${disabled ? '#' : buildSeatSelectionUrl(occurrence.id)}"
        ${disabled ? 'aria-disabled="true"' : ''}
      >
        <div class="classes-mini-event__topline">
          <span>${startsAt.format('HH:mm')}</span>
          <span>${esc(intensity.label)}</span>
        </div>
        <strong>${esc(occurrence.classType.name)}</strong>
        <small>${esc(occurrence.trainer.displayName)} · ${esc(stateLabel)}</small>
      </a>
    `;
  }

  return `
    <a
      class="classes-event-card ${intensity.className} ${isCancelled ? 'is-cancelled' : ''} ${isFull ? 'is-full' : ''}"
      href="${disabled ? '#' : buildSeatSelectionUrl(occurrence.id)}"
      ${disabled ? 'aria-disabled="true"' : ''}
    >
      <div class="classes-event-card__topline">
        <span class="classes-event-pill">${esc(intensity.label)}</span>
        <span class="classes-event-time">${startsAt.format('HH:mm')}</span>
      </div>
      <h3>${esc(occurrence.classType.name)}</h3>
      <p class="classes-event-card__summary">${esc(occurrence.classType.description)}</p>
      <div class="classes-event-card__meta">
        <div>
          <span>Guía</span>
          <strong>${esc(occurrence.trainer.displayName)}</strong>
        </div>
        <div>
          <span>Valor</span>
          <strong>${formatCurrency(occurrence.unitPriceCents)}</strong>
        </div>
      </div>
      <div class="classes-event-card__footer">
        <span class="classes-event-card__state">${esc(stateLabel)}</span>
        <span class="classes-event-card__cta">${ctaLabel}</span>
      </div>
    </a>
  `;
}

function renderSeatSelectionBody({
  occurrence,
  occupiedSeatCodes,
  selectedSeatCodes = [],
  customerName = '',
  customerEmail = '',
  customerPhone = '',
  message = '',
  messageType = 'error',
}) {
  const layout = getSeatLayout(occurrence.layoutJson, occurrence.capacity);
  const occupiedSet = new Set((occupiedSeatCodes || []).map((value) => String(value)));
  const enabledSeats = layout.seats.filter((seat) => seat.enabled && seat.bookable);
  const availableCount = enabledSeats.filter((seat) => !occupiedSet.has(seat.id)).length;
  const selectedSummary = formatSeatLabels(selectedSeatCodes, occurrence.layoutJson, occurrence.capacity);
  const seatMapHtml = renderSeatMapMarkup({
    layoutJson: occurrence.layoutJson,
    fallbackCapacity: occurrence.capacity,
    occupiedSeatIds: occupiedSeatCodes,
    selectedSeatCodes,
    inputName: 'seatCodes',
    interactive: true,
  });

  return `
    <section class="section seat-floorplan-page">
      <div class="seat-floorplan-app">
        <aside class="seat-floorplan-sidebar">
          <article class="seat-floorplan-sidebar__card">
            <p class="seat-floorplan-eyebrow">Sesión elegida</p>
            <h1>${esc(occurrence.classType.name)}</h1>
            <p>Visualiza el salón, confirma disponibilidad real y reserva sin cambiar de contexto.</p>
            <div class="seat-floorplan-sidebar__meta">
              <div><span>Horario</span><strong>${dayjs(occurrence.startsAt).format('DD MMM · HH:mm')}</strong></div>
              <div><span>Guía</span><strong>${esc(occurrence.trainer.displayName)}</strong></div>
              <div><span>Estudio</span><strong>${esc(occurrence.location.name)}</strong></div>
              <div><span>Mapa</span><strong>${enabledSeats.length} lugares habilitados · ${availableCount} disponibles</strong></div>
              <div><span>Precio por lugar</span><strong>MXN ${(occurrence.unitPriceCents / 100).toLocaleString('es-MX')}</strong></div>
            </div>
            <div class="seat-floorplan-sidebar__note">
              <p>${brand.seatSelection.note}</p>
            </div>
            <figure class="seat-floorplan-sidebar__media">
              <img src="${brand.assets.editorialGrid}" alt="Atmósfera visual de TISA" />
            </figure>
          </article>
        </aside>
        <form action="/reservations/web-checkout" method="post" id="seat-selection-form" class="seat-floorplan-form">
          <input type="hidden" name="occurrenceId" value="${occurrence.id}" />
          <input type="hidden" name="salesChannel" value="web" />
          <section class="seat-floorplan-board">
            <div class="seat-floorplan-board__header">
              <div>
                <p class="seat-floorplan-eyebrow">Layout activo</p>
                <h2>Selecciona tu lugar</h2>
              </div>
              <div class="seat-legend">
                <span class="legend seat-available">Disponible</span>
                <span class="legend seat-selected">Seleccionado</span>
                <span class="legend seat-occupied">Ocupado</span>
              </div>
            </div>
            <div class="seat-floorplan-board__stage">
              ${seatMapHtml}
            </div>
          </section>
          <aside class="seat-floorplan-summary">
            <article class="seat-floorplan-summary__card">
              <div class="seat-floorplan-summary__handle" aria-hidden="true"></div>
              <div class="seat-floorplan-summary__top">
                <div>
                  <p class="seat-floorplan-eyebrow">Tu selección</p>
                  <h3 id="seat-selection-count">${selectedSeatCodes.length} de ${MAX_SEATS_PER_BOOKING} lugares elegidos</h3>
                  <p id="seat-selection-summary">${selectedSummary || brand.seatSelection.summaryEmpty}</p>
                  ${message ? `<p class="seat-inline-message">${esc(message)}</p>` : ''}
                </div>
              </div>
              <div class="seat-floorplan-summary__session">
                <div>
                  <span>Clase</span>
                  <strong>${esc(occurrence.classType.name)}</strong>
                </div>
                <div>
                  <span>Horario</span>
                  <strong>${dayjs(occurrence.startsAt).format('DD MMM · HH:mm')}</strong>
                </div>
                <div>
                  <span>Guía</span>
                  <strong>${esc(occurrence.trainer.displayName)}</strong>
                </div>
                <div>
                  <span>Total</span>
                  <strong>MXN ${(occurrence.unitPriceCents / 100).toLocaleString('es-MX')}</strong>
                </div>
              </div>
              <div class="seat-floorplan-summary__fields">
                <label class="form-row seat-floorplan-field">
                  <span>Nombre</span>
                  <input type="text" name="customerName" value="${esc(customerName)}" placeholder="Nombre completo" required />
                </label>
                <label class="form-row seat-floorplan-field">
                  <span>Correo</span>
                  <input type="email" name="customerEmail" value="${esc(customerEmail)}" placeholder="tu@correo.com" required />
                </label>
                <label class="form-row seat-floorplan-field">
                  <span>Teléfono</span>
                  <input type="tel" name="customerPhone" value="${esc(customerPhone)}" placeholder="55..." />
                </label>
              </div>
              <div class="seat-floorplan-summary__actions">
                <button class="btn" type="submit">${brand.seatSelection.cta}</button>
                <a class="btn alt" href="/classes">Volver a la agenda</a>
              </div>
            </article>
          </aside>
        </form>
      </div>
    </section>
  `;
}

function renderAssistedSalesBody({
  occurrences,
  form = {},
  result = null,
  error = '',
}) {
  const upcomingOptions = occurrences
    .map((occurrence) => {
      const start = dayjs(occurrence.startsAt);
      return `<option value="${occurrence.id}" ${form.occurrenceId === occurrence.id ? 'selected' : ''}>${esc(occurrence.classType.name)} · ${start.format('DD MMM HH:mm')} · ${esc(occurrence.location.name)} · ${occurrence.availableSlots} libres · ${formatCurrency(occurrence.unitPriceCents)}</option>`;
    })
    .join('');
  const selectedOccurrence = occurrences.find((occurrence) => occurrence.id === form.occurrenceId) || occurrences[0] || null;
  const selectedSeatCodes = parseSeatCodesInput(form.seatCodesText || '');
  const selectedSeatLabels = selectedOccurrence
    ? formatSeatLabels(selectedSeatCodes, selectedOccurrence.layoutJson, selectedOccurrence.capacity)
    : '';

  return `<section class="section">
    <div class="system-shell">
      <section class="system-hero scroll-hero" data-scroll-target="staff-assisted-sales-grid">
        <p class="concept-kicker">TISA / VENTAS ASISTIDAS</p>
        <h1>Crea una reservación y comparte el Checkout por WhatsApp.</h1>
        <p>El staff genera primero la reservación interna, conserva el amarre a lugares concretos y luego comparte una URL única de Stripe Checkout para cerrar el pago asistido.</p>
      </section>
      <div class="system-grid" id="staff-assisted-sales-grid">
        <article class="system-panel system-panel-light">
          <h2>Nueva reservación asistida</h2>
          <form method="post" action="/admin/assisted-sales" class="admin-login-mock">
            <label class="form-row">
              <span>Clase</span>
              <select class="admin-input" name="occurrenceId" required>${upcomingOptions}</select>
            </label>
            <label class="form-row">
              <span>Lugares</span>
              <input class="admin-input" type="text" name="seatCodesText" value="${esc(form.seatCodesText || '')}" placeholder="A1, A2" required />
            </label>
            <label class="form-row">
              <span>Nombre</span>
              <input class="admin-input" type="text" name="customerName" value="${esc(form.customerName || '')}" required />
            </label>
            <label class="form-row">
              <span>Correo</span>
              <input class="admin-input" type="email" name="customerEmail" value="${esc(form.customerEmail || '')}" required />
            </label>
            <label class="form-row">
              <span>Teléfono</span>
              <input class="admin-input" type="tel" name="customerPhone" value="${esc(form.customerPhone || '')}" />
            </label>
            <p class="system-inline-note">Captura uno o dos lugares exactos. La reserva se crea con canal <strong>whatsapp</strong> y el apartado dura 10 minutos hasta que Stripe confirme el pago.</p>
            ${error ? `<p class="seat-inline-message">${esc(error)}</p>` : ''}
            <button class="btn" type="submit">Generar checkout compartible</button>
          </form>
        </article>
        <article class="system-panel system-panel-dark">
          <h2>Contexto operativo</h2>
          ${
            selectedOccurrence
              ? `<div class="system-detail-list">
                  <div><span>Clase</span><strong>${esc(selectedOccurrence.classType.name)}</strong></div>
                  <div><span>Horario</span><strong>${dayjs(selectedOccurrence.startsAt).format('DD MMM YYYY · HH:mm')}</strong></div>
                  <div><span>Sede</span><strong>${esc(selectedOccurrence.location.name)}</strong></div>
                  <div><span>Precio</span><strong>${formatCurrency(selectedOccurrence.unitPriceCents)}</strong></div>
                  <div><span>Lugares elegidos</span><strong>${esc(selectedSeatLabels || selectedSeatCodes.join(', ') || 'Pendientes')}</strong></div>
                  <div><span>Métodos</span><strong>${isAsyncMethodEligible(selectedOccurrence.startsAt) ? 'Tarjeta y SPEI' : 'Tarjeta y wallets'}</strong></div>
                </div>`
              : '<p class="system-inline-note">No hay clases próximas para ventas asistidas.</p>'
          }
          ${
            result
              ? `<div class="system-action-stack">
                  <p class="system-inline-note">Reservación ${esc(result.bookingRef)} creada para ${esc(result.customerEmail)}.</p>
                  <a class="btn" href="${result.checkoutUrl}" target="_blank" rel="noreferrer">Abrir Checkout</a>
                  <label class="form-row">
                    <span>URL para WhatsApp</span>
                    <input class="admin-input" type="text" value="${esc(result.checkoutUrl)}" readonly />
                  </label>
                  <div class="system-detail-list">
                    <div><span>Estado</span><strong>${esc(getBookingStateLabel(result.status))}</strong></div>
                    <div><span>Expira</span><strong>${result.expiresAt ? dayjs(result.expiresAt).format('DD MMM HH:mm') : 'Sin hold'}</strong></div>
                  </div>
                </div>`
              : '<p class="system-inline-note">Cuando generes la reservación aquí aparecerá la URL única para compartir por WhatsApp o Instagram.</p>'
          }
        </article>
      </div>
    </div>
  </section>`;
}

const publicDir = fileURLToPath(new URL('./public', import.meta.url));
const konvaDir = fileURLToPath(new URL('../node_modules/konva', import.meta.url));
const layoutUploadsDir = path.join(publicDir, 'uploads', 'layouts');

export function createApp({ prisma }) {
  const app = express();

  app.use(morgan('dev'));
  app.use('/static', express.static(publicDir));
  app.use('/vendor/konva', express.static(konvaDir));
  app.use(session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax' },
  }));

  app.post('/admin/layout-assets/background', async (req, res) => {
    if (!req.session.staffId) {
      return res.status(401).json({ error: 'Necesitas iniciar sesión para subir una foto.' });
    }
    if (!['ADMIN', 'OPS'].includes(String(req.session.staffRole || ''))) {
      return res.status(403).json({ error: 'No autorizado para subir fondos de layout.' });
    }

    try {
      const upload = await parseBackgroundUpload(req, layoutUploadsDir);
      return res.json(upload);
    } catch (error) {
      return res.status(400).json({ error: error.message || 'No se pudo subir la imagen.' });
    }
  });

  const handleStripeWebhook = async (req, res) => {
    try {
      let event;
      if (stripeClient && config.stripeWebhookSecret) {
        const sig = req.headers['stripe-signature'];
        event = stripeClient.webhooks.constructEvent(req.body, sig, config.stripeWebhookSecret);
      } else {
        event = JSON.parse(req.body.toString('utf8'));
      }

      const existing = await prisma.payment_webhooks.findUnique({ where: { stripeEventId: event.id } });
      if (existing) return res.json({ received: true, duplicate: true });

      let paymentId = null;
      if (
        event.type === 'checkout.session.completed'
        || event.type === 'checkout.session.async_payment_succeeded'
        || event.type === 'checkout.session.async_payment_failed'
      ) {
        const sessionObj = event.data.object;
        const result = await fulfillCheckout(prisma, {
          sessionId: sessionObj.id,
          eventType: event.type,
          baseUrl: config.appUrl,
        });
        paymentId = result.payment?.id || null;
      }

      if (event.type === 'payment_intent.payment_failed') {
        await markPaymentIntentFailed(prisma, event.data.object.id);
      }

      if (event.type === 'charge.refunded') {
        await markChargeRefunded(prisma, event.data.object);
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
  };

  app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), handleStripeWebhook);
  app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), handleStripeWebhook);

  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());

  if (process.env.NODE_ENV !== 'test') {
    const expiryTimer = setInterval(() => {
      expireStaleReservations(prisma).catch((error) => {
        console.error('[reservations] stale cleanup failed', error);
      });
    }, 60_000);
    expiryTimer.unref?.();
  }

  app.get('/', async (req, res) => {
    const [types, upcoming] = await Promise.all([
      prisma.class_types.findMany({ orderBy: { name: 'asc' }, take: 4 }),
      prisma.class_occurrences.findMany({
        include: { classType: true, trainer: true },
        orderBy: { startsAt: 'asc' },
        take: 4,
        where: { startsAt: { gte: new Date(dayjs().startOf('day').toISOString()) } },
      }),
    ]);

    const stats = {
      classTypes: types.length,
      upcoming: upcoming.length,
      firstClass: upcoming[0] || null,
    };

    const classProfiles = [
      {
        intensity: 'Baja',
        name: 'Yoga',
        description: 'Práctica accesible para aterrizar el cuerpo, soltar tensión y regular el ritmo.',
        durationMin: 40,
        guideText: 'Ideal cuando buscas bajar revoluciones con una secuencia amable y clara.',
        intensitySummary: 'Baja. Movimiento accesible para entrar en ritmo.',
        visualClass: 'baja',
        intensityOrder: 2,
      },
      {
        intensity: 'Media/Alta',
        name: 'Yoga Inmersivo',
        description: 'Práctica envolvente de mayor intensidad para foco, resistencia y presencia sostenida.',
        durationMin: 55,
        guideText: 'Pensada para una energía más activa, profunda y sostenida.',
        intensitySummary: 'Media/Alta. Práctica más intensa, activa y sostenida.',
        visualClass: 'media-alta',
        intensityOrder: 3,
      },
      {
        intensity: 'Suave',
        name: 'Head Spa',
        description: 'Experiencia suave de descanso, respiración y bienestar para volver al centro.',
        durationMin: 50,
        guideText: 'Funciona mejor cuando necesitas pausa, ligereza y recuperación.',
        intensitySummary: 'Suave. Pausa profunda, descanso y regulación.',
        visualClass: 'suave',
        intensityOrder: 1,
      },
    ];

    const normalizeIntensity = (value) => {
      const raw = String(value || '').trim().toLowerCase();
      if (raw === 'media' || raw === 'media/alta' || raw === 'media alta' || raw === 'alta') return 'Media/Alta';
      if (raw === 'suave') return 'Suave';
      if (raw === 'baja') return 'Baja';
      return 'Suave';
    };

    const getClassProfile = (intensity) => {
      const normalized = normalizeIntensity(intensity);
      return classProfiles.find((profile) => profile.intensity === normalized) || classProfiles[0];
    };

    const fallbackPractices = classProfiles.map((profile) => ({
      ...profile,
      intensity: profile.intensity,
      name: profile.name,
      description: profile.description,
      durationMin: profile.durationMin,
    }));

    const practiceEntries = [
      ...upcoming.map((occurrence) => {
        const profile = getClassProfile(occurrence.classType.intensity);
        return {
          intensity: profile.intensity,
          name: profile.name,
          description: profile.description,
          durationMin: occurrence.classType.durationMin || profile.durationMin,
          trainerName: occurrence.trainer.displayName,
          scheduleLabel: dayjs(occurrence.startsAt).format('DD MMM · HH:mm'),
          availabilityLabel: `${occurrence.availableSlots} cupos`,
          priceLabel: formatCurrency(occurrence.unitPriceCents),
          href: buildSeatSelectionUrl(occurrence.id),
          ctaLabel: 'Reservar práctica',
        };
      }),
      ...types
        .filter((type) => {
          const typeProfile = getClassProfile(type.intensity);
          return !upcoming.some((occurrence) => getClassProfile(occurrence.classType.intensity).name === typeProfile.name);
        })
        .map((type) => {
          const profile = getClassProfile(type.intensity);
          return {
            intensity: profile.intensity,
            name: profile.name,
            description: profile.description,
            durationMin: type.durationMin || profile.durationMin,
            trainerName: 'Equipo TISA',
            scheduleLabel: 'Agenda en actualización',
            availabilityLabel: 'Consulta horarios',
            priceLabel: 'Ver agenda',
            href: '/classes',
            ctaLabel: 'Ver agenda',
          };
        }),
      ...fallbackPractices
        .filter((fallback) => {
          return !types.some((type) => getClassProfile(type.intensity).name === fallback.name)
            && !upcoming.some((occurrence) => getClassProfile(occurrence.classType.intensity).name === fallback.name);
        })
        .map((fallback) => ({
          ...fallback,
          trainerName: 'Equipo TISA',
          scheduleLabel: 'Agenda en actualización',
          availabilityLabel: 'Consulta horarios',
          priceLabel: 'Ver agenda',
          href: '/classes',
          ctaLabel: 'Ver agenda',
        })),
    ];

    const typeCards = practiceEntries
      .map(
        (t) => `
      <article class="card tisa-card landing-practice-card reveal">
        <div class="landing-practice-topline">
          <span class="tag">${esc(t.intensity)}</span>
          <span class="landing-practice-schedule">${esc(t.scheduleLabel)}</span>
        </div>
        <h3>${esc(t.name)}</h3>
        <p>${esc(t.description)}</p>
        <div class="experience-meta">
          <span class="status-pill">${t.durationMin} min</span>
          <span class="experience-detail">Diseñada para un ritmo ${esc(t.intensity.toLowerCase())}</span>
        </div>
        <div class="landing-practice-info">
          <div class="landing-practice-info-row">
            <span>Guía</span>
            <strong>${esc(t.trainerName)}</strong>
          </div>
          <div class="landing-practice-info-row">
            <span>Disponibilidad</span>
            <strong>${esc(t.availabilityLabel)}</strong>
          </div>
          <div class="landing-practice-info-row">
            <span>Precio</span>
            <strong>${esc(t.priceLabel)}</strong>
          </div>
        </div>
        <div class="landing-practice-actions">
          <a class="btn" href="${esc(t.href)}">${esc(t.ctaLabel)}</a>
        </div>
      </article>
    `
      )
      .join('');

    const classGuideCards = [...classProfiles]
      .sort((a, b) => a.intensityOrder - b.intensityOrder)
      .map(
        (profile) => `
      <article class="card tisa-card landing-class-guide-card reveal">
        <span class="ritual-step">${esc(profile.intensity)}</span>
        <h3>${esc(profile.name)}</h3>
        <p>${esc(profile.guideText)}</p>
      </article>
    `
      )
      .join('');

    const principleCards = brand.home.principles
      .map(
        (item) => `
      <article class="card tisa-card landing-principle-card reveal">
        <span class="ritual-step">${item.label}</span>
        <h3>${item.title}</h3>
        <p>${item.text}</p>
      </article>
    `
      )
      .join('');

    const body = `
      <section class="landing-intro" id="landing-intro" aria-label="Pantalla de bienvenida de TISA">
        <div class="intro-shell">
          <div class="intro-copy">
            <div class="intro-panel">
              <div class="intro-actions" role="group" aria-label="Acciones principales de TISA">
                <button type="button" class="btn intro-glass-button intro-glass-button-wordmark" id="intro-discover" aria-label="Conoce Tisa">
                  <span class="intro-button-copy">
                    <span>Conoce</span>
                    <img class="intro-button-wordmark" src="/static/intro-tisa-wordmark.svg" alt="Tisa" />
                  </span>
                </button>
                <a class="btn intro-glass-button" id="intro-reserve" href="/classes">Reservar Ahora</a>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section class="landing-page story-root">
        <section class="landing-hero reveal scroll-hero" data-scroll-target="home-overview">
          <div class="landing-hero-main">
            <p class="page-kicker">${brand.home.kicker}</p>
            <h1>${brand.home.title}</h1>
            <p class="page-lede">${brand.home.lede}</p>
            <div class="hero-actions">
              <a class="btn" href="/classes">Ver agenda</a>
              <button type="button" class="btn alt" data-scroll-target="home-overview">Cómo funciona</button>
            </div>
            <div class="landing-stat-grid">
              <article class="landing-stat-card"><span>Prácticas activas</span><strong>${stats.classTypes}</strong></article>
              <article class="landing-stat-card"><span>Próximas salidas</span><strong>${stats.upcoming}</strong></article>
              <article class="landing-stat-card"><span>Primera clase</span><strong>${stats.firstClass ? dayjs(stats.firstClass.startsAt).format('DD MMM · HH:mm') : 'En actualización'}</strong></article>
            </div>
          </div>
          <aside class="landing-hero-side">
            <figure class="landing-media-frame">
              <img src="${brand.assets.editorialGrid}" alt="Atmósfera editorial de TISA" />
            </figure>
            <div class="landing-note-card">
              <span>${brand.home.noteTitle}</span>
              <strong>${brand.home.noteText}</strong>
            </div>
          </aside>
        </section>

        <section class="landing-principles" id="home-overview">
          ${principleCards}
        </section>

        <section class="landing-feature reveal">
          <article class="landing-feature-copy">
            <p class="eyebrow">${brand.home.storyKicker}</p>
            <h2>${brand.home.storyTitle}</h2>
            <p>${brand.home.storyBody}</p>
            <p class="quote">"${brand.home.storyQuote}"</p>
          </article>
          <article class="landing-feature-media">
            <img src="${brand.assets.conceptGrid}" alt="Referencia conceptual TISA" />
          </article>
        </section>

        <section class="landing-band reveal">
          <div class="landing-band-lead">
            <p class="eyebrow">TIPOS DE CLASE</p>
            <h2>Diferentes prácticas para distintos ritmos y necesidades.</h2>
            <p>Revisa cada clase con su enfoque, horario, guía, cupos y precio para identificar rápido la opción que mejor acompaña tu momento.</p>
          </div>
          <div class="landing-band-body landing-practice-carousel" data-card-carousel>
            <div class="landing-carousel-toolbar">
              <div class="landing-carousel-controls" aria-label="Controles de navegación de clases">
                <button type="button" class="landing-carousel-button" data-carousel-prev aria-label="Ver clase anterior">&larr;</button>
                <button type="button" class="landing-carousel-button" data-carousel-next aria-label="Ver siguiente clase">&rarr;</button>
              </div>
            </div>
            <div class="landing-carousel-viewport" data-carousel-viewport aria-label="Tipos de clase disponibles">
              <div class="landing-practice-grid landing-carousel-track">
                ${typeCards}
              </div>
            </div>
          </div>
        </section>

        <section class="landing-panel reveal">
          <div class="landing-panel-head">
            <p class="eyebrow">GUÍA RÁPIDA</p>
            <h2>Una forma simple de elegir entre las tres prácticas.</h2>
            <p>Cada clase responde a una intención distinta: bajar el ritmo, profundizar la energía o descansar con suavidad.</p>
          </div>
          <div class="landing-panel-body landing-class-guide-grid">
            ${classGuideCards}
          </div>
        </section>

        <section class="landing-panel reveal landing-ops-panel">
          <div class="landing-panel-head">
            <p class="eyebrow">OPERACIÓN COMPARTIDA</p>
            <h2>La parte interna también responde al mismo sistema.</h2>
            <p>Staff, trainers y operación reciben una limpieza visual inmediata para que el producto público y la operación hablen el mismo idioma.</p>
          </div>
          <div class="landing-panel-body landing-ops-layout">
            <div class="ops-panels">
              <div class="ops-panel">
                <span>Admin</span>
                <strong>Lectura diaria del estudio, pagos y ocupación sin ruido visual.</strong>
              </div>
              <div class="ops-panel">
                <span>Trainer</span>
                <strong>Agenda clara para programar, revisar reservas y sostener el ritmo del día.</strong>
              </div>
              <div class="ops-panel">
                <span>Check-in</span>
                <strong>Validación rápida con respuestas legibles y consistentes con la experiencia pública.</strong>
              </div>
            </div>
          </div>
        </section>
      </section>
    `;

    res.send(renderLayout({ title: 'Inicio', body, simulationMode: config.simulationMode }));
  });

  app.get(['/concept-tisa-01', '/concept-goyo'], async (req, res) => {
    const [types, upcoming] = await Promise.all([
      prisma.class_types.findMany({ orderBy: { name: 'asc' }, take: 3 }),
      prisma.class_occurrences.findMany({
        include: { classType: true, trainer: true },
        orderBy: { startsAt: 'asc' },
        take: 4,
        where: { startsAt: { gte: new Date(dayjs().startOf('day').toISOString()) } },
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

    const pricingCards = upcoming
      .map(
        (occurrence) => `
        <article class="concept-bundle-card">
          <p>${esc(occurrence.classType.name)}</p>
          <strong>${dayjs(occurrence.startsAt).format('DD MMM · HH:mm')}</strong>
          <span>${formatCurrency(occurrence.unitPriceCents)}</span>
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
            <p class="concept-label">PRECIO</p>
            <h2>El valor de la reservación visible antes del clic.</h2>
            <div class="concept-bundle-grid">
              ${pricingCards}
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
    const upcoming = await prisma.class_occurrences.findMany({
      include: { classType: true, trainer: true, location: true },
      orderBy: { startsAt: 'asc' },
      take: 6,
      where: { startsAt: { gte: new Date(dayjs().startOf('day').toISOString()) } },
    });

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

    const pricingRows = upcoming
      .map(
        (occurrence) => `
        <article class="concept2-bundle-row">
          <div>
            <p>${esc(occurrence.classType.name)}</p>
            <strong>${dayjs(occurrence.startsAt).format('DD MMM · HH:mm')}</strong>
          </div>
          <span>${formatCurrency(occurrence.unitPriceCents)}</span>
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
            <p>Este concepto lleva la calma visual de TISA al momento más importante: elegir una práctica, entender el valor de cada lugar y cerrar la reserva dentro de una superficie cálida, simple y precisa.</p>
          </div>
          <div class="concept2-chip-row">
            <span>Agenda contemplativa</span>
            <span>Reserva sin fricción</span>
            <span>Precio visible</span>
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
              <div><span>Precio</span><strong>${featured ? formatCurrency(featured.unitPriceCents) : 'Por definir'}</strong></div>
            </div>
            <div class="concept2-action-box">
              <button class="btn" type="button">Abrir Checkout</button>
              <button class="btn alt" type="button">Ver agenda</button>
            </div>
          </article>
        </section>

        <section class="concept2-secondary-grid">
          <article class="concept2-panel concept2-wallet-panel">
            <p class="concept-label">PRICING</p>
            <h2>El precio por horario debe sentirse claro, presente y tranquilo.</h2>
            <div class="concept2-wallet-card">
              <span>Disponible ahora</span>
              <strong>${featured ? formatCurrency(featured.unitPriceCents) : 'MXN 350'}</strong>
              <p>${featured ? esc(featured.classType.name) : 'Práctica destacada'}</p>
            </div>
            <div class="concept2-bundle-list">
              ${pricingRows}
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
          <h2>Este concepto conserva la sensibilidad editorial de TISA, pero la acerca más al producto real: agenda, checkout y reserva dentro de una experiencia coherente.</h2>
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
              <p>Este concepto reúne agenda, selección, pago y confirmación en una experiencia más cálida, pensada para moverse con una mano y decidir sin esfuerzo.</p>
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
                  <div><span>Precio</span><strong>${featured ? formatCurrency(featured.unitPriceCents) : 'MXN 350'}</strong></div>
                </div>
                <button class="btn" type="button">Pagar ahora</button>
                <button class="btn alt" type="button">Ver agenda</button>
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
              <button class="btn" type="button">Abrir checkout</button>
              <button class="btn alt" type="button">Ver lugares</button>
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
    const accessCards = await prisma.class_occurrences.findMany({
      include: { classType: true, trainer: true },
      orderBy: { startsAt: 'asc' },
      take: 3,
      where: { startsAt: { gte: new Date(dayjs().startOf('day').toISOString()) } },
    });

    const pricingCards = accessCards
      .map(
        (schedule) => `
        <article class="access-product-row">
          <div>
            <p>${esc(schedule.classType.name)}</p>
            <strong>${dayjs(schedule.startsAt).format('DD MMM · HH:mm')}</strong>
          </div>
          <span>${formatCurrency(schedule.unitPriceCents)}</span>
        </article>
      `
      )
      .join('');

    const body = `
      <section class="system-shell">
        <section class="system-hero scroll-hero" data-scroll-target="access-entry">
          <div>
            <p class="concept-label">TISA / CHECKOUT Y RESERVA</p>
            <h1>El checkout, la confirmación y el QR deben sentirse parte del mismo ritual.</h1>
            <p>Este board ordena el tramo más sensible del producto: elegir lugares, decidir qué horario pagar y llegar con una confirmación que inspire calma y certeza.</p>
          </div>
          <div class="system-chip-row">
            <button class="system-chip-button" type="button" data-scroll-target="access-entry">Checkout directo</button>
            <button class="system-chip-button" type="button" data-scroll-target="access-bundles">Precio contextual</button>
            <button class="system-chip-button" type="button" data-scroll-target="access-qr">QR sereno</button>
          </div>
        </section>

        <section class="system-grid access-grid">
          <article class="system-panel system-panel-light" id="access-entry">
            <p class="concept-label">CHECKOUT DIRECTO</p>
            <h2>Confirmar tu lugar en menos de un minuto.</h2>
            <div class="system-detail-list">
              <div><span>Práctica</span><strong>${occurrence ? esc(occurrence.classType.name) : 'Meditación Guiada'}</strong></div>
              <div><span>Horario</span><strong>${occurrence ? shortDateLabel(dayjs(occurrence.startsAt)) : '06 MAR · 07:00'}</strong></div>
              <div><span>Guía</span><strong>${occurrence ? esc(occurrence.trainer.displayName) : 'Sofía Luna'}</strong></div>
              <div><span>Precio</span><strong>${occurrence ? formatCurrency(occurrence.unitPriceCents) : 'MXN 350'}</strong></div>
            </div>
            <div class="mail-chip">alemunozpro80@gmail.com</div>
            <button class="btn" type="button">Pagar y emitir QR</button>
          </article>

          <article class="system-panel system-panel-dark" id="access-bundles">
            <p class="concept-label">PRECIO POR HORARIO</p>
            <h2>Elegir sin salir del flujo.</h2>
            <div class="access-product-list">
              ${pricingCards}
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
      prisma.bookings.count({ where: { status: { in: ACTIVE_RESERVATION_STATUSES } } }),
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
    const titleRange = formatAgendaRangeLabel(periodStart, view);
    const classCount = classes.length;
    const availableCount = classes.filter((c) => c.status !== 'CANCELLED' && c.availableSlots > 0).length;
    const firstClass = classes[0] || null;
    const firstBookableClass = classes.find((item) => item.status !== 'CANCELLED' && item.availableSlots > 0) || null;
    const classesByDay = new Map(days.map((d) => [d.format('YYYY-MM-DD'), []]));

    classes.forEach((item) => {
      const key = dayjs(item.startsAt).format('YYYY-MM-DD');
      if (!classesByDay.has(key)) classesByDay.set(key, []);
      classesByDay.get(key).push(item);
    });

    const typeLabels = Array.from(new Set(classes.map((item) => item.classType.name))).sort((a, b) => a.localeCompare(b, 'es-MX'));
    const intensityLabels = Array.from(new Set(classes.map((item) => normalizeAgendaIntensity(item.classType.intensity)))).sort(
      (a, b) => AGENDA_INTENSITY_ORDER.indexOf(a) - AGENDA_INTENSITY_ORDER.indexOf(b),
    );

    const typeChips = typeLabels.length
      ? typeLabels.map((label) => `<span class="classes-filter-chip">${esc(label)}</span>`).join('')
      : '<span class="classes-filter-chip is-muted">Agenda en actualización</span>';
    const intensityChips = intensityLabels.length
      ? intensityLabels
          .map((label) => {
            const meta = getAgendaIntensityMeta(label);
            return `<span class="classes-filter-chip ${meta.className}">${esc(meta.label)}</span>`;
          })
          .join('')
      : '<span class="classes-filter-chip is-muted">Sin intensidades en este rango</span>';

    const weekColumns = days
      .map((d) => {
        const dayKey = d.format('YYYY-MM-DD');
        const dayClasses = classesByDay.get(dayKey) || [];
        return `
          <section class="classes-day-column ${dayjs().isSame(d, 'day') ? 'is-today' : ''}">
            <header class="classes-day-column__header">
              <span>${formatAgendaDayName(d)}</span>
              <strong>${formatAgendaDateLabel(d)}</strong>
            </header>
            <div class="classes-day-column__events">
              ${
                dayClasses.length
                  ? dayClasses.map((occurrence) => renderClassesEditorialEventCard(occurrence)).join('')
                  : `<article class="classes-empty-card">
                      <span>Sin clases</span>
                      <p>Este día queda libre para una pausa más amplia o una próxima actualización de agenda.</p>
                    </article>`
              }
            </div>
          </section>
        `;
      })
      .join('');

    const monthGrid = days
      .map((d) => {
        const dayKey = d.format('YYYY-MM-DD');
        const dayClasses = classesByDay.get(dayKey) || [];
        return `
          <section class="classes-month-day ${!d.isSame(periodStart, 'month') ? 'is-out-of-range' : ''} ${dayjs().isSame(d, 'day') ? 'is-today' : ''}">
            <header class="classes-month-day__header">
              <span>${formatAgendaDayNameShort(d)}</span>
              <strong>${String(d.date()).padStart(2, '0')}</strong>
            </header>
            <div class="classes-month-day__events">
              ${
                dayClasses.length
                  ? dayClasses.map((occurrence) => renderClassesEditorialEventCard(occurrence, { compact: true })).join('')
                  : '<p class="classes-month-day__empty">Sin clases programadas.</p>'
              }
            </div>
          </section>
        `;
      })
      .join('');

    const body = `<section class="classes-editorial-shell">
      <section class="classes-hero reveal">
        <div class="classes-hero__copy">
          <p class="classes-kicker">${brand.agenda.kicker}</p>
          <h1>${brand.agenda.title}</h1>
          <p class="classes-lede">${brand.agenda.lede}</p>
          <div class="classes-hero__actions">
            <button type="button" class="classes-hero-button" data-scroll-target="classes-editorial-grid">Ver agenda</button>
            <button type="button" class="classes-hero-button is-secondary" data-scroll-target="classes-toolbar">Cambiar vista</button>
          </div>
          <div class="classes-metric-row">
            <article class="classes-metric-card">
              <span>Clases en rango</span>
              <strong>${classCount}</strong>
            </article>
            <article class="classes-metric-card">
              <span>Disponibles</span>
              <strong>${availableCount}</strong>
            </article>
            <article class="classes-metric-card">
              <span>Primera salida</span>
              <strong>${firstClass ? `${formatAgendaDateLabel(firstClass.startsAt)} · ${dayjs(firstClass.startsAt).format('HH:mm')}` : 'Sin clases'}</strong>
            </article>
          </div>
        </div>
        <aside class="classes-hero__aside">
          <article class="classes-spotlight-card">
            <span>${brand.agenda.howItWorksTitle}</span>
            <strong>${firstBookableClass ? esc(firstBookableClass.classType.name) : 'Agenda en actualización'}</strong>
            <p>${
              firstBookableClass
                ? `${formatAgendaDayName(firstBookableClass.startsAt)} ${formatAgendaDateLabel(firstBookableClass.startsAt)} · ${dayjs(firstBookableClass.startsAt).format('HH:mm')} · ${esc(firstBookableClass.trainer.displayName)}`
                : esc(brand.agenda.howItWorksText)
            }</p>
          </article>
          <div class="classes-hero-media">
            <figure class="classes-hero-media__portrait">
              <img src="${brand.assets.editorialGrid}" alt="Textura editorial TISA" />
            </figure>
            <figure class="classes-hero-media__landscape">
              <img src="${brand.assets.mineralSurface}" alt="Superficie mineral TISA" />
            </figure>
          </div>
        </aside>
      </section>

      <section class="classes-filter-panel">
        <div class="classes-filter-group">
          <span class="classes-filter-group__label">Prácticas en este rango</span>
          <div class="classes-filter-group__chips">${typeChips}</div>
        </div>
        <div class="classes-filter-group">
          <span class="classes-filter-group__label">Intensidades activas</span>
          <div class="classes-filter-group__chips">${intensityChips}</div>
        </div>
      </section>

      <section class="classes-toolbar" id="classes-toolbar">
        <div class="classes-toolbar__copy">
          <p class="classes-toolbar__eyebrow">Navegación</p>
          <h2>${view === 'month' ? 'Mes editorial' : 'Semana editorial'}</h2>
          <p>${titleRange}</p>
        </div>
        <div class="classes-toolbar__actions">
          <a class="classes-toolbar-link" href="/classes?view=${view}&start=${prevStart.format('YYYY-MM-DD')}">Anterior</a>
          <span class="classes-toolbar-range">${titleRange}</span>
          <a class="classes-toolbar-link" href="/classes?view=${view}&start=${nextStart.format('YYYY-MM-DD')}">Siguiente</a>
          <a class="classes-toolbar-link ${view === 'week' ? 'is-active' : ''}" href="/classes?view=week&start=${startOfWeekMonday(periodStart).format('YYYY-MM-DD')}">Semana</a>
          <a class="classes-toolbar-link ${view === 'month' ? 'is-active' : ''}" href="/classes?view=month&start=${dayjs(periodStart).startOf('month').format('YYYY-MM-DD')}">Mes</a>
        </div>
      </section>

      ${
        req.query.error
          ? `<div class="ui-status-banner is-cancel classes-status-banner">
              <div>
                <p class="concept-kicker">Disponibilidad</p>
                <h2>El mapa cambió antes de confirmar.</h2>
                <p>${esc(String(req.query.error))}</p>
              </div>
            </div>`
          : ''
      }

      <section class="classes-board" id="classes-editorial-grid">
        ${
          view === 'month'
            ? `<div class="classes-month-grid">${monthGrid}</div>`
            : `<div class="classes-week-grid">${weekColumns}</div>`
        }
      </section>
    </section>`;
    res.send(
      renderLayout({
        title: 'Clases',
        body,
        simulationMode: config.simulationMode,
        bodyClass: 'classes-editorial-page',
        mainClass: 'classes-editorial-main',
        hideDefaultHeader: true,
        customHeaderHtml: renderClassesCustomHeader(),
        customFooterHtml: renderClassesCustomFooter({ view, periodStart }),
      }),
    );
  });

  app.get('/booking/seats', async (req, res) => {
    await expireStaleReservations(prisma);
    const occurrenceId = String(req.query.occurrenceId || '');
    if (!occurrenceId) return res.status(400).send(renderError('Falta la clase a reservar.'));

    const occurrence = await prisma.class_occurrences.findUnique({
      where: { id: occurrenceId },
      include: { classType: true, trainer: true, location: true },
    });
    if (!occurrence) return res.status(404).send(renderError('Clase no encontrada.'));
    if (occurrence.status === 'CANCELLED') return res.status(409).send(renderError('La clase fue cancelada por el trainer.'));

    const occupiedSeatCodes = await getActiveSeatCodes(prisma, occurrence.id);

    const body = renderSeatSelectionBody({
      occurrence,
      occupiedSeatCodes,
      customerName: String(req.query.customerName || ''),
      customerEmail: String(req.query.customerEmail || ''),
      customerPhone: String(req.query.customerPhone || ''),
      message: req.query.error ? String(req.query.error) : '',
      messageType: 'error',
    });

    res.send(renderLayout({
      title: 'Elegir lugares',
      body,
      simulationMode: config.simulationMode,
      bodyClass: 'seat-floorplan-body',
      mainClass: 'seat-floorplan-main',
      hideDefaultHeader: true,
      customHeaderHtml: renderSeatSelectionHeader(),
    }));
  });

  const reservationSchema = z.object({
    occurrenceId: z.string().min(8),
    seatCodes: z.array(z.string().min(2)).min(1),
    customerName: z.string().min(2),
    customerEmail: z.string().email(),
    customerPhone: z.string().trim().optional().or(z.literal('')),
    salesChannel: z.enum(['web', 'whatsapp']).default('web'),
  });

  const checkoutSchema = z.object({
    reservationId: z.string().min(8),
    salesChannel: z.enum(['web', 'whatsapp']).default('web'),
  });

  app.post('/api/reservations', async (req, res) => {
    try {
      const parsed = reservationSchema.parse({
        ...req.body,
        seatCodes: Array.isArray(req.body.seatCodes) ? req.body.seatCodes : [req.body.seatCodes].filter(Boolean),
      });
      const reservation = await createDraftReservation(prisma, parsed);
      const payload = await getReservationResponse(prisma, reservation.id, getBaseUrl(req));
      res.status(201).json(payload);
    } catch (error) {
      if (error instanceof ReservationError) {
        return res.status(error.status).json({ error: error.message, code: error.code });
      }
      throw error;
    }
  });

  app.get('/api/reservations/:id', async (req, res) => {
    try {
      const payload = await getReservationResponse(prisma, req.params.id, getBaseUrl(req), { createManageLink: true });
      res.json(payload);
    } catch (error) {
      if (error instanceof ReservationError) {
        return res.status(error.status).json({ error: error.message, code: error.code });
      }
      throw error;
    }
  });

  app.post('/api/payments/checkout-session', async (req, res) => {
    try {
      const parsed = checkoutSchema.parse(req.body);
      const result = await createCheckoutSessionForReservation(prisma, {
        ...parsed,
        baseUrl: getBaseUrl(req),
      });
      res.status(201).json({
        reservationId: parsed.reservationId,
        paymentId: result.payment.id,
        checkoutUrl: result.checkoutUrl,
        paymentMethodTypes: result.paymentMethodTypes,
      });
    } catch (error) {
      if (error instanceof ReservationError) {
        return res.status(error.status).json({ error: error.message, code: error.code });
      }
      throw error;
    }
  });

  app.post('/api/payments/payment-link', async (req, res) => {
    try {
      const parsed = checkoutSchema.parse({
        reservationId: req.body.reservationId,
        salesChannel: 'whatsapp',
      });
      const result = await createCheckoutSessionForReservation(prisma, {
        ...parsed,
        baseUrl: getBaseUrl(req),
      });
      res.status(201).json({
        reservationId: parsed.reservationId,
        paymentId: result.payment.id,
        paymentLinkUrl: result.checkoutUrl,
        checkoutUrl: result.checkoutUrl,
        paymentMethodTypes: result.paymentMethodTypes,
      });
    } catch (error) {
      if (error instanceof ReservationError) {
        return res.status(error.status).json({ error: error.message, code: error.code });
      }
      throw error;
    }
  });

  app.post('/reservations/web-checkout', async (req, res) => {
    const seatCodes = Array.isArray(req.body.seatCodes) ? req.body.seatCodes : req.body.seatCodes ? [req.body.seatCodes] : [];
    const parsed = reservationSchema.safeParse({
      ...req.body,
      seatCodes,
      customerName: req.body.customerName,
      customerEmail: req.body.customerEmail,
      customerPhone: req.body.customerPhone,
      salesChannel: req.body.salesChannel || 'web',
    });

    if (!parsed.success) {
      return res.status(400).redirect(buildSeatSelectionUrl(String(req.body.occurrenceId || ''), {
        error: 'Completa nombre, correo y al menos un lugar para continuar.',
        customerName: String(req.body.customerName || ''),
        customerEmail: String(req.body.customerEmail || ''),
        customerPhone: String(req.body.customerPhone || ''),
      }));
    }

    try {
      const reservation = await createDraftReservation(prisma, parsed.data);
      const checkout = await createCheckoutSessionForReservation(prisma, {
        reservationId: reservation.id,
        salesChannel: parsed.data.salesChannel,
        baseUrl: getBaseUrl(req),
      });
      return res.redirect(checkout.checkoutUrl);
    } catch (error) {
      const occurrence = await prisma.class_occurrences.findUnique({
        where: { id: parsed.data.occurrenceId },
        include: { classType: true, trainer: true, location: true },
      });
      if (!occurrence) throw error;
      const occupiedSeatCodes = await getActiveSeatCodes(prisma, occurrence.id);
      const body = renderSeatSelectionBody({
        occurrence,
        occupiedSeatCodes,
        selectedSeatCodes: parsed.data.seatCodes,
        customerName: parsed.data.customerName,
        customerEmail: parsed.data.customerEmail,
        customerPhone: parsed.data.customerPhone || '',
        message: error instanceof ReservationError ? error.message : 'No se pudo iniciar la reservación.',
      });
      return res.status(error instanceof ReservationError ? error.status : 500).send(
        renderLayout({
          title: 'Elegir lugares',
          body,
          simulationMode: config.simulationMode,
          bodyClass: 'seat-floorplan-body',
          mainClass: 'seat-floorplan-main',
          hideDefaultHeader: true,
          customHeaderHtml: renderSeatSelectionHeader(),
        }),
      );
    }
  });

  app.post('/reservations/:id/checkout', async (req, res) => {
    try {
      const result = await createCheckoutSessionForReservation(prisma, {
        reservationId: req.params.id,
        salesChannel: String(req.body.salesChannel || 'web'),
        baseUrl: getBaseUrl(req),
      });
      res.redirect(result.checkoutUrl);
    } catch (error) {
      if (error instanceof ReservationError) {
        return res.status(error.status).send(renderError(error.message));
      }
      throw error;
    }
  });

  app.get('/checkout/success', async (req, res) => {
    const sessionId = String(req.query.session_id || '');
    if (!sessionId) return res.status(400).send(renderError('Falta la sesión de checkout.'));

    try {
      const result = await fulfillCheckout(prisma, {
        sessionId,
        baseUrl: getBaseUrl(req),
      });
      const reservation = await getReservationResponse(prisma, result.reservation.id, getBaseUrl(req), { createManageLink: result.state === 'paid' });
      const qrDataUrl =
        reservation.qrPayload && result.reservation.qrSignature
          ? await QRCode.toDataURL(JSON.stringify({ ...parseJson(reservation.qrPayload, {}), signature: result.reservation.qrSignature }))
          : null;

      const checkoutCopy = getCheckoutStateCopy(result.state);
      let heroTitle = checkoutCopy.title;
      let heroCopy = checkoutCopy.copy;
      let actionMarkup = '<a class="btn alt" href="/classes">Volver a la agenda</a>';

      if (result.state === 'paid') {
        actionMarkup = `
          ${reservation.manageUrl ? `<a class="btn" href="${reservation.manageUrl}">Abrir detalle de la reservación</a>` : ''}
          <a class="btn alt" href="/classes">Reservar otra práctica</a>
        `;
      }

      const body = `<section class="section"><div class="system-shell">
        <section class="system-hero">
          <p class="concept-kicker">TISA / CHECKOUT</p>
          <h1>${heroTitle}</h1>
          <p>${heroCopy}</p>
        </section>
        <div class="system-grid">
          <article class="system-panel system-panel-light">
            <h2>Resumen</h2>
            <div class="system-detail-list">
              <div><span>Referencia</span><strong>${esc(reservation.bookingRef)}</strong></div>
              <div><span>Estado</span><strong>${esc(getBookingStateLabel(reservation.status))}</strong></div>
              <div><span>Cliente</span><strong>${esc(reservation.customer.email)}</strong></div>
              <div><span>Total</span><strong>MXN ${(reservation.pricing.totalCents / 100).toLocaleString('es-MX')}</strong></div>
            </div>
          </article>
          <article class="system-panel system-panel-dark system-panel-texture-dark">
            <h2>Próximo paso</h2>
            ${qrDataUrl ? `<img class="qr" src="${qrDataUrl}" alt="QR de acceso" />` : '<p class="system-inline-note">El QR solo aparece cuando el pago ya está confirmado.</p>'}
            <div class="system-action-stack">${actionMarkup}</div>
          </article>
        </div>
      </div></section>`;
      res.send(renderLayout({ title: 'Checkout', body, simulationMode: config.simulationMode }));
    } catch (error) {
      if (error instanceof ReservationError) {
        return res.status(error.status).send(renderError(error.message));
      }
      throw error;
    }
  });

  app.get('/checkout/cancel', async (req, res) => {
    const reservationId = String(req.query.reservation_id || '');
    if (!reservationId) return res.status(400).send(renderError('Falta la reservación asociada.'));

    try {
      const reservation = await getReservationResponse(prisma, reservationId, getBaseUrl(req));
      const canRetry = reservation.status === 'PENDING_PAYMENT' || reservation.status === 'PAYMENT_PENDING_ASYNC';
      const body = `<section class="section"><div class="system-shell">
        <section class="system-hero">
          <p class="concept-kicker">TISA / CHECKOUT</p>
          <h1>Pausa en el pago.</h1>
          <p>No se registró un cobro confirmado. Si el apartado sigue vigente, puedes retomarlo desde esta misma pantalla.</p>
        </section>
        <div class="system-grid">
          <article class="system-panel system-panel-light">
            <h2>Reservación</h2>
            <div class="system-detail-list">
              <div><span>Referencia</span><strong>${esc(reservation.bookingRef)}</strong></div>
              <div><span>Estado</span><strong>${esc(getBookingStateLabel(reservation.status))}</strong></div>
              <div><span>Expira</span><strong>${reservation.expiresAt ? dayjs(reservation.expiresAt).format('DD MMM · HH:mm') : 'Sin hold activo'}</strong></div>
            </div>
          </article>
          <article class="system-panel system-panel-dark">
            <h2>Continuar cuando quieras</h2>
            <div class="system-action-stack">
              ${canRetry ? `<form method="post" action="/reservations/${reservation.id}/checkout"><input type="hidden" name="salesChannel" value="${esc(reservation.salesChannel || 'web')}" /><button class="btn" type="submit">Reintentar pago</button></form>` : ''}
              <a class="btn alt" href="/classes">Volver a la agenda</a>
            </div>
          </article>
        </div>
      </div></section>`;
      res.send(renderLayout({ title: 'Pago cancelado', body, simulationMode: config.simulationMode }));
    } catch (error) {
      if (error instanceof ReservationError) {
        return res.status(error.status).send(renderError(error.message));
      }
      throw error;
    }
  });

  app.get('/booking/manage', async (req, res) => {
    const token = String(req.query.token || '');
    const bookingId = String(req.query.bookingId || '');
    const link = await prisma.magic_links.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!link || dayjs(link.expiresAt).isBefore(dayjs())) return res.status(400).send(renderError('Acceso inválido'));
    if (!link.purpose.includes(bookingId)) return res.status(403).send(renderError('Token no corresponde a la reserva'));

    const booking = await prisma.bookings.findUnique({
      where: { id: bookingId },
      include: { classOccurrence: { include: { classType: true, trainer: true, location: true } }, client: true, reservedSeats: true },
    });

    if (!booking) return res.status(404).send(renderError('Reserva no encontrada'));
    const qrDataUrl = booking.qrPayload && booking.qrSignature
      ? await QRCode.toDataURL(JSON.stringify({ ...parseJson(booking.qrPayload, {}), signature: booking.qrSignature }))
      : null;
    const seatSummary = describeReservedSeats(booking.reservedSeats, booking.classOccurrence.layoutJson, booking.classOccurrence.capacity);
    const seatLabels = seatSummary.map((seat) => seat.label).join(', ');

    const body = `<section class="section">
      <div class="system-shell">
        <section class="system-hero scroll-hero" data-scroll-target="manage-booking-grid">
          <p class="concept-kicker">${brand.manage.kicker}</p>
          <h1>${brand.manage.title}</h1>
          <p>${brand.manage.lede}</p>
        </section>
        <div class="system-grid" id="manage-booking-grid">
          <article class="system-panel system-panel-light system-panel-texture">
            <h2>${esc(booking.classOccurrence.classType.name)}</h2>
            <div class="system-detail-list">
              <div><span>Correo</span><strong>${esc(booking.client.email)}</strong></div>
              <div><span>Guía</span><strong>${esc(booking.classOccurrence.trainer.displayName)}</strong></div>
              <div><span>Espacio</span><strong>${esc(booking.classOccurrence.location.name)}</strong></div>
              <div><span>Lugares</span><strong>${esc(seatLabels || 'Sin lugares asignados')}</strong></div>
              <div><span>Personas</span><strong>${booking.quantity}</strong></div>
              <div><span>Estado</span><strong>${getBookingStateLabel(booking.status)}</strong></div>
            </div>
          </article>
          <article class="system-panel system-panel-dark system-panel-texture-dark">
            <h2>Tu QR de acceso</h2>
            <p>${qrDataUrl ? 'Presenta este código al llegar al estudio para completar tu entrada.' : 'El QR aparece aquí solo después de la confirmación definitiva del pago.'}</p>
            ${qrDataUrl ? `<img class="qr" src="${qrDataUrl}" alt="QR" />` : '<p class="system-inline-note">Aún no hay acceso emitido para esta reservación.</p>'}
          </article>
        </div>
      </div>
    </section>`;
    res.send(renderLayout({ title: 'Gestionar reserva', body, simulationMode: config.simulationMode }));
  });

  app.post('/bookings/:id/cancel', async (req, res) => {
    res.status(409).send(renderError('La cancelación en línea no está disponible en esta fase. Contacta al staff para soporte.'));
  });

  app.get('/staff/login', (req, res) => {
    const body = `<section class="section">
      <div class="system-shell">
        <section class="system-hero">
          <p class="concept-kicker">${brand.staff.kicker}</p>
          <h1>${brand.staff.title}</h1>
          <p>${brand.staff.lede}</p>
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

  const loadAssistedSalesOccurrences = () =>
    prisma.class_occurrences.findMany({
      include: { classType: true, trainer: true, location: true },
      orderBy: { startsAt: 'asc' },
      take: 24,
      where: {
        status: { not: 'CANCELLED' },
        startsAt: { gte: new Date(dayjs().startOf('day').toISOString()) },
      },
    });

  app.get('/admin/assisted-sales', requireStaff, requireRole('ADMIN', 'OPS'), async (req, res) => {
    const occurrences = await loadAssistedSalesOccurrences();
    const body = renderAssistedSalesBody({
      occurrences,
      form: {
        occurrenceId: String(req.query.occurrenceId || occurrences[0]?.id || ''),
        seatCodesText: String(req.query.seatCodesText || ''),
        customerName: String(req.query.customerName || ''),
        customerEmail: String(req.query.customerEmail || ''),
        customerPhone: String(req.query.customerPhone || ''),
      },
    });
    res.send(renderLayout({
      title: 'Ventas Asistidas',
      body,
      staff: req.session.staffName,
      staffRole: req.session.staffRole,
      simulationMode: config.simulationMode,
    }));
  });

  app.post('/admin/assisted-sales', requireStaff, requireRole('ADMIN', 'OPS'), async (req, res) => {
    const occurrences = await loadAssistedSalesOccurrences();
    const form = {
      occurrenceId: String(req.body.occurrenceId || ''),
      seatCodesText: String(req.body.seatCodesText || ''),
      customerName: String(req.body.customerName || ''),
      customerEmail: String(req.body.customerEmail || ''),
      customerPhone: String(req.body.customerPhone || ''),
    };
    const schema = z.object({
      occurrenceId: z.string().min(8),
      customerName: z.string().min(2),
      customerEmail: z.string().email(),
      customerPhone: z.string().trim().optional().or(z.literal('')),
    });
    const parsed = schema.safeParse(form);
    if (!parsed.success) {
      const body = renderAssistedSalesBody({
        occurrences,
        form,
        error: 'Completa clase, nombre y correo para generar el checkout.',
      });
      return res.status(400).send(renderLayout({
        title: 'Ventas Asistidas',
        body,
        staff: req.session.staffName,
        staffRole: req.session.staffRole,
        simulationMode: config.simulationMode,
      }));
    }

    const seatCodes = parseSeatCodesInput(form.seatCodesText);
    if (seatCodes.length === 0) {
      const body = renderAssistedSalesBody({
        occurrences,
        form,
        error: 'Captura uno o dos lugares, por ejemplo A1 o A1, A2.',
      });
      return res.status(400).send(renderLayout({
        title: 'Ventas Asistidas',
        body,
        staff: req.session.staffName,
        staffRole: req.session.staffRole,
        simulationMode: config.simulationMode,
      }));
    }

    try {
      const reservation = await createDraftReservation(prisma, {
        occurrenceId: parsed.data.occurrenceId,
        seatCodes,
        customerName: parsed.data.customerName,
        customerEmail: parsed.data.customerEmail,
        customerPhone: parsed.data.customerPhone || '',
        salesChannel: 'whatsapp',
      });
      const checkout = await createCheckoutSessionForReservation(prisma, {
        reservationId: reservation.id,
        salesChannel: 'whatsapp',
        baseUrl: getBaseUrl(req),
      });
      const reservationPayload = await getReservationResponse(prisma, reservation.id, getBaseUrl(req));
      const body = renderAssistedSalesBody({
        occurrences,
        form,
        result: {
          bookingRef: reservationPayload.bookingRef,
          checkoutUrl: checkout.checkoutUrl,
          customerEmail: reservationPayload.customer.email,
          status: reservationPayload.status,
          expiresAt: reservationPayload.expiresAt,
        },
      });
      return res.send(renderLayout({
        title: 'Ventas Asistidas',
        body,
        staff: req.session.staffName,
        staffRole: req.session.staffRole,
        simulationMode: config.simulationMode,
      }));
    } catch (error) {
      const body = renderAssistedSalesBody({
        occurrences,
        form,
        error: error instanceof ReservationError ? error.message : 'No se pudo crear la reservación asistida.',
      });
      return res.status(error instanceof ReservationError ? error.status : 500).send(renderLayout({
        title: 'Ventas Asistidas',
        body,
        staff: req.session.staffName,
        staffRole: req.session.staffRole,
        simulationMode: config.simulationMode,
      }));
    }
  });

  app.get('/admin/layouts', requireStaff, requireRole('ADMIN', 'OPS'), async (req, res) => {
    const [locations, occurrences] = await Promise.all([
      prisma.locations.findMany({
        where: { isActive: true },
        orderBy: { name: 'asc' },
      }),
      prisma.class_occurrences.findMany({
        where: {
          status: { not: 'CANCELLED' },
          startsAt: { gte: new Date(dayjs().startOf('day').toISOString()) },
        },
        include: {
          classType: true,
          location: true,
        },
        orderBy: { startsAt: 'asc' },
        take: 24,
      }),
    ]);

    const body = renderLayoutsIndexBody({
      locations,
      occurrences,
      staffRole: req.session.staffRole,
    });
    res.send(renderLayout({
      title: 'Layouts',
      body,
      staff: req.session.staffName,
      staffRole: req.session.staffRole,
      simulationMode: config.simulationMode,
    }));
  });

  app.get('/admin/layouts/:locationId', requireStaff, requireRole('ADMIN', 'OPS'), async (req, res) => {
    const location = await prisma.locations.findUnique({
      where: { id: req.params.locationId },
      include: { classes: { orderBy: { startsAt: 'asc' }, take: 3 } },
    });
    if (!location) return res.status(404).send(renderError('Sede no encontrada.'));

    const fallbackCapacity = Math.max(location.classes[0]?.capacity || 18, 1);
    const layout = parseLayoutJson(location.layoutJson, fallbackCapacity);
    const body = renderLayoutEditorBody({
      title: `Layout base · ${location.name}`,
      kicker: 'TISA / LAYOUT BASE',
      subtitle: 'Este layout se clona cuando se programa una clase nueva en esta sede.',
      staffRole: req.session.staffRole,
      details: `
        <div><span>Sede</span><strong>${esc(location.name)}</strong></div>
        <div><span>Dirección</span><strong>${esc(location.address)}</strong></div>
        <div><span>Capacidad base</span><strong>${getLayoutCapacity(layout, fallbackCapacity)} lugares</strong></div>
      `,
      savePath: `/admin/layouts/${location.id}`,
      backPath: '/admin/layouts',
      layout,
      structureLocked: false,
    });

    res.send(renderLayout({
      title: 'Editar Layout Base',
      body,
      staff: req.session.staffName,
      staffRole: req.session.staffRole,
      simulationMode: config.simulationMode,
    }));
  });

  app.post('/admin/layouts/:locationId', requireStaff, requireRole('ADMIN', 'OPS'), async (req, res) => {
    const location = await prisma.locations.findUnique({ where: { id: req.params.locationId } });
    if (!location) return res.status(404).send(renderError('Sede no encontrada.'));

    const rawLayout = parseJson(req.body.layoutJson);
    if (!rawLayout) return res.status(400).send(renderError('El layout recibido no es JSON válido.'));
    const nextLayout = parseLayoutJson(rawLayout, 18);
    await prisma.locations.update({
      where: { id: location.id },
      data: { layoutJson: serializeLayout(nextLayout) },
    });

    res.redirect(`/admin/layouts/${location.id}`);
  });

  app.get('/admin/class-layouts/:occurrenceId', requireStaff, requireRole('ADMIN', 'OPS'), async (req, res) => {
    const occurrence = await prisma.class_occurrences.findUnique({
      where: { id: req.params.occurrenceId },
      include: {
        classType: true,
        trainer: true,
        location: true,
        bookings: {
          where: {
            OR: [
              { status: { in: ['PAID', 'CHECKED_IN'] } },
              { status: { in: OPEN_RESERVATION_STATUSES }, expiresAt: { gt: new Date() } },
            ],
          },
          select: { id: true },
        },
      },
    });
    if (!occurrence) return res.status(404).send(renderError('Clase no encontrada.'));

    const baseLayout = parseLayoutJson(occurrence.location.layoutJson, occurrence.capacity);
    const layout = parseLayoutJson(occurrence.layoutJson || baseLayout, occurrence.capacity);
    const structureLocked = occurrence.bookings.length > 0;
    const body = renderLayoutEditorBody({
      title: `Layout de clase · ${occurrence.classType.name}`,
      kicker: 'TISA / OVERRIDE POR CLASE',
      subtitle: 'Este snapshot lo usan la selección pública, ventas asistidas y check-in de esta clase.',
      staffRole: req.session.staffRole,
      details: `
        <div><span>Clase</span><strong>${esc(occurrence.classType.name)}</strong></div>
        <div><span>Horario</span><strong>${dayjs(occurrence.startsAt).format('DD MMM YYYY · HH:mm')}</strong></div>
        <div><span>Sede</span><strong>${esc(occurrence.location.name)}</strong></div>
        <div><span>Estado</span><strong>${structureLocked ? 'Bloqueado por reservas activas' : 'Editable'}</strong></div>
      `,
      savePath: `/admin/class-layouts/${occurrence.id}`,
      backPath: '/admin/layouts',
      layout,
      baseLayout,
      structureLocked,
      canResetToBase: true,
    });

    res.send(renderLayout({
      title: 'Editar Layout de Clase',
      body,
      staff: req.session.staffName,
      staffRole: req.session.staffRole,
      simulationMode: config.simulationMode,
    }));
  });

  app.post('/admin/class-layouts/:occurrenceId', requireStaff, requireRole('ADMIN', 'OPS'), async (req, res) => {
    const occurrence = await prisma.class_occurrences.findUnique({
      where: { id: req.params.occurrenceId },
      include: {
        location: true,
        bookings: {
          where: {
            OR: [
              { status: { in: ['PAID', 'CHECKED_IN'] } },
              { status: { in: OPEN_RESERVATION_STATUSES }, expiresAt: { gt: new Date() } },
            ],
          },
          select: { id: true },
        },
      },
    });
    if (!occurrence) return res.status(404).send(renderError('Clase no encontrada.'));

    const currentLayout = parseLayoutJson(occurrence.layoutJson || occurrence.location.layoutJson, occurrence.capacity);
    const rawLayout = parseJson(req.body.layoutJson);
    if (!rawLayout) return res.status(400).send(renderError('El layout recibido no es JSON válido.'));
    const nextLayout = parseLayoutJson(rawLayout, occurrence.capacity);
    const structureLocked = occurrence.bookings.length > 0;

    if (structureLocked && hasStructuralSeatChanges(currentLayout, nextLayout, occurrence.capacity)) {
      return res.status(409).send(renderError('La clase ya tiene reservas activas. Solo puedes mover la instructora en este punto.'));
    }

    const occupiedSeatIds = await getActiveSeatCodes(prisma, occurrence.id);
    const nextCapacity = structureLocked ? occurrence.capacity : getLayoutCapacity(nextLayout, occurrence.capacity);
    const nextAvailableSlots = structureLocked
      ? occurrence.availableSlots
      : Math.max(nextCapacity - occupiedSeatIds.length, 0);

    await prisma.class_occurrences.update({
      where: { id: occurrence.id },
      data: {
        layoutJson: serializeLayout(nextLayout),
        capacity: nextCapacity,
        availableSlots: nextAvailableSlots,
      },
    });

    res.redirect(`/admin/class-layouts/${occurrence.id}`);
  });

  app.get('/admin/dashboard', requireStaff, requireRole('ADMIN'), async (req, res) => {
    const [bookings, clients, paid, classes] = await Promise.all([
      prisma.bookings.count({ where: { status: { in: ACTIVE_RESERVATION_STATUSES } } }),
      prisma.clients.count(),
      prisma.payments.count({ where: { status: 'PAID' } }),
      prisma.class_occurrences.count({ where: { startsAt: { gte: new Date(dayjs().startOf('day').toISOString()) } } }),
    ]);

    const topClasses = await prisma.class_occurrences.findMany({
      take: 6,
      include: { classType: true, trainer: true },
      orderBy: { startsAt: 'asc' },
    });

    const content = `<div class="system-grid studio-dashboard-grid">
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
    </div>`;

    const body = `<section class="section studio-workspace-section">
      ${renderStudioWorkspace({
        activeKey: 'dashboard',
        staffRole: req.session.staffRole,
        eyebrow: 'TISA / ADMIN',
        title: 'La operación también debe sentirse precisa, elegante y confiable.',
        subtitle: 'Lectura clara de métricas, seguimiento de ocupación y acceso directo a la agenda activa del estudio dentro de una sola superficie.',
        content,
        footerActionLabel: 'Ventas WhatsApp',
        footerActionHref: '/admin/assisted-sales',
      })}
    </section>`;

    res.send(renderLayout({
      title: 'Admin Dashboard',
      body,
      staff: req.session.staffName,
      staffRole: req.session.staffRole,
      simulationMode: config.simulationMode,
    }));
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
        include: {
          classType: true,
          location: true,
          bookings: { where: { status: { in: ACTIVE_RESERVATION_STATUSES } }, include: { client: true } },
        },
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
            <div class="form-row"><label>Precio por lugar (MXN)</label><input type="number" name="unitPriceMxn" min="0" max="5000" step="0.01" value="350" required /></div>
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
    res.send(renderLayout({
      title: 'Trainer',
      body,
      staff: req.session.staffName,
      staffRole: req.session.staffRole,
      simulationMode: config.simulationMode,
    }));
  });

  app.post('/trainer/classes', requireStaff, requireRole('TRAINER'), async (req, res) => {
    const schema = z.object({
      classTypeId: z.string().min(8),
      locationId: z.string().min(8),
      date: z.string().min(10),
      startTime: z.string().min(4),
      durationMin: z.coerce.number().int().min(30).max(180),
      capacity: z.coerce.number().int().min(1).max(80),
      unitPriceMxn: z.coerce.number().min(0).max(5000),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).send(renderError('Datos inválidos para crear clase.'));

    const { classTypeId, locationId, date, startTime, durationMin, capacity, unitPriceMxn } = parsed.data;
    const startsAt = dayjs(`${date}T${startTime}`);
    if (!startsAt.isValid()) return res.status(400).send(renderError('Fecha u hora inválida.'));
    if (startsAt.isBefore(dayjs().subtract(5, 'minute'))) return res.status(400).send(renderError('No se puede crear una clase en el pasado.'));

    const location = await prisma.locations.findUnique({ where: { id: locationId } });
    if (!location) return res.status(404).send(renderError('Sede no encontrada.'));

    let occurrenceLayout;
    try {
      occurrenceLayout = createOccurrenceLayoutSnapshot(location.layoutJson || createDefaultLayout(capacity), capacity);
    } catch (error) {
      return res.status(400).send(renderError(error.message || 'No se pudo preparar el layout para esta clase.'));
    }

    const derivedCapacity = getLayoutCapacity(occurrenceLayout, capacity);

    const endsAt = startsAt.add(durationMin, 'minute');
    await prisma.class_occurrences.create({
      data: {
        locationId,
        classTypeId,
        trainerId: req.session.staffId,
        startsAt: startsAt.toDate(),
        endsAt: endsAt.toDate(),
        capacity: derivedCapacity,
        availableSlots: derivedCapacity,
        unitPriceCents: Math.round(unitPriceMxn * 100),
        status: 'SCHEDULED',
        layoutJson: serializeLayout(occurrenceLayout),
      },
    });

    res.redirect('/trainer/classes');
  });

  app.post('/trainer/classes/:id/cancel', requireStaff, requireRole('TRAINER'), async (req, res) => {
    const occurrence = await prisma.class_occurrences.findUnique({
      where: { id: req.params.id },
      include: { bookings: { where: { status: { in: ACTIVE_RESERVATION_STATUSES } } } },
    });
    if (!occurrence || occurrence.trainerId !== req.session.staffId) {
      return res.status(404).send(renderError('Clase no encontrada para este trainer.'));
    }
    if (occurrence.status === 'CANCELLED') return res.redirect('/trainer/classes');

    const bookingIds = occurrence.bookings.map((booking) => booking.id);
    const openBookingIds = occurrence.bookings
      .filter((booking) => OPEN_RESERVATION_STATUSES.includes(booking.status))
      .map((booking) => booking.id);

    await prisma.$transaction(async (tx) => {
      await tx.class_occurrences.update({
        where: { id: occurrence.id },
        data: { status: 'CANCELLED', availableSlots: 0 },
      });

      if (bookingIds.length > 0) {
        await tx.bookings.updateMany({
          where: { id: { in: bookingIds } },
          data: { status: 'CANCELLED', cancelledAt: new Date(), expiresAt: null },
        });
        await tx.reserved_seats.deleteMany({ where: { classOccurrenceId: occurrence.id } });
      }

      if (openBookingIds.length > 0) {
        await tx.payments.updateMany({
          where: {
            bookingId: { in: openBookingIds },
            status: { in: ['CREATED', 'PENDING_ASYNC'] },
          },
          data: { status: 'FAILED' },
        });
      }

      if (bookingIds.length > 0) {
        await tx.audit_events.create({
          data: {
            actorType: 'staff',
            actorId: req.session.staffId,
            action: 'CLASS_CANCELLED',
            entityType: 'class_occurrence',
            entityId: occurrence.id,
            metadata: JSON.stringify({
              bookingIds,
              requiresManualRefundReview: occurrence.bookings.some((booking) => booking.status === 'PAID' || booking.status === 'CHECKED_IN'),
            }),
          },
        });
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
    res.send(renderLayout({
      title: 'Ops Check-in',
      body,
      staff: req.session.staffName,
      staffRole: req.session.staffRole,
      simulationMode: config.simulationMode,
    }));
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
      include: { classOccurrence: true, client: true, reservedSeats: true },
    });
    if (!booking || booking.classOccurrenceId !== occurrence_id || booking.clientId !== client_ref) {
      return res.status(404).send(renderError('Booking no coincide con payload'));
    }
    if (booking.status === 'CHECKED_IN') return res.status(409).send(renderError('Cliente ya ingresó'));
    if (!CONFIRMED_RESERVATION_STATUSES.includes(booking.status)) {
      return res.status(409).send(renderError('La reservación aún no está pagada o ya no está activa.'));
    }

    const classStart = dayjs(booking.classOccurrence.startsAt);
    const classEnd = dayjs(booking.classOccurrence.endsAt);
    const now = dayjs();
    if (!isWithinCheckinWindow(now.toISOString(), classStart.toISOString(), classEnd.toISOString())) {
      return res.status(409).send(renderError('Fuera de ventana de check-in'));
    }

    await prisma.$transaction(async (tx) => {
      await tx.bookings.update({ where: { id: booking.id }, data: { status: 'CHECKED_IN', checkedInAt: new Date() } });
      await tx.checkins.create({ data: { bookingId: booking.id, staffId: req.session.staffId, method: 'QR_CAMERA_OR_MANUAL' } });
    });

    const seatLabels = describeReservedSeats(booking.reservedSeats, booking.classOccurrence.layoutJson, booking.classOccurrence.capacity)
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
    res.send(renderLayout({
      title: 'Check-in OK',
      body,
      staff: req.session.staffName,
      staffRole: req.session.staffRole,
      simulationMode: config.simulationMode,
    }));
  });

  app.get('/health', (req, res) => res.json({ status: 'ok', app: 'tisa-studio' }));

  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).send(renderLayout({ title: 'Error', body: renderError(err.message || 'Error interno'), simulationMode: config.simulationMode }));
  });

  return app;
}
