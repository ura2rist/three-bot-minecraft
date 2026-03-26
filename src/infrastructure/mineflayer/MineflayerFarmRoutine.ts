import { Block } from 'prismarine-block';
import { Item } from 'prismarine-item';
import { Vec3 } from 'vec3';
import {
  FarmPlotSettings,
  FarmPointSettings,
  FarmRoleSettings,
} from '../../domain/bot/entities/RoleSettings';
import { Logger } from '../../application/shared/ports/Logger';
import { BotRallyPoint } from '../../domain/bot/entities/BotConfiguration';
import { NightlyShelterTimingService } from '../../application/bot/services/NightlyShelterTimingService';
import { BlockPosition, ShelterLayoutService } from '../../application/bot/services/ShelterLayoutService';
import { BotWithPathfinder, PathfinderMovements } from './MineflayerPortsShared';
import { MineflayerChestInventoryManager } from './MineflayerChestInventoryManager';
import { MineflayerLogHarvestingPort } from './MineflayerLogHarvestingPort';
import { MineflayerNearbyDroppedItemCollector } from './MineflayerNearbyDroppedItemCollector';

const mineflayerPathfinder = require('../../../.vendor/mineflayer-pathfinder-master');
const Movements = mineflayerPathfinder.Movements as new (bot: BotWithPathfinder) => PathfinderMovements;
const GoalNear = mineflayerPathfinder.goals.GoalNear as new (
  x: number,
  y: number,
  z: number,
  range: number,
) => unknown;

interface SupportedFarmPlot {
  definition: FarmCropDefinition;
  settings: FarmPlotSettings;
}

interface FarmCropDefinition {
  plantedItemId: string;
  cropBlockName: string;
  matureAge: number;
  harvestItemIds: readonly string[];
}

interface FarmCellInspection {
  needsInteraction: boolean;
  needsHarvest: boolean;
  needsPlanting: boolean;
}

const FARM_CROP_DEFINITIONS = new Map<string, FarmCropDefinition>([
  [
    'wheat_seeds',
    {
      plantedItemId: 'wheat_seeds',
      cropBlockName: 'wheat',
      matureAge: 7,
      harvestItemIds: ['wheat', 'wheat_seeds'],
    },
  ],
  [
    'carrot',
    {
      plantedItemId: 'carrot',
      cropBlockName: 'carrots',
      matureAge: 7,
      harvestItemIds: ['carrot'],
    },
  ],
  [
    'potato',
    {
      plantedItemId: 'potato',
      cropBlockName: 'potatoes',
      matureAge: 7,
      harvestItemIds: ['potato', 'poisonous_potato'],
    },
  ],
  [
    'beetroot_seeds',
    {
      plantedItemId: 'beetroot_seeds',
      cropBlockName: 'beetroots',
      matureAge: 3,
      harvestItemIds: ['beetroot', 'beetroot_seeds'],
    },
  ],
]);

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

const PLANK_ITEM_NAMES = [...new Set(LOG_TO_PLANK_ITEM.values())];
const HOE_ITEM_NAMES = [
  'netherite_hoe',
  'diamond_hoe',
  'iron_hoe',
  'stone_hoe',
  'golden_hoe',
  'wooden_hoe',
] as const;
const WEAPON_ITEM_NAMES = new Set([
  'wooden_sword',
  'stone_sword',
  'iron_sword',
  'diamond_sword',
  'netherite_sword',
]);
const KEPT_FOOD_ITEM_NAMES = new Set([
  'cooked_chicken',
  'cooked_beef',
  'cooked_porkchop',
]);

export class MineflayerFarmRoutine {
  private readonly maximumSeedStacks = 2;
  private readonly craftingTableSearchRadius = 4;
  private readonly farmingRadius = 3;
  private readonly farmPointArrivalRange = 0;
  private readonly farmPointFallbackRange = 1;
  private readonly farmCellInspectionRange = 0;
  private readonly idleCheckTicks = 20;
  private readonly retreatCheckTicks = 40;
  private readonly nearbyThreatRadius = 8;
  private readonly shelterThreatRadius = 10;
  private readonly shelterDoorSearchRadius = 8;
  private readonly shelterDoorEntryAttempts = 3;
  private readonly nightTimingService = new NightlyShelterTimingService();
  private readonly shelterLayout = new ShelterLayoutService({
    width: 9,
    length: 6,
    wallHeight: 3,
    roofAccessStepZ: 1,
  });
  private readonly chestInventoryManager: MineflayerChestInventoryManager;
  private readonly supportedPlots: SupportedFarmPlot[];
  private observedHealth: number | null = null;
  private inferredFarmDay: number | null = null;
  private observedTimeOfDay: number | null = null;
  private lastCompletedFarmDay: number | null = null;

