import test from 'node:test';
import assert from 'node:assert/strict';
import { EstablishMicroBaseService } from '../../../../src/application/bot/services/EstablishMicroBaseService';
import { DeterministicMicroBaseAssignmentPolicy } from '../../../../src/application/bot/services/DeterministicMicroBaseAssignmentPolicy';
import { SquadWeaponReadinessTracker } from '../../../../src/application/bot/services/SquadWeaponReadinessTracker';
import { InMemoryEventBus } from '../../../../src/infrastructure/events/InMemoryEventBus';
import { BotActivityEvent } from '../../../../src/application/bot/events/BotActivityEvent';
import { BotConfiguration } from '../../../../src/domain/bot/entities/BotConfiguration';
import { TestLogger } from '../../../helpers/TestLogger';

const createBot = (role: 'farm' | 'mine' | 'trading', username: string) =>
  new BotConfiguration({
    role,
    host: 'localhost',
    port: 25565,
    username,
    password: 'secret',
    rallyPoint: { x: 215, y: 64, z: -77 },
    auth: 'offline',
  });

test('EstablishMicroBaseService runs the leader flow after the squad is ready', async () => {
  const logger = new TestLogger();
  const assignmentPolicy = new DeterministicMicroBaseAssignmentPolicy();
  const leader = createBot('farm', 'Gamgee');
  const support = createBot('mine', 'Gimli');
  assignmentPolicy.prepareFleet([leader, support]);

  const readinessTracker = new SquadWeaponReadinessTracker();
  readinessTracker.markReady('Gimli');

  let ensuredSword = 0;
  let establishCalls = 0;
  const service = new EstablishMicroBaseService(
    assignmentPolicy,
    {
      ensureWoodenSwordNearRallyPoint: async () => {
        ensuredSword += 1;
      },
      establishAtRallyPoint: async () => {
        establishCalls += 1;
      },
      supportLeader: async () => {
        throw new Error('support should not run for leader');
      },
    },
    logger,
    new InMemoryEventBus<BotActivityEvent>(),
    readinessTracker,
    ['Gamgee', 'Gimli'],
    () => true,
  );

  await service.execute(leader);
  assert.equal(ensuredSword, 1);
  assert.equal(establishCalls, 1);
});

test('EstablishMicroBaseService runs escort flow for a non-leader', async () => {
  const assignmentPolicy = new DeterministicMicroBaseAssignmentPolicy();
  const leader = createBot('farm', 'Gamgee');
  const support = createBot('trading', 'Lawrence');
  assignmentPolicy.prepareFleet([leader, support]);

  let escortedLeader = '';
  const service = new EstablishMicroBaseService(
    assignmentPolicy,
    {
      ensureWoodenSwordNearRallyPoint: async () => undefined,
      establishAtRallyPoint: async () => {
        throw new Error('leader flow should not run');
      },
      supportLeader: async (leaderUsername: string) => {
        escortedLeader = leaderUsername;
      },
    },
    new TestLogger(),
    new InMemoryEventBus<BotActivityEvent>(),
    new SquadWeaponReadinessTracker(),
    ['Gamgee', 'Lawrence'],
    () => true,
  );

  await service.execute(support);
  assert.equal(escortedLeader, 'Gamgee');
});
