import { Block } from 'prismarine-block';
import { Entity } from 'prismarine-entity';
import { Item } from 'prismarine-item';
import { Vec3 } from 'vec3';
import { MicroBasePort } from '../../application/bot/ports/MicroBasePort';
import { Logger } from '../../application/shared/ports/Logger';
import { BotRallyPoint } from '../../domain/bot/entities/BotConfiguration';
import { MineflayerLogHarvestingPort } from './MineflayerLogHarvestingPort';
import { MineflayerNearbyDroppedItemCollector } from './MineflayerNearbyDroppedItemCollector';
import { BotWithPathfinder } from './MineflayerPortsShared';

const LOG_TO_PLANK_ITEM = new Map<string, string>([
  ['oak_log', 'oak_planks'],
  ['spruce_log', 'spruce_planks'],
  ['birch_log', 'birch_planks'],
  ['jungle_log', 'jungle_planks'],
  ['acacia_log', 'acacia_planks'],
  ['dark_oak_log', 'dark_oak_planks'],
  ['mangrove_log', 'mangrove_planks'],
  ['cherry_log', 'cherry_planks'],
  ['pale_oak_log', 'pale_oak_planks'],
  ['crimson_stem', 'crimson_planks'],
  ['warped_stem', 'warped_planks'],
]);

const WOOL_TO_BED_ITEM = new Map<string, string>([
  ['white_wool', 'white_bed'],
  ['orange_wool', 'orange_bed'],
  ['magenta_wool', 'magenta_bed'],
  ['light_blue_wool', 'light_blue_bed'],
  ['yellow_wool', 'yellow_bed'],
  ['lime_wool', 'lime_bed'],
  ['pink_wool', 'pink_bed'],
  ['gray_wool', 'gray_bed'],
  ['light_gray_wool', 'light_gray_bed'],
  ['cyan_wool', 'cyan_bed'],
  ['purple_wool', 'purple_bed'],
  ['blue_wool', 'blue_bed'],
  ['brown_wool', 'brown_bed'],
  ['green_wool', 'green_bed'],
  ['red_wool', 'red_bed'],
  ['black_wool', 'black_bed'],
]);

const PLANK_TO_DOOR_ITEM = new Map<string, string>([
  ['oak_planks', 'oak_door'],
  ['spruce_planks', 'spruce_door'],
  ['birch_planks', 'birch_door'],
  ['jungle_planks', 'jungle_door'],
  ['acacia_planks', 'acacia_door'],
  ['dark_oak_planks', 'dark_oak_door'],
  ['mangrove_planks', 'mangrove_door'],
  ['cherry_planks', 'cherry_door'],
  ['pale_oak_planks', 'pale_oak_door'],
  ['crimson_planks', 'crimson_door'],
  ['warped_planks', 'warped_door'],
]);

const PLANK_ITEM_NAMES = [...PLANK_TO_DOOR_ITEM.keys()];
const BED_ITEM_NAMES = [...WOOL_TO_BED_ITEM.values()];
const BED_BLOCK_NAMES = new Set([...BED_ITEM_NAMES, 'bed']);

export class MicroBaseScenarioCancelledError extends Error {
  constructor() {
    super('Micro-base scenario was cancelled.');
  }
}

export class MineflayerMicroBasePort implements MicroBasePort {
  private readonly craftingTableSearchRadius = 4;
  private readonly sheepSearchRadius = 64;
  private readonly sheepPickupRange = 6;
  private readonly sheepSearchStepDistance = 12;
  private readonly sheepSearchPauseTicks = 10;
  private readonly woodTargetPlanks = 72;
  private readonly houseWidth = 5;
  private readonly houseLength = 5;
  private readonly wallHeight = 2;

