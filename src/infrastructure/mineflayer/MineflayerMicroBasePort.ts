import { Block } from 'prismarine-block';
import { Entity } from 'prismarine-entity';
import { Item } from 'prismarine-item';
import { Vec3 } from 'vec3';
import { MicroBasePort } from '../../application/bot/ports/MicroBasePort';
import { Logger } from '../../application/shared/ports/Logger';
import { BotRallyPoint } from '../../domain/bot/entities/BotConfiguration';
import { BotRole } from '../../domain/bot/entities/BotRole';
import { BedAssignmentService } from '../../application/bot/services/BedAssignmentService';
import { MineflayerLogHarvestingPort } from './MineflayerLogHarvestingPort';
import { MineflayerNearbyDroppedItemCollector } from './MineflayerNearbyDroppedItemCollector';
import { MineflayerCombatService } from './MineflayerCombatService';
import { BotWithPathfinder } from './MineflayerPortsShared';
import { BlockPosition, ShelterLayoutService } from '../../application/bot/services/ShelterLayoutService';

const mineflayerPathfinder = require('../../../.vendor/mineflayer-pathfinder-master');
const GoalPlaceBlock = mineflayerPathfinder.goals.GoalPlaceBlock as new (
  pos: Vec3,
  world: BotWithPathfinder['world'],
  options: {
    range?: number;
    faces?: Vec3[];
    facing?: string;
    facing3D?: boolean;
    half?: 'top' | 'bottom';
    LOS?: boolean;
  },
) => unknown;

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
const DOOR_ITEM_NAMES = [...PLANK_TO_DOOR_ITEM.values()];
const BED_ITEM_NAMES = [...WOOL_TO_BED_ITEM.values()];
const BED_BLOCK_NAMES = new Set([...BED_ITEM_NAMES, 'bed']);