  constructor(
    private readonly bot: BotWithPathfinder,
    private readonly logger: Logger,
    private readonly rallyPoint: BotRallyPoint,
    private readonly settings: FarmRoleSettings,
    private readonly gotoPosition: (target: Vec3, range: number) => Promise<void>,
    private readonly logHarvestingPort: MineflayerLogHarvestingPort,
    private readonly nearbyDroppedItemCollector: MineflayerNearbyDroppedItemCollector,
    private readonly isScenarioActive: () => boolean,
    private readonly waitUntilTaskMayProceed: () => Promise<void>,
  ) {
    this.chestInventoryManager = new MineflayerChestInventoryManager(bot, logger, gotoPosition);
    this.supportedPlots = settings.farms
      .map((plot) => {
        const definition = FARM_CROP_DEFINITIONS.get(plot.itemId);
        return definition ? { definition, settings: plot } : null;
      })
      .filter((plot): plot is SupportedFarmPlot => plot !== null);
  }

  async maintain(): Promise<void> {
    this.logUnsupportedCrops();

    if (this.supportedPlots.length === 0) {
      this.logger.info('Farm routine has no supported crop zones configured. Skipping the main farm loop.');
      return;
    }

    this.observeCurrentHealth();

    while (this.isScenarioActive()) {
      await this.waitForScenarioWindow();

      if (!this.isScenarioActive()) {
        return;
      }

      if (this.shouldPauseForNightlyShelter()) {
        this.observeCurrentHealth();
        await this.bot.waitForTicks(this.idleCheckTicks);
        continue;
      }

      if (this.shouldRetreatToShelter()) {
        await this.retreatToShelterUntilSafe();
        this.observeCurrentHealth();
        continue;
      }

      if (this.hasCompletedFarmWorkToday()) {
        await this.enterShelterAndCloseDoor();
        this.observeCurrentHealth();
        await this.bot.waitForTicks(this.idleCheckTicks);
        continue;
      }

      const exitedShelter = await this.ensureOutsideShelter();

      if (!exitedShelter) {
        await this.bot.waitForTicks(this.idleCheckTicks);
        continue;
      }

      await this.ensureWoodenHoeAvailable();

      await this.restockPlantingItems();

      if (!this.isScenarioActive() || this.shouldPauseForNightlyShelter()) {
        continue;
      }

      const completedFarmPass = await this.runFarmRoute();
      await this.storeFarmLoot();
      await this.enterShelterAndCloseDoor();

      if (completedFarmPass) {
        this.markFarmWorkCompletedForToday();
      }

      this.observeCurrentHealth();
      await this.bot.waitForTicks(this.idleCheckTicks);
    }
  }

  private async runFarmRoute(): Promise<boolean> {
    for (const plot of this.supportedPlots) {
      for (const point of plot.settings.points) {
        await this.waitForScenarioWindow();

        if (this.shouldPauseForNightlyShelter() || this.shouldRetreatToShelter()) {
          return false;
        }

        const pointCenter = this.toFarmPointVec3(point);

        try {
          await this.gotoFarmPoint(point);
        } catch (error) {
          this.logger.info(
            `Could not reach the farm point at ${point.x} ${point.y} ${point.z} yet: ${this.stringifyError(error)}.`,
          );
          continue;
        }

        const completedPlot = await this.processFarmZone(plot, point);

        if (!completedPlot) {
          return false;
        }

        await this.nearbyDroppedItemCollector.collectAround(pointCenter, 5, 3).catch(() => undefined);
      }
    }

    return true;
  }

  private async processFarmZone(plot: SupportedFarmPlot, point: FarmPointSettings): Promise<boolean> {
    const farmCells = this.getFarmCells(point);

    for (const cell of farmCells) {
      await this.waitForScenarioWindow();

      if (this.shouldPauseForNightlyShelter() || this.shouldRetreatToShelter()) {
        return false;
      }

      const inspection = this.inspectFarmCell(plot, cell);

      if (!inspection.needsInteraction) {
        continue;
      }

      const reachedCell = await this.moveToFarmCell(cell);

      if (!reachedCell) {
        this.logger.info(
          `Could not reach the farm cell at ${cell.x} ${cell.y} ${cell.z} for inspection. Skipping it for now.`,
        );
        continue;
      }

      await this.tendFarmCell(plot, cell);
    }

    return true;
  }

