import { z } from 'zod';

export const MAX_SEATS_PER_BOOKING = 2;
export const DEFAULT_LAYOUT_VERSION = 1;
export const DEFAULT_CANVAS = { width: 1200, height: 800, grid: 24 };

const ZONE_LABELS = {
  near: 'Cerca de la instructora',
  middle: 'Zona media',
  back: 'Parte trasera',
};

const DEFAULT_LAYOUT_BLUEPRINT = [
  { label: 'A1', row: 'A', order: 1, zone: 'near', x: 414, y: 194 },
  { label: 'A2', row: 'A', order: 2, zone: 'near', x: 534, y: 194 },
  { label: 'A3', row: 'A', order: 3, zone: 'near', x: 654, y: 194 },
  { label: 'B1', row: 'B', order: 1, zone: 'near', x: 414, y: 294 },
  { label: 'B2', row: 'B', order: 2, zone: 'near', x: 534, y: 294 },
  { label: 'B3', row: 'B', order: 3, zone: 'near', x: 654, y: 294 },
  { label: 'C1', row: 'C', order: 1, zone: 'middle', x: 354, y: 414 },
  { label: 'C2', row: 'C', order: 2, zone: 'middle', x: 474, y: 414 },
  { label: 'C3', row: 'C', order: 3, zone: 'middle', x: 594, y: 414 },
  { label: 'C4', row: 'C', order: 4, zone: 'middle', x: 714, y: 414 },
  { label: 'D1', row: 'D', order: 1, zone: 'middle', x: 354, y: 514 },
  { label: 'D2', row: 'D', order: 2, zone: 'middle', x: 474, y: 514 },
  { label: 'D3', row: 'D', order: 3, zone: 'middle', x: 594, y: 514 },
  { label: 'D4', row: 'D', order: 4, zone: 'middle', x: 714, y: 514 },
  { label: 'E1', row: 'E', order: 1, zone: 'back', x: 414, y: 634 },
  { label: 'E2', row: 'E', order: 2, zone: 'back', x: 534, y: 634 },
  { label: 'E3', row: 'E', order: 3, zone: 'back', x: 654, y: 634 },
  { label: 'F1', row: 'F', order: 1, zone: 'back', x: 414, y: 734 },
  { label: 'F2', row: 'F', order: 2, zone: 'back', x: 534, y: 734 },
  { label: 'F3', row: 'F', order: 3, zone: 'back', x: 654, y: 734 },
];

const seatSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  x: z.number(),
  y: z.number(),
  rotation: z.number().default(0),
  zone: z.string().min(1).default('middle'),
  row: z.string().min(1).default('A'),
  order: z.number().int().nonnegative().default(1),
  bookable: z.boolean().default(true),
  enabled: z.boolean().default(true),
});

const layoutSchema = z.object({
  version: z.literal(DEFAULT_LAYOUT_VERSION).default(DEFAULT_LAYOUT_VERSION),
  canvas: z.object({
    width: z.number().positive().default(DEFAULT_CANVAS.width),
    height: z.number().positive().default(DEFAULT_CANVAS.height),
    grid: z.number().positive().default(DEFAULT_CANVAS.grid),
  }),
  instructor: z.object({
    x: z.number(),
    y: z.number(),
    rotation: z.number().default(0),
    label: z.string().min(1).default('Instructora'),
  }),
  seats: z.array(seatSchema).min(1),
});

function safeUpper(value, fallback = '') {
  const normalized = String(value || '').trim().toUpperCase();
  return normalized || fallback;
}

function roundCoord(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round(number);
}

