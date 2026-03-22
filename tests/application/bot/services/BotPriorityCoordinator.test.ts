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