  private async tendFarmCell(plot: SupportedFarmPlot, groundPosition: Vec3): Promise<void> {
    const cropPosition = groundPosition.offset(0, 1, 0);
    const cropBlock = this.bot.blockAt(cropPosition);

    if (cropBlock) {
      const cropDefinition = this.getCropDefinitionForBlock(cropBlock);

      if (cropDefinition && this.isMatureCropBlock(cropBlock, cropDefinition)) {
        await this.harvestCrop(cropBlock);
        await this.nearbyDroppedItemCollector.collectAround(cropPosition, 2, 2).catch(() => undefined);
      }
    }

    const refreshedGroundBlock = this.bot.blockAt(groundPosition);
    const refreshedCropBlock = this.bot.blockAt(cropPosition);

    if (!this.isPlantingSpaceEmpty(refreshedCropBlock)) {
      return;
    }

    if (!refreshedGroundBlock) {
      return;
    }

    if (this.requiresTilling(refreshedGroundBlock) && this.countInventoryItems(plot.definition.plantedItemId) > 0) {
      await this.tillGround(refreshedGroundBlock);
    }

    const plantableGround = this.bot.blockAt(groundPosition);
    const openPlantingSpace = this.bot.blockAt(cropPosition);

    if (!plantableGround || !this.isPlantingSpaceEmpty(openPlantingSpace)) {
      return;
    }

    if (!this.canPlantOn(plantableGround)) {
      return;
    }

    await this.plantCrop(plot.definition, plantableGround);
  }

  private async restockPlantingItems(): Promise<void> {
    const uniqueRequests = [...new Set(this.supportedPlots.map((plot) => plot.definition.plantedItemId))]
      .map((itemId) => ({
        itemId,
        targetCount: 64 * this.maximumSeedStacks,
      }));

    if (uniqueRequests.length === 0) {
      return;
    }

    const storageOrigin = this.toVec3(this.rallyPoint);
    const withdrawn = await this.chestInventoryManager.restockItems(storageOrigin, uniqueRequests);
    const withdrawnSummary = [...withdrawn.entries()]
      .map(([itemId, amount]) => `${itemId}=${amount}`)
      .join(', ');

    if (withdrawnSummary.length > 0) {
      this.logger.info(`Restocked farm supplies from nearby chests: ${withdrawnSummary}.`);
    }

    for (const request of uniqueRequests) {
      if (this.countInventoryItems(request.itemId) <= 0) {
        this.logger.warn(`Нет нужной культуры в ящиках: ${request.itemId}.`);
      }
    }
  }

  private async storeFarmLoot(): Promise<void> {
    const deposited = await this.chestInventoryManager.depositUnneededItems(
      this.toVec3(this.rallyPoint),
      (item) => this.shouldKeepItemAfterRoute(item),
    );

    if (deposited > 0) {
      this.logger.info(`Deposited ${deposited} farm item(s) into the nearby storage chests.`);
    }
  }

  private shouldKeepItemAfterRoute(item: Item): boolean {
    if (HOE_ITEM_NAMES.includes(item.name as (typeof HOE_ITEM_NAMES)[number])) {
      return true;
    }

    if (WEAPON_ITEM_NAMES.has(item.name)) {
      return true;
    }

    return KEPT_FOOD_ITEM_NAMES.has(item.name);
  }

  private async ensureWoodenHoeAvailable(): Promise<void> {
    if (this.findAnyHoe()) {
      return;
    }

    await this.moveNearIfNeeded(this.toVec3(this.rallyPoint), this.craftingTableSearchRadius);

    while (this.countInventoryItems('stick') < 2 || this.countTotalPlanks() < 2) {
      await this.ensurePlanksAvailable(4);

      while (this.countInventoryItems('stick') < 2) {
        const craftedStick = await this.craftSingleItem('stick');

        if (!craftedStick) {
          throw new Error('Could not craft sticks for the wooden hoe.');
        }
      }
    }

    const craftedHoe = await this.craftSingleItem(
      'wooden_hoe',
      this.requireNearbyCraftingTable(),
    );

    if (!craftedHoe && !this.findInventoryItem('wooden_hoe')) {
      throw new Error('Could not craft a wooden hoe.');
    }

    this.logger.info('Crafted a wooden hoe for the farm routine.');
  }

  private async ensurePlanksAvailable(minimumPlanks: number): Promise<void> {
    await this.craftAllInventoryLogsIntoPlanks();

    while (this.countTotalPlanks() < minimumPlanks) {
      await this.waitForScenarioWindow();
      await this.logHarvestingPort.gatherNearestLog();
      await this.craftAllInventoryLogsIntoPlanks();
    }
  }

  private async craftAllInventoryLogsIntoPlanks(): Promise<void> {
    while (true) {
      let craftedAny = false;

      for (const [logItemName, plankItemName] of LOG_TO_PLANK_ITEM.entries()) {
        while (this.countInventoryItems(logItemName) > 0) {
          const crafted = await this.craftSingleItem(plankItemName);

          if (!crafted) {
            break;
          }

          craftedAny = true;
        }
      }

      if (!craftedAny) {
        return;
      }
    }
  }

  private async craftSingleItem(itemName: string, craftingTable: Block | null = null): Promise<boolean> {
    await this.waitForScenarioWindow();
    const itemId = this.bot.registry.itemsByName[itemName]?.id;

    if (itemId === undefined) {
      throw new Error(`Item id for "${itemName}" is unavailable in the current registry.`);
    }

    const recipe = this.bot.recipesFor(itemId, null, 1, craftingTable)[0];

    if (!recipe) {
      return false;
    }

    if (craftingTable) {
      await this.moveNearIfNeeded(craftingTable.position, 2);
    }

    await this.bot.craft(recipe, 1, craftingTable ?? undefined);
    return true;
  }