function toSeatId(label, index = 0) {
  const slug = String(label || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug ? `seat-${slug}` : `seat-${index + 1}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function withSeatMeta(seat) {
  return {
    ...seat,
    code: seat.label,
    zoneLabel: getZoneLabel(seat.zone),
  };
}

function sortSeats(seats) {
  return [...seats].sort((left, right) => {
    if (left.row !== right.row) return left.row.localeCompare(right.row, 'es');
    if (left.order !== right.order) return left.order - right.order;
    if (left.y !== right.y) return left.y - right.y;
    if (left.x !== right.x) return left.x - right.x;
    return left.label.localeCompare(right.label, 'es');
  });
}

function normalizeSeat(rawSeat, index) {
  const row = safeUpper(rawSeat.row, 'A');
  const label = safeUpper(rawSeat.label, `${row}${index + 1}`);
  return {
    id: String(rawSeat.id || toSeatId(label, index)),
    label,
    x: roundCoord(rawSeat.x),
    y: roundCoord(rawSeat.y),
    rotation: Number(rawSeat.rotation || 0),
    zone: String(rawSeat.zone || 'middle'),
    row,
    order: Number.isFinite(Number(rawSeat.order)) ? Number(rawSeat.order) : index + 1,
    bookable: rawSeat.bookable !== false,
    enabled: rawSeat.enabled !== false,
  };
}

function normalizeLayout(layout) {
  const parsed = layoutSchema.parse(layout);
  const seats = sortSeats(parsed.seats.map(normalizeSeat)).map(withSeatMeta);
  return {
    version: DEFAULT_LAYOUT_VERSION,
    canvas: {
      width: roundCoord(parsed.canvas.width) || DEFAULT_CANVAS.width,
      height: roundCoord(parsed.canvas.height) || DEFAULT_CANVAS.height,
      grid: roundCoord(parsed.canvas.grid) || DEFAULT_CANVAS.grid,
    },
    instructor: {
      x: roundCoord(parsed.instructor.x),
      y: roundCoord(parsed.instructor.y),
      rotation: Number(parsed.instructor.rotation || 0),
      label: String(parsed.instructor.label || 'Instructora'),
    },
    seats,
  };
}

function resolveLayoutObject(layoutOrJson) {
  if (!layoutOrJson) return null;
  if (typeof layoutOrJson === 'string') {
    try {
      return JSON.parse(layoutOrJson);
    } catch {
      return null;
    }
  }
  return layoutOrJson;
}

export function getZoneLabel(zone) {
  return ZONE_LABELS[zone] || zone;
}

export function createDefaultLayout(enabledSeatCount = DEFAULT_LAYOUT_BLUEPRINT.length) {
  const safeEnabledCount = Math.max(1, Math.min(Number(enabledSeatCount || DEFAULT_LAYOUT_BLUEPRINT.length), DEFAULT_LAYOUT_BLUEPRINT.length));
  return normalizeLayout({
    version: DEFAULT_LAYOUT_VERSION,
    canvas: DEFAULT_CANVAS,
    instructor: { x: 600, y: 80, rotation: 0, label: 'Instructora' },
    seats: DEFAULT_LAYOUT_BLUEPRINT.map((seat, index) => ({
      ...seat,
      id: toSeatId(seat.label, index),
      enabled: index < safeEnabledCount,
      bookable: true,
      rotation: 0,
    })),
  });
}

export function cloneLayout(layout) {
  return normalizeLayout(clone(layout));
}

export function parseLayoutJson(layoutJson, fallbackCapacity = DEFAULT_LAYOUT_BLUEPRINT.length) {
  const layout = resolveLayoutObject(layoutJson);
  if (!layout) return createDefaultLayout(fallbackCapacity);

  try {
    return normalizeLayout(layout);
  } catch {
    return createDefaultLayout(fallbackCapacity);
  }
}

export function serializeLayout(layout) {
  return JSON.stringify(normalizeLayout(layout));
}

export function getSeatLayout(layoutJson, fallbackCapacity = DEFAULT_LAYOUT_BLUEPRINT.length) {
  const layout = parseLayoutJson(layoutJson, fallbackCapacity);
  const rows = [...new Set(layout.seats.map((seat) => seat.row))].map((row) => ({
    row,
    seats: sortSeats(layout.seats.filter((seat) => seat.row === row)),
  }));

  return {
    supported: true,
    canvas: layout.canvas,
    instructor: layout.instructor,
    seats: sortSeats(layout.seats),
    rows,
  };
}

export function getLayoutCapacity(layoutJson, fallbackCapacity = DEFAULT_LAYOUT_BLUEPRINT.length) {
  return getSeatLayout(layoutJson, fallbackCapacity).seats.filter((seat) => seat.bookable && seat.enabled).length;
}

export function normalizeSeatCodes(input) {
  const list = Array.isArray(input) ? input : input ? [input] : [];
  return [...new Set(list.map((value) => String(value || '').trim()).filter(Boolean))];
}

export function getSeatMaps(layoutJson, fallbackCapacity = DEFAULT_LAYOUT_BLUEPRINT.length) {
  const layout = getSeatLayout(layoutJson, fallbackCapacity);
  const byId = new Map(layout.seats.map((seat) => [seat.id, seat]));
  const byLabel = new Map(layout.seats.map((seat) => [seat.label.toUpperCase(), seat]));
  return { layout, byId, byLabel };
}

export function resolveSeatToken(layoutJson, token, fallbackCapacity = DEFAULT_LAYOUT_BLUEPRINT.length) {
  const normalizedToken = String(token || '').trim();
  if (!normalizedToken) return null;
  const { byId, byLabel } = getSeatMaps(layoutJson, fallbackCapacity);
  return byId.get(normalizedToken) || byLabel.get(normalizedToken.toUpperCase()) || null;
}

export function describeSeatCodes(seatCodes, layoutJson, fallbackCapacity = DEFAULT_LAYOUT_BLUEPRINT.length) {
  const { layout, byId, byLabel } = getSeatMaps(layoutJson, fallbackCapacity);
  return normalizeSeatCodes(seatCodes)
    .map((token) => byId.get(token) || byLabel.get(token.toUpperCase()))
    .filter(Boolean)
    .map((seat) => ({
      id: seat.id,
      code: seat.label,
      label: seat.label,
      zone: seat.zone,
      zoneLabel: seat.zoneLabel,
      row: seat.row,
      order: seat.order,
      x: seat.x,
      y: seat.y,
      rotation: seat.rotation,
      enabled: seat.enabled,
      bookable: seat.bookable,
      canvas: layout.canvas,
    }));
}

export function describeReservedSeats(reservedSeats, layoutJson, fallbackCapacity = DEFAULT_LAYOUT_BLUEPRINT.length) {
  const { byId, byLabel } = getSeatMaps(layoutJson, fallbackCapacity);
  return (reservedSeats || [])
    .map((seat) => {
      const match =
        (seat.seatId && byId.get(seat.seatId))
        || (seat.seatLabelSnapshot && byLabel.get(String(seat.seatLabelSnapshot).toUpperCase()))
        || (seat.seatCode && byLabel.get(String(seat.seatCode).toUpperCase()));
      if (match) {
        return {
          id: match.id,
          code: match.label,
          label: match.label,
          zone: match.zone,
          zoneLabel: match.zoneLabel,
          row: match.row,
          order: match.order,
        };
      }

      const fallbackLabel = String(seat.seatLabelSnapshot || seat.seatCode || '').trim();
      if (!fallbackLabel) return null;
      return {
        id: seat.seatId || null,
        code: fallbackLabel,
        label: fallbackLabel,
        zone: String(seat.zone || 'middle'),
        zoneLabel: getZoneLabel(String(seat.zone || 'middle')),
        row: fallbackLabel.charAt(0).toUpperCase(),
        order: Number.parseInt(fallbackLabel.slice(1), 10) || 0,
      };
    })
    .filter(Boolean);
}

export function formatSeatLabels(seatCodes, layoutJson, fallbackCapacity = DEFAULT_LAYOUT_BLUEPRINT.length) {
  return describeSeatCodes(seatCodes, layoutJson, fallbackCapacity)
    .map((seat) => seat.label)
    .join(', ');
}

export function validateSeatSelection({
  seatCodes,
  layoutJson,
  occupiedSeatIds = [],
  fallbackCapacity = DEFAULT_LAYOUT_BLUEPRINT.length,
}) {
  const normalized = normalizeSeatCodes(seatCodes);
  const occupied = new Set(normalizeSeatCodes(occupiedSeatIds));
  const { layout, byId, byLabel } = getSeatMaps(layoutJson, fallbackCapacity);

  if (normalized.length === 0) {
    return { ok: false, message: 'Selecciona al menos un lugar para continuar.', seats: [], layout };
  }

  if (normalized.length > MAX_SEATS_PER_BOOKING) {
    return { ok: false, message: `Solo puedes apartar hasta ${MAX_SEATS_PER_BOOKING} lugares por reserva.`, seats: [], layout };
  }

  const seats = [];
  for (const token of normalized) {
    const seat = byId.get(token) || byLabel.get(token.toUpperCase());
    if (!seat) return { ok: false, message: `El lugar ${token} no existe en el mapa actual.`, seats: [], layout };
    if (!seat.bookable || !seat.enabled) {
      return { ok: false, message: `El lugar ${seat.label} no está habilitado para esta clase.`, seats: [], layout };
    }
    if (occupied.has(seat.id)) {
      return { ok: false, message: `El lugar ${seat.label} ya fue ocupado por otra reserva.`, seats: [], layout };
    }
    seats.push(seat);
  }

  return { ok: true, seats, layout };
}

export function hasStructuralSeatChanges(currentLayoutJson, nextLayoutJson, fallbackCapacity = DEFAULT_LAYOUT_BLUEPRINT.length) {
  const current = getSeatLayout(currentLayoutJson, fallbackCapacity).seats.map((seat) => ({
    id: seat.id,
    label: seat.label,
    x: seat.x,
    y: seat.y,
    rotation: seat.rotation,
    zone: seat.zone,
    row: seat.row,
    order: seat.order,
    bookable: seat.bookable,
    enabled: seat.enabled,
  }));
  const next = getSeatLayout(nextLayoutJson, fallbackCapacity).seats.map((seat) => ({
    id: seat.id,
    label: seat.label,
    x: seat.x,
    y: seat.y,
    rotation: seat.rotation,
    zone: seat.zone,
    row: seat.row,
    order: seat.order,
    bookable: seat.bookable,
    enabled: seat.enabled,
  }));
  return JSON.stringify(current) !== JSON.stringify(next);
}
