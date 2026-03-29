const SEAT_LAYOUT = [
  { code: 'A1', row: 'A', number: 1, zone: 'near' },
  { code: 'A2', row: 'A', number: 2, zone: 'near' },
  { code: 'A3', row: 'A', number: 3, zone: 'near' },
  { code: 'B1', row: 'B', number: 1, zone: 'near' },
  { code: 'B2', row: 'B', number: 2, zone: 'near' },
  { code: 'B3', row: 'B', number: 3, zone: 'near' },
  { code: 'C1', row: 'C', number: 1, zone: 'middle' },
  { code: 'C2', row: 'C', number: 2, zone: 'middle' },
  { code: 'C3', row: 'C', number: 3, zone: 'middle' },
  { code: 'C4', row: 'C', number: 4, zone: 'middle' },
  { code: 'D1', row: 'D', number: 1, zone: 'middle' },
  { code: 'D2', row: 'D', number: 2, zone: 'middle' },
  { code: 'D3', row: 'D', number: 3, zone: 'middle' },
  { code: 'D4', row: 'D', number: 4, zone: 'middle' },
  { code: 'E1', row: 'E', number: 1, zone: 'back' },
  { code: 'E2', row: 'E', number: 2, zone: 'back' },
  { code: 'E3', row: 'E', number: 3, zone: 'back' },
  { code: 'F1', row: 'F', number: 1, zone: 'back' },
  { code: 'F2', row: 'F', number: 2, zone: 'back' },
  { code: 'F3', row: 'F', number: 3, zone: 'back' },
];

const ZONE_LABELS = {
  near: 'Cerca de la instructora',
  middle: 'Zona media',
  back: 'Parte trasera',
};

export const MAX_SEATS_PER_BOOKING = 2;
export const MAX_LAYOUT_CAPACITY = SEAT_LAYOUT.length;

export function getZoneLabel(zone) {
  return ZONE_LABELS[zone] || zone;
}

export function normalizeSeatCodes(input) {
  const list = Array.isArray(input) ? input : input ? [input] : [];
  return [...new Set(list.map((value) => String(value || '').trim().toUpperCase()).filter(Boolean))];
}

export function getSeatLayout(capacity) {
  const safeCapacity = Number(capacity || 0);
  if (safeCapacity > MAX_LAYOUT_CAPACITY) {
    return {
      supported: false,
      error: `La clase tiene capacidad ${safeCapacity}, pero el mapa fijo solo soporta ${MAX_LAYOUT_CAPACITY} lugares.`,
      seats: [],
      rows: [],
    };
  }

  const seats = SEAT_LAYOUT.map((seat, index) => ({
    ...seat,
    label: `${seat.row}${seat.number}`,
    enabled: index < safeCapacity,
    zoneLabel: getZoneLabel(seat.zone),
  }));

  const rows = [...new Set(seats.map((seat) => seat.row))].map((row) => ({
    row,
    seats: seats.filter((seat) => seat.row === row),
  }));

  return { supported: true, seats, rows };
}

export function getSeatMapByCode(capacity) {
  const layout = getSeatLayout(capacity);
  return new Map(layout.seats.map((seat) => [seat.code, seat]));
}

export function describeSeatCodes(seatCodes, capacity = MAX_LAYOUT_CAPACITY) {
  const seatMap = getSeatMapByCode(capacity);
  return normalizeSeatCodes(seatCodes)
    .map((code) => {
      const seat = seatMap.get(code);
      return seat ? { code: seat.code, label: seat.label, zone: seat.zone, zoneLabel: seat.zoneLabel } : null;
    })
    .filter(Boolean);
}

export function formatSeatLabels(seatCodes, capacity = MAX_LAYOUT_CAPACITY) {
  const seats = describeSeatCodes(seatCodes, capacity);
  return seats.map((seat) => seat.label).join(', ');
}

export function validateSeatSelection({ seatCodes, capacity, occupiedSeatCodes = [] }) {
  const normalized = normalizeSeatCodes(seatCodes);
  const occupied = new Set(normalizeSeatCodes(occupiedSeatCodes));
  const layout = getSeatLayout(capacity);

  if (!layout.supported) {
    return { ok: false, message: layout.error, seats: [] };
  }

  if (normalized.length === 0) {
    return { ok: false, message: 'Selecciona al menos un lugar para continuar.', seats: [] };
  }

  if (normalized.length > MAX_SEATS_PER_BOOKING) {
    return { ok: false, message: `Solo puedes apartar hasta ${MAX_SEATS_PER_BOOKING} lugares por reserva.`, seats: [] };
  }

  const seatMap = new Map(layout.seats.map((seat) => [seat.code, seat]));
  const seats = [];

  for (const code of normalized) {
    const seat = seatMap.get(code);
    if (!seat) return { ok: false, message: `El lugar ${code} no existe en el mapa actual.`, seats: [] };
    if (!seat.enabled) return { ok: false, message: `El lugar ${code} no está habilitado para esta clase.`, seats: [] };
    if (occupied.has(code)) return { ok: false, message: `El lugar ${code} ya fue ocupado por otra reserva.`, seats: [] };
    seats.push(seat);
  }

  return { ok: true, seats };
}