  private requireNearbyCraftingTable(): Block {
    const craftingTable = this.findNearbyCraftingTable();

    if (!craftingTable) {
      throw new Error('Could not find a crafting table near the rally point for the farm routine.');
    }

    return craftingTable;
  }

  private findNearbyCraftingTable(): Block | null {
    const craftingTableId = this.bot.registry.blocksByName.crafting_table?.id;

    if (craftingTableId === undefined) {
      return null;
    }

    return this.bot.findBlock({
      matching: craftingTableId,
      maxDistance: this.craftingTableSearchRadius,
      point: this.toVec3(this.rallyPoint),
    });
  }

  private async harvestCrop(cropBlock: Block): Promise<void> {
    await this.bot.lookAt(cropBlock.position.offset(0.5, 0.5, 0.5), true).catch(() => undefined);
    await this.bot.dig(cropBlock, true);
    await this.bot.waitForTicks(5);
  }

  private async tillGround(groundBlock: Block): Promise<void> {
    let hoe = this.findAnyHoe();

    if (!hoe) {
      this.logger.info('Farm hoe is missing. Pausing the farm route to craft a replacement.');
      await this.ensureWoodenHoeAvailable();
      hoe = this.findAnyHoe();
    }

    if (!hoe) {
      return;
    }

    await this.bot.equip(hoe, 'hand').catch(() => undefined);
    await this.bot.lookAt(groundBlock.position.offset(0.5, 0.5, 0.5), true).catch(() => undefined);
    await this.bot.activateBlock(groundBlock).catch(() => undefined);
    await this.bot.waitForTicks(5);
  }

  private async plantCrop(definition: FarmCropDefinition, groundBlock: Block): Promise<void> {
    const plantingItem = this.findInventoryItem(definition.plantedItemId);

    if (!plantingItem) {
      return;
    }

    await this.bot.equip(plantingItem, 'hand').catch(() => undefined);
    await this.bot.lookAt(groundBlock.position.offset(0.5, 0.5, 0.5), true).catch(() => undefined);
    await this.bot.activateBlock(groundBlock).catch(() => undefined);
    await this.bot.waitForTicks(5);
  }

  private shouldRetreatToShelter(): boolean {
    return this.hasTakenDamageSinceLastCheck() || this.isCreeperNearby();
  }

  private async retreatToShelterUntilSafe(): Promise<void> {
    this.logger.warn('Farmer detected danger and is retreating to the shelter.');
    await this.enterShelterAndCloseDoor();

    while (this.isScenarioActive()) {
      await this.waitForScenarioWindow();
      await this.enterShelterAndCloseDoor();
      this.observeCurrentHealth();

      if (this.isSafeToLeaveShelter()) {
        return;
      }

      await this.bot.waitForTicks(this.retreatCheckTicks);
    }
  }

  private isSafeToLeaveShelter(): boolean {
    return this.isDaytime() && !this.hasThreatNearShelter();
  }

  private isDaytime(): boolean {
    const timeOfDay = this.bot.time.timeOfDay;

    if (timeOfDay === null || timeOfDay === undefined) {
      return true;
    }

    const normalizedTime = ((timeOfDay % 24000) + 24000) % 24000;
    return normalizedTime < 12000;
  }

  private hasThreatNearShelter(): boolean {
    const shelterCenter = this.toVec3(this.rallyPoint);

    return Object.values(this.bot.entities).some((entity) => {
      if (!entity || !entity.isValid) {
        return false;
      }

      if (entity.id === this.bot.entity?.id) {
        return false;
      }

      if (!entity.position || entity.position.distanceTo(shelterCenter) > this.shelterThreatRadius) {
        return false;
      }

      return this.isThreatEntity(entity);
    });
  }

  private isCreeperNearby(): boolean {
    if (!this.bot.entity) {
      return false;
    }

    return Object.values(this.bot.entities).some((entity) => {
      if (!entity || !entity.isValid) {
        return false;
      }

      if (!entity.position || entity.position.distanceTo(this.bot.entity!.position) > this.nearbyThreatRadius) {
        return false;
      }

      const entityName = `${entity.name ?? ''}${entity.displayName ?? ''}`.toLowerCase();
      return entityName.includes('creeper');
    });
  }

  private isThreatEntity(entity: {
    type?: string;
    kind?: string;
    name?: string;
    displayName?: string;
    username?: string;
  }): boolean {
    if (entity.type === 'player') {
      return typeof entity.username === 'string' && entity.username !== this.bot.username;
    }

    const entityName = `${entity.name ?? ''}${entity.displayName ?? ''}`.toLowerCase();

    if (entityName.includes('creeper')) {
      return true;
    }

    return entity.kind?.toLowerCase().includes('hostile') ?? false;
  }

