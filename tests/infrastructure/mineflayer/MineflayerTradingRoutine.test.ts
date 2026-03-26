import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { MineflayerTradingRoutine } from '../../../src/infrastructure/mineflayer/MineflayerTradingRoutine';
import { TestLogger } from '../../helpers/TestLogger';

const rallyPoint = { x: 215, y: 64, z: -77 };

function createRoutine(inventoryItems: Array<{ name: string; count: number; type: number }>) {
  const tradeDropDelays: number[] = [];
  const bot: any = {
    entity: { position: new Vec3(215, 64, -71) },
    inventory: {
      items: () => inventoryItems,
      emptySlotCount: () => 8,
    },
    isSleeping: false,
    time: { timeOfDay: 6000 },
    toss: async (_type?: number, _metadata?: number | null, _amount?: number | null) => undefined,
    waitForTicks: async () => undefined,
    blockAt: (position: Vec3) => {
      if (position.x === 215 && position.y === 64 && position.z === -75) {
        return {
          position,
          name: 'dark_oak_door',
          getProperties: () => ({ half: 'lower' }),
        };
      }

      return null;
    },
  };

  const routine = new MineflayerTradingRoutine(
    bot as never,
    new TestLogger(),
    rallyPoint,
    {
      offers: [
        {
          playerGives: [{ itemId: 'bread', amount: 2 }],
          botGives: [{ itemId: 'white_wool', amount: 1 }],
        },
      ],
    },
    async () => undefined,
    () => true,
    async () => undefined,
    (delayMs: number) => {
      tradeDropDelays.push(delayMs);
    },
  ) as any;

  return { routine, bot, tradeDropDelays };
}

test('MineflayerTradingRoutine tosses the configured trade output after collecting enough input items', async () => {
  const inventoryItems = [
    { name: 'bread', count: 0, type: 297 },
    { name: 'white_wool', count: 5, type: 35 },
  ];
  const { routine, bot, tradeDropDelays } = createRoutine(inventoryItems);
  const tossCalls: Array<{ type: number; amount: number | null }> = [];

  bot.toss = async (type?: number, _metadata?: number | null, amount?: number | null) => {
    tossCalls.push({ type: type ?? -1, amount: amount ?? null });
  };

  routine.resetObservedInputCounts();
  inventoryItems[0]!.count = 2;

  await routine.processTradesFromCollectedItems();

  assert.deepEqual(tossCalls, [{ type: 35, amount: 1 }]);
  assert.deepEqual(tradeDropDelays, [15000]);
});

test('MineflayerTradingRoutine performs cleanup and restock when inventory maintenance is needed', async () => {
  const inventoryItems = [{ name: 'white_wool', count: 0, type: 35 }];
  const { routine } = createRoutine(inventoryItems);
  let depositCalls = 0;
  let restockCalls = 0;

  routine.chestInventoryManager = {
    getFreeInventorySlots: () => 2,
    depositUnneededItems: async () => {
      depositCalls += 1;
      return 8;
    },
    restockItems: async () => {
      restockCalls += 1;
      return new Map([['white_wool', 32]]);
    },
  };

  const maintained = await routine.maintainTradingInventory();

  assert.equal(maintained, true);
  assert.equal(depositCalls, 1);
  assert.equal(restockCalls, 1);
});

test('MineflayerTradingRoutine tries to leave the shelter before opening storage chests', async () => {
  const inventoryItems = [{ name: 'white_wool', count: 0, type: 35 }];
  const { routine, bot } = createRoutine(inventoryItems);
  let exitCalls = 0;
  let restockCalls = 0;

  bot.entity.position = new Vec3(215, 64, -75);
  routine.exitShelterThroughDoor = async () => {
    exitCalls += 1;
    return true;
  };
  routine.chestInventoryManager = {
    getFreeInventorySlots: () => 8,
    depositUnneededItems: async () => 0,
    restockItems: async () => {
      restockCalls += 1;
      return new Map([['white_wool', 16]]);
    },
  };

  const maintained = await routine.maintainTradingInventory();

  assert.equal(maintained, true);
  assert.equal(exitCalls, 1);
  assert.equal(restockCalls, 1);
});

test('MineflayerTradingRoutine skips chest interaction when it cannot leave the shelter yet', async () => {
  const inventoryItems = [{ name: 'white_wool', count: 0, type: 35 }];
  const { routine, bot } = createRoutine(inventoryItems);
  let restockCalls = 0;

  bot.entity.position = new Vec3(215, 64, -75);
  routine.exitShelterThroughDoor = async () => false;
  routine.chestInventoryManager = {
    getFreeInventorySlots: () => 8,
    depositUnneededItems: async () => 0,
    restockItems: async () => {
      restockCalls += 1;
      return new Map();
    },
  };

  const maintained = await routine.maintainTradingInventory();

  assert.equal(maintained, false);
  assert.equal(restockCalls, 0);
});

test('MineflayerTradingRoutine treats the shelter doorway as needing an exit before storage access', async () => {
  const inventoryItems = [{ name: 'white_wool', count: 0, type: 35 }];
  const { routine, bot } = createRoutine(inventoryItems);
  let exitCalls = 0;

  bot.entity.position = new Vec3(215, 64, -75);
  routine.exitShelterThroughDoor = async () => {
    exitCalls += 1;
    return true;
  };

  const exited = await routine.ensureOutsideShelter();

  assert.equal(exited, true);
  assert.equal(exitCalls, 1);
});

test('MineflayerTradingRoutine exits through the outside tile directly in front of the shelter door', async () => {
  const inventoryItems = [{ name: 'white_wool', count: 0, type: 35 }];
  const { routine, bot } = createRoutine(inventoryItems);
  const gotoTargets: Vec3[] = [];

  bot.entity.position = new Vec3(215, 64, -76);
  routine.gotoPosition = async (target: Vec3) => {
    gotoTargets.push(target.clone());

    if (target.x === 215 && target.y === 64 && target.z === -74) {
      bot.entity.position = new Vec3(215, 64, -74);
    }
  };
  routine.openShelterDoorIfNeeded = async () => undefined;
  routine.stepTowards = async () => undefined;

  const exited = await routine.exitShelterThroughDoor();

  assert.equal(exited, true);
  assert.equal(
    gotoTargets.some((target) => target.x === 215 && target.y === 64 && target.z === -74),
    true,
  );
});

test('MineflayerTradingRoutine does not immediately recheck chests while a depleted trade item still remains in inventory', async () => {
  const inventoryItems = [{ name: 'white_wool', count: 26, type: 35 }];
  const { routine } = createRoutine(inventoryItems);

  routine.updateTemporarilyDepletedOutputs(
    [{ itemId: 'white_wool', targetCount: 128 }],
    new Map([['white_wool', 26]]),
  );

  const requests = routine.buildRestockRequests();

  assert.deepEqual(requests, []);
});

test('MineflayerTradingRoutine checks chests again after the depleted trade item reaches zero', async () => {
  const inventoryItems = [{ name: 'white_wool', count: 26, type: 35 }];
  const { routine } = createRoutine(inventoryItems);

  routine.updateTemporarilyDepletedOutputs(
    [{ itemId: 'white_wool', targetCount: 128 }],
    new Map([['white_wool', 26]]),
  );
  inventoryItems[0]!.count = 0;

  const requests = routine.buildRestockRequests();

  assert.deepEqual(requests, [{ itemId: 'white_wool', targetCount: 128 }]);
});
