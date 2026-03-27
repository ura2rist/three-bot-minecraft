import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { MineflayerMineRoutine } from '../../../src/infrastructure/mineflayer/MineflayerMineRoutine';
import { TestLogger } from '../../helpers/TestLogger';

const rallyPoint = { x: 215, y: 64, z: -77 };

function createRoutine(inventoryItems: Array<{ name: string; count: number; type: number }>) {
  const logger = new TestLogger();
  const chatMessages: string[] = [];
  const bot: any = {
    username: 'Gimli',
    entity: { id: 1, position: new Vec3(215, 64, -75) },
    inventory: {
      items: () => inventoryItems,
      emptySlotCount: () => 8,
    },
    time: { timeOfDay: 6000, day: 0 },
    isSleeping: false,
    registry: {
      itemsByName: {
        stone_pickaxe: { id: 1 },
        wooden_pickaxe: { id: 2 },
        stick: { id: 3 },
        torch: { id: 4 },
        oak_planks: { id: 5 },
      },
      blocksByName: {
        crafting_table: { id: 58 },
      },
    },
    findBlock: () => ({
      position: new Vec3(215, 64, -77),
      name: 'crafting_table',
      getProperties: () => ({}),
    }),
    blockAt: () => null,
    recipesFor: () => [{}],
    craft: async () => undefined,
    equip: async () => undefined,
    lookAt: async () => undefined,
    dig: async () => undefined,
    canDigBlock: () => true,
    placeBlock: async () => undefined,
    activateBlock: async () => undefined,
    waitForTicks: async () => undefined,
    setControlState: () => undefined,
    chat: (message: string) => {
      chatMessages.push(message);
    },
  };

  const routine = new MineflayerMineRoutine(
    bot as never,
    logger,
    rallyPoint,
    {
      shaft: {
        targetDepthY: 20,
        shaftHeight: 3,
        shaftWidth: 2,
        shaftLength: 24,
      },
    },
    async () => undefined,
    {
      gatherNearestLog: async () => undefined,
    } as never,
    {
      collectAround: async () => false,
    } as never,
    {
      load: () => null,
      save: () => undefined,
    } as never,
    () => true,
    async () => undefined,
  ) as any;

  return { routine, bot, logger, inventoryItems, chatMessages };
}

test('MineflayerMineRoutine prefers crafting a stone pickaxe when cobblestone is available', async () => {
  const inventoryItems = [
    { name: 'cobblestone', count: 3, type: 1 },
    { name: 'stick', count: 2, type: 3 },
  ];
  const { routine } = createRoutine(inventoryItems);
  const craftedItems: string[] = [];

  routine.restockMiningMaterials = async () => undefined;
  routine.moveNearIfNeeded = async () => undefined;
  routine.requireNearbyCraftingTable = () => ({ position: new Vec3(215, 64, -77) });
  routine.craftSingleItem = async (itemName: string) => {
    craftedItems.push(itemName);

    if (itemName === 'stone_pickaxe') {
      inventoryItems.push({ name: 'stone_pickaxe', count: 1, type: 10 });
      return true;
    }

    return false;
  };

  await routine.ensurePickaxeAvailable();

  assert.equal(craftedItems.includes('stone_pickaxe'), true);
  assert.equal(craftedItems.includes('wooden_pickaxe'), false);
});

test('MineflayerMineRoutine gathers wood when planks are missing for the starter tools', async () => {
  const inventoryItems: Array<{ name: string; count: number; type: number }> = [];
  const { routine } = createRoutine(inventoryItems);
  let gatherCalls = 0;

  routine.craftSingleItem = async (itemName: string) => {
    if (itemName === 'oak_planks') {
      const log = inventoryItems.find((item) => item.name === 'oak_log');

      if (log) {
        log.count -= 1;
      }

      inventoryItems.push({ name: 'oak_planks', count: 4, type: 5 });
      return true;
    }

    return false;
  };
  routine.logHarvestingPort = {
    gatherNearestLog: async () => {
      gatherCalls += 1;
      inventoryItems.push({ name: 'oak_log', count: 1, type: 17 });
    },
  };

  await routine.ensurePlanksAvailable(4);

  assert.equal(gatherCalls, 1);
  assert.equal(inventoryItems.some((item) => item.name === 'oak_planks'), true);
});

test('MineflayerMineRoutine reports a blocked block with coordinates only once', async () => {
  const { routine, chatMessages } = createRoutine([]);
  const position = new Vec3(200, 12, -90);

  await routine.reportUnbreakableBlock(position);
  await routine.reportUnbreakableBlock(position);

  assert.deepEqual(chatMessages, ['не могу сломать блок 200 12 -90']);
});

