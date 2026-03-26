import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { MineflayerFarmRoutine } from '../../../src/infrastructure/mineflayer/MineflayerFarmRoutine';
import { TestLogger } from '../../helpers/TestLogger';

const rallyPoint = { x: 215, y: 64, z: -77 };

function createRoutine(inventoryItems: Array<{ name: string; count: number; type: number }>) {
  const logger = new TestLogger();
  const bot: any = {
    username: 'Gamgee',
    entity: { id: 1, position: new Vec3(215, 64, -75) },
    entities: {},
    inventory: {
      items: () => inventoryItems,
      emptySlotCount: () => 8,
    },
    time: { timeOfDay: 6000, day: 0 },
    isSleeping: false,
    health: 20,
    registry: {
      itemsByName: {},
    },
    blockAt: () => null,
    waitForTicks: async () => undefined,
    lookAt: async () => undefined,
    activateBlock: async () => undefined,
    dig: async () => undefined,
    equip: async () => undefined,
    craft: async () => undefined,
    recipesFor: () => [],
    setControlState: () => undefined,
  };

  const routine = new MineflayerFarmRoutine(
    bot as never,
    logger,
    rallyPoint,
    {
      farms: [
        {
          itemId: 'wheat_seeds',
          points: [{ x: 210, y: 64, z: -70 }],
        },
        {
          itemId: 'carrot',
          points: [{ x: 220, y: 64, z: -70 }],
        },
      ],
    },
    async () => undefined,
    {
      gatherNearestLog: async () => undefined,
    } as never,
    {
      collectAround: async () => false,
    } as never,
    () => true,
    async () => undefined,
  ) as any;

  return { routine, bot, logger };
}

test('MineflayerFarmRoutine keeps the hoe, weapon and cooked meat after a farm route', () => {
  const { routine } = createRoutine([]);

  assert.equal(routine.shouldKeepItemAfterRoute({ name: 'wooden_hoe' }), true);
  assert.equal(routine.shouldKeepItemAfterRoute({ name: 'stone_sword' }), true);
  assert.equal(routine.shouldKeepItemAfterRoute({ name: 'cooked_beef' }), true);
  assert.equal(routine.shouldKeepItemAfterRoute({ name: 'carrot' }), false);
});

test('MineflayerFarmRoutine requests up to two stacks of each configured planting item from nearby chests', async () => {
  const inventoryItems = [
    { name: 'wheat_seeds', count: 0, type: 295 },
    { name: 'carrot', count: 0, type: 391 },
  ];
  const { routine } = createRoutine(inventoryItems);
  const restockCalls: Array<Array<{ itemId: string; targetCount: number }>> = [];

  routine.chestInventoryManager = {
    restockItems: async (_origin: Vec3, requests: Array<{ itemId: string; targetCount: number }>) => {
      restockCalls.push(requests);
      return new Map<string, number>();
    },
  };

  await routine.restockPlantingItems();

  assert.deepEqual(restockCalls, [[
    { itemId: 'wheat_seeds', targetCount: 128 },
    { itemId: 'carrot', targetCount: 128 },
  ]]);
});

test('MineflayerFarmRoutine warns when the planting item is missing in the nearby chests', async () => {
  const inventoryItems = [
    { name: 'wheat_seeds', count: 0, type: 295 },
    { name: 'carrot', count: 0, type: 391 },
  ];
  const { routine, logger } = createRoutine(inventoryItems);

  routine.chestInventoryManager = {
    restockItems: async () => new Map<string, number>(),
  };

  await routine.restockPlantingItems();

  assert.equal(
    logger.getEntries().some((entry) => entry.level === 'warn' && entry.message.includes('Нет нужной культуры в ящиках: wheat_seeds.')),
    true,
  );
  assert.equal(
    logger.getEntries().some((entry) => entry.level === 'warn' && entry.message.includes('Нет нужной культуры в ящиках: carrot.')),
    true,
  );
});

test('MineflayerFarmRoutine treats the shelter doorway as needing an exit before the farm work starts', async () => {
  const { routine, bot } = createRoutine([]);
  let exitAttempts = 0;

  bot.entity.position = new Vec3(215, 64, -75);
  routine.exitShelterThroughDoor = async () => {
    exitAttempts += 1;
    return true;
  };

  const exited = await routine.ensureOutsideShelter();

  assert.equal(exited, true);
  assert.equal(exitAttempts, 1);
});

