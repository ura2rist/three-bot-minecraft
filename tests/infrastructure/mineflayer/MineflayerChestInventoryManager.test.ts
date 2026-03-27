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

test('MineflayerChestInventoryManager approaches a nearby side tile instead of pathing into the chest block itself', async () => {
  const gotoTargets: Vec3[] = [];
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
    findBlocks: () => [new Vec3(210, 65, -77)],
    blockAt: (position: Vec3) => ({ position, name: 'chest' }),
    world: {},
    openChest: async () => ({
      containerItems: () => [{ name: 'white_wool', count: 32, type: 35 }],
      deposit: async () => undefined,
      withdraw: async () => undefined,
      close: () => undefined,
    }),
  };

  const manager = new MineflayerChestInventoryManager(
    bot as never,
    new TestLogger(),
    async (target: Vec3) => {
      gotoTargets.push(target.clone());
    },
  );

  await manager.restockItems(new Vec3(215, 64, -77), [
    { itemId: 'white_wool', targetCount: 16 },
  ]);

  assert.equal(
    gotoTargets.some((target) => target.x === 210 && target.y === 65 && target.z === -77),
    false,
  );
  assert.equal(gotoTargets.length > 0, true);
});

test('MineflayerChestInventoryManager inspects a double chest only once when both halves are discovered', async () => {
  let openChestCalls = 0;
  const chestBlocks = new Map<string, { position: Vec3; name: string }>([
    ['210:65:-77', { position: new Vec3(210, 65, -77), name: 'chest' }],
    ['211:65:-77', { position: new Vec3(211, 65, -77), name: 'chest' }],
  ]);
  const bot = {
    entity: { position: new Vec3(209, 64, -77), height: 1.62 },
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
    findBlocks: () => [new Vec3(210, 65, -77), new Vec3(211, 65, -77)],
    blockAt: (position: Vec3) => chestBlocks.get(`${position.x}:${position.y}:${position.z}`) ?? null,
    world: {
      raycast: () => ({ position: new Vec3(210, 65, -77) }),
    },
    openChest: async () => {
      openChestCalls += 1;

      return {
        containerItems: () => [{ name: 'white_wool', count: 32, type: 35 }],
        deposit: async () => undefined,
        withdraw: async () => undefined,
        close: () => undefined,
      };
    },
  };

  const manager = new MineflayerChestInventoryManager(
    bot as never,
    new TestLogger(),
    async () => undefined,
  );

  await manager.restockItems(new Vec3(209, 64, -77), [
    { itemId: 'white_wool', targetCount: 64 },
  ]);

  assert.equal(openChestCalls, 1);
});

test('MineflayerChestInventoryManager prefers chests that were not inspected in the current nearby storage sweep', async () => {
  const chestA = { position: new Vec3(210, 65, -77), name: 'chest', boundingBox: 'block' };
  const chestB = { position: new Vec3(212, 65, -77), name: 'chest', boundingBox: 'block' };
  const chestBlocks = new Map<string, { position: Vec3; name: string; boundingBox: string }>([
    ['210:65:-77', chestA],
    ['212:65:-77', chestB],
  ]);
  const openedChestKeys: string[] = [];
  const bot = {
    entity: { position: new Vec3(209, 64, -77), height: 1.62 },
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
    findBlocks: () => [new Vec3(210, 65, -77), new Vec3(212, 65, -77)],
    blockAt: (position: Vec3) => chestBlocks.get(`${position.x}:${position.y}:${position.z}`) ?? null,
    world: {},
    openChest: async (block: { position: Vec3 }) => ({
      containerItems: () => [{ name: 'white_wool', count: 32, type: 35 }],
      deposit: async () => undefined,
      withdraw: async () => {
        openedChestKeys.push(`${block.position.x}:${block.position.y}:${block.position.z}`);
      },
      close: () => undefined,
    }),
  };

  const manager = new MineflayerChestInventoryManager(
    bot as never,
    new TestLogger(),
    async () => undefined,
  );

  await manager.restockItems(new Vec3(209, 64, -77), [{ itemId: 'white_wool', targetCount: 16 }]);
  await manager.restockItems(new Vec3(209, 64, -77), [{ itemId: 'white_wool', targetCount: 16 }]);

  assert.deepEqual(openedChestKeys, ['210:65:-77', '212:65:-77']);
});
