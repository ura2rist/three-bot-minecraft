import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { MineflayerMicroBasePort } from '../../../src/infrastructure/mineflayer/MineflayerMicroBasePort';
import { TestLogger } from '../../helpers/TestLogger';

const rallyPoint = { x: 215, y: 64, z: -77 };

function createPort(inventoryItems: Array<{ name: string; count: number }>) {
  const bot = {
    inventory: {
      items: () => inventoryItems,
    },
    entity: { position: new Vec3(215, 64, -77) },
    isSleeping: false,
    thunderState: 0,
    time: { timeOfDay: 0, isDay: true },
    world: {},
    registry: {
      itemsByName: {},
      blocksByName: {},
      foodsByName: {},
    },
    pathfinder: {
      setMovements: () => undefined,
      goto: async () => undefined,
      stop: () => undefined,
    },
  };

  const port = new MineflayerMicroBasePort(
    bot as never,
    'farm',
    new TestLogger(),
    async () => undefined,
    {} as never,
    {} as never,
    {} as never,
    async () => undefined,
    () => true,
    async () => undefined,
    () => false,
    3,
  );

  return port as never;
}

test('MineflayerMicroBasePort counts bed items already in inventory before crafting for the initial shelter', async () => {
  const port = createPort([{ name: 'white_bed', count: 1 }]) as any;
  let craftedAdditionalBeds = -1;

  port.waitForNearbyCraftingTable = async () => undefined;
  port.navigateTo = async () => undefined;
  port.isShelterReadyForSpawn = () => false;
  port.isShelterBuilt = () => true;
  port.hasPlacedShelterDoor = () => true;
  port.ensureBedsCraftable = async () => undefined;
  port.countAccessiblePlacedBeds = () => 0;
  port.craftAdditionalBeds = async (_rallyPoint: unknown, additionalBeds: number) => {
    craftedAdditionalBeds = additionalBeds;
    return additionalBeds;
  };
  port.buildShelter = async () => undefined;
  port.placeBedsUntilShelterCapacity = async () => undefined;
  port.sleepUntilSpawnIsSet = async () => undefined;

  await port.establishAtRallyPoint(rallyPoint);

  assert.equal(craftedAdditionalBeds, 2);
});

test('MineflayerMicroBasePort counts bed items already in inventory before expanding shelter capacity', async () => {
  const port = createPort([{ name: 'white_bed', count: 1 }]) as any;
  let gatheredBedTarget = -1;
  let craftedAdditionalBeds = -1;

  port.waitForNearbyCraftingTable = async () => undefined;
  port.countAccessiblePlacedBeds = () => 1;
  port.ensureBedsCraftable = async (_rallyPoint: unknown, targetBeds: number) => {
    gatheredBedTarget = targetBeds;
  };
  port.ensurePlanksAvailable = async () => undefined;
  port.craftAdditionalBeds = async (_rallyPoint: unknown, additionalBeds: number) => {
    craftedAdditionalBeds = additionalBeds;
    return additionalBeds;
  };
  port.placeBedsUntilShelterCapacity = async () => undefined;
  port.sleepUntilSpawnIsSet = async () => undefined;

  await port.expandShelterSleepingCapacityAfterMissedNight(rallyPoint);

  assert.equal(gatheredBedTarget, 2);
  assert.equal(craftedAdditionalBeds, 1);
});

test('MineflayerMicroBasePort clears the bed footprint and the required stand position before placing a bed', async () => {
  const airBlock = { name: 'air', boundingBox: 'empty' };
  const floorBlock = { name: 'dark_oak_planks', boundingBox: 'block' };
  const port = createPort([{ name: 'white_bed', count: 1 }]) as any;
  const clearedPositions: string[] = [];

  port.bot.blockAt = (position: Vec3) => {
    if (position.y === 63) {
      return floorBlock;
    }

    if (position.y === 64 || position.y === 65) {
      return airBlock;
    }

    return airBlock;
  };
  port.requestFriendlyBotsToClearPosition = async (position: Vec3) => {
    clearedPositions.push(`${position.x},${position.y},${position.z}`);
  };
  port.findInventoryItem = () => ({ name: 'white_bed', count: 1 });
  port.placeBlockFromInventory = async () => undefined;

  await port.placeBed(new Vec3(213, 64, -79), rallyPoint);

  assert.deepEqual([...new Set(clearedPositions)], [
    '213,64,-79',
    '214,64,-79',
    '212,64,-79',
  ]);
});

test('MineflayerMicroBasePort skips shelter construction when the structure and door already exist', async () => {
  const port = createPort([
    { name: 'white_bed', count: 3 },
  ]) as any;
  let buildShelterCalls = 0;

  port.waitForNearbyCraftingTable = async () => undefined;
  port.navigateTo = async () => undefined;
  port.isShelterReadyForSpawn = () => false;
  port.isShelterBuilt = () => true;
  port.hasPlacedShelterDoor = () => true;
  port.ensureBedsCraftable = async () => undefined;
  port.countAccessiblePlacedBeds = () => 0;
  port.buildShelter = async () => {
    buildShelterCalls += 1;
  };
  port.placeBedsUntilShelterCapacity = async () => undefined;
  port.sleepUntilSpawnIsSet = async () => undefined;

  await port.establishAtRallyPoint(rallyPoint);

  assert.equal(buildShelterCalls, 0);
});