type BedMetadata = {
  part: boolean;
  occupied: boolean;
  headOffset: Vec3;
};

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
  private readonly woodTargetPlanks = 156;
  private readonly houseWidth = 9;
  private readonly houseLength = 6;
  private readonly wallHeight = 3;
  private readonly blockPlacementAttempts = 3;
  private readonly blockPlacementRange = 4.5;
  private readonly woodenSwordCraftAttempts = 4;
  private readonly maxConsecutivePlankGatherStalls = 6;
  private readonly buildingMaterialRestockPlanks = 12;
  private readonly roofAccessStepZ = 1;
  private readonly shelterLayout: ShelterLayoutService;
  private readonly bedAssignmentService = new BedAssignmentService();

  constructor(
    private readonly bot: BotWithPathfinder,
    private readonly botRole: BotRole,
    private readonly logger: Logger,
    private readonly gotoPosition: (target: Vec3, range: number) => Promise<void>,
    private readonly logHarvestingPort: MineflayerLogHarvestingPort,
    private readonly nearbyDroppedItemCollector: MineflayerNearbyDroppedItemCollector,
    private readonly combatService: MineflayerCombatService,
    private readonly requestFriendlyBotsToClearPosition: (
      position: Vec3,
      minimumDistance: number,
    ) => Promise<void>,
    private readonly isScenarioActive: () => boolean,
    private readonly waitUntilTaskMayProceed: () => Promise<void>,
    private readonly isThreatResponseActive: () => boolean,
  ) {
    this.shelterLayout = new ShelterLayoutService({
      width: this.houseWidth,
      length: this.houseLength,
      wallHeight: this.wallHeight,
      roofAccessStepZ: this.roofAccessStepZ,
    });
  }

  async ensureWoodenSwordNearRallyPoint(rallyPoint: BotRallyPoint): Promise<void> {
    this.ensureScenarioActive();
    if (this.findInventoryItem('wooden_sword')) {
      return;
    }

    for (let attempt = 1; attempt <= this.woodenSwordCraftAttempts; attempt += 1) {
      await this.waitForNearbyCraftingTable(rallyPoint);
      await this.ensurePlanksAvailable(attempt === 1 ? 4 : 6);

      if (!this.findInventoryItem('stick')) {
        const craftedStick = await this.craftSingleItem('stick', null);

        if (!craftedStick) {
          if (attempt >= this.woodenSwordCraftAttempts) {
            throw this.createMissingThingError('палочки для деревянного меча');
          }

          this.logger.warn(
            `Could not craft sticks for a wooden sword on attempt ${attempt}/${this.woodenSwordCraftAttempts}. Gathering more wood and retrying.`,
          );
          await this.ensurePlanksAvailable(Math.max(6, this.countTotalPlanks() + 4));
          continue;
        }
      }

      const craftingTable = this.requireNearbyCraftingTable(rallyPoint);
      const craftedSword = await this.craftSingleItem('wooden_sword', craftingTable, rallyPoint);

      if (craftedSword || this.findInventoryItem('wooden_sword')) {
        this.logger.info('Crafted a wooden sword for squad defense.');
        return;
      }

      if (attempt >= this.woodenSwordCraftAttempts) {
        break;
      }

      this.logger.warn(
        `Could not craft a wooden sword on attempt ${attempt}/${this.woodenSwordCraftAttempts}. Gathering more wood and retrying.`,
      );
      await this.ensurePlanksAvailable(Math.max(6, this.countTotalPlanks() + 4));
    }

    throw this.createMissingThingError('деревянный меч');
  }

  async establishAtRallyPoint(rallyPoint: BotRallyPoint): Promise<void> {
    this.ensureScenarioActive();
    await this.waitForTaskPriority();
    await this.waitForNearbyCraftingTable(rallyPoint);

    if (this.isShelterReadyForSpawn(rallyPoint)) {
      this.logger.info('Shelter and placed beds already exist near the rally point. Proceeding directly to the sleeping phase.');
      await this.sleepUntilSpawnIsSet(rallyPoint);
      return;
    }

    await this.ensureBedsCraftable(rallyPoint, 3);
    this.logger.info('Collected enough wool for three beds. Returning to the rally point for the building phase.');
    await this.navigateTo(this.toVec3(rallyPoint), 2);
    await this.waitForNearbyCraftingTable(rallyPoint);

    if (!this.isShelterBuilt(rallyPoint)) {
      this.logger.info(
        `Gathering wood for the shelter and the remaining bed materials. Target planks: ${this.woodTargetPlanks}.`,
      );
      await this.ensurePlanksAvailable(this.woodTargetPlanks);
    } else {
      this.logger.info('Shelter structure already exists near the rally point. Skipping the bulk wood-gathering phase.');
    }

    const placedBedCount = this.countPlacedBedsNearRallyPoint(rallyPoint);
    const missingBeds = Math.max(0, 3 - placedBedCount);

    if (missingBeds > 0) {
      const craftedBeds = await this.craftBeds(rallyPoint, missingBeds);

      if (craftedBeds < missingBeds) {
        throw this.createMissingThingError('кровати для дома');
      }

      this.logger.info(`Crafted ${craftedBeds} bed item(s). Proceeding to the shelter construction phase.`);
    } else {
      this.logger.info('Three beds are already placed near the rally point. Skipping bed crafting.');
    }

    if (!this.hasPlacedShelterDoor(rallyPoint)) {
      await this.ensureDoorCrafted(rallyPoint);
    } else {
      this.logger.info('Shelter entrance already has a door. Skipping door crafting.');
    }

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
      this.logger.info(
        `Wool progress: ${this.countTotalWool()} wool item(s), ${this.countCraftableBeds()} craftable bed(s) out of ${targetBeds}.`,
      );
      await this.waitForNearbyCraftingTable(rallyPoint);
    }
  }

  private async ensurePlanksAvailable(minPlanks: number): Promise<void> {
    await this.craftAllInventoryLogsIntoPlanks();
    let consecutiveStalls = 0;

    while (this.countTotalPlanks() < minPlanks) {
      this.ensureScenarioActive();
      await this.waitForTaskPriority();
      const planksBeforeGather = this.countTotalPlanks();
      const logsBeforeGather = this.countInventoryLogs();
      this.logger.info(`Need at least ${minPlanks} planks. Gathering another log.`);

      try {
        await this.logHarvestingPort.gatherNearestLog();
      } catch (error) {
        consecutiveStalls += 1;

        if (consecutiveStalls >= this.maxConsecutivePlankGatherStalls) {
          throw this.createMissingThingError(`достаточно брёвен для ${minPlanks} досок`);
        }

        this.logger.warn(
          `Could not gather another log for ${minPlanks} planks yet. Retrying (${consecutiveStalls}/${this.maxConsecutivePlankGatherStalls}): ${this.stringifyError(error)}.`,
        );
        await this.bot.waitForTicks(20);
        continue;
      }

      await this.craftAllInventoryLogsIntoPlanks();

      const planksAfterGather = this.countTotalPlanks();
      const logsAfterGather = this.countInventoryLogs();

      if (planksAfterGather > planksBeforeGather || logsAfterGather > logsBeforeGather) {
        consecutiveStalls = 0;
        continue;
      }

      consecutiveStalls += 1;

      if (consecutiveStalls >= this.maxConsecutivePlankGatherStalls) {
        throw this.createMissingThingError(`достаточно брёвен для ${minPlanks} досок`);
      }

      this.logger.warn(
        `Log gathering did not increase the available wood for ${minPlanks} planks. Retrying with another tree (${consecutiveStalls}/${this.maxConsecutivePlankGatherStalls}).`,
      );
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

      await this.combatService.attackTarget(sheep);
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
    const origin = this.getShelterOrigin(rallyPoint);

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

          const isDoorOpening = this.isShelterDoorOpeningPosition(origin.offset(x, y, z), rallyPoint);

          if (isDoorOpening) {
            continue;
          }

          await this.placePlankBlock(origin.offset(x, y, z), rallyPoint);
        }
      }
    }

    await this.buildRoofFromAbove(rallyPoint, origin);

    await this.placeDoor(this.getShelterDoorPosition(rallyPoint), rallyPoint);
    this.logger.info('Finished building the primitive shelter.');
  }

  private async buildRoofFromAbove(rallyPoint: BotRallyPoint, origin: Vec3): Promise<void> {
    await this.ensureRoofAccess(rallyPoint, origin);
    this.logger.info('Climbing above the shelter to finish the roof.');
    await this.navigateTo(this.getRoofAccessStandingPosition(rallyPoint), 1);

    for (const position of this.getRoofPositions(rallyPoint)) {
      await this.placePlankBlock(position, rallyPoint);
    }
  }

  private async ensureRoofAccess(rallyPoint: BotRallyPoint, origin: Vec3): Promise<void> {
    for (const stepPosition of this.getRoofAccessStepPositions(rallyPoint)) {
      await this.placePlankBlock(stepPosition, rallyPoint);
    }
  }

  private getRoofAccessStepPositions(rallyPoint: BotRallyPoint): Vec3[] {
    return this.shelterLayout
      .getRoofAccessStepPositions(rallyPoint)
      .map((position) => this.toBlockVec3(position));
  }

  private getRoofAccessStandingPosition(rallyPoint: BotRallyPoint): Vec3 {
    return this.toBlockVec3(this.shelterLayout.getRoofAccessStandingPosition(rallyPoint));
  }

  private getRoofPositions(rallyPoint: BotRallyPoint): Vec3[] {
    const roofAccessStandingPosition = this.toBlockVec3(
      this.shelterLayout.getRoofAccessStandingPosition(rallyPoint),
    );

    return this.shelterLayout
      .getRoofPositions(rallyPoint)
      .map((position) => this.toBlockVec3(position))
      .sort((left, right) => {
        const leftDistance = left.distanceSquared(roofAccessStandingPosition);
        const rightDistance = right.distanceSquared(roofAccessStandingPosition);

        return leftDistance - rightDistance;
      });
  }

  private async placeThreeBeds(rallyPoint: BotRallyPoint): Promise<void> {
    this.ensureScenarioActive();
    await this.waitForTaskPriority();
    if (this.hasAllExpectedBedsPlaced(rallyPoint)) {
      return;
    }

    const bedPositions = this.shelterLayout
      .getBedFootPositions(rallyPoint)
      .map((position) => this.toBlockVec3(position));
    await this.moveInsideShelter(rallyPoint);

    for (const position of bedPositions) {
      await this.moveInsideShelter(rallyPoint);
      await this.placeBed(position, rallyPoint);
    }

    this.logger.info('Placed three beds inside the shelter.');
  }

  private async placeBed(position: Vec3, rallyPoint: BotRallyPoint): Promise<void> {
    for (let shelterEntryAttempt = 0; shelterEntryAttempt < 2; shelterEntryAttempt += 1) {
      for (const bedName of BED_ITEM_NAMES) {
        const bedItem = this.findInventoryItem(bedName);

        if (!bedItem) {
          continue;
        }

        for (const yaw of [0, Math.PI]) {
          try {
            await this.placeBlockFromInventory(
              position,
              bedItem,
              new Set(BED_BLOCK_NAMES),
              yaw,
              [new Vec3(0, 1, 0)],
            );
            return;
          } catch {
            continue;
          }
        }
      }

      if (this.isBotInsideShelter(rallyPoint)) {
        break;
      }

      this.logger.info(
        `Bed placement point ${position.x} ${position.y} ${position.z} is still unreachable from outside the shelter. Looking for the door and entering the house before retrying.`,
      );
      await this.enterShelterThroughDoor(rallyPoint);
    }

    throw this.createMissingThingError(`место для кровати в точке ${position.x} ${position.y} ${position.z}`);
  }

  private async placeDoor(position: Vec3, rallyPoint: BotRallyPoint): Promise<void> {
    let doorItem = this.findAnyInventoryDoor();

    if (!doorItem) {
      this.logger.info('Ran out of doors during shelter construction. Crafting another one.');
      await this.ensurePlanksAvailable(Math.max(6, this.countTotalPlanks() + 6));
      await this.ensureDoorCrafted(rallyPoint);
      doorItem = this.findAnyInventoryDoor();
    }

    if (!doorItem) {
      throw this.createMissingThingError('деревянную дверь в инвентаре');
    }

    await this.placeBlockFromInventory(position, doorItem, new Set(DOOR_ITEM_NAMES), Math.PI);
  }

  private async placePlankBlock(position: Vec3, rallyPoint: BotRallyPoint): Promise<void> {
    let plankItem = this.findAnyInventoryPlank();

    if (!plankItem) {
      this.logger.info('Ran out of planks during shelter construction. Gathering more wood before continuing.');
      await this.ensurePlanksAvailable(
        Math.max(this.buildingMaterialRestockPlanks, this.countTotalPlanks() + this.buildingMaterialRestockPlanks),
      );
      plankItem = this.findAnyInventoryPlank();
    }

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
    preferredFaceVectors?: ReadonlyArray<Vec3>,
  ): Promise<void> {
    for (let attempt = 1; attempt <= this.blockPlacementAttempts; attempt += 1) {
      this.ensureScenarioActive();
      await this.waitForTaskPriority();
      await this.requestFriendlyBotsToClearPosition(position, 2);

      if (this.hasAllowedBlockAtPosition(position, allowedExistingBlockNames)) {
        return;
      }

      await this.prepareTargetBlock(position, allowedExistingBlockNames);

      if (this.hasAllowedBlockAtPosition(position, allowedExistingBlockNames)) {
        return;
      }

      const placements = this.findPlacementReferences(position, preferredFaceVectors);

      if (placements.length === 0) {
        if (this.hasAllowedBlockAtPosition(position, allowedExistingBlockNames)) {
          return;
        }

        throw this.createMissingThingError(`опору для установки блока в точке ${position.x} ${position.y} ${position.z}`);
      }

      await this.bot.equip(item, 'hand');
      let retryRequested = false;
      let lastPlacementError: unknown = new Error('Block placement could not be confirmed.');

      for (const placement of placements) {
        try {
          await this.navigateToPlacementPosition(position, placement.faceVector);

          if (yaw !== undefined) {
            await this.bot.look(yaw, 0, true);
          } else {
            await this.bot.lookAt(position.offset(0.5, 0.5, 0.5), true);
          }

          let placementError: unknown;

          try {
            await this.bot.placeBlock(placement.referenceBlock, placement.faceVector);
          } catch (error) {
            placementError = error;
          }

          await this.bot.waitForTicks(5);

          if (this.hasAllowedBlockAtPosition(position, allowedExistingBlockNames)) {
            return;
          }

          if (placementError) {
            lastPlacementError = placementError;

            if (this.isRetryableBlockPlacementIssue(placementError)) {
              retryRequested = true;
              continue;
            }

            throw placementError;
          }

          retryRequested = true;
          lastPlacementError = new Error(
            `Block placement at ${position.x} ${position.y} ${position.z} did not update the world state yet.`,
          );
        } catch (error) {
          if (error instanceof MicroBaseScenarioCancelledError) {
            throw error;
          }

          lastPlacementError = error;

          if (this.isRetryableBlockPlacementIssue(error)) {
            retryRequested = true;
            continue;
          }

          throw error;
        }
      }

      if (attempt < this.blockPlacementAttempts && retryRequested) {
        this.logger.warn(
          `Block placement at ${position.x} ${position.y} ${position.z} was not confirmed yet: ${this.stringifyError(lastPlacementError)}. Retrying.`,
        );
        await this.bot.waitForTicks(10);
        continue;
      }

      throw lastPlacementError;
    }

    throw new Error(
      `Block placement at ${position.x} ${position.y} ${position.z} was not confirmed. Current block: ${this.describeBlockAtPosition(position)}.`,
    );
  }

  private findPlacementReferences(
    position: Vec3,
    preferredFaceVectors?: ReadonlyArray<Vec3>,
  ): Array<{ referenceBlock: Block; faceVector: Vec3 }> {
    const candidates = preferredFaceVectors ?? [
      new Vec3(0, 1, 0),
      new Vec3(0, 0, -1),
      new Vec3(0, 0, 1),
      new Vec3(1, 0, 0),
      new Vec3(-1, 0, 0),
      new Vec3(0, -1, 0),
    ];
    const placements: Array<{ referenceBlock: Block; faceVector: Vec3 }> = [];

    for (const faceVector of candidates) {
      const referenceBlock = this.bot.blockAt(position.minus(faceVector));

      if (!referenceBlock || referenceBlock.boundingBox !== 'block') {
        continue;
      }

      placements.push({ referenceBlock, faceVector });
    }

    return placements;
  }

  private async prepareTargetBlock(
    position: Vec3,
    allowedExistingBlockNames: ReadonlySet<string>,
  ): Promise<void> {
    const block = this.bot.blockAt(position);

    if (!block || this.isAirBlockName(block.name) || allowedExistingBlockNames.has(block.name)) {
      return;
    }

    if (block.boundingBox === 'empty' && block.diggable) {
      await this.navigateTo(block.position, 2);
      await this.bot.dig(block, true);
      await this.bot.waitForTicks(5);
      return;
    }

    if (block.diggable && this.mayClearBlockingBuildBlock(block.name)) {
      await this.navigateTo(block.position, 2);
      await this.bot.dig(block, true);
      await this.bot.waitForTicks(5);
      return;
    }

    throw new Error(`Block ${block.name} already occupies ${position.x} ${position.y} ${position.z}.`);
  }

  private hasAllowedBlockAtPosition(position: Vec3, allowedExistingBlockNames: ReadonlySet<string>): boolean {
    const block = this.bot.blockAt(position);

    return !!block && allowedExistingBlockNames.has(block.name);
  }

  private isRetryableBlockPlacementIssue(error: unknown): boolean {
    const message = this.stringifyError(error).toLowerCase();

    return (
      message.includes('blockupdate:') ||
      message.includes('did not fire within timeout') ||
      message.includes('goal changed') ||
      message.includes('path was stopped') ||
      message.includes('path stopped before it could be completed') ||
      message.includes('took to long to decide path to goal') ||
      message.includes('no path to the goal')
    );
  }

  private async navigateToPlacementPosition(position: Vec3, faceVector: Vec3): Promise<void> {
    const placementGoal = new GoalPlaceBlock(position, this.bot.world, {
      range: this.blockPlacementRange,
      faces: [faceVector.scaled(-1)],
    });

    while (true) {
      this.ensureScenarioActive();
      await this.waitForTaskPriority();

      try {
        await this.bot.pathfinder.goto(placementGoal);
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

  private describeBlockAtPosition(position: Vec3): string {
    const block = this.bot.blockAt(position);

    if (!block) {
      return 'missing';
    }

    return block.name;
  }

  private mayClearBlockingBuildBlock(blockName: string): boolean {
    if (BED_BLOCK_NAMES.has(blockName)) {
      return false;
    }

    if (blockName === 'crafting_table') {
      return false;
    }

    if (DOOR_ITEM_NAMES.includes(blockName)) {
      return false;
    }

    return !blockName.includes('chest') && blockName !== 'furnace' && blockName !== 'barrel';
  }

  private isAirBlockName(blockName: string): boolean {
    return blockName === 'air' || blockName === 'cave_air' || blockName === 'void_air';
  }

  private async sleepUntilSpawnIsSet(rallyPoint: BotRallyPoint): Promise<void> {
    while (!this.bot.isSleeping) {
      this.ensureScenarioActive();
      await this.waitForTaskPriority();
      const beds = this.getBedSelectionOrder(rallyPoint);

      if (beds.length === 0) {
        throw this.createMissingThingError('кровать рядом с точкой сбора');
      }

      if (!this.isSleepWindow()) {
        for (const bed of beds) {
          if (this.isBedOccupied(bed)) {
            continue;
          }

          try {
            await this.navigateTo(bed.position, 2);
            await this.touchBedToSetSpawnPoint(bed);
            this.logger.info(
              `Touched a bed at ${bed.position.x} ${bed.position.y} ${bed.position.z} to set the spawn point during daytime.`,
            );
            return;
          } catch (error) {
            this.logger.warn(`Could not set the spawn point from a nearby bed yet: ${this.stringifyError(error)}.`);
          }
        }

        await this.bot.waitForTicks(40);
        continue;
      }

      for (const bed of beds) {
        if (this.isBedOccupied(bed)) {
          continue;
        }

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

  private async touchBedToSetSpawnPoint(bed: Block): Promise<void> {
    await this.bot.lookAt(bed.position.offset(0.5, 0.5, 0.5), true).catch(() => undefined);
    await this.bot.activateBlock(bed);
    await this.bot.waitForTicks(10);
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

  private getUniquePlacedBedsNearRallyPoint(rallyPoint: BotRallyPoint): Block[] {
    const bedsByFootPosition = new Map<string, Block>();

    for (const bed of this.findPlacedBedsNearRallyPoint(rallyPoint)) {
      const canonicalBed = this.toBedFootBlock(bed);

      if (!canonicalBed) {
        continue;
      }

      bedsByFootPosition.set(this.toBlockKey(canonicalBed.position), canonicalBed);
    }

    return [...bedsByFootPosition.values()].sort((left, right) => {
      if (left.position.x !== right.position.x) {
        return left.position.x - right.position.x;
      }

      if (left.position.z !== right.position.z) {
        return left.position.z - right.position.z;
      }

      return left.position.y - right.position.y;
    });
  }

  private getBedSelectionOrder(rallyPoint: BotRallyPoint): Block[] {
    const beds = this.getUniquePlacedBedsNearRallyPoint(rallyPoint);

    if (beds.length <= 1) {
      return beds;
    }

    return this.bedAssignmentService
      .getAssignmentOrder(this.botRole, beds.length)
      .map((index) => beds[index]!);
  }

  private isBedOccupied(bed: Block): boolean {
    return this.getBedMetadata(bed)?.occupied === true;
  }

  private toBedFootBlock(bed: Block): Block | null {
    const metadata = this.getBedMetadata(bed);

    if (!metadata) {
      return null;
    }

    const footPosition = metadata.part ? bed.position.minus(metadata.headOffset) : bed.position;
    const footBlock = this.bot.blockAt(footPosition);

    return footBlock && BED_BLOCK_NAMES.has(footBlock.name) ? footBlock : null;
  }

  private getBedMetadata(bed: Block): BedMetadata | null {
    const parseBedMetadata = (this.bot as BotWithPathfinder & {
      parseBedMetadata?: (block: Block) => BedMetadata;
    }).parseBedMetadata;

    if (parseBedMetadata) {
      return parseBedMetadata(bed);
    }

    const properties = bed.getProperties() as {
      part?: string;
      occupied?: boolean;
      facing?: string;
    };

    if (!properties.part || !properties.facing) {
      return null;
    }

    const headOffsetByFacing: Record<string, Vec3> = {
      north: new Vec3(0, 0, -1),
      south: new Vec3(0, 0, 1),
      west: new Vec3(-1, 0, 0),
      east: new Vec3(1, 0, 0),
    };

    return {
      part: properties.part === 'head',
      occupied: properties.occupied === true,
      headOffset: headOffsetByFacing[properties.facing] ?? new Vec3(0, 0, 1),
    };
  }

  private toBlockKey(position: Vec3): string {
    return `${position.x}:${position.y}:${position.z}`;
  }

  private countPlacedBedBlocksNearRallyPoint(rallyPoint: BotRallyPoint): number {
    return this.findPlacedBedsNearRallyPoint(rallyPoint).length;
  }

  private countPlacedBedsNearRallyPoint(rallyPoint: BotRallyPoint): number {
    return Math.floor(this.countPlacedBedBlocksNearRallyPoint(rallyPoint) / 2);
  }

  private isShelterReadyForSpawn(rallyPoint: BotRallyPoint): boolean {
    return (
      this.isShelterBuilt(rallyPoint) &&
      this.hasPlacedShelterDoor(rallyPoint) &&
      this.isShelterTraversable(rallyPoint) &&
      this.arePlacedBedsAccessible(rallyPoint)
    );
  }

  private isShelterBuilt(rallyPoint: BotRallyPoint): boolean {
    return (
      this.shelterLayout
        .getWallPositions(rallyPoint)
        .every((position) =>
          this.hasAllowedBlockAtPosition(this.toBlockVec3(position), new Set(PLANK_ITEM_NAMES)),
        ) &&
      this.shelterLayout
        .getRoofPositions(rallyPoint)
        .every((position) =>
          this.hasAllowedBlockAtPosition(this.toBlockVec3(position), new Set(PLANK_ITEM_NAMES)),
        )
    );
  }

  private hasPlacedShelterDoor(rallyPoint: BotRallyPoint): boolean {
    const doorPosition = this.getShelterDoorPosition(rallyPoint);
    const lowerDoorBlock = this.bot.blockAt(doorPosition);
    const upperDoorBlock = this.bot.blockAt(doorPosition.offset(0, 1, 0));

    return (
      !!lowerDoorBlock &&
      !!upperDoorBlock &&
      DOOR_ITEM_NAMES.includes(lowerDoorBlock.name) &&
      DOOR_ITEM_NAMES.includes(upperDoorBlock.name)
    );
  }

  private isShelterTraversable(rallyPoint: BotRallyPoint): boolean {
    return this.shelterLayout
      .getDoorwayPassagePositions(rallyPoint)
      .every((position) => this.isPassableStandPosition(position));
  }

  private arePlacedBedsAccessible(rallyPoint: BotRallyPoint): boolean {
    return this.shelterLayout.getBedFootPositions(rallyPoint).every((bedPosition) => {
      return (
        this.hasPlacedBedAtPosition(bedPosition, rallyPoint) &&
        this.shelterLayout
          .getBedAccessCandidatePositions(rallyPoint, bedPosition)
          .some((candidate) => this.isPassableStandPosition(candidate))
      );
    });
  }

  private hasAllExpectedBedsPlaced(rallyPoint: BotRallyPoint): boolean {
    return this.shelterLayout
      .getBedFootPositions(rallyPoint)
      .every((position) => this.hasPlacedBedAtPosition(position, rallyPoint));
  }

  private hasPlacedBedAtPosition(position: BlockPosition, rallyPoint: BotRallyPoint): boolean {
    const blockKey = this.toBlockKey(this.toBlockVec3(position));

    return this.getUniquePlacedBedsNearRallyPoint(rallyPoint).some((bed) => {
      return this.toBlockKey(bed.position) === blockKey;
    });
  }

  private isPassableStandPosition(position: BlockPosition): boolean {
    const footBlock = this.bot.blockAt(this.toBlockVec3(position));
    const headBlock = this.bot.blockAt(this.toBlockVec3(position).offset(0, 1, 0));

    return this.isPassableShelterSpaceBlock(footBlock) && this.isPassableShelterSpaceBlock(headBlock);
  }

  private isPassableShelterSpaceBlock(block: Block | null): boolean {
    if (!block) {
      return false;
    }

    return this.isAirBlockName(block.name) || DOOR_ITEM_NAMES.includes(block.name);
  }

  private countCraftableBeds(): number {
    let craftableBeds = 0;

    for (const woolName of WOOL_TO_BED_ITEM.keys()) {
      craftableBeds += Math.floor(this.countItem(woolName) / 3);
    }

    return craftableBeds;
  }

  private countTotalWool(): number {
    return this.bot.inventory
      .items()
      .filter((item) => WOOL_TO_BED_ITEM.has(item.name))
      .reduce((total, item) => total + item.count, 0);
  }

  private countInventoryBeds(): number {
    return this.bot.inventory
      .items()
      .filter((item) => BED_ITEM_NAMES.includes(item.name))
      .reduce((total, item) => total + item.count, 0);
  }

  private countInventoryLogs(): number {
    return this.bot.inventory
      .items()
      .filter((item) => LOG_TO_PLANK_ITEM.has(item.name))
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

  private getShelterOrigin(rallyPoint: BotRallyPoint): Vec3 {
    return this.toBlockVec3(this.shelterLayout.getOrigin(rallyPoint));
  }

  private async moveInsideShelter(rallyPoint: BotRallyPoint): Promise<void> {
    if (this.isBotInsideShelter(rallyPoint)) {
      await this.navigateTo(this.getShelterInteriorAnchor(rallyPoint), 1);
      return;
    }

    await this.enterShelterThroughDoor(rallyPoint);
  }

  private async enterShelterThroughDoor(rallyPoint: BotRallyPoint): Promise<void> {
    const doorPosition = this.getShelterDoorPosition(rallyPoint);
    const outsideApproach = doorPosition.offset(0, 0, 1);
    const interiorAnchor = this.getShelterInteriorAnchor(rallyPoint);
    await this.navigateTo(outsideApproach, 1).catch(() => undefined);
    await this.openShelterDoorIfNeeded(doorPosition);

    if (!this.isBotInsideShelter(rallyPoint)) {
      await this.stepTowards(interiorAnchor, 14);
    }

    if (!this.isBotInsideShelter(rallyPoint)) {
      await this.navigateTo(interiorAnchor, 1).catch(() => undefined);
    }

    if (!this.isBotInsideShelter(rallyPoint)) {
      throw new Error('Could not enter the shelter through the door.');
    }
  }

  private getShelterInteriorAnchor(rallyPoint: BotRallyPoint): Vec3 {
    return this.toBlockVec3(this.shelterLayout.getInteriorAnchor(rallyPoint));
  }

  private getShelterDoorPosition(rallyPoint: BotRallyPoint): Vec3 {
    return this.toBlockVec3(this.shelterLayout.getDoorPosition(rallyPoint));
  }

  private isDoorBlock(block: Block): boolean {
    return block.name.endsWith('_door');
  }

  private async openShelterDoorIfNeeded(doorPosition: Vec3): Promise<void> {
    const lowerDoorBlock = this.bot.blockAt(doorPosition);

    if (lowerDoorBlock && this.isDoorBlock(lowerDoorBlock) && lowerDoorBlock.getProperties().open !== true) {
      await this.bot.lookAt(doorPosition.offset(0.5, 0.5, 0.5), true).catch(() => undefined);
      await this.bot.activateBlock(lowerDoorBlock).catch(() => undefined);
      await this.bot.waitForTicks(10);
    }

    const refreshedLowerDoorBlock = this.bot.blockAt(doorPosition);
    const upperDoorBlock = this.bot.blockAt(doorPosition.offset(0, 1, 0));

    if (refreshedLowerDoorBlock && this.isDoorBlock(refreshedLowerDoorBlock) && refreshedLowerDoorBlock.getProperties().open === true) {
      return;
    }

    if (upperDoorBlock && this.isDoorBlock(upperDoorBlock)) {
      await this.bot.lookAt(doorPosition.offset(0.5, 1.5, 0.5), true).catch(() => undefined);
      await this.bot.activateBlock(upperDoorBlock).catch(() => undefined);
      await this.bot.waitForTicks(10);
    }
  }

  private async stepTowards(target: Vec3, ticks: number): Promise<void> {
    await this.bot.lookAt(target.offset(0.5, 0, 0.5), true).catch(() => undefined);
    this.bot.setControlState('forward', true);

    try {
      await this.bot.waitForTicks(ticks);
    } finally {
      this.bot.setControlState('forward', false);
    }
  }

  private isBotInsideShelter(rallyPoint: BotRallyPoint): boolean {
    if (!this.bot.entity) {
      return false;
    }

    const position = this.bot.entity.position.floored();

    return this.shelterLayout.isInsideInterior(
      {
        x: position.x,
        y: position.y,
        z: position.z,
      },
      rallyPoint,
    );
  }

  private isShelterDoorOpeningPosition(position: Vec3, rallyPoint: BotRallyPoint): boolean {
    const doorPosition = this.getShelterDoorPosition(rallyPoint);

    return position.x === doorPosition.x && position.z === doorPosition.z && position.y < doorPosition.y + 2;
  }

  private toVec3(rallyPoint: BotRallyPoint): Vec3 {
    return new Vec3(rallyPoint.x, rallyPoint.y, rallyPoint.z);
  }

  private toBlockVec3(position: BlockPosition): Vec3 {
    return new Vec3(position.x, position.y, position.z);
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