test('MineflayerMineRoutine sends "все занято" and waits until the next day when storage remains full', async () => {
  const inventoryItems = [{ name: 'cobblestone', count: 64, type: 1 }];
  const { routine, chatMessages } = createRoutine(inventoryItems);

  routine.chestInventoryManager = {
    depositUnneededItems: async () => 0,
    getFreeInventorySlots: () => 0,
  };
  routine.enterShelterAndCloseDoor = async () => undefined;

  const stored = await routine.storeMineLoot();

  assert.equal(stored, false);
  assert.deepEqual(chatMessages, ['все занято']);
  assert.equal(routine.isStorageBlockedForToday(), true);
});

test('MineflayerMineRoutine advances through four branches before moving to a deeper layer', () => {
  const { routine } = createRoutine([]);

  assert.equal(routine.currentLayerIndex, 0);
  assert.equal(routine.currentBranchIndex, 0);

  routine.advanceToNextBranch();
  assert.equal(routine.currentLayerIndex, 0);
  assert.equal(routine.currentBranchIndex, 1);

  routine.advanceToNextBranch();
  routine.advanceToNextBranch();
  routine.advanceToNextBranch();

  assert.equal(routine.currentLayerIndex, 1);
  assert.equal(routine.currentBranchIndex, 0);
  assert.equal(routine.currentBranchProgress, 0);
});

test('MineflayerMineRoutine places each next layer hub deeper and farther than the previous one', () => {
  const { routine } = createRoutine([]);
  const firstHub = routine.getLayerHubCenter(0);
  const secondHub = routine.getLayerHubCenter(1);

  assert.equal(secondHub.y, firstHub.y - 4);
  assert.equal(firstHub.distanceTo(secondHub) > 0, true);
});

test('MineflayerMineRoutine switches to the next branch when the current branch is blocked by liquid', async () => {
  const { routine } = createRoutine([]);

  routine.currentBranchIndex = 2;
  routine.currentBranchProgress = 0;
  routine.waitForScenarioWindow = async () => undefined;
  routine.clearCorridorAt = async () => false;

  await routine.excavateCurrentBranch();

  assert.equal(routine.currentBranchIndex, 3);
  assert.equal(routine.currentBranchProgress, 0);
});

test('MineflayerMineRoutine follows an ore vein only within four blocks from the branch anchor', async () => {
  const { routine, bot } = createRoutine([]);
  const mined: string[] = [];
  const orePositions = new Set([
    '100:12:0',
    '101:12:0',
    '102:12:0',
    '103:12:0',
    '104:12:0',
    '105:12:0',
  ]);

  bot.blockAt = (position: Vec3) => {
    const key = `${position.x}:${position.y}:${position.z}`;

    if (!orePositions.has(key)) {
      return null;
    }

    return {
      position,
      name: 'coal_ore',
      getProperties: () => ({}),
    };
  };
  routine.gotoPosition = async () => undefined;
  routine.excavateBlock = async (block: { position: Vec3 }) => {
    mined.push(`${block.position.x}:${block.position.y}:${block.position.z}`);
    orePositions.delete(`${block.position.x}:${block.position.y}:${block.position.z}`);
    return true;
  };

  await routine.mineOreVein(new Vec3(100, 12, 0), new Vec3(100, 12, 0));

  assert.deepEqual(mined, [
    '100:12:0',
    '101:12:0',
    '102:12:0',
    '103:12:0',
    '104:12:0',
  ]);
});

test('MineflayerMineRoutine restores persisted progress on startup', () => {
  const logger = new TestLogger();
  const bot: any = {
    username: 'Gimli',
    entity: { id: 1, position: new Vec3(215, 64, -75) },
    inventory: { items: () => [], emptySlotCount: () => 8 },
    time: { timeOfDay: 6000, day: 0 },
    isSleeping: false,
    registry: { itemsByName: {}, blocksByName: {} },
    findBlock: () => null,
    blockAt: () => null,
    recipesFor: () => [],
    craft: async () => undefined,
    equip: async () => undefined,
    lookAt: async () => undefined,
    dig: async () => undefined,
    canDigBlock: () => true,
    placeBlock: async () => undefined,
    activateBlock: async () => undefined,
    waitForTicks: async () => undefined,
    setControlState: () => undefined,
    chat: () => undefined,
  };

  const routine = new MineflayerMineRoutine(
    bot as never,
    logger,
    rallyPoint,
    {
      shaft: {
        targetDepthY: 20,
        shaftHeight: 3,
        shaftWidth: 2,
        shaftLength: 24,
      },
    },
    async () => undefined,
    { gatherNearestLog: async () => undefined } as never,
    { collectAround: async () => false } as never,
    {
      load: () => ({
        staircaseProgress: 20,
        currentLayerIndex: 2,
        currentBranchIndex: 1,
        currentBranchProgress: 7,
        minePlanComplete: false,
      }),
      save: () => undefined,
    } as never,
    () => true,
    async () => undefined,
  ) as any;

  assert.equal(routine.staircaseProgress, 20);
  assert.equal(routine.currentLayerIndex, 2);
  assert.equal(routine.currentBranchIndex, 1);
  assert.equal(routine.currentBranchProgress, 7);
});

