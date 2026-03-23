import test from 'node:test';
import assert from 'node:assert/strict';
import { NightlyShelterTimingService } from '../../../../src/application/bot/services/NightlyShelterTimingService';

test('NightlyShelterTimingService starts the return window 30 seconds before night', () => {
  const service = new NightlyShelterTimingService();
  assert.equal(service.getReturnWindowStartTimeOfDay(), 12400);
});

test('NightlyShelterTimingService reports whether bots should already return home', () => {
  const service = new NightlyShelterTimingService();

  assert.equal(service.shouldReturnToShelter(12399), false);
  assert.equal(service.shouldReturnToShelter(12400), true);
  assert.equal(service.shouldReturnToShelter(13000), true);
});

test('NightlyShelterTimingService reports the remaining ticks until the return window', () => {
  const service = new NightlyShelterTimingService();

  assert.equal(service.getTicksUntilReturnWindow(11800), 600);
  assert.equal(service.getTicksUntilReturnWindow(12380), 20);
  assert.equal(service.getTicksUntilReturnWindow(12400), 0);
});

test('NightlyShelterTimingService handles null values and wrap-around time points', () => {
  const service = new NightlyShelterTimingService();

  assert.equal(service.shouldReturnToShelter(null), false);
  assert.equal(service.getTicksUntilReturnWindow(undefined), 600);
  assert.equal(service.shouldReturnToShelter(36400), true);
  assert.equal(service.shouldReturnToShelter(24400), false);
  assert.equal(service.getTicksUntilReturnWindow(-11600), 0);
});

test('NightlyShelterTimingService supports custom night and lead settings', () => {
  const service = new NightlyShelterTimingService(14000, 800);

  assert.equal(service.getReturnWindowStartTimeOfDay(), 13200);
  assert.equal(service.shouldReturnToShelter(13199), false);
  assert.equal(service.shouldReturnToShelter(13200), true);
});

test('NightlyShelterTimingService correctly wraps a return window that crosses midnight', () => {
  const service = new NightlyShelterTimingService(200, 400);

  assert.equal(service.getReturnWindowStartTimeOfDay(), 23800);
  assert.equal(service.shouldReturnToShelter(23799), false);
  assert.equal(service.shouldReturnToShelter(23800), true);
  assert.equal(service.getTicksUntilReturnWindow(100), 23700);
});