  constructor(
    private readonly bot: BotWithPathfinder,
    private readonly logger: Logger,
    private readonly gotoPosition: (target: Vec3, range: number) => Promise<void>,
    private readonly logHarvestingPort: MineflayerLogHarvestingPort,
    private readonly nearbyDroppedItemCollector: MineflayerNearbyDroppedItemCollector,
    private readonly isScenarioActive: () => boolean,
    private readonly waitUntilTaskMayProceed: () => Promise<void>,
    private readonly isThreatResponseActive: () => boolean,
  ) {}

  async ensureWoodenSwordNearRallyPoint(rallyPoint: BotRallyPoint): Promise<void> {
    this.ensureScenarioActive();
    if (this.findInventoryItem('wooden_sword')) {
      return;
    }

    await this.waitForNearbyCraftingTable(rallyPoint);
    await this.ensurePlanksAvailable(4);

    if (!this.findInventoryItem('stick')) {
      const craftedStick = await this.craftSingleItem('stick', null);

      if (!craftedStick) {
        throw this.createMissingThingError('палочки для деревянного меча');
      }
    }

    const craftingTable = this.requireNearbyCraftingTable(rallyPoint);
    const craftedSword = await this.craftSingleItem('wooden_sword', craftingTable, rallyPoint);

    if (!craftedSword) {
      throw this.createMissingThingError('деревянный меч');
    }

    this.logger.info('Crafted a wooden sword for squad defense.');
  }

  async establishAtRallyPoint(rallyPoint: BotRallyPoint): Promise<void> {
    this.ensureScenarioActive();
    await this.waitForTaskPriority();
    await this.waitForNearbyCraftingTable(rallyPoint);
    await this.ensureBedsCraftable(rallyPoint, 3);
    await this.ensurePlanksAvailable(this.woodTargetPlanks);

    const craftedBeds = await this.craftBeds(rallyPoint, 3);

    if (craftedBeds < 3) {
      throw this.createMissingThingError('три кровати');
    }

    await this.ensureDoorCrafted(rallyPoint);
    await this.buildShelter(rallyPoint);
    await this.placeThreeBeds(rallyPoint);
    await this.sleepUntilSpawnIsSet(rallyPoint);
  }

  async supportLeader(leaderUsername: string, rallyPoint: BotRallyPoint): Promise<void> {
    this.ensureScenarioActive();
    while (!this.bot.isSleeping) {
      this.ensureScenarioActive();
      await this.waitForTaskPriority();
      if (this.countPlacedBedBlocksNearRallyPoint(rallyPoint) >= 6) {
        await this.sleepUntilSpawnIsSet(rallyPoint);
        return;
      }

      const leader = this.findLeaderEntity(leaderUsername);

      if (leader) {
        await this.followLeader(leader);
      } else {
        await this.gotoPosition(this.toVec3(rallyPoint), 2).catch(() => undefined);
      }

      await this.bot.waitForTicks(20);
    }
  }

  private async ensureBedsCraftable(rallyPoint: BotRallyPoint, targetBeds: number): Promise<void> {
    while (this.countInventoryBeds() + this.countCraftableBeds() < targetBeds) {
      this.ensureScenarioActive();
      await this.waitForTaskPriority();
      const sheep = await this.findNearestSheepOrSearchAroundRallyPoint(rallyPoint);

      if (!sheep) {
        throw this.createMissingThingError('овцу даже после обхода вокруг точки сбора');
      }

      this.logger.info(
        `Hunting sheep at ${sheep.position.x.toFixed(1)} ${sheep.position.y.toFixed(1)} ${sheep.position.z.toFixed(1)} for bed wool.`,
      );

      await this.huntSheep(sheep);
      await this.nearbyDroppedItemCollector.collectAround(sheep.position, this.sheepPickupRange, 3);
      await this.bot.waitForTicks(10);
      await this.waitForNearbyCraftingTable(rallyPoint);
    }
  }