  private hasTakenDamageSinceLastCheck(): boolean {
    if (typeof this.bot.health !== 'number') {
      return false;
    }

    if (this.observedHealth === null) {
      this.observedHealth = this.bot.health;
      return false;
    }

    const tookDamage = this.bot.health < this.observedHealth;
    this.observedHealth = this.bot.health;
    return tookDamage;
  }

  private observeCurrentHealth(): void {
    this.observedHealth = typeof this.bot.health === 'number' ? this.bot.health : null;
  }

  private shouldPauseForNightlyShelter(): boolean {
    return this.bot.isSleeping || this.nightTimingService.shouldReturnToShelter(this.bot.time.timeOfDay ?? null);
  }

  private hasCompletedFarmWorkToday(): boolean {
    const currentFarmDay = this.getCurrentFarmDay();

    return currentFarmDay !== null && this.lastCompletedFarmDay === currentFarmDay;
  }

  private markFarmWorkCompletedForToday(): void {
    const currentFarmDay = this.getCurrentFarmDay();

    if (currentFarmDay !== null) {
      this.lastCompletedFarmDay = currentFarmDay;
    }
  }

  private getCurrentFarmDay(): number | null {
    const normalizedTimeOfDay = this.getNormalizedTimeOfDay();
    const explicitDay = this.getExplicitFarmDay();

    if (this.inferredFarmDay === null) {
      this.inferredFarmDay = explicitDay ?? 0;
    } else if (
      normalizedTimeOfDay !== null &&
      this.observedTimeOfDay !== null &&
      normalizedTimeOfDay < this.observedTimeOfDay
    ) {
      this.inferredFarmDay += 1;
    }

    if (explicitDay !== null && explicitDay > this.inferredFarmDay) {
      this.inferredFarmDay = explicitDay;
    }

    if (normalizedTimeOfDay !== null) {
      this.observedTimeOfDay = normalizedTimeOfDay;
    }

    if (this.inferredFarmDay !== null) {
      return this.inferredFarmDay;
    }

    return explicitDay;
  }

  private getExplicitFarmDay(): number | null {
    const time = this.bot.time as { day?: number };

    return typeof time.day === 'number' && Number.isFinite(time.day) ? time.day : null;
  }

  private getNormalizedTimeOfDay(): number | null {
    const timeOfDay = this.bot.time.timeOfDay;

    if (typeof timeOfDay !== 'number' || !Number.isFinite(timeOfDay)) {
      return null;
    }

    return ((timeOfDay % 24000) + 24000) % 24000;
  }

  private async ensureOutsideShelter(): Promise<boolean> {
    if (!this.isBotWithinShelterBounds()) {
      return true;
    }

    const exited = await this.exitShelterThroughDoor();

    if (!exited) {
      this.logger.info('Farm bot could not leave the shelter through the door yet. Retrying shortly.');
    }

    return exited;
  }

  private async waitForScenarioWindow(): Promise<void> {
    this.ensureScenarioActive();
    await this.waitUntilTaskMayProceed();
    this.ensureScenarioActive();
  }

  private async enterShelterAndCloseDoor(): Promise<void> {
    if (this.isBotInsideShelter()) {
      const doorPosition = this.getShelterDoorPosition();
      await this.closeShelterDoorIfOpen(doorPosition);
      return;
    }

    const doorPosition = this.getShelterDoorPosition();
    const interiorAnchor = this.getShelterInteriorAnchor(doorPosition);
    const outsideApproach = this.getOutsideDoorApproachPosition(doorPosition, interiorAnchor);

    for (let attempt = 1; attempt <= this.shelterDoorEntryAttempts; attempt += 1) {
      await this.gotoPosition(outsideApproach, 1).catch(() => undefined);
      await this.openShelterDoorIfNeeded(doorPosition);

      if (!this.isBotInsideShelter()) {
        await this.stepTowards(interiorAnchor, 16);
      }

      if (!this.isBotInsideShelter()) {
        await this.gotoPosition(interiorAnchor, 1).catch(() => undefined);
      }

      if (this.isBotInsideShelter()) {
        await this.closeShelterDoorIfOpen(doorPosition);
        return;
      }

      await this.bot.waitForTicks(10);
    }
  }

  private async exitShelterThroughDoor(): Promise<boolean> {
    const doorPosition = this.getShelterDoorPosition();
    const interiorAnchor = this.getShelterInteriorAnchor(doorPosition);
    const outsideApproach = this.getOutsideDoorApproachPosition(doorPosition, interiorAnchor);

    for (let attempt = 1; attempt <= this.shelterDoorEntryAttempts; attempt += 1) {
      await this.gotoPosition(interiorAnchor, 1).catch(() => undefined);
      await this.openShelterDoorIfNeeded(doorPosition);

      if (this.isBotInsideShelter()) {
        await this.stepTowards(outsideApproach, 16);
      }

      if (this.isBotInsideShelter()) {
        await this.gotoPosition(outsideApproach, 1).catch(() => undefined);
      }

      if (!this.isBotInsideShelter()) {
        return true;
      }

      await this.bot.waitForTicks(10);
    }

    return false;
  }

