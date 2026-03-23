import test from 'node:test';
import assert from 'node:assert/strict';
import { BotPriorityCoordinator } from '../../../../src/application/bot/services/BotPriorityCoordinator';

test('BotPriorityCoordinator blocks mission tasks during an active threat', async () => {
  const coordinator = new BotPriorityCoordinator();
  coordinator.onRallyStarted();
  coordinator.onRallyCompleted();
  coordinator.onTaskStarted('escort');
  coordinator.onThreatEngaged();

  let resumed = false;
  const waitPromise = coordinator.waitUntilTaskMayProceed(() => true).then(() => {
    resumed = true;
  });

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(resumed, false);

  coordinator.onThreatResolved();
  await waitPromise;
  assert.equal(resumed, true);
});

test('BotPriorityCoordinator does not let threats interrupt rally phase', () => {
  const coordinator = new BotPriorityCoordinator();
  coordinator.onRallyStarted();
  coordinator.onThreatEngaged();

  assert.equal(coordinator.canInterruptWithThreatResponse(), false);
  assert.equal(coordinator.isThreatResponseActive(), false);
});

test('BotPriorityCoordinator lets night shelter override an active threat response', () => {
  const coordinator = new BotPriorityCoordinator();
  coordinator.onRallyStarted();
  coordinator.onRallyCompleted();
  coordinator.onTaskStarted('escort');
  coordinator.onThreatEngaged();

  assert.equal(coordinator.isThreatResponseActive(), true);

  coordinator.onTaskStarted('night_shelter');

  assert.equal(coordinator.canInterruptWithThreatResponse(), false);
  assert.equal(coordinator.isThreatResponseActive(), false);
});

test('BotPriorityCoordinator resets task and threats on respawn and death', () => {
  const coordinator = new BotPriorityCoordinator();
  coordinator.onRallyStarted();
  coordinator.onRallyCompleted();
  coordinator.onTaskStarted('resource_gathering');
  coordinator.onThreatEngaged();

  coordinator.onRespawned();
  assert.equal(coordinator.getCurrentTask(), 'idle');
  assert.equal(coordinator.isThreatResponseActive(), false);

  coordinator.onRallyCompleted();
  coordinator.onTaskStarted('escort');
  coordinator.onThreatEngaged();
  coordinator.onBotDied();

  assert.equal(coordinator.getCurrentTask(), 'idle');
  assert.equal(coordinator.isThreatResponseActive(), false);
});
