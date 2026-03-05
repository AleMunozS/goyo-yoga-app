import crypto from 'node:crypto';
import dayjs from 'dayjs';

export function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function signPayload(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

export function createToken() {
  return crypto.randomBytes(24).toString('hex');
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function makeBookingRef() {
  return `GY-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

export function canRefundBooking(now, classStartIso) {
  return dayjs(now).isBefore(dayjs(classStartIso).subtract(2, 'hour'));
}

export function isWithinCheckinWindow(now, classStartIso, classEndIso) {
  const current = dayjs(now);
  const start = dayjs(classStartIso).subtract(30, 'minute');
  const end = dayjs(classEndIso).add(20, 'minute');
  return current.isAfter(start) && current.isBefore(end);
}