  private getShelterDoorPosition(): Vec3 {
    return this.findNearestShelterDoor()?.position.clone() ??
      this.toBlockVec3(this.shelterLayout.getDoorPosition(this.rallyPoint));
  }

  private getShelterInteriorAnchor(doorPosition: Vec3): Vec3 {
    return (
      this.getDoorApproachPositions(doorPosition).find((position) => this.isInsideShelterArea(position)) ??
      this.toBlockVec3(this.shelterLayout.getInteriorAnchor(this.rallyPoint))
    );
  }

  private getOutsideDoorApproachPosition(doorPosition: Vec3, interiorAnchor: Vec3): Vec3 {
    const outwardOffset = doorPosition.minus(interiorAnchor);

    return doorPosition.plus(outwardOffset);
  }

  private findNearestShelterDoor(): Block | null {
    if (!this.bot.entity) {
      return null;
    }

    const rallyCenter = this.toVec3(this.rallyPoint);
    let nearestDoor: Block | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;

    for (let dx = -this.shelterDoorSearchRadius; dx <= this.shelterDoorSearchRadius; dx += 1) {
      for (let dy = -1; dy <= 2; dy += 1) {
        for (let dz = -this.shelterDoorSearchRadius; dz <= this.shelterDoorSearchRadius; dz += 1) {
          const candidate = this.bot.blockAt(rallyCenter.offset(dx, dy, dz));

          if (!candidate || !candidate.name.endsWith('_door')) {
            continue;
          }

          const normalizedDoor = this.normalizeDoorBlock(candidate.position);

          if (!normalizedDoor) {
            continue;
          }

          const distanceToBot = this.bot.entity.position.distanceTo(normalizedDoor.position);

          if (distanceToBot >= nearestDistance) {
            continue;
          }

          nearestDistance = distanceToBot;
          nearestDoor = normalizedDoor;
        }
      }
    }

    return nearestDoor;
  }

  private normalizeDoorBlock(position: Vec3): Block | null {
    const block = this.bot.blockAt(position);

    if (!block || !block.name.endsWith('_door')) {
      return null;
    }

    const properties = block.getProperties();

    if (properties.half === 'upper') {
      const lowerDoorBlock = this.bot.blockAt(position.offset(0, -1, 0));
      return lowerDoorBlock && lowerDoorBlock.name.endsWith('_door') ? lowerDoorBlock : null;
    }

    return block;
  }

  private getDoorApproachPositions(doorPosition: Vec3): Vec3[] {
    const rallyCenter = this.toVec3(this.rallyPoint);

    return this.getCardinalOffsets()
      .map((offset) => doorPosition.plus(offset))
      .sort((left, right) => left.distanceSquared(rallyCenter) - right.distanceSquared(rallyCenter));
  }

  private getCardinalOffsets(): Vec3[] {
    return [
      new Vec3(1, 0, 0),
      new Vec3(-1, 0, 0),
      new Vec3(0, 0, 1),
      new Vec3(0, 0, -1),
    ];
  }

  private async openShelterDoorIfNeeded(doorPosition: Vec3): Promise<void> {
    const lowerDoorBlock = this.bot.blockAt(doorPosition);

    if (lowerDoorBlock && lowerDoorBlock.name.endsWith('_door') && lowerDoorBlock.getProperties().open !== true) {
      await this.bot.lookAt(doorPosition.offset(0.5, 0.5, 0.5), true).catch(() => undefined);
      await this.bot.activateBlock(lowerDoorBlock).catch(() => undefined);
      await this.bot.waitForTicks(10);
    }
  }

