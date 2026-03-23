import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NightlyShelterSleepDecisionService,
} from '../../../../src/application/bot/services/NightlyShelterSleepDecisionService';

test('NightlyShelterSleepDecisionService waits quietly before the sleep window opens', () => {
  const service = new NightlyShelterSleepDecisionService();

  assert.deepEqual(
    service.evaluate({
      sleepWindowObserved: false,
      isSleepWindow: false,
      isDay: true,
      totalBeds: 3,
      freeBeds: 3,
    }),
    {
      kind: 'wait',
      reason: 'before_sleep_window',
      nextSleepWindowObserved: false,
    },
  );
});

test('NightlyShelterSleepDecisionService tries to sleep as soon as a free bed exists at night', () => {
  const service = new NightlyShelterSleepDecisionService();

  assert.deepEqual(
    service.evaluate({
      sleepWindowObserved: false,
      isSleepWindow: true,
      isDay: false,
      totalBeds: 3,
      freeBeds: 1,
    }),
    {
      kind: 'try_sleep',
      reason: 'free_bed_available',
      nextSleepWindowObserved: true,
    },
  );
});

test('NightlyShelterSleepDecisionService keeps waiting through the night when all beds are occupied', () => {
  const service = new NightlyShelterSleepDecisionService();

  assert.deepEqual(
    service.evaluate({
      sleepWindowObserved: true,
      isSleepWindow: true,
      isDay: false,
      totalBeds: 3,
      freeBeds: 0,
    }),
    {
      kind: 'wait',
      reason: 'all_beds_occupied',
      nextSleepWindowObserved: true,
    },
  );
});

test('NightlyShelterSleepDecisionService treats a bedless shelter as a wait-during-night state', () => {
  const service = new NightlyShelterSleepDecisionService();

  assert.deepEqual(
    service.evaluate({
      sleepWindowObserved: true,
      isSleepWindow: true,
      isDay: false,
      totalBeds: 0,
      freeBeds: 0,
    }),
    {
      kind: 'wait',
      reason: 'no_beds_available',
      nextSleepWindowObserved: true,
    },
  );
});

test('NightlyShelterSleepDecisionService triggers a capacity expansion after morning if the night was missed', () => {
  const service = new NightlyShelterSleepDecisionService();

  assert.deepEqual(
    service.evaluate({
      sleepWindowObserved: true,
      isSleepWindow: false,
      isDay: true,
      totalBeds: 3,
      freeBeds: 0,
    }),
    {
      kind: 'expand_after_morning',
      reason: 'night_missed',
      nextSleepWindowObserved: true,
    },
  );
});

test('NightlyShelterSleepDecisionService still expands after morning even if beds become free again', () => {
  const service = new NightlyShelterSleepDecisionService();

  assert.deepEqual(
    service.evaluate({
      sleepWindowObserved: true,
      isSleepWindow: false,
      isDay: true,
      totalBeds: 3,
      freeBeds: 3,
    }),
    {
      kind: 'expand_after_morning',
      reason: 'night_missed',
      nextSleepWindowObserved: true,
    },
  );
});

test('NightlyShelterSleepDecisionService preserves state across a missed-night progression', () => {
  const service = new NightlyShelterSleepDecisionService();

  const beforeNight = service.evaluate({
    sleepWindowObserved: false,
    isSleepWindow: false,
    isDay: true,
    totalBeds: 3,
    freeBeds: 3,
  });
  assert.deepEqual(beforeNight, {
    kind: 'wait',
    reason: 'before_sleep_window',
    nextSleepWindowObserved: false,
  });

  const duringNightWithoutBeds = service.evaluate({
    sleepWindowObserved: beforeNight.nextSleepWindowObserved,
    isSleepWindow: true,
    isDay: false,
    totalBeds: 0,
    freeBeds: 0,
  });
  assert.deepEqual(duringNightWithoutBeds, {
    kind: 'wait',
    reason: 'no_beds_available',
    nextSleepWindowObserved: true,
  });

  const afterMissedNight = service.evaluate({
    sleepWindowObserved: duringNightWithoutBeds.nextSleepWindowObserved,
    isSleepWindow: false,
    isDay: true,
    totalBeds: 1,
    freeBeds: 1,
  });
  assert.deepEqual(afterMissedNight, {
    kind: 'expand_after_morning',
    reason: 'night_missed',
    nextSleepWindowObserved: true,
  });
});
