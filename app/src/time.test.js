import test from 'node:test';
import assert from 'node:assert/strict';
import { rel } from './time.js';

const now = Date.parse('2026-08-02T12:00:00.000Z');

test('formatea timestamps Unix en segundos como tiempo reciente', () => {
  assert.equal(rel((now - 30_000) / 1000, now), 'hace 30s');
});

test('mantiene soporte para timestamps en milisegundos e ISO', () => {
  assert.equal(rel(now - 120_000, now), 'hace 2m');
  assert.equal(rel(new Date(now + 3_600_000).toISOString(), now), 'en 1h');
});
