import test from 'node:test';
import assert from 'node:assert/strict';
import { SquadWeaponReadinessTracker } from '../../../../src/application/bot/services/SquadWeaponReadinessTracker';

test('SquadWeaponReadinessTracker waits until the whole squad is ready', async () => {
  const tracker = new SquadWeaponReadinessTracker();
  const waitPromise = tracker.waitUntilAllReady(['Gamgee', 'Gimli'], () => true);

  tracker.markReady('Gamgee');
  let settled = false;
  void waitPromise.then(() => {
    settled = true;
  });

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(settled, false);

  tracker.markReady('Gimli');
  await waitPromise;
  assert.equal(tracker.areAllReady(['Gamgee', 'Gimli']), true);
});

test('SquadWeaponReadinessTracker stops waiting when the scenario is inactive', async () => {
  const tracker = new SquadWeaponReadinessTracker();
  await tracker.waitUntilAllReady(['Gamgee'], () => false);
  assert.equal(tracker.areAllReady(['Gamgee']), false);
});

test('SquadWeaponReadinessTracker clearReady and reset roll readiness back', () => {
  const tracker = new SquadWeaponReadinessTracker();

  tracker.markReady('Gamgee');
  tracker.markReady('Gimli');
  assert.equal(tracker.areAllReady(['Gamgee', 'Gimli']), true);

  tracker.clearReady('Gimli');
  assert.equal(tracker.areAllReady(['Gamgee', 'Gimli']), false);

  tracker.reset();
  assert.equal(tracker.areAllReady(['Gamgee']), false);
});