  private async ensurePlanksAvailable(minPlanks: number): Promise<void> {
    await this.craftAllInventoryLogsIntoPlanks();

    for (let attempt = 0; this.countTotalPlanks() < minPlanks; attempt += 1) {
      this.ensureScenarioActive();
      await this.waitForTaskPriority();
      if (attempt >= 24) {
        throw this.createMissingThingError(`достаточно брёвен для ${minPlanks} досок`);
      }

      this.logger.info(`Need at least ${minPlanks} planks. Gathering another log.`);
      await this.logHarvestingPort.gatherNearestLog();
      await this.craftAllInventoryLogsIntoPlanks();
    }
  }

  private async craftAllInventoryLogsIntoPlanks(): Promise<void> {
    let craftedAny = false;

    while (true) {
      this.ensureScenarioActive();
      await this.waitForTaskPriority();
      let craftedDuringPass = false;

      for (const [logItemName, plankItemName] of LOG_TO_PLANK_ITEM.entries()) {
        while (this.countItem(logItemName) > 0) {
          const crafted = await this.craftSingleItem(plankItemName, null);

          if (!crafted) {
            break;
          }

          craftedAny = true;
          craftedDuringPass = true;
        }
      }

      if (!craftedDuringPass) {
        if (craftedAny) {
          this.logger.info(`Converted logs to planks. Planks available: ${this.countTotalPlanks()}.`);
        }

        return;
      }
    }
  }

  private async ensureDoorCrafted(rallyPoint: BotRallyPoint): Promise<void> {
    if (this.findAnyInventoryDoor()) {
      return;
    }

    const craftingTable = this.requireNearbyCraftingTable(rallyPoint);

    for (const [plankName, doorName] of PLANK_TO_DOOR_ITEM.entries()) {
      if (this.countItem(plankName) < 6) {
        continue;
      }

      const craftedDoor = await this.craftSingleItem(doorName, craftingTable, rallyPoint);

      if (craftedDoor) {
        this.logger.info(`Crafted a ${doorName} for the shelter entrance.`);
        return;
      }
    }

    throw this.createMissingThingError('деревянную дверь');
  }

  private async craftBeds(rallyPoint: BotRallyPoint, targetBeds: number): Promise<number> {
    const craftingTable = this.requireNearbyCraftingTable(rallyPoint);

    for (const [woolName, bedName] of WOOL_TO_BED_ITEM.entries()) {
      while (this.countInventoryBeds() < targetBeds && this.countItem(woolName) >= 3) {
        const crafted = await this.craftSingleItem(bedName, craftingTable, rallyPoint);

        if (!crafted) {
          break;
        }
      }
    }

    return this.countInventoryBeds();
  }

  private async huntSheep(sheep: Entity): Promise<void> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      this.ensureScenarioActive();
      await this.waitForTaskPriority();
      if (!sheep.isValid) {
        return;
      }

      if (!this.bot.entity) {
        throw new Error('Bot entity is unavailable while hunting sheep.');
      }

      const distance = this.bot.entity.position.distanceTo(sheep.position);

      if (distance > 3) {
        await this.navigateTo(sheep.position, 2);
      }

      if (!sheep.isValid) {
        return;
      }

