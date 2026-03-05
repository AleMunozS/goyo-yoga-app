import test from 'node:test';
import assert from 'node:assert/strict';
import { canRefundBooking, hashToken, isWithinCheckinWindow, signPayload } from '../src/utils.js';

test('hashToken is deterministic and non-empty', () => {
  const a = hashToken('abc');
  const b = hashToken('abc');
  assert.equal(a, b);
  assert.ok(a.length > 10);
});

test('signPayload changes with secret', () => {
  const payload = '{"a":1}';
  assert.notEqual(signPayload(payload, 'x'), signPayload(payload, 'y'));
});

test('refund window allows cancellation before 2h', () => {
  assert.equal(canRefundBooking('2026-03-01T10:00:00.000Z', '2026-03-01T13:00:00.000Z'), true);
  assert.equal(canRefundBooking('2026-03-01T11:10:00.000Z', '2026-03-01T13:00:00.000Z'), false);
});

test('checkin window validates boundaries', () => {
  assert.equal(isWithinCheckinWindow('2026-03-01T12:45:00.000Z', '2026-03-01T13:00:00.000Z', '2026-03-01T14:00:00.000Z'), true);
  assert.equal(isWithinCheckinWindow('2026-03-01T12:20:00.000Z', '2026-03-01T13:00:00.000Z', '2026-03-01T14:00:00.000Z'), false);
  assert.equal(isWithinCheckinWindow('2026-03-01T14:30:01.000Z', '2026-03-01T13:00:00.000Z', '2026-03-01T14:00:00.000Z'), false);
});