  private async closeShelterDoorIfOpen(doorPosition: Vec3): Promise<void> {
    const lowerDoorBlock = this.bot.blockAt(doorPosition);

    if (lowerDoorBlock && lowerDoorBlock.name.endsWith('_door') && lowerDoorBlock.getProperties().open === true) {
      await this.bot.lookAt(doorPosition.offset(0.5, 0.5, 0.5), true).catch(() => undefined);
      await this.bot.activateBlock(lowerDoorBlock).catch(() => undefined);
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

  private isBotInsideShelter(): boolean {
    if (!this.bot.entity) {
      return false;
    }

    return this.isInsideShelterArea(this.bot.entity.position.floored());
  }

  private isBotWithinShelterBounds(): boolean {
    if (!this.bot.entity) {
      return false;
    }

    const position = this.toBlockPosition(this.bot.entity.position);
    const wallPositions = this.shelterLayout.getWallPositions(this.rallyPoint);

    if (wallPositions.length === 0) {
      return this.isBotInsideShelter();
    }

    const minX = Math.min(...wallPositions.map((wall) => wall.x));
    const maxX = Math.max(...wallPositions.map((wall) => wall.x));
    const minZ = Math.min(...wallPositions.map((wall) => wall.z));
    const maxZ = Math.max(...wallPositions.map((wall) => wall.z));

    return (
      position.x >= minX &&
      position.x <= maxX &&
      position.z >= minZ &&
      position.z <= maxZ &&
      position.y === this.rallyPoint.y
    );
  }

  private isInsideShelterArea(position: Vec3): boolean {
    return this.shelterLayout.isInsideInterior(this.toBlockPosition(position), this.rallyPoint);
  }

  private getFarmCells(point: FarmPointSettings): Vec3[] {
    const center = this.toFarmPointVec3(point);
    const cells: Vec3[] = [];

    for (let ring = 1; ring <= this.farmingRadius; ring += 1) {
      for (let dx = -(ring - 1); dx <= ring; dx += 1) {
        cells.push(new Vec3(center.x + dx, center.y, center.z - ring));
      }

      for (let dz = -(ring - 1); dz <= ring; dz += 1) {
        cells.push(new Vec3(center.x + ring, center.y, center.z + dz));
      }

      for (let dx = ring - 1; dx >= -ring; dx -= 1) {
        cells.push(new Vec3(center.x + dx, center.y, center.z + ring));
      }

      for (let dz = ring - 1; dz >= -ring; dz -= 1) {
        cells.push(new Vec3(center.x - ring, center.y, center.z + dz));
      }
    }

    const uniqueCells = new Map<string, Vec3>();

    for (const cell of cells) {
      if (cell.x === center.x && cell.z === center.z) {
        continue;
      }

      uniqueCells.set(`${cell.x}:${cell.y}:${cell.z}`, cell);
    }

    return [...uniqueCells.values()];
  }

  private isMatureCropBlock(block: Block, definition: FarmCropDefinition): boolean {
    if (block.name !== definition.cropBlockName) {
      return false;
    }

    const age = this.getCropAge(block);
    return age !== null && age >= definition.matureAge;
  }

  private getCropDefinitionForBlock(block: Block): FarmCropDefinition | null {
    return [...FARM_CROP_DEFINITIONS.values()].find((definition) => definition.cropBlockName === block.name) ?? null;
  }

  private getCropAge(block: Block): number | null {
    const age = block.getProperties().age;

    if (typeof age === 'number' && Number.isFinite(age)) {
      return age;
    }

    if (typeof age === 'string') {
      const parsedAge = Number(age);
      return Number.isFinite(parsedAge) ? parsedAge : null;
    }

    return null;
  }

  private isPlantingSpaceEmpty(block: Block | null): boolean {
    return !block || block.name === 'air' || block.boundingBox === 'empty';
  }

  private requiresTilling(block: Block): boolean {
    return block.name === 'dirt' || block.name === 'grass_block';
  }

  private canPlantOn(block: Block): boolean {
    return block.name === 'farmland';
  }

  private findAnyHoe(): Item | undefined {
    return this.bot.inventory
      .items()
      .find((item) => HOE_ITEM_NAMES.includes(item.name as (typeof HOE_ITEM_NAMES)[number]));
  }

  private countInventoryItems(itemId: string): number {
    return this.bot.inventory.items().reduce((total, item) => {
      return item.name === itemId ? total + item.count : total;
    }, 0);
  }

  private countTotalPlanks(): number {
    return this.bot.inventory.items().reduce((total, item) => {
      return PLANK_ITEM_NAMES.includes(item.name) ? total + item.count : total;
    }, 0);
  }

  private findInventoryItem(itemName: string): Item | undefined {
    return this.bot.inventory.items().find((item) => item.name === itemName);
  }

  private logUnsupportedCrops(): void {
    for (const plot of this.settings.farms) {
      if (FARM_CROP_DEFINITIONS.has(plot.itemId)) {
        continue;
      }

      this.logger.warn(
        `Farm crop "${plot.itemId}" is not supported yet and will be skipped by the farm routine.`,
      );
    }
  }

  private ensureScenarioActive(): void {
    if (!this.isScenarioActive()) {
      throw new Error('Farm routine was cancelled.');
    }
  }

  private toVec3(position: BotRallyPoint | FarmPointSettings): Vec3 {
    return new Vec3(position.x, position.y, position.z);
  }

  private toFarmPointVec3(point: FarmPointSettings): Vec3 {
    return new Vec3(Math.round(point.x), Math.round(point.y), Math.round(point.z));
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

  private async moveNearIfNeeded(target: Vec3, range: number): Promise<void> {
    if (!this.bot.entity) {
      return;
    }

    if (this.bot.entity.position.distanceTo(target) <= range + 0.5) {
      return;
    }

    await this.gotoPosition(target, range).catch(() => undefined);
  }

  private async moveToFarmCell(target: Vec3): Promise<boolean> {
    if (this.bot.entity && this.bot.entity.position.distanceTo(target) <= 0.25) {
      return true;
    }

    for (const candidate of this.getFarmCellInspectionTargets(target)) {
      try {
        await this.gotoFarmPosition(candidate, this.farmCellInspectionRange);
      } catch {
        continue;
      }

      if (this.canInspectFarmCellFrom(target)) {
        return true;
      }
    }

    return this.canInspectFarmCellFrom(target);
  }

  private async gotoFarmPosition(target: Vec3, range: number): Promise<void> {
    if (!this.bot.pathfinder) {
      await this.gotoPosition(target, range);
      return;
    }

    const movements = this.createFarmMovements();
    this.bot.pathfinder.setMovements(movements);

    try {
      await this.bot.pathfinder.goto(new GoalNear(target.x, target.y, target.z, range));
    } finally {
      this.bot.pathfinder.stop();
    }
  }

  private async gotoFarmPoint(point: FarmPointSettings): Promise<void> {
    const center = this.toFarmPointVec3(point);
    let lastError: unknown = null;

    try {
      await this.gotoFarmPosition(center, this.farmPointArrivalRange);
      return;
    } catch (error) {
      lastError = error;
    }

    for (const target of this.getFarmPointApproachTargets(center)) {
      try {
        await this.gotoFarmPosition(target, this.farmPointFallbackRange);
        return;
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError instanceof Error ? lastError : new Error('No reachable approach path to the farm point.');
  }

  private getFarmPointApproachTargets(center: Vec3): Vec3[] {
    const ring = this.farmingRadius + 1;
    const targets = [
      new Vec3(center.x, center.y, center.z - ring),
      new Vec3(center.x + ring, center.y, center.z),
      new Vec3(center.x, center.y, center.z + ring),
      new Vec3(center.x - ring, center.y, center.z),
      new Vec3(center.x + ring, center.y, center.z - ring),
      new Vec3(center.x + ring, center.y, center.z + ring),
      new Vec3(center.x - ring, center.y, center.z + ring),
      new Vec3(center.x - ring, center.y, center.z - ring),
    ];

    return [...new Map(targets.map((target) => [`${target.x}:${target.y}:${target.z}`, target])).values()];
  }

  private getFarmCellInspectionTargets(cell: Vec3): Vec3[] {
    const adjacentCandidates = [
      cell.offset(1, 0, 0),
      cell.offset(-1, 0, 0),
      cell.offset(0, 0, 1),
      cell.offset(0, 0, -1),
      cell.offset(1, 0, 1),
      cell.offset(1, 0, -1),
      cell.offset(-1, 0, 1),
      cell.offset(-1, 0, -1),
    ];

    if (!this.bot.entity) {
      return [cell, ...new Map(adjacentCandidates.map((target) => [`${target.x}:${target.y}:${target.z}`, target])).values()];
    }

    const sortedAdjacentCandidates = [...new Map(adjacentCandidates.map((target) => [`${target.x}:${target.y}:${target.z}`, target])).values()]
      .sort((left, right) => left.distanceSquared(this.bot.entity!.position) - right.distanceSquared(this.bot.entity!.position));

    return [cell, ...sortedAdjacentCandidates];
  }

  private canInspectFarmCellFrom(cell: Vec3): boolean {
    if (!this.bot.entity) {
      return false;
    }

    return this.bot.entity.position.distanceTo(cell) <= 1.75;
  }

  private inspectFarmCell(plot: SupportedFarmPlot, groundPosition: Vec3): FarmCellInspection {
    const cropPosition = groundPosition.offset(0, 1, 0);
    const cropBlock = this.bot.blockAt(cropPosition);

    if (cropBlock) {
      const cropDefinition = this.getCropDefinitionForBlock(cropBlock);

      if (cropDefinition && this.isMatureCropBlock(cropBlock, cropDefinition)) {
        return {
          needsInteraction: true,
          needsHarvest: true,
          needsPlanting: true,
        };
      }

      if (!this.isPlantingSpaceEmpty(cropBlock)) {
        return {
          needsInteraction: false,
          needsHarvest: false,
          needsPlanting: false,
        };
      }
    }

    const groundBlock = this.bot.blockAt(groundPosition);
    const hasSeeds = this.countInventoryItems(plot.definition.plantedItemId) > 0;

    if (!groundBlock || !hasSeeds) {
      return {
        needsInteraction: false,
        needsHarvest: false,
        needsPlanting: false,
      };
    }

    const needsPlanting = this.requiresTilling(groundBlock) || this.canPlantOn(groundBlock);

    return {
      needsInteraction: needsPlanting,
      needsHarvest: false,
      needsPlanting,
    };
  }

  private createFarmMovements(): PathfinderMovements {
    const movements = new Movements(this.bot) as PathfinderMovements;

    movements.canDig = false;
    movements.allow1by1towers = false;
    movements.allowParkour = false;
    movements.allowSprinting = false;
    movements.canOpenDoors = true;
    movements.maxDropDown = 1;

    return movements;
  }
}
