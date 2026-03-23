import test from 'node:test';
import assert from 'node:assert/strict';
import { DeterministicMicroBaseAssignmentPolicy } from '../../../../src/application/bot/services/DeterministicMicroBaseAssignmentPolicy';
import { BotConfiguration } from '../../../../src/domain/bot/entities/BotConfiguration';

const createBot = (role: 'farm' | 'mine' | 'trading', username: string) =>
  new BotConfiguration({
    role,
    host: 'localhost',
    port: 25565,
    username,
    password: 'secret',
    auth: 'offline',
  });

test('DeterministicMicroBaseAssignmentPolicy picks the highest-priority role present', () => {
  const policy = new DeterministicMicroBaseAssignmentPolicy();
  const mine = createBot('mine', 'Gimli');
  const trading = createBot('trading', 'Lawrence');

  policy.prepareFleet([trading, mine]);

  assert.equal(policy.getLeaderUsername(), 'Gimli');
  assert.equal(policy.isLeader(mine), true);
  assert.equal(policy.isLeader(trading), false);
});

test('DeterministicMicroBaseAssignmentPolicy prefers farm when available', () => {
  const policy = new DeterministicMicroBaseAssignmentPolicy();
  policy.prepareFleet([
    createBot('trading', 'Lawrence'),
    createBot('farm', 'Gamgee'),
    createBot('mine', 'Gimli'),
  ]);

  assert.equal(policy.getLeaderUsername(), 'Gamgee');
});

test('DeterministicMicroBaseAssignmentPolicy has no leader when the fleet is empty', () => {
  const policy = new DeterministicMicroBaseAssignmentPolicy();
  policy.prepareFleet([]);

  assert.equal(policy.getLeaderUsername(), null);
});
