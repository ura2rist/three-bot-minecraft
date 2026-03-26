import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { MineflayerChestInventoryManager } from '../../../src/infrastructure/mineflayer/MineflayerChestInventoryManager';
import { TestLogger } from '../../helpers/TestLogger';

test('MineflayerChestInventoryManager deposits only unneeded inventory items', async () => {
  const depositedItems: Array<{ type: number; amount: number }> = [];
  const bot = {
    entity: { position: new Vec3(215, 64, -78), height: 1.62 },
    inventory: {
      items: () => [
        { name: 'white_wool', count: 16, type: 1 },
        { name: 'dirt', count: 12, type: 2 },
      ],
      emptySlotCount: () => 5,
    },
    registry: {
      blocksByName: {
        chest: { id: 54 },
        trapped_chest: { id: 146 },
      },
    },
    findBlocks: () => [new Vec3(215, 64, -77)],
    blockAt: () => ({ position: new Vec3(215, 64, -77), name: 'chest' }),
    world: {
      raycast: () => ({ position: new Vec3(215, 64, -77) }),
    },
    openChest: async () => ({
      containerItems: () => [],
      deposit: async (type: number, _metadata: number | null, amount: number) => {
        depositedItems.push({ type, amount });
      },
      withdraw: async () => undefined,
      close: () => undefined,
    }),
  };

  const manager = new MineflayerChestInventoryManager(
    bot as never,
    new TestLogger(),
    async () => undefined,
  );

  const deposited = await manager.depositUnneededItems(new Vec3(215, 64, -77), (item) => item.name === 'white_wool');

  assert.equal(deposited, 12);
  assert.deepEqual(depositedItems, [{ type: 2, amount: 12 }]);
});

test('MineflayerChestInventoryManager withdraws requested trade stock from nearby chests', async () => {
  const withdrawnItems: Array<{ type: number; amount: number }> = [];
  const bot = {
    entity: { position: new Vec3(215, 64, -78), height: 1.62 },
    inventory: {
      items: () => [],
      emptySlotCount: () => 10,
    },
    registry: {
      blocksByName: {
        chest: { id: 54 },
        trapped_chest: { id: 146 },
      },
    },
    findBlocks: () => [new Vec3(215, 64, -77)],
    blockAt: () => ({ position: new Vec3(215, 64, -77), name: 'chest' }),
    world: {
      raycast: () => ({ position: new Vec3(215, 64, -77) }),
    },
    openChest: async () => ({
      containerItems: () => [{ name: 'white_wool', count: 32, type: 35 }],
      deposit: async () => undefined,
      withdraw: async (type: number, _metadata: number | null, amount: number) => {
        withdrawnItems.push({ type, amount });
      },
      close: () => undefined,
    }),
  };

  const manager = new MineflayerChestInventoryManager(
    bot as never,
    new TestLogger(),
    async () => undefined,
  );

  const withdrawn = await manager.restockItems(new Vec3(215, 64, -77), [
    { itemId: 'white_wool', targetCount: 16 },
  ]);

  assert.equal(withdrawn.get('white_wool'), 16);
  assert.deepEqual(withdrawnItems, [{ type: 35, amount: 16 }]);
});

test('MineflayerChestInventoryManager does not open a chest through a wall when it is outside direct line of sight', async () => {
  let openChestCalls = 0;
  const logger = new TestLogger();
  const bot = {
    entity: { position: new Vec3(215, 64, -78), height: 1.62 },
    inventory: {
      items: () => [{ name: 'dirt', count: 12, type: 2 }],
      emptySlotCount: () => 5,
    },
    registry: {
      blocksByName: {
        chest: { id: 54 },
        trapped_chest: { id: 146 },
      },
    },
    findBlocks: () => [new Vec3(215, 64, -77)],
    blockAt: () => ({ position: new Vec3(215, 64, -77), name: 'chest' }),
    world: {
      raycast: () => ({ position: new Vec3(214, 64, -77) }),
    },
    openChest: async () => {
      openChestCalls += 1;
      return {
        containerItems: () => [],
        deposit: async () => undefined,
        withdraw: async () => undefined,
        close: () => undefined,
      };
    },
  };

  const manager = new MineflayerChestInventoryManager(
    bot as never,
    logger,
    async () => undefined,
  );

  const deposited = await manager.depositUnneededItems(new Vec3(215, 64, -77), () => false);

  assert.equal(deposited, 0);
  assert.equal(openChestCalls, 0);
  assert.equal(
    logger.getEntries().some((entry) => entry.level === 'warn' && entry.message.includes('direct line of sight')),
    true,
  );
});
