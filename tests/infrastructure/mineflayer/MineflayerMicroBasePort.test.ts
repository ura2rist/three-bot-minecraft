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

test('MineflayerMicroBasePort reuses an existing shelter instead of restarting the bootstrap flow', async () => {
  const port = createPort([]) as any;
  let sleepUntilSpawnIsSetCalls = 0;

  port.isShelterReadyForSpawn = () => true;
  port.sleepUntilSpawnIsSet = async () => {
    sleepUntilSpawnIsSetCalls += 1;
  };

  const resumed = await port.resumeExistingShelterIfReady(rallyPoint);

  assert.equal(resumed, true);
  assert.equal(sleepUntilSpawnIsSetCalls, 1);
});

test('MineflayerMicroBasePort closes the shelter door right before sleeping for the night', async () => {
  const bed = {
    position: new Vec3(213, 64, -79),
    getProperties: () => ({ occupied: false }),
  };
  const port = createPort([]) as any;
  let closeDoorCalls = 0;
  let sleepCalls = 0;

  port.moveInsideShelter = async () => undefined;
  port.getBedSelectionOrder = () => [bed];
  port.isBedOccupied = () => false;
  port.isSleepWindow = () => true;
  port.ensureShelterDoorClosedBeforeSleeping = async () => {
    closeDoorCalls += 1;
  };
  port.navigateTo = async () => undefined;
  port.bot.sleep = async () => {
    sleepCalls += 1;
    port.bot.isSleeping = true;
  };

  const slept = await port.sleepInShelterForTheNight(rallyPoint);

  assert.equal(slept, true);
  assert.equal(closeDoorCalls, 1);
  assert.equal(sleepCalls, 1);
});

test('MineflayerMicroBasePort retries entering the shelter when another bot closes the door too early', async () => {
  const port = createPort([]) as any;
  let openDoorCalls = 0;
  let stepTowardsCalls = 0;
  let inside = false;

  port.getShelterDoorPosition = () => new Vec3(215, 64, -80);
  port.getShelterInteriorAnchor = () => new Vec3(215, 64, -78);
  port.getDoorApproachPositions = () => [new Vec3(215, 64, -81)];
  port.isPassableStandPosition = () => true;
  port.isInsideShelterArea = () => false;
  port.isBotInsideShelter = () => inside;
  port.navigateTo = async (_target: Vec3, range: number) => {
    if (range === 1 && openDoorCalls >= 2) {
      inside = true;
    }
  };
  port.openShelterDoorIfNeeded = async () => {
    openDoorCalls += 1;
  };
  port.stepTowards = async () => {
    stepTowardsCalls += 1;
  };
  port.bot.waitForTicks = async () => undefined;

  await port.enterShelterThroughDoor(rallyPoint, false);

  assert.equal(openDoorCalls, 2);
  assert.equal(stepTowardsCalls, 2);
});

test('MineflayerMicroBasePort schedules a delayed shelter-door close after entry', async () => {
  const port = createPort([]) as any;
  let closeDoorCalls = 0;
  const waitedTicks: number[] = [];

  port.bot.waitForTicks = async (ticks: number) => {
    waitedTicks.push(ticks);
  };
  port.isBotInsideShelter = () => true;
  port.getShelterDoorPosition = () => new Vec3(215, 64, -80);
  port.isShelterDoorOpen = () => true;
  port.closeShelterDoorIfOpen = async () => {
    closeDoorCalls += 1;
  };

  port.scheduleShelterDoorClose(rallyPoint);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(waitedTicks, [300]);
  assert.equal(closeDoorCalls, 1);
});

test('MineflayerMicroBasePort does not interact with a bed through a wall', async () => {
  const port = createPort([]) as any;
  const bed = {
    position: new Vec3(213, 64, -79),
  };

  port.bot.entity = { position: new Vec3(213, 64, -77), height: 1.62 };
  port.bot.world = {
    raycast: () => ({ position: new Vec3(213, 64, -78) }),
  };

  assert.throws(
    () => port.ensureBlockIsInDirectLineOfSight(bed, 'touch a bed to set the spawn point'),
    /direct line of sight/i,
  );
});