test('MineflayerMineRoutine persists progress when staircase advances', async () => {
  const { routine } = createRoutine([]);
  const saved: Array<Record<string, number | boolean>> = [];

  routine.progressStore = {
    load: () => null,
    save: (_username: string, progress: Record<string, number | boolean>) => {
      saved.push(progress);
    },
  };
  routine.waitForScenarioWindow = async () => undefined;
  routine.shouldPauseForNightlyShelter = () => false;
  routine.needsInventoryUnload = () => false;
  routine.clearCorridorAt = async () => true;
  routine.moveNearIfNeeded = async () => undefined;
  routine.mineExposedOresNear = async () => undefined;
  routine.placeTorchIfNeeded = async () => undefined;
  routine.getTargetMineDepth = () => 1;

  await routine.excavateStaircase();

  assert.equal(saved.length > 0, true);
  assert.equal(saved.at(-1)?.staircaseProgress, 1);
});

test('MineflayerMineRoutine does not place staircase torches early just because the mined path is open nearby', async () => {
  const inventoryItems = [{ name: 'torch', count: 16, type: 4 }];
  const { routine, bot } = createRoutine(inventoryItems);
  let placedTorch = false;

  bot.blockAt = (position: Vec3) => {
    if (position.y === 11) {
      return {
        position,
        name: 'stone',
        boundingBox: 'block',
        getProperties: () => ({}),
      };
    }

    return null;
  };
  bot.placeBlock = async () => {
    placedTorch = true;
  };
  routine.hasExposedCaveNearby = () => true;

  await routine.placeTorchIfNeeded(new Vec3(100, 12, 0), 1, false);

  assert.equal(placedTorch, false);
});

test('MineflayerMineRoutine places staircase torches on the configured ten-block interval', async () => {
  const inventoryItems = [{ name: 'torch', count: 16, type: 4 }];
  const { routine, bot } = createRoutine(inventoryItems);
  let placedTorch = false;

  bot.blockAt = (position: Vec3) => {
    if (position.y === 11) {
      return {
        position,
        name: 'stone',
        boundingBox: 'block',
        getProperties: () => ({}),
      };
    }

    return null;
  };
  bot.placeBlock = async () => {
    placedTorch = true;
  };
  routine.hasExposedCaveNearby = () => false;

  await routine.placeTorchIfNeeded(new Vec3(100, 12, 0), 10, false);

  assert.equal(placedTorch, true);
});

test('MineflayerMineRoutine treats a transient missing ingredient craft error as a retryable failure', async () => {
  const { routine, bot } = createRoutine([]);

  bot.registry.itemsByName.stick = { id: 3 };
  bot.recipesFor = () => ([{}]);
  bot.craft = async () => {
    throw new Error('missing ingredient');
  };

  const crafted = await routine.craftSingleItem('stick');

  assert.equal(crafted, false);
});

test('MineflayerMineRoutine retries the loop after a transient goal-changed interruption instead of stopping the routine', async () => {
  const { routine, bot, logger } = createRoutine([]);
  let maintainIterations = 0;

  routine.isScenarioActive = () => maintainIterations < 1;
  routine.waitForScenarioWindow = async () => undefined;
  routine.shouldPauseForNightlyShelter = () => false;
  routine.isStorageBlockedForToday = () => false;
  routine.ensureOutsideShelter = async () => true;
  routine.needsInventoryUnload = () => false;
  routine.ensureMiningSuppliesAvailable = async () => undefined;
  routine.advanceMine = async () => {
    maintainIterations += 1;
    throw new Error('The goal was changed before it could be completed!');
  };
  bot.waitForTicks = async () => undefined;

  await routine.maintain();

  assert.equal(
    logger.getEntries().some(
      (entry) =>
        entry.level === 'info' &&
        entry.message.includes('Mining step was interrupted and will be retried'),
    ),
    true,
  );
});