      await this.bot.lookAt(sheep.position.offset(0, Math.max(sheep.height / 2, 0.5), 0), true);
      this.bot.attack(sheep);
      await this.bot.waitForTicks(12);
    }

    if (sheep.isValid) {
      throw new Error('Не получилось добить овцу после нескольких попыток.');
    }
  }

  private async followLeader(leader: Entity): Promise<void> {
    this.ensureScenarioActive();
    if (!this.bot.entity) {
      return;
    }

    const distance = this.bot.entity.position.distanceTo(leader.position);

    if (distance <= 4) {
      await this.bot.lookAt(leader.position.offset(0, Math.max(leader.height / 2, 0.5), 0), true).catch(() => undefined);
      return;
    }

    await this.navigateTo(leader.position, 2).catch((error) => {
      if (error instanceof MicroBaseScenarioCancelledError) {
        throw error;
      }
    });
  }

  private async buildShelter(rallyPoint: BotRallyPoint): Promise<void> {
    this.ensureScenarioActive();
    await this.waitForTaskPriority();
    const origin = new Vec3(rallyPoint.x - 2, rallyPoint.y, rallyPoint.z - 2);

    this.logger.info(
      `Building a primitive shelter near ${rallyPoint.x} ${rallyPoint.y} ${rallyPoint.z}.`,
    );

    for (let y = 0; y < this.wallHeight; y += 1) {
      for (let x = 0; x < this.houseWidth; x += 1) {
        for (let z = 0; z < this.houseLength; z += 1) {
          const isPerimeter =
            x === 0 || x === this.houseWidth - 1 || z === 0 || z === this.houseLength - 1;

          if (!isPerimeter) {
            continue;
          }

          const isDoorOpening = x === Math.floor(this.houseWidth / 2) && z === this.houseLength - 1;

          if (isDoorOpening) {
            continue;
          }

          await this.placePlankBlock(origin.offset(x, y, z));
        }
      }
    }

    for (let x = 0; x < this.houseWidth; x += 1) {
      for (let z = 0; z < this.houseLength; z += 1) {
        await this.placePlankBlock(origin.offset(x, this.wallHeight, z));
      }
    }

    const doorPosition = origin.offset(Math.floor(this.houseWidth / 2), 0, this.houseLength - 1);
    await this.placeDoor(doorPosition);
    this.logger.info('Finished building the primitive shelter.');
  }

  private async placeThreeBeds(rallyPoint: BotRallyPoint): Promise<void> {
    this.ensureScenarioActive();
    await this.waitForTaskPriority();
    if (this.countPlacedBedBlocksNearRallyPoint(rallyPoint) >= 6) {
      return;
    }

    const origin = new Vec3(rallyPoint.x - 2, rallyPoint.y, rallyPoint.z - 2);
    const bedPositions = [origin.offset(1, 0, 3), origin.offset(2, 0, 3), origin.offset(3, 0, 3)];

    for (const position of bedPositions) {
      await this.placeBed(position);
    }

    this.logger.info('Placed three beds inside the shelter.');
  }

  private async placeBed(position: Vec3): Promise<void> {
    for (const bedName of BED_ITEM_NAMES) {
      const bedItem = this.findInventoryItem(bedName);

      if (!bedItem) {
        continue;
      }

      for (const yaw of [0, Math.PI]) {
        try {
          await this.placeBlockFromInventory(position, bedItem, new Set(BED_BLOCK_NAMES), yaw);
          return;
        } catch {
          continue;
        }
      }
    }

    throw this.createMissingThingError(`место для кровати в точке ${position.x} ${position.y} ${position.z}`);
  }

  private async placeDoor(position: Vec3): Promise<void> {
    const doorItem = this.findAnyInventoryDoor();

    if (!doorItem) {
      throw this.createMissingThingError('деревянную дверь в инвентаре');
    }

    await this.placeBlockFromInventory(position, doorItem, new Set([doorItem.name]), Math.PI);
  }

  private async placePlankBlock(position: Vec3): Promise<void> {
    const plankItem = this.findAnyInventoryPlank();

    if (!plankItem) {
      throw this.createMissingThingError('доски в инвентаре');
    }

    await this.placeBlockFromInventory(position, plankItem, new Set(PLANK_ITEM_NAMES));
  }

  private async placeBlockFromInventory(
    position: Vec3,
    item: Item,
    allowedExistingBlockNames: ReadonlySet<string>,
    yaw?: number,
  ): Promise<void> {
    this.ensureScenarioActive();
    await this.waitForTaskPriority();
    const currentBlock = this.bot.blockAt(position);

    if (currentBlock && allowedExistingBlockNames.has(currentBlock.name)) {
      return;
    }

    await this.prepareTargetBlock(position);
    const placement = this.findPlacementReference(position);

    if (!placement) {
      throw this.createMissingThingError(`опору для установки блока в точке ${position.x} ${position.y} ${position.z}`);
    }

    await this.bot.equip(item, 'hand');
    await this.navigateTo(placement.referenceBlock.position, 2);

    if (yaw !== undefined) {
      await this.bot.look(yaw, 0, true);
    } else {
      await this.bot.lookAt(position.offset(0.5, 0.5, 0.5), true);
    }

    await this.bot.placeBlock(placement.referenceBlock, placement.faceVector);
    await this.bot.waitForTicks(5);
  }

  private findPlacementReference(position: Vec3): { referenceBlock: Block; faceVector: Vec3 } | null {
    const candidates = [
      new Vec3(0, -1, 0),
      new Vec3(1, 0, 0),
      new Vec3(-1, 0, 0),
      new Vec3(0, 0, 1),
      new Vec3(0, 0, -1),
      new Vec3(0, 1, 0),
    ];

    for (const faceVector of candidates) {
      const referenceBlock = this.bot.blockAt(position.minus(faceVector));

      if (!referenceBlock || referenceBlock.boundingBox !== 'block') {
        continue;
      }

      return { referenceBlock, faceVector };
    }

    return null;
  }

  private async prepareTargetBlock(position: Vec3): Promise<void> {
    const block = this.bot.blockAt(position);

    if (!block || block.name === 'air') {
      return;
    }

    if (block.boundingBox === 'empty' && block.diggable) {
      await this.bot.dig(block, true);
      await this.bot.waitForTicks(5);
      return;
    }

    throw new Error(`Block ${block.name} already occupies ${position.x} ${position.y} ${position.z}.`);
  }

  private async sleepUntilSpawnIsSet(rallyPoint: BotRallyPoint): Promise<void> {
    while (!this.bot.isSleeping) {
      this.ensureScenarioActive();
      await this.waitForTaskPriority();
      const beds = this.findPlacedBedsNearRallyPoint(rallyPoint);

      if (beds.length === 0) {
        throw this.createMissingThingError('кровать рядом с точкой сбора');
      }

      if (!this.isSleepWindow()) {
        await this.bot.waitForTicks(100);
        continue;
      }

      for (const bed of beds) {
        try {
          await this.navigateTo(bed.position, 2);
          await this.bot.sleep(bed);
          this.logger.info(
            `Sleeping in a bed at ${bed.position.x} ${bed.position.y} ${bed.position.z} to set the spawn point.`,
          );
          return;
        } catch (error) {
          this.logger.warn(`Could not sleep in a nearby bed yet: ${this.stringifyError(error)}.`);
        }
      }

      await this.bot.waitForTicks(40);
    }
  }

  private isSleepWindow(): boolean {
    return !this.bot.time.isDay || this.bot.thunderState > 0;
  }

  private findNearestSheep(): Entity | null {
    return this.bot.nearestEntity((entity) => {
      return (
        entity.name === 'sheep' &&
        this.bot.entity.position.distanceTo(entity.position) <= this.sheepSearchRadius
      );
    });
  }

  private async findNearestSheepOrSearchAroundRallyPoint(rallyPoint: BotRallyPoint): Promise<Entity | null> {
    this.ensureScenarioActive();
    await this.waitForTaskPriority();
    const nearbySheep = this.findNearestSheep();

    if (nearbySheep) {
      return nearbySheep;
    }

    this.logger.info('No sheep are visible nearby. Searching around the rally point.');

    for (const searchPoint of this.getSheepSearchPoints(rallyPoint)) {
      this.ensureScenarioActive();
      try {
        this.logger.info(
          `Searching for sheep near ${searchPoint.x} ${searchPoint.y} ${searchPoint.z}.`,
        );
        await this.navigateTo(searchPoint, 3);
      } catch (error) {
        if (error instanceof MicroBaseScenarioCancelledError) {
          throw error;
        }

        this.logger.warn(
          `Could not inspect sheep-search point ${searchPoint.x} ${searchPoint.y} ${searchPoint.z}: ${this.stringifyError(error)}.`,
        );
        continue;
      }

      await this.bot.waitForTicks(this.sheepSearchPauseTicks);
      const sheep = this.findNearestSheep();

      if (sheep) {
        this.logger.info(
          `Found a sheep near ${sheep.position.x.toFixed(1)} ${sheep.position.y.toFixed(1)} ${sheep.position.z.toFixed(1)} during the search route.`,
        );
        return sheep;
      }
    }

    return null;
  }

  private getSheepSearchPoints(rallyPoint: BotRallyPoint): Vec3[] {
    const searchPoints: Vec3[] = [];
    const seen = new Set<string>();

    for (
      let distance = this.sheepSearchStepDistance;
      distance <= this.sheepSearchRadius;
      distance += this.sheepSearchStepDistance
    ) {
      for (let offset = -distance; offset <= distance; offset += this.sheepSearchStepDistance) {
        const perimeterOffsets: Array<[number, number]> = [
          [offset, -distance],
          [offset, distance],
          [-distance, offset],
          [distance, offset],
        ];

        for (const [dx, dz] of perimeterOffsets) {
          const point = new Vec3(rallyPoint.x + dx, rallyPoint.y, rallyPoint.z + dz);
          const key = `${point.x}:${point.y}:${point.z}`;

          if (seen.has(key)) {
            continue;
          }

          seen.add(key);
          searchPoints.push(point);
        }
      }
    }

    return searchPoints;
  }

  private findLeaderEntity(leaderUsername: string): Entity | null {
    return this.bot.players[leaderUsername]?.entity ?? null;
  }

  private waitForNearbyCraftingTable(rallyPoint: BotRallyPoint): Promise<void> {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + 30000;

      const intervalId = setInterval(() => {
        if (this.findNearbyCraftingTable(rallyPoint)) {
          cleanup();
          resolve();
          return;
        }

        if (Date.now() >= deadline) {
          cleanup();
          reject(this.createMissingThingError('верстак рядом с точкой сбора'));
        }
      }, 500);

      const cleanup = () => {
        clearInterval(intervalId);
      };
    });
  }

  private requireNearbyCraftingTable(rallyPoint: BotRallyPoint): Block {
    const craftingTable = this.findNearbyCraftingTable(rallyPoint);

    if (!craftingTable) {
      throw this.createMissingThingError('верстак рядом с точкой сбора');
    }

    return craftingTable;
  }

  private findNearbyCraftingTable(rallyPoint: BotRallyPoint): Block | null {
    const craftingTableId = this.bot.registry.blocksByName.crafting_table?.id;

    if (craftingTableId === undefined) {
      return null;
    }

    return this.bot.findBlock({
      matching: craftingTableId,
      maxDistance: this.craftingTableSearchRadius,
      point: this.toVec3(rallyPoint),
    });
  }

  private findPlacedBedsNearRallyPoint(rallyPoint: BotRallyPoint): Block[] {
    const center = this.toVec3(rallyPoint);
    const beds: Block[] = [];

    for (let dx = -4; dx <= 4; dx += 1) {
      for (let dy = -1; dy <= 2; dy += 1) {
        for (let dz = -4; dz <= 4; dz += 1) {
          const block = this.bot.blockAt(center.offset(dx, dy, dz));

          if (!block || !BED_BLOCK_NAMES.has(block.name)) {
            continue;
          }

          beds.push(block);
        }
      }
    }

    return beds;
  }

  private countPlacedBedBlocksNearRallyPoint(rallyPoint: BotRallyPoint): number {
    return this.findPlacedBedsNearRallyPoint(rallyPoint).length;
  }

  private countCraftableBeds(): number {
    let craftableBeds = 0;

    for (const woolName of WOOL_TO_BED_ITEM.keys()) {
      craftableBeds += Math.floor(this.countItem(woolName) / 3);
    }

    return craftableBeds;
  }

  private countInventoryBeds(): number {
    return this.bot.inventory
      .items()
      .filter((item) => BED_ITEM_NAMES.includes(item.name))
      .reduce((total, item) => total + item.count, 0);
  }

  private countTotalPlanks(): number {
    return this.bot.inventory
      .items()
      .filter((item) => PLANK_ITEM_NAMES.includes(item.name))
      .reduce((total, item) => total + item.count, 0);
  }

  private countItem(itemName: string): number {
    return this.bot.inventory
      .items()
      .filter((item) => item.name === itemName)
      .reduce((total, item) => total + item.count, 0);
  }

  private findAnyInventoryPlank(): Item | undefined {
    return this.bot.inventory.items().find((item) => PLANK_ITEM_NAMES.includes(item.name));
  }

  private findAnyInventoryDoor(): Item | undefined {
    return this.bot.inventory.items().find((item) => item.name.endsWith('_door'));
  }

  private findInventoryItem(itemName: string): Item | undefined {
    return this.bot.inventory.items().find((item) => item.name === itemName);
  }

  private async craftSingleItem(
    itemName: string,
    craftingTable: Block | null,
    rallyPoint?: BotRallyPoint,
  ): Promise<boolean> {
    this.ensureScenarioActive();
    await this.waitForTaskPriority();
    const itemId = this.bot.registry.itemsByName[itemName]?.id;

    if (itemId === undefined) {
      throw new Error(`Item id for "${itemName}" is unavailable in the current registry.`);
    }

    const craftingTarget =
      craftingTable && rallyPoint ? await this.prepareCraftingTableForUse(rallyPoint) : craftingTable;
    const recipe = this.bot.recipesFor(itemId, null, 1, craftingTarget)[0];

    if (!recipe) {
      return false;
    }

    await this.bot.craft(recipe, 1, craftingTarget ?? undefined);
    return true;
  }

  private async prepareCraftingTableForUse(rallyPoint: BotRallyPoint): Promise<Block> {
    await this.navigateTo(this.toVec3(rallyPoint), 2);

    const craftingTable = this.requireNearbyCraftingTable(rallyPoint);
    await this.navigateTo(craftingTable.position, 2);

    return this.requireNearbyCraftingTable(rallyPoint);
  }

  private toVec3(rallyPoint: BotRallyPoint): Vec3 {
    return new Vec3(rallyPoint.x, rallyPoint.y, rallyPoint.z);
  }

  private stringifyError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }

  private createMissingThingError(thing: string): Error {
    return new Error(`Ой, не могу найти ${thing}.`);
  }

  private ensureScenarioActive(): void {
    if (!this.isScenarioActive()) {
      throw new MicroBaseScenarioCancelledError();
    }
  }

  private async navigateTo(target: Vec3, range: number): Promise<void> {
    while (true) {
      this.ensureScenarioActive();
      await this.waitForTaskPriority();

      try {
        await this.gotoPosition(target, range);
        this.ensureScenarioActive();
        return;
      } catch (error) {
        if (!this.isScenarioActive()) {
          throw new MicroBaseScenarioCancelledError();
        }

        if (this.isThreatResponseActive() && this.isRetryablePriorityInterruption(error)) {
          this.logger.info(
            `Pausing the current task because combat has higher priority: ${this.stringifyError(error)}.`,
          );
          await this.waitForTaskPriority();
          continue;
        }

        throw error;
      }
    }
  }

  private async waitForTaskPriority(): Promise<void> {
    this.ensureScenarioActive();
    await this.waitUntilTaskMayProceed();
    this.ensureScenarioActive();
  }

  private isRetryablePriorityInterruption(error: unknown): boolean {
    const message = this.stringifyError(error).toLowerCase();

    return (
      message.includes('goal changed') ||
      message.includes('path was stopped') ||
      message.includes('path stopped before it could be completed')
    );
  }
}
