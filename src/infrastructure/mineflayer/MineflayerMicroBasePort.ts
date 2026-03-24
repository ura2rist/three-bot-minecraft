import { Block } from 'prismarine-block';
import { Entity } from 'prismarine-entity';
import { Item } from 'prismarine-item';
import { Vec3 } from 'vec3';
import { MicroBasePort } from '../../application/bot/ports/MicroBasePort';
import { Logger } from '../../application/shared/ports/Logger';
import { BotRallyPoint } from '../../domain/bot/entities/BotConfiguration';
import { BotRole } from '../../domain/bot/entities/BotRole';
import { BedAssignmentService } from '../../application/bot/services/BedAssignmentService';
import { NightlyShelterSleepDecisionService } from '../../application/bot/services/NightlyShelterSleepDecisionService';
import { NightlyShelterTimingService } from '../../application/bot/services/NightlyShelterTimingService';
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
  private readonly nightShelterCheckIntervalTicks = 20;
  private readonly shelterDoorSearchRadius = 8;
  private readonly shelterLayout: ShelterLayoutService;
  private readonly bedAssignmentService = new BedAssignmentService();
  private readonly nightlyShelterSleepDecisionService = new NightlyShelterSleepDecisionService();
  private readonly nightlyShelterTimingService = new NightlyShelterTimingService();
  private readonly minimumShelterBedCount: number;

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
    squadSize: number,
    private readonly onNightShelterStarted: () => Promise<void> | void = () => undefined,
    private readonly onNightShelterCompleted: () => Promise<void> | void = () => undefined,
  ) {
    this.shelterLayout = new ShelterLayoutService({
      width: this.houseWidth,
      length: this.houseLength,
      wallHeight: this.wallHeight,
      roofAccessStepZ: this.roofAccessStepZ,
    });
    this.minimumShelterBedCount = Math.max(3, squadSize);
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

    const requiredInventoryBeds = this.getRequiredShelterInventoryBeds(rallyPoint);
    await this.ensureBedsCraftable(rallyPoint, requiredInventoryBeds);
    this.logger.info(
      `Collected enough wool for ${this.minimumShelterBedCount} beds. Returning to the rally point for the building phase.`,
    );
    await this.navigateTo(this.toVec3(rallyPoint), 2);
    await this.waitForNearbyCraftingTable(rallyPoint);

    const shelterBuilt = this.isShelterBuilt(rallyPoint);

    if (!shelterBuilt) {
      this.logger.info(
        `Gathering wood for the shelter and the remaining bed materials. Target planks: ${this.woodTargetPlanks}.`,
      );
      await this.ensurePlanksAvailable(this.woodTargetPlanks);
    } else {
      this.logger.info('Shelter structure already exists near the rally point. Skipping the bulk wood-gathering phase.');
    }

    const accessibleBedCount = this.countAccessiblePlacedBeds(rallyPoint);
    const missingBeds = Math.max(0, this.minimumShelterBedCount - accessibleBedCount);
    const bedsToCraft = Math.max(0, requiredInventoryBeds - this.countInventoryBeds());

    if (bedsToCraft > 0) {
      const craftedBeds = await this.craftAdditionalBeds(rallyPoint, bedsToCraft);

      if (craftedBeds < bedsToCraft) {
        throw this.createMissingThingError('кровати для дома');
      }

      this.logger.info(`Crafted ${craftedBeds} bed item(s). Proceeding to the shelter construction phase.`);
    } else if (missingBeds > 0) {
      this.logger.info('Enough bed items are already in inventory for the shelter. Skipping additional bed crafting.');
    } else {
      this.logger.info('Enough beds are already placed near the rally point. Skipping bed crafting.');
    }

    const shelterDoorPlaced = this.hasPlacedShelterDoor(rallyPoint);

    if (!shelterDoorPlaced) {
      await this.ensureDoorCrafted(rallyPoint);
    } else {
      this.logger.info('Shelter entrance already has a door. Skipping door crafting.');
    }

    if (!shelterBuilt || !shelterDoorPlaced) {
      await this.buildShelter(rallyPoint);
    } else {
      this.logger.info('Shelter structure and door already exist near the rally point. Skipping shelter construction.');
    }
    await this.placeBedsUntilShelterCapacity(rallyPoint);
    await this.sleepUntilSpawnIsSet(rallyPoint);
  }

  async supportLeader(leaderUsername: string, rallyPoint: BotRallyPoint): Promise<void> {
    this.ensureScenarioActive();
    while (!this.bot.isSleeping) {
      this.ensureScenarioActive();
      await this.waitForTaskPriority();
      if (this.countAccessiblePlacedBeds(rallyPoint) >= this.minimumShelterBedCount) {
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

  async maintainNightlyShelterRoutine(rallyPoint: BotRallyPoint): Promise<void> {
    while (this.isScenarioActive()) {
      let sleptDuringTheNight = false;
      let nightShelterTaskStarted = false;

      try {
        await this.waitUntilNightShelterReturnWindow();
        this.ensureScenarioActive();
        await this.onNightShelterStarted();
        nightShelterTaskStarted = true;
        this.logger.info(
          `Night return window opened at timeOfDay ${this.bot.time.timeOfDay ?? 'unknown'}. Returning to the shelter and preparing to sleep.`,
        );
        await this.moveInsideShelter(rallyPoint, true);
        sleptDuringTheNight = await this.sleepInShelterForTheNight(rallyPoint);

        if (sleptDuringTheNight) {
          await this.waitUntilMorningAfterSleeping();
        }
      } catch (error) {
        if (error instanceof MicroBaseScenarioCancelledError) {
          return;
        }

        this.logger.warn(
          `Night shelter routine was interrupted and will retry shortly: ${this.stringifyError(error)}.`,
        );
        await this.bot.waitForTicks(40);
      } finally {
        if (nightShelterTaskStarted) {
          await this.onNightShelterCompleted();
        }
      }

      if (nightShelterTaskStarted && !sleptDuringTheNight && this.isScenarioActive()) {
        await this.expandShelterSleepingCapacityAfterMissedNight(rallyPoint);
      }
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

  private async craftAdditionalBeds(
    rallyPoint: BotRallyPoint,
    additionalBeds: number,
  ): Promise<number> {
    if (additionalBeds <= 0) {
      return 0;
    }

    const inventoryBedsBeforeCrafting = this.countInventoryBeds();
    const targetInventoryBeds = inventoryBedsBeforeCrafting + additionalBeds;
    const inventoryBedsAfterCrafting = await this.craftBeds(rallyPoint, targetInventoryBeds);

    return Math.max(0, inventoryBedsAfterCrafting - inventoryBedsBeforeCrafting);
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

  private async placeBedsUntilShelterCapacity(rallyPoint: BotRallyPoint): Promise<void> {
    this.ensureScenarioActive();
    await this.waitForTaskPriority();
    if (this.countAccessiblePlacedBeds(rallyPoint) >= this.minimumShelterBedCount) {
      return;
    }

    await this.moveInsideShelter(rallyPoint);

    while (this.countAccessiblePlacedBeds(rallyPoint) < this.minimumShelterBedCount) {
      const position = this.findNextAvailableBedPlacementPosition(rallyPoint);

      if (!position) {
        throw this.createMissingThingError('РјРµСЃС‚Рѕ РґР»СЏ РєСЂРѕРІР°С‚Рё РІРЅСѓС‚СЂРё РґРѕРјР°');
      }

      await this.moveInsideShelter(rallyPoint);
      await this.placeBed(position, rallyPoint);
    }

    this.logger.info(`Placed ${this.countPlacedBedsNearRallyPoint(rallyPoint)} beds inside the shelter.`);
  }

  private async placeBed(position: Vec3, rallyPoint: BotRallyPoint): Promise<void> {
    this.logger.info(
      `Attempting to place a bed at ${position.x} ${position.y} ${position.z}. ${this.describeBedPlacementState(position, rallyPoint)}`,
    );

    for (let shelterEntryAttempt = 0; shelterEntryAttempt < 2; shelterEntryAttempt += 1) {
      await this.clearBedPlacementArea(position, rallyPoint);
      const candidatePlacements = this.getCandidateBedPlacements(position, rallyPoint);

      for (const bedName of BED_ITEM_NAMES) {
        const bedItem = this.findInventoryItem(bedName);

        if (!bedItem) {
          continue;
        }

        for (const candidatePlacement of candidatePlacements) {
          try {
            await this.placeBlockFromInventory(
              position,
              bedItem,
              new Set(BED_BLOCK_NAMES),
              candidatePlacement.yaw,
              [new Vec3(0, 1, 0)],
              candidatePlacement.standPosition,
            );
            this.logger.info(
              `Placed ${bedName} at ${position.x} ${position.y} ${position.z} using yaw ${this.describeYaw(candidatePlacement.yaw)} from ${this.describeVec3(candidatePlacement.standPosition)} toward ${this.describeVec3(candidatePlacement.headPosition)}.`,
            );
            return;
          } catch (error) {
            this.logger.warn(
              `Bed placement attempt failed for ${bedName} at ${position.x} ${position.y} ${position.z} using yaw ${this.describeYaw(candidatePlacement.yaw)} from ${this.describeVec3(candidatePlacement.standPosition)} toward ${this.describeVec3(candidatePlacement.headPosition)}: ${this.stringifyError(error)}. ${this.describeBedPlacementState(position, rallyPoint)}`,
            );
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

    this.logger.warn(
      `Exhausted all bed placement attempts at ${position.x} ${position.y} ${position.z}. ${this.describeBedPlacementState(position, rallyPoint)}`,
    );
    throw this.createMissingThingError(`место для кровати в точке ${position.x} ${position.y} ${position.z}`);
  }

  private findNextAvailableBedPlacementPosition(rallyPoint: BotRallyPoint): Vec3 | null {
    const doorPosition = this.getShelterDoorPosition(rallyPoint);
    const occupiedBedPositions = new Set(
      this.getUniquePlacedBedsNearRallyPoint(rallyPoint).map((bed) => this.toBlockKey(bed.position)),
    );
    const candidatePlacements = this.shelterLayout
      .getInteriorFloorPositions(rallyPoint)
      .map((position) => this.toBlockVec3(position))
      .filter((position) => !occupiedBedPositions.has(this.toBlockKey(position)))
      .flatMap((position) =>
        this.getCandidateBedPlacements(position, rallyPoint).map((placement) => ({
          footPosition: position,
          headPosition: placement.headPosition,
          standPosition: placement.standPosition,
        })),
      )
      .sort((left, right) => {
        const leftDistance = left.footPosition.distanceSquared(doorPosition) + left.headPosition.distanceSquared(doorPosition);
        const rightDistance = right.footPosition.distanceSquared(doorPosition) + right.headPosition.distanceSquared(doorPosition);

        if (leftDistance !== rightDistance) {
          return rightDistance - leftDistance;
        }

        if (left.footPosition.z !== right.footPosition.z) {
          return left.footPosition.z - right.footPosition.z;
        }

        return left.footPosition.x - right.footPosition.x;
      });

    return candidatePlacements[0]?.footPosition ?? null;
  }

  private isCandidateBedPlacementPosition(position: Vec3, rallyPoint: BotRallyPoint): boolean {
    if (!this.isPassableShelterSpaceBlock(this.bot.blockAt(position))) {
      return false;
    }

    if (!this.isPassableShelterSpaceBlock(this.bot.blockAt(position.offset(0, 1, 0)))) {
      return false;
    }

    const footFloorBlock = this.bot.blockAt(position.offset(0, -1, 0));

    if (!footFloorBlock || footFloorBlock.boundingBox !== 'block') {
      return false;
    }

    return this.getCandidateBedPlacements(position, rallyPoint).length > 0;
  }

  private getCandidateBedPlacements(
    position: Vec3,
    rallyPoint: BotRallyPoint,
  ): Array<{ headPosition: Vec3; standPosition: Vec3; yaw: number }> {
    return this.getCardinalOffsets().flatMap((offset) => {
      const headPosition = position.plus(offset);

      if (!this.isInsideShelterArea(headPosition, rallyPoint)) {
        return [];
      }

      const headFloorBlock = this.bot.blockAt(headPosition.offset(0, -1, 0));

      if (!headFloorBlock || headFloorBlock.boundingBox !== 'block') {
        return [];
      }

      if (
        !this.isPassableShelterSpaceBlock(this.bot.blockAt(headPosition)) ||
        !this.isPassableShelterSpaceBlock(this.bot.blockAt(headPosition.offset(0, 1, 0)))
      ) {
        return [];
      }

      const standPosition = position.minus(offset);

      if (!this.isInsideShelterArea(standPosition, rallyPoint)) {
        return [];
      }

      if (!this.isPassableStandPosition(this.toBlockPosition(standPosition))) {
        return [];
      }

      return [{
        headPosition,
        standPosition,
        yaw: this.getBedPlacementYaw(offset),
      }];
    });
  }

  private async clearBedPlacementArea(position: Vec3, rallyPoint: BotRallyPoint): Promise<void> {
    await this.requestFriendlyBotsToClearPosition(position, 2);

    for (const candidatePlacement of this.getCandidateBedPlacements(position, rallyPoint)) {
      await this.requestFriendlyBotsToClearPosition(candidatePlacement.headPosition, 2);
      await this.requestFriendlyBotsToClearPosition(candidatePlacement.standPosition, 2);
    }
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
    preferredStandPosition?: Vec3,
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
          await this.navigateToPlacementPosition(position, placement.faceVector, preferredStandPosition);

          if (yaw !== undefined) {
            await this.lookAtPlacementPosition(position, yaw);
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
          `Block placement of ${item.name} at ${position.x} ${position.y} ${position.z}${yaw !== undefined ? ` with yaw ${this.describeYaw(yaw)}` : ''} was not confirmed yet: ${this.stringifyError(lastPlacementError)}. Retrying.`,
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

  private async navigateToPlacementPosition(
    position: Vec3,
    faceVector: Vec3,
    preferredStandPosition?: Vec3,
  ): Promise<void> {
    if (preferredStandPosition) {
      await this.navigateTo(preferredStandPosition, 0.75);
      return;
    }

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

  private async lookAtPlacementPosition(position: Vec3, yaw: number): Promise<void> {
    await this.bot.lookAt(position.offset(0.5, 0.5, 0.5), true);
    const pitch = this.bot.entity?.pitch ?? 0;
    await this.bot.look(yaw, pitch, true);
  }

  private describeBedPlacementState(position: Vec3, rallyPoint: BotRallyPoint): string {
    const candidateHeads = this.getCardinalOffsets().map((offset) => {
      const headPosition = position.plus(offset);

      return `${this.describeVec3(headPosition)} inside=${this.isInsideShelterArea(headPosition, rallyPoint)} floor=${this.describeBlockAtPosition(headPosition.offset(0, -1, 0))} foot=${this.describeBlockAtPosition(headPosition)} head=${this.describeBlockAtPosition(headPosition.offset(0, 1, 0))}`;
    });
    const botPosition = this.bot.entity ? this.describeVec3(this.bot.entity.position) : 'missing';

    return `Bot=${botPosition}; targetFloor=${this.describeBlockAtPosition(position.offset(0, -1, 0))}; targetFoot=${this.describeBlockAtPosition(position)}; targetHead=${this.describeBlockAtPosition(position.offset(0, 1, 0))}; inventoryBeds=${this.countInventoryBeds()}; candidateHeads=[${candidateHeads.join('; ')}]`;
  }

  private describeYaw(yaw: number): string {
    if (yaw === 0) {
      return 'south(0)';
    }

    if (yaw === Math.PI / 2) {
      return 'west(pi/2)';
    }

    if (yaw === Math.PI) {
      return 'north(pi)';
    }

    if (yaw === -Math.PI / 2) {
      return 'east(-pi/2)';
    }

    return String(yaw);
  }

  private getBedPlacementYaw(headOffset: Vec3): number {
    if (headOffset.x === 1) {
      return -Math.PI / 2;
    }

    if (headOffset.x === -1) {
      return Math.PI / 2;
    }

    if (headOffset.z === 1) {
      return 0;
    }

    return Math.PI;
  }

  private describeVec3(position: Vec3): string {
    return `${position.x.toFixed(2)} ${position.y.toFixed(2)} ${position.z.toFixed(2)}`;
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
            this.logger.info(
              `Bed at ${bed.position.x} ${bed.position.y} ${bed.position.z} is occupied. Trying the next bed.`,
            );
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
          this.logger.info(
            `Bed at ${bed.position.x} ${bed.position.y} ${bed.position.z} is occupied. Trying the next bed.`,
          );
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

  private async sleepInShelterForTheNight(rallyPoint: BotRallyPoint): Promise<boolean> {
    let sleepWindowObserved = false;

    while (!this.bot.isSleeping) {
      this.ensureScenarioActive();
      await this.waitForTaskPriority();
      await this.moveInsideShelter(rallyPoint, true);
      const beds = this.getBedSelectionOrder(rallyPoint);
      const freeBeds = beds.filter((bed) => !this.isBedOccupied(bed));
      const decision = this.nightlyShelterSleepDecisionService.evaluate({
        sleepWindowObserved,
        isSleepWindow: this.isSleepWindow(),
        isDay: this.bot.time.isDay,
        totalBeds: beds.length,
        freeBeds: freeBeds.length,
      });
      sleepWindowObserved = decision.nextSleepWindowObserved;

      if (decision.kind === 'expand_after_morning') {
        this.logger.info(
          'No free shelter bed was available during the night. Morning has started, so the bot will expand the sleeping capacity.',
        );
        return false;
        throw this.createMissingThingError('кровать рядом с точкой сбора');
      }

      if (decision.kind === 'wait') {
        if (decision.reason === 'all_beds_occupied') {
          this.logger.info('All shelter beds are occupied right now. Waiting for morning before adding more beds.');
        } else if (decision.reason === 'no_beds_available') {
          this.logger.info('No shelter beds are available right now. Waiting for morning before adding more beds.');
        }

        await this.bot.waitForTicks(this.nightShelterCheckIntervalTicks);
        continue;
      }

      for (const bed of freeBeds) {
        try {
          await this.navigateTo(bed.position, 2);
          await this.bot.sleep(bed);
          this.logger.info(
            `Sleeping in a shelter bed at ${bed.position.x} ${bed.position.y} ${bed.position.z} for the night.`,
          );
          return true;
        } catch (error) {
          this.logger.warn(`Could not sleep in a shelter bed yet: ${this.stringifyError(error)}.`);
        }
      }

      await this.bot.waitForTicks(this.nightShelterCheckIntervalTicks);
    }

    return true;
  }

  private async waitUntilMorningAfterSleeping(): Promise<void> {
    while (this.isScenarioActive()) {
      if (!this.bot.isSleeping && this.bot.time.isDay) {
        return;
      }

      await this.bot.waitForTicks(this.nightShelterCheckIntervalTicks);
    }
  }

  private async waitUntilNightShelterReturnWindow(): Promise<void> {
    while (this.isScenarioActive()) {
      this.ensureScenarioActive();

      if (this.nightlyShelterTimingService.shouldReturnToShelter(this.bot.time.timeOfDay)) {
        return;
      }

      const ticksUntilReturnWindow = this.nightlyShelterTimingService.getTicksUntilReturnWindow(
        this.bot.time.timeOfDay,
      );
      const waitTicks = Math.max(
        1,
        Math.min(this.nightShelterCheckIntervalTicks, ticksUntilReturnWindow),
      );

      await this.bot.waitForTicks(waitTicks);
    }
  }

  private async expandShelterSleepingCapacityAfterMissedNight(
    rallyPoint: BotRallyPoint,
  ): Promise<void> {
    this.ensureScenarioActive();
    await this.waitForTaskPriority();

    const accessibleBeds = this.countAccessiblePlacedBeds(rallyPoint);

    if (accessibleBeds >= this.minimumShelterBedCount) {
      this.logger.info(
        'All required shelter beds are already accessible. Reusing an existing bed during daytime to refresh the spawn point.',
      );
      await this.sleepUntilSpawnIsSet(rallyPoint);
      return;
    }

    const requiredInventoryBeds = this.getRequiredShelterInventoryBeds(rallyPoint);
    const currentInventoryBeds = this.countInventoryBeds();
    const bedsToCraft = Math.max(0, requiredInventoryBeds - currentInventoryBeds);

    if (bedsToCraft > 0) {
      this.logger.info(
        `Shelter had only ${accessibleBeds}/${this.minimumShelterBedCount} accessible beds overnight. Gathering sheep and wood for ${bedsToCraft} additional bed(s).`,
      );
      await this.waitForNearbyCraftingTable(rallyPoint);
      await this.ensureBedsCraftable(rallyPoint, currentInventoryBeds + bedsToCraft);
      await this.ensurePlanksAvailable(3 * bedsToCraft);

      const craftedBeds = await this.craftAdditionalBeds(rallyPoint, bedsToCraft);

      if (craftedBeds < bedsToCraft) {
        throw this.createMissingThingError('кровати для расширения дома');
      }

      this.logger.info(
        `Crafted ${craftedBeds} additional bed item(s) after a missed night. Expanding the shelter sleeping capacity.`,
      );
    } else {
      this.logger.info('The missing shelter beds are already in inventory. Expanding the sleeping capacity without crafting more beds.');
    }
    await this.placeBedsUntilShelterCapacity(rallyPoint);
    await this.sleepUntilSpawnIsSet(rallyPoint);
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
    const searchRadius = Math.max(this.houseWidth, this.houseLength);

    for (let dx = -searchRadius; dx <= searchRadius; dx += 1) {
      for (let dy = -1; dy <= 2; dy += 1) {
        for (let dz = -searchRadius; dz <= searchRadius; dz += 1) {
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
    return this.getUniquePlacedBedsNearRallyPoint(rallyPoint).length;
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
    const doorPosition = this.getShelterDoorPosition(rallyPoint);
    const interiorAnchor = this.findActualShelterInteriorAnchor(rallyPoint);

    return !!interiorAnchor && this.isPassableStandPosition(this.toBlockPosition(doorPosition)) && this.isPassableStandPosition(this.toBlockPosition(interiorAnchor));
  }

  private arePlacedBedsAccessible(rallyPoint: BotRallyPoint): boolean {
    return this.countAccessiblePlacedBeds(rallyPoint) >= this.minimumShelterBedCount;
  }

  private hasAllExpectedBedsPlaced(rallyPoint: BotRallyPoint): boolean {
    return this.countPlacedBedsNearRallyPoint(rallyPoint) >= this.minimumShelterBedCount;
  }

  private hasPlacedBedAtPosition(position: BlockPosition, rallyPoint: BotRallyPoint): boolean {
    const blockKey = this.toBlockKey(this.toBlockVec3(position));

    return this.getUniquePlacedBedsNearRallyPoint(rallyPoint).some((bed) => {
      return this.toBlockKey(bed.position) === blockKey;
    });
  }

  private countAccessiblePlacedBeds(rallyPoint: BotRallyPoint): number {
    return this.getUniquePlacedBedsNearRallyPoint(rallyPoint).filter((bed) => {
      return this.getActualBedAccessCandidatePositions(bed.position).some((candidate) =>
        this.isPassableStandPosition(candidate),
      );
    }).length;
  }

  private getActualBedAccessCandidatePositions(position: Vec3): BlockPosition[] {
    return this.getCardinalOffsets().map((offset) =>
      this.toBlockPosition(position.plus(offset)),
    );
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

  private getRequiredShelterInventoryBeds(rallyPoint: BotRallyPoint): number {
    return Math.max(0, this.minimumShelterBedCount - this.countAccessiblePlacedBeds(rallyPoint));
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

  private async moveInsideShelter(
    rallyPoint: BotRallyPoint,
    closeDoorAfterEntry = false,
  ): Promise<void> {
    const doorPosition = this.getShelterDoorPosition(rallyPoint);

    if (this.isBotInsideShelter(rallyPoint)) {
      await this.navigateTo(this.getShelterInteriorAnchor(rallyPoint), 1);

      if (closeDoorAfterEntry) {
        await this.closeShelterDoorIfOpen(doorPosition);
      }

      return;
    }

    await this.enterShelterThroughDoor(rallyPoint, closeDoorAfterEntry);
  }

  private async enterShelterThroughDoor(
    rallyPoint: BotRallyPoint,
    closeDoorAfterEntry = false,
  ): Promise<void> {
    const doorPosition = this.getShelterDoorPosition(rallyPoint);
    const interiorAnchor = this.getShelterInteriorAnchor(rallyPoint);
    const outsideApproach =
      this.getDoorApproachPositions(doorPosition, rallyPoint).find(
        (position) =>
          !this.isInsideShelterArea(position, rallyPoint) &&
          this.isPassableStandPosition(this.toBlockPosition(position)),
      ) ??
      doorPosition;

    await this.navigateTo(outsideApproach, 1).catch(() => undefined);
    await this.openShelterDoorIfNeeded(doorPosition);

    if (!this.isBotInsideShelter(rallyPoint)) {
      await this.stepTowards(interiorAnchor, 16);
    }

    if (!this.isBotInsideShelter(rallyPoint)) {
      await this.navigateTo(interiorAnchor, 1).catch(() => undefined);
    }

    if (!this.isBotInsideShelter(rallyPoint)) {
      throw new Error('Could not enter the shelter through the door.');
    }

    if (closeDoorAfterEntry) {
      await this.closeShelterDoorIfOpen(doorPosition);
      this.logger.info(
        `Entered the shelter through the door at ${doorPosition.x} ${doorPosition.y} ${doorPosition.z} and closed it behind the bot.`,
      );
    }
  }

  private getShelterInteriorAnchor(rallyPoint: BotRallyPoint): Vec3 {
    return (
      this.findActualShelterInteriorAnchor(rallyPoint) ??
      this.toBlockVec3(this.shelterLayout.getInteriorAnchor(rallyPoint))
    );
  }

  private getShelterDoorPosition(rallyPoint: BotRallyPoint): Vec3 {
    return (
      this.findActualShelterDoorPosition(rallyPoint) ??
      this.toBlockVec3(this.shelterLayout.getDoorPosition(rallyPoint))
    );
  }

  private findActualShelterDoorPosition(rallyPoint: BotRallyPoint): Vec3 | null {
    const center = this.toVec3(rallyPoint);
    const seenDoorPositions = new Set<string>();
    let bestDoor: Vec3 | null = null;
    let bestScore = Number.POSITIVE_INFINITY;

    for (let dx = -this.shelterDoorSearchRadius; dx <= this.shelterDoorSearchRadius; dx += 1) {
      for (let dy = -1; dy <= 2; dy += 1) {
        for (let dz = -this.shelterDoorSearchRadius; dz <= this.shelterDoorSearchRadius; dz += 1) {
          const candidate = this.bot.blockAt(center.offset(dx, dy, dz));

          if (!candidate || !this.isDoorBlock(candidate)) {
            continue;
          }

          const normalizedDoor = this.normalizeDoorBlock(candidate);

          if (!normalizedDoor) {
            continue;
          }

          const key = this.toBlockKey(normalizedDoor.position);

          if (seenDoorPositions.has(key)) {
            continue;
          }

          seenDoorPositions.add(key);
          const interiorAnchor = this.findDoorInteriorAnchor(normalizedDoor.position, rallyPoint);
          const score =
            normalizedDoor.position.distanceSquared(center) +
            (interiorAnchor ? interiorAnchor.distanceSquared(center) : 1000);

          if (score < bestScore) {
            bestScore = score;
            bestDoor = normalizedDoor.position.clone();
          }
        }
      }
    }

    return bestDoor;
  }

  private findActualShelterInteriorAnchor(rallyPoint: BotRallyPoint): Vec3 | null {
    return this.findDoorInteriorAnchor(this.getShelterDoorPosition(rallyPoint), rallyPoint);
  }

  private findDoorInteriorAnchor(doorPosition: Vec3, rallyPoint: BotRallyPoint): Vec3 | null {
    const rallyCenter = this.toVec3(rallyPoint);

    return this.getDoorApproachPositions(doorPosition, rallyPoint)
      .filter((position) => this.isPassableStandPosition(this.toBlockPosition(position)))
      .sort((left, right) => left.distanceSquared(rallyCenter) - right.distanceSquared(rallyCenter))[0] ?? null;
  }

  private getDoorApproachPositions(doorPosition: Vec3, rallyPoint: BotRallyPoint): Vec3[] {
    const rallyCenter = this.toVec3(rallyPoint);

    return this.getCardinalOffsets()
      .map((offset) => doorPosition.plus(offset))
      .sort((left, right) => left.distanceSquared(rallyCenter) - right.distanceSquared(rallyCenter));
  }

  private normalizeDoorBlock(block: Block): Block | null {
    if (!this.isDoorBlock(block)) {
      return null;
    }

    if (block.getProperties().half === 'upper') {
      const lowerDoorBlock = this.bot.blockAt(block.position.offset(0, -1, 0));

      if (lowerDoorBlock && this.isDoorBlock(lowerDoorBlock)) {
        return lowerDoorBlock;
      }
    }

    return block;
  }

  private getCardinalOffsets(): Vec3[] {
    return [
      new Vec3(1, 0, 0),
      new Vec3(-1, 0, 0),
      new Vec3(0, 0, 1),
      new Vec3(0, 0, -1),
    ];
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

  private async closeShelterDoorIfOpen(doorPosition: Vec3): Promise<void> {
    const lowerDoorBlock = this.bot.blockAt(doorPosition);

    if (lowerDoorBlock && this.isDoorBlock(lowerDoorBlock) && lowerDoorBlock.getProperties().open === true) {
      await this.bot.lookAt(doorPosition.offset(0.5, 0.5, 0.5), true).catch(() => undefined);
      await this.bot.activateBlock(lowerDoorBlock).catch(() => undefined);
      await this.bot.waitForTicks(10);
    }

    const refreshedLowerDoorBlock = this.bot.blockAt(doorPosition);
    const upperDoorBlock = this.bot.blockAt(doorPosition.offset(0, 1, 0));

    if (
      refreshedLowerDoorBlock &&
      this.isDoorBlock(refreshedLowerDoorBlock) &&
      refreshedLowerDoorBlock.getProperties().open !== true
    ) {
      return;
    }

    if (upperDoorBlock && this.isDoorBlock(upperDoorBlock) && upperDoorBlock.getProperties().open === true) {
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

    return this.isInsideShelterArea(this.bot.entity.position.floored(), rallyPoint);
  }

  private isInsideShelterArea(position: Vec3, rallyPoint: BotRallyPoint): boolean {
    return this.shelterLayout.isInsideInterior(this.toBlockPosition(position), rallyPoint);
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

  private toBlockPosition(position: Vec3): BlockPosition {
    return {
      x: Math.floor(position.x),
      y: Math.floor(position.y),
      z: Math.floor(position.z),
    };
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