test('MineflayerFarmRoutine exits through the outside tile directly in front of the shelter door', async () => {
  const { routine, bot } = createRoutine([]);
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

test('MineflayerFarmRoutine does not try to restock or farm while leaving the shelter is still blocked', async () => {
  const { routine, bot } = createRoutine([]);
  let scenarioActive = true;
  let restockCalls = 0;
  let farmRouteCalls = 0;

  bot.entity.position = new Vec3(215, 64, -75);
  bot.waitForTicks = async () => {
    scenarioActive = false;
  };

  routine.isScenarioActive = () => scenarioActive;
  routine.ensureWoodenHoeAvailable = async () => undefined;
  routine.exitShelterThroughDoor = async () => false;
  routine.chestInventoryManager = {
    restockItems: async () => {
      restockCalls += 1;
      return new Map<string, number>();
    },
    depositUnneededItems: async () => 0,
  };
  routine.runFarmRoute = async () => {
    farmRouteCalls += 1;
  };

  await routine.maintain();

  assert.equal(restockCalls, 0);
  assert.equal(farmRouteCalls, 0);
});

test('MineflayerFarmRoutine leaves the shelter before trying to replace a missing hoe', async () => {
  const { routine, bot } = createRoutine([]);
  let scenarioActive = true;
  const callOrder: string[] = [];

  bot.entity.position = new Vec3(215, 64, -75);
  bot.waitForTicks = async () => {
    scenarioActive = false;
  };

  routine.isScenarioActive = () => scenarioActive;
  routine.exitShelterThroughDoor = async () => {
    callOrder.push('exit');
    return true;
  };
  routine.ensureWoodenHoeAvailable = async () => {
    callOrder.push('hoe');
  };
  routine.chestInventoryManager = {
    restockItems: async () => new Map<string, number>(),
    depositUnneededItems: async () => 0,
  };
  routine.runFarmRoute = async () => {
    scenarioActive = false;
  };
  routine.enterShelterAndCloseDoor = async () => undefined;

  await routine.maintain();

  assert.deepEqual(callOrder.slice(0, 2), ['exit', 'hoe']);
});

test('MineflayerFarmRoutine visits farm cells in a deterministic expanding ring around the water source', () => {
  const { routine } = createRoutine([]);

  const cells = routine.getFarmCells({ x: 210, y: 64, z: -70 });

  assert.deepEqual(
    cells.slice(0, 8).map((cell: Vec3) => [cell.x, cell.y, cell.z]),
    [
      [210, 64, -71],
      [211, 64, -71],
      [211, 64, -70],
      [211, 64, -69],
      [210, 64, -69],
      [209, 64, -69],
      [209, 64, -70],
      [209, 64, -71],
    ],
  );
  assert.equal(cells.length, 48);
});

test('MineflayerFarmRoutine normalizes decimal farm points to the nearest block coordinates before scanning cells', () => {
  const { routine } = createRoutine([]);

  const cells = routine.getFarmCells({ x: 199.515, y: 63, z: -97.373 });

  assert.deepEqual(
    cells.slice(0, 8).map((cell: Vec3) => [cell.x, cell.y, cell.z]),
    [
      [200, 63, -98],
      [201, 63, -98],
      [201, 63, -97],
      [201, 63, -96],
      [200, 63, -96],
      [199, 63, -96],
      [199, 63, -97],
      [199, 63, -98],
    ],
  );
});

test('MineflayerFarmRoutine re-crafts a wooden hoe when the current one breaks during tilling', async () => {
  const inventoryItems: Array<{ name: string; count: number; type: number }> = [];
  const { routine, bot, logger } = createRoutine(inventoryItems);
  let craftedReplacement = false;
  let equippedItemName: string | null = null;
  let activatedBlockCount = 0;

  routine.ensureWoodenHoeAvailable = async () => {
    craftedReplacement = true;
    inventoryItems.push({ name: 'wooden_hoe', count: 1, type: 290 });
  };
  bot.equip = async (item: { name: string }) => {
    equippedItemName = item.name;
  };
  bot.activateBlock = async () => {
    activatedBlockCount += 1;
  };

  await routine.tillGround({
    position: new Vec3(210, 64, -70),
  });

  assert.equal(craftedReplacement, true);
  assert.equal(equippedItemName, 'wooden_hoe');
  assert.equal(activatedBlockCount, 1);
  assert.equal(
    logger.getEntries().some(
      (entry) => entry.level === 'info' && entry.message.includes('Farm hoe is missing. Pausing the farm route'),
    ),
    true,
  );
});

test('MineflayerFarmRoutine treats string crop ages as mature values when harvesting', () => {
  const { routine } = createRoutine([]);

  const mature = routine.isMatureCropBlock(
    {
      name: 'wheat',
      getProperties: () => ({ age: '7' }),
    },
    {
      plantedItemId: 'wheat_seeds',
      cropBlockName: 'wheat',
      matureAge: 7,
      harvestItemIds: ['wheat', 'wheat_seeds'],
    },
  );

  assert.equal(mature, true);
});

test('MineflayerFarmRoutine harvests a mature crop by actual block type before replanting the plot crop', async () => {
  const inventoryItems = [{ name: 'wheat_seeds', count: 16, type: 295 }];
  const { routine, bot } = createRoutine(inventoryItems);
  const actions: string[] = [];

  bot.blockAt = (position: Vec3) => {
    if (position.x === 210 && position.y === 65 && position.z === -70) {
      return {
        name: 'carrots',
        position,
        getProperties: () => ({ age: 7 }),
      };
    }

    if (position.x === 210 && position.y === 64 && position.z === -70) {
      return {
        name: 'farmland',
        position,
      };
    }

    return { name: 'air', boundingBox: 'empty', position, getProperties: () => ({}) };
  };
  routine.harvestCrop = async () => {
    actions.push('harvest');
  };
  routine.plantCrop = async () => {
    actions.push('plant');
  };
  routine.nearbyDroppedItemCollector = {
    collectAround: async () => false,
  };

  await routine.tendFarmCell(
    {
      definition: {
        plantedItemId: 'wheat_seeds',
        cropBlockName: 'wheat',
        matureAge: 7,
        harvestItemIds: ['wheat', 'wheat_seeds'],
      },
      settings: {
        itemId: 'wheat_seeds',
        points: [{ x: 210, y: 64, z: -70 }],
      },
    },
    new Vec3(210, 64, -70),
  );

  assert.equal(actions.includes('harvest'), true);
});

test('MineflayerFarmRoutine returns to the crafting table before crafting a wooden hoe', async () => {
  const inventoryItems = [
    { name: 'dark_oak_planks', count: 2, type: 5 },
    { name: 'stick', count: 2, type: 280 },
  ];
  const { routine, bot, logger } = createRoutine(inventoryItems);
  const gotoTargets: Vec3[] = [];
  const craftingTableBlock = {
    position: new Vec3(215, 64, -77),
    name: 'crafting_table',
  };

  bot.entity.position = new Vec3(210, 64, -68);
  bot.registry.itemsByName = {
    wooden_hoe: { id: 290 },
  };
  bot.recipesFor = () => ([{}]);
  routine.gotoPosition = async (target: Vec3) => {
    gotoTargets.push(target.clone());
  };
  routine.findNearbyCraftingTable = () => craftingTableBlock;
  bot.craft = async () => {
    inventoryItems.push({ name: 'wooden_hoe', count: 1, type: 290 });
  };

  await routine.ensureWoodenHoeAvailable();

  assert.equal(
    gotoTargets.some((target) => target.x === 215 && target.y === 64 && target.z === -77),
    true,
  );
  assert.equal(
    logger.getEntries().some(
      (entry) => entry.level === 'info' && entry.message.includes('Crafted a wooden hoe for the farm routine.'),
    ),
    true,
  );
});

test('MineflayerFarmRoutine does not trigger pathfinding to rally or crafting table when already nearby', async () => {
  const inventoryItems = [
    { name: 'dark_oak_planks', count: 2, type: 5 },
    { name: 'stick', count: 2, type: 280 },
  ];
  const { routine, bot } = createRoutine(inventoryItems);
  let gotoCalls = 0;

  bot.entity.position = new Vec3(215, 64, -75.4);
  bot.registry.itemsByName = {
    wooden_hoe: { id: 290 },
  };
  bot.recipesFor = () => ([{}]);
  routine.gotoPosition = async () => {
    gotoCalls += 1;
  };
  routine.findNearbyCraftingTable = () => ({
    position: new Vec3(215, 64, -77),
    name: 'crafting_table',
  });
  bot.craft = async () => {
    inventoryItems.push({ name: 'wooden_hoe', count: 1, type: 290 });
  };

  await routine.ensureWoodenHoeAvailable();

  assert.equal(gotoCalls, 0);
});

test('MineflayerFarmRoutine runs the farm route only once per in-game day', async () => {
  const { routine, bot } = createRoutine([]);
  let scenarioActive = true;
  let waitCalls = 0;
  let farmRouteCalls = 0;

  bot.time.day = 5;
  bot.waitForTicks = async () => {
    waitCalls += 1;

    if (waitCalls >= 2) {
      scenarioActive = false;
    }
  };

  routine.isScenarioActive = () => scenarioActive;
  routine.ensureOutsideShelter = async () => true;
  routine.ensureWoodenHoeAvailable = async () => undefined;
  routine.restockPlantingItems = async () => undefined;
  routine.runFarmRoute = async () => {
    farmRouteCalls += 1;
    return true;
  };
  routine.storeFarmLoot = async () => undefined;
  routine.enterShelterAndCloseDoor = async () => undefined;

  await routine.maintain();

  assert.equal(farmRouteCalls, 1);
});

test('MineflayerFarmRoutine resumes the farm route on the next in-game day', async () => {
  const { routine, bot } = createRoutine([]);
  let scenarioActive = true;
  let waitCalls = 0;
  let farmRouteCalls = 0;

  bot.time.day = 5;
  bot.waitForTicks = async () => {
    waitCalls += 1;

    if (waitCalls === 1) {
      bot.time.day = 6;
      return;
    }

    scenarioActive = false;
  };

  routine.isScenarioActive = () => scenarioActive;
  routine.ensureOutsideShelter = async () => true;
  routine.ensureWoodenHoeAvailable = async () => undefined;
  routine.restockPlantingItems = async () => undefined;
  routine.runFarmRoute = async () => {
    farmRouteCalls += 1;
    return true;
  };
  routine.storeFarmLoot = async () => undefined;
  routine.enterShelterAndCloseDoor = async () => undefined;

  await routine.maintain();

  assert.equal(farmRouteCalls, 2);
});

test('MineflayerFarmRoutine resumes the farm route after morning even when the explicit day counter does not change', async () => {
  const { routine, bot } = createRoutine([]);
  let scenarioActive = true;
  let waitCalls = 0;
  let farmRouteCalls = 0;

  bot.time.day = 5;
  bot.time.timeOfDay = 13010;
  bot.waitForTicks = async () => {
    waitCalls += 1;

    if (waitCalls === 1) {
      bot.time.timeOfDay = 100;
      return;
    }

    scenarioActive = false;
  };

  routine.isScenarioActive = () => scenarioActive;
  routine.ensureOutsideShelter = async () => true;
  routine.ensureWoodenHoeAvailable = async () => undefined;
  routine.restockPlantingItems = async () => undefined;
  routine.runFarmRoute = async () => {
    farmRouteCalls += 1;
    return true;
  };
  routine.storeFarmLoot = async () => undefined;
  routine.enterShelterAndCloseDoor = async () => undefined;

  routine.markFarmWorkCompletedForToday();
  await routine.maintain();

  assert.equal(farmRouteCalls, 1);
});

test('MineflayerFarmRoutine retries farm-point approach from surrounding positions when the center is not reachable', async () => {
  const { routine } = createRoutine([]);
  const attemptedTargets: Array<[number, number, number, number]> = [];

  routine.gotoFarmPosition = async (target: Vec3, range: number) => {
    attemptedTargets.push([target.x, target.y, target.z, range]);

    if (target.x === 200 && target.y === 63 && target.z === -97) {
      throw new Error('center blocked');
    }
  };

  await routine.gotoFarmPoint({ x: 199.515, y: 63, z: -97.373 });

  assert.deepEqual(attemptedTargets[0], [200, 63, -97, 0]);
  assert.equal(attemptedTargets.length > 1, true);
});

test('MineflayerFarmRoutine steps onto each farm cell in order after reaching the water point', async () => {
  const { routine, bot } = createRoutine([]);
  const processedCells: string[] = [];
  const gotoTargets: Array<[number, number, number, number]> = [];

  bot.entity.position = new Vec3(210, 64, -70);
  routine.getFarmCells = () => [
    new Vec3(210, 64, -71),
    new Vec3(211, 64, -71),
  ];
  routine.gotoFarmPoint = async () => {
    bot.entity.position = new Vec3(210, 64, -70);
  };
  routine.inspectFarmCell = () => ({
    needsInteraction: true,
    needsHarvest: true,
    needsPlanting: true,
  });
  routine.gotoFarmPosition = async (target: Vec3, range: number) => {
    gotoTargets.push([target.x, target.y, target.z, range]);
    bot.entity.position = target;
  };
  routine.tendFarmCell = async (_plot: unknown, cell: Vec3) => {
    processedCells.push(`${cell.x}:${cell.y}:${cell.z}`);
  };

  const completed = await routine.processFarmZone(
    {
      definition: {
        plantedItemId: 'wheat_seeds',
        cropBlockName: 'wheat',
        matureAge: 7,
        harvestItemIds: ['wheat', 'wheat_seeds'],
      },
      settings: {
        itemId: 'wheat_seeds',
        points: [{ x: 210, y: 64, z: -70 }],
      },
    },
    { x: 210, y: 64, z: -70 },
  );

  assert.equal(completed, true);
  assert.deepEqual(processedCells, ['210:64:-71', '211:64:-71']);
  assert.deepEqual(gotoTargets, [
    [210, 64, -71, 0],
    [211, 64, -71, 0],
  ]);
});
