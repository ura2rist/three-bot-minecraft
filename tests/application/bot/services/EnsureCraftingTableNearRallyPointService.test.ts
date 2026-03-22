import test from 'node:test';
import assert from 'node:assert/strict';
import { EnsureCraftingTableNearRallyPointService } from '../../../../src/application/bot/services/EnsureCraftingTableNearRallyPointService';
import { BotConfiguration } from '../../../../src/domain/bot/entities/BotConfiguration';
import { TestLogger } from '../../../helpers/TestLogger';

const configuration = new BotConfiguration({
  role: 'mine',
  host: 'localhost',
  port: 25565,
  username: 'Gimli',
  password: 'secret',
  rallyPoint: { x: 215, y: 64, z: -77 },
  auth: 'offline',
});

test('EnsureCraftingTableNearRallyPointService waits for the assigned crafter when current bot is not selected', async () => {
  let checkCount = 0;
  const service = new EnsureCraftingTableNearRallyPointService(
    {
      prepareFleet: () => undefined,
      getAssignedUsername: () => 'Gamgee',
      isAssignedCrafter: () => false,
    },
    {
      hasCraftingTableNearRallyPoint: async () => {
        checkCount += 1;
        return checkCount >= 2;
      },
      placeCraftingTableNearRallyPoint: async () => {
        throw new Error('should not place');
      },
    },
    {
      hasItem: async () => false,
      craftCraftingTable: async () => false,
      craftPlanksFromInventoryLogs: async () => false,
    },
    {
      gatherNearestLog: async () => {
        throw new Error('should not gather');
      },
    },
    new TestLogger(),
  );

  (service as unknown as { craftingTableWaitPollIntervalMs: number }).craftingTableWaitPollIntervalMs = 1;
  (service as unknown as { craftingTableWaitTimeoutMs: number }).craftingTableWaitTimeoutMs = 50;

  await service.execute(configuration);
  assert.ok(checkCount >= 2);
});

test('EnsureCraftingTableNearRallyPointService gathers logs when nothing can be crafted immediately', async () => {
  let gatherCalls = 0;
  let craftTableCalls = 0;
  const service = new EnsureCraftingTableNearRallyPointService(
    {
      prepareFleet: () => undefined,
      getAssignedUsername: () => 'Gimli',
      isAssignedCrafter: () => true,
    },
    {
      hasCraftingTableNearRallyPoint: async () => false,
      placeCraftingTableNearRallyPoint: async () => undefined,
    },
    {
      hasItem: async () => false,
      craftCraftingTable: async () => {
        craftTableCalls += 1;
        return gatherCalls > 0 && craftTableCalls > 1;
      },
      craftPlanksFromInventoryLogs: async () => gatherCalls > 0,
    },
    {
      gatherNearestLog: async () => {
        gatherCalls += 1;
      },
    },
    new TestLogger(),
  );

  await service.execute(configuration);
  assert.equal(gatherCalls, 1);
});
