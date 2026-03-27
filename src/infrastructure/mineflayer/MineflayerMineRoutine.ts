import { Block } from 'prismarine-block';
import { Item } from 'prismarine-item';
import { Vec3 } from 'vec3';
import { MineRoleSettings } from '../../domain/bot/entities/RoleSettings';
import { MineRoutineProgress } from '../../domain/bot/entities/MineRoutineProgress';
import { Logger } from '../../application/shared/ports/Logger';
import { BotRallyPoint } from '../../domain/bot/entities/BotConfiguration';
import { NightlyShelterTimingService } from '../../application/bot/services/NightlyShelterTimingService';
import { BlockPosition, ShelterLayoutService } from '../../application/bot/services/ShelterLayoutService';
import { MineRoutineProgressStore } from '../../application/bot/ports/MineRoutineProgressStore';
import { MineflayerChestInventoryManager } from './MineflayerChestInventoryManager';
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

const PLANK_ITEM_NAMES = [...new Set(LOG_TO_PLANK_ITEM.values())];
const PICKAXE_ITEM_NAMES = [
  'netherite_pickaxe',
  'diamond_pickaxe',
  'iron_pickaxe',
  'stone_pickaxe',
  'golden_pickaxe',
  'wooden_pickaxe',
] as const;
const WEAPON_ITEM_NAMES = new Set([
  'wooden_sword',
  'stone_sword',
  'iron_sword',
  'diamond_sword',
  'netherite_sword',
]);
const KEPT_FOOD_ITEM_NAMES = new Set([
  'cooked_mutton',
  'cooked_beef',
  'cooked_porkchop',
  'cooked_chicken',
  'baked_potato',
]);
const PASSABLE_BLOCK_NAMES = new Set([
  'air',
  'cave_air',
  'void_air',
  'torch',
  'wall_torch',
  'redstone_torch',
  'redstone_wall_torch',
]);

export class MineflayerMineRoutine {
  private readonly craftingTableSearchRadius = 4;
  private readonly minimumFreeInventorySlots = 2;
  private readonly targetTorchCount = 32;
  private readonly minimumTorchCount = 8;
  private readonly torchPlacementInterval = 10;
  private readonly entryRange = 1;
  private readonly hubRadius = 2;
  private readonly branchCount = 4;
  private readonly branchDeviationLimit = 4;
  private readonly layerForwardStep = 6;
  private readonly layerDepthStep = 4;
  private readonly minimumMiningY = 5;
  private readonly idleCheckTicks = 20;
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
  private inferredMineDay: number | null = null;
  private observedTimeOfDay: number | null = null;
  private storageBlockedDay: number | null = null;
  private staircaseProgress = 0;
  private currentLayerIndex = 0;
  private currentBranchIndex = 0;
  private currentBranchProgress = 0;
  private minePlanComplete = false;
  private readonly reportedBlockedPositions = new Set<string>();

  constructor(
    private readonly bot: BotWithPathfinder,
    private readonly logger: Logger,
    private readonly rallyPoint: BotRallyPoint,
    private readonly settings: MineRoleSettings,
    private readonly gotoPosition: (target: Vec3, range: number) => Promise<void>,
    private readonly logHarvestingPort: MineflayerLogHarvestingPort,
    private readonly nearbyDroppedItemCollector: MineflayerNearbyDroppedItemCollector,
    private readonly progressStore: MineRoutineProgressStore,
    private readonly isScenarioActive: () => boolean,
    private readonly waitUntilTaskMayProceed: () => Promise<void>,
  ) {
    this.chestInventoryManager = new MineflayerChestInventoryManager(bot, logger, gotoPosition);
    this.restoreProgress();
  }

  async maintain(): Promise<void> {
    while (this.isScenarioActive()) {
      try {
        await this.waitForScenarioWindow();

        if (!this.isScenarioActive()) {
          return;
        }

        if (this.shouldPauseForNightlyShelter()) {
          await this.enterShelterAndCloseDoor();
          await this.bot.waitForTicks(this.idleCheckTicks);
          continue;
        }

        if (this.isStorageBlockedForToday()) {
          await this.enterShelterAndCloseDoor();
          await this.bot.waitForTicks(this.idleCheckTicks);
          continue;
        }

        const exitedShelter = await this.ensureOutsideShelter();

        if (!exitedShelter) {
          await this.bot.waitForTicks(this.idleCheckTicks);
          continue;
        }

        if (this.needsInventoryUnload()) {
          const stored = await this.storeMineLoot();

          if (!stored) {
            await this.bot.waitForTicks(this.idleCheckTicks);
            continue;
          }
        }

        await this.ensureMiningSuppliesAvailable();

        if (!this.isScenarioActive() || this.shouldPauseForNightlyShelter()) {
          continue;
        }

        await this.advanceMine();
        await this.bot.waitForTicks(this.idleCheckTicks);
      } catch (error) {
        if (!this.isRetryableNavigationInterruption(error)) {
          throw error;
        }

        this.logger.info(
          `Mining step was interrupted and will be retried: ${this.stringifyError(error)}.`,
        );
        await this.bot.waitForTicks(this.idleCheckTicks);
      }
    }
  }

  private async advanceMine(): Promise<void> {
    if (this.minePlanComplete || this.isMineComplete()) {
      await this.enterShelterAndCloseDoor();
      return;
    }

    const mineEntry = this.getMineEntryPosition();
    await this.gotoPosition(mineEntry, this.entryRange);

    await this.excavateStaircase();

    if (
      !this.isScenarioActive() ||
      this.shouldPauseForNightlyShelter() ||
      this.isStorageBlockedForToday() ||
      this.needsInventoryUnload()
    ) {
      return;
    }

    await this.ensureCurrentLayerAccessible();

    if (
      !this.isScenarioActive() ||
      this.shouldPauseForNightlyShelter() ||
      this.isStorageBlockedForToday() ||
      this.needsInventoryUnload()
    ) {
      return;
    }

    await this.excavateCurrentBranch();
  }

  private async excavateStaircase(): Promise<void> {
    const targetDepth = this.getTargetMineDepth();

    while (this.staircaseProgress < targetDepth && this.isScenarioActive()) {
      await this.waitForScenarioWindow();

      if (this.shouldPauseForNightlyShelter() || this.needsInventoryUnload()) {
        return;
      }

      const floor = this.getStairFloor(this.staircaseProgress + 1);
      const cleared = await this.clearCorridorAt(floor);

      if (!cleared) {
        return;
      }

      await this.moveNearIfNeeded(floor, 0);
      this.staircaseProgress += 1;
      this.saveProgress();
      await this.mineExposedOresNear(floor);
      await this.placeTorchIfNeeded(floor, this.staircaseProgress, false);
    }
  }

  private async ensureCurrentLayerAccessible(): Promise<void> {
    for (let layerIndex = 0; layerIndex <= this.currentLayerIndex; layerIndex += 1) {
      await this.waitForScenarioWindow();

      if (this.shouldPauseForNightlyShelter() || this.needsInventoryUnload()) {
        return;
      }

      if (layerIndex > 0) {
        await this.excavateLayerTransition(layerIndex);

        if (this.minePlanComplete) {
          return;
        }
      }

      const preparedHub = await this.excavateLayerHub(layerIndex);

      if (!preparedHub) {
        return;
      }
    }
  }

  private async excavateCurrentBranch(): Promise<void> {
    const targetLength = Math.max(0, Math.floor(this.settings.shaft.shaftLength));

    while (this.currentBranchProgress < targetLength && this.isScenarioActive()) {
      await this.waitForScenarioWindow();

      if (this.shouldPauseForNightlyShelter() || this.needsInventoryUnload()) {
        return;
      }

      const floor = this.getBranchFloor(
        this.currentLayerIndex,
        this.currentBranchIndex,
        this.currentBranchProgress + 1,
      );
      const cleared = await this.clearCorridorAt(floor);

      if (!cleared) {
        this.logger.warn(
          `Mine branch ${this.getBranchLabel(this.currentBranchIndex)} on layer ${this.currentLayerIndex + 1} was blocked. Switching to the next branch.`,
        );
        this.advanceToNextBranch();
        return;
      }

      await this.moveNearIfNeeded(floor, 0);
      this.currentBranchProgress += 1;
      this.saveProgress();
      await this.mineExposedOresNear(floor);
      await this.placeTorchIfNeeded(floor, this.currentBranchProgress, true);
    }

    if (this.currentBranchProgress >= targetLength) {
      this.advanceToNextBranch();
    }
  }

  private async clearCorridorAt(floor: Vec3): Promise<boolean> {
    for (const position of this.getCorridorExcavationPositions(floor)) {
      await this.waitForScenarioWindow();

      const block = this.bot.blockAt(position);

      if (!block || PASSABLE_BLOCK_NAMES.has(block.name)) {
        continue;
      }

      const cleared = await this.excavateBlock(block);

      if (!cleared) {
        return false;
      }
    }

    return true;
  }

  private async excavateLayerTransition(layerIndex: number): Promise<void> {
    const previousHub = this.getLayerHubCenter(layerIndex - 1);
    const nextHub = this.getLayerHubCenter(layerIndex);
    const direction = this.getMineDirection();

    for (let step = 1; step <= this.layerForwardStep; step += 1) {
      const verticalDrop = Math.floor((step * this.layerDepthStep) / this.layerForwardStep);
      const floor = new Vec3(
        previousHub.x + direction.x * step,
        previousHub.y - verticalDrop,
        previousHub.z + direction.z * step,
      );
      const cleared = await this.clearCorridorAt(floor);

      if (!cleared) {
        this.minePlanComplete = true;
        return;
      }

      await this.placeTorchIfNeeded(floor, step, false);
    }

    await this.moveNearIfNeeded(nextHub, 1);
  }

  private async excavateLayerHub(layerIndex: number): Promise<boolean> {
    const hubCenter = this.getLayerHubCenter(layerIndex);

    for (const floor of this.getHubFloorPositions(hubCenter)) {
      const cleared = await this.clearCorridorAt(floor);

      if (!cleared) {
        return false;
      }
    }

    await this.moveNearIfNeeded(hubCenter, 1);
    await this.placeHubTorches(hubCenter);
    return true;
  }

  private async excavateBlock(block: Block): Promise<boolean> {
    if (this.isLiquidBlock(block.name)) {
      this.logger.warn(
        `Mining routine stopped at ${block.position.x} ${block.position.y} ${block.position.z}: encountered ${block.name}.`,
      );
      return false;
    }

    await this.ensurePickaxeAvailable();
    await this.equipBestPickaxe();

    if (this.isStonePickaxeInsufficient(block) && !this.hasBetterThanStonePickaxe()) {
      await this.reportUnbreakableBlock(block.position);
      return false;
    }

    if (!this.bot.canDigBlock(block)) {
      this.logger.warn(
        `Could not dig ${block.name} at ${block.position.x} ${block.position.y} ${block.position.z}.`,
      );
      return false;
    }

    await this.bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true).catch(() => undefined);
    await this.bot.dig(block, true);
    await this.nearbyDroppedItemCollector.collectAround(block.position, 4, 3).catch(() => undefined);
    return true;
  }

  private async mineExposedOresNear(floor: Vec3): Promise<void> {
    const visited = new Set<string>();

    for (const candidate of this.getAdjacentInspectionPositions(floor)) {
      const key = `${candidate.x}:${candidate.y}:${candidate.z}`;

      if (visited.has(key)) {
        continue;
      }

      visited.add(key);
      const block = this.bot.blockAt(candidate);

      if (!block || !this.isOreBlock(block.name) || PASSABLE_BLOCK_NAMES.has(block.name)) {
        continue;
      }

      if (this.isStonePickaxeInsufficient(block) && !this.hasBetterThanStonePickaxe()) {
        await this.reportUnbreakableBlock(block.position);
        continue;
      }

      try {
        await this.gotoPosition(block.position, 1);
      } catch {
        continue;
      }

      await this.mineOreVein(block.position, floor);
      await this.moveNearIfNeeded(floor, 1);
    }
  }

  private async mineOreVein(seedPosition: Vec3, anchor: Vec3): Promise<void> {
    const queue: Vec3[] = [seedPosition.clone()];
    const visited = new Set<string>();

    while (queue.length > 0 && this.isScenarioActive()) {
      const position = queue.shift()!;
      const key = `${position.x}:${position.y}:${position.z}`;

      if (visited.has(key) || position.distanceTo(anchor) > this.branchDeviationLimit + 0.5) {
        continue;
      }

      visited.add(key);
      const block = this.bot.blockAt(position);

      if (!block || !this.isOreBlock(block.name)) {
        continue;
      }

      try {
        await this.gotoPosition(position, 1);
      } catch {
        continue;
      }

      const dug = await this.excavateBlock(block);

      if (!dug) {
        continue;
      }

      for (const offset of this.getCardinalAndVerticalOffsets()) {
        queue.push(position.plus(offset));
      }
    }
  }

  private async ensureMiningSuppliesAvailable(): Promise<void> {
    await this.restockMiningMaterials();
    await this.ensurePickaxeAvailable();
    await this.ensureTorchesAvailable();
  }

  private async restockMiningMaterials(): Promise<void> {
    const requests = [
      { itemId: 'torch', targetCount: this.targetTorchCount },
      { itemId: 'cobblestone', targetCount: 3 },
      { itemId: 'stick', targetCount: 8 },
      { itemId: 'coal', targetCount: 8 },
      { itemId: 'charcoal', targetCount: 8 },
      ...PLANK_ITEM_NAMES.map((itemId) => ({ itemId, targetCount: 8 })),
      ...[...LOG_TO_PLANK_ITEM.keys()].map((itemId) => ({ itemId, targetCount: 4 })),
    ];
    const withdrawn = await this.chestInventoryManager.restockItems(this.toVec3(this.rallyPoint), requests);
    const summary = [...withdrawn.entries()]
      .map(([itemId, amount]) => `${itemId}=${amount}`)
      .join(', ');

    if (summary.length > 0) {
      this.logger.info(`Restocked mining supplies from nearby chests: ${summary}.`);
    }
  }

  private async ensurePickaxeAvailable(): Promise<void> {
    if (this.findBestPickaxe()) {
      return;
    }

    await this.moveNearIfNeeded(this.toVec3(this.rallyPoint), this.craftingTableSearchRadius);

    if (await this.tryCraftStonePickaxe()) {
      return;
    }

    if (await this.tryCraftWoodenPickaxe()) {
      return;
    }

    while (!this.findBestPickaxe()) {
      await this.ensurePlanksAvailable(4);

      if (await this.tryCraftWoodenPickaxe()) {
        return;
      }
    }
  }

  private async tryCraftStonePickaxe(): Promise<boolean> {
    await this.ensureSticksAvailable(2);

    if (this.countInventoryItems('cobblestone') < 3) {
      return false;
    }

    const crafted = await this.craftSingleItem('stone_pickaxe', this.requireNearbyCraftingTable());

    if (!crafted && !this.findInventoryItem('stone_pickaxe')) {
      return false;
    }

    this.logger.info('Crafted a stone pickaxe for the mining routine.');
    return true;
  }

  private async tryCraftWoodenPickaxe(): Promise<boolean> {
    await this.ensurePlanksAvailable(3);
    await this.ensureSticksAvailable(2);

    const crafted = await this.craftSingleItem('wooden_pickaxe', this.requireNearbyCraftingTable());

    if (!crafted && !this.findInventoryItem('wooden_pickaxe')) {
      return false;
    }

    this.logger.info('Crafted a wooden pickaxe for the mining routine.');
    return true;
  }

  private async ensureTorchesAvailable(): Promise<void> {
    if (this.countInventoryItems('torch') >= this.minimumTorchCount) {
      return;
    }

    await this.ensureSticksAvailable(1);

    while (
      this.countInventoryItems('torch') < this.targetTorchCount &&
      this.countInventoryItems('stick') > 0 &&
      this.countTorchFuelItems() > 0
    ) {
      const crafted = await this.craftSingleItem('torch');

      if (!crafted) {
        break;
      }
    }
  }

  private async ensureSticksAvailable(minimumSticks: number): Promise<void> {
    while (this.countInventoryItems('stick') < minimumSticks) {
      await this.ensurePlanksAvailable(2);
      const crafted = await this.craftSingleItem('stick');

      if (!crafted && this.countInventoryItems('stick') < minimumSticks) {
        throw new Error('Could not craft sticks for the mining routine.');
      }
    }
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

    try {
      await this.bot.craft(recipe, 1, craftingTable ?? undefined);
      return true;
    } catch (error) {
      if (this.isMissingIngredientCraftError(error)) {
        await this.bot.waitForTicks(5);
        return false;
      }

      throw error;
    }
  }

  private async equipBestPickaxe(): Promise<void> {
    const pickaxe = this.findBestPickaxe();

    if (!pickaxe) {
      return;
    }

    await this.bot.equip(pickaxe, 'hand').catch(() => undefined);
  }

  private async placeTorchIfNeeded(
    floor: Vec3,
    progress: number,
    allowCaveTrigger: boolean,
  ): Promise<void> {
    if (
      this.countInventoryItems('torch') <= 0 ||
      (progress % this.torchPlacementInterval !== 0 && !(allowCaveTrigger && this.hasExposedCaveNearby(floor)))
    ) {
      return;
    }

    const torchItem = this.findInventoryItem('torch');

    if (!torchItem) {
      return;
    }

    const candidates = [
      floor.clone(),
      floor.plus(this.getMineRightDirection()),
      floor.minus(this.getMineRightDirection()),
    ];

    for (const candidate of candidates) {
      const supportBlock = this.bot.blockAt(candidate.offset(0, -1, 0));
      const targetBlock = this.bot.blockAt(candidate);

      if (
        !supportBlock ||
        supportBlock.boundingBox !== 'block' ||
        (targetBlock && !PASSABLE_BLOCK_NAMES.has(targetBlock.name))
      ) {
        continue;
      }

      try {
        await this.bot.equip(torchItem, 'hand');
        await this.bot.lookAt(candidate.offset(0.5, 0.2, 0.5), true).catch(() => undefined);
        await this.bot.placeBlock(supportBlock, new Vec3(0, 1, 0));
        return;
      } catch {
        continue;
      }
    }
  }

  private async storeMineLoot(): Promise<boolean> {
    const storageOrigin = this.toVec3(this.rallyPoint);
    const deposited = await this.chestInventoryManager.depositUnneededItems(
      storageOrigin,
      (item) => this.shouldKeepItemAfterRoute(item),
    );

    if (deposited > 0) {
      this.logger.info(`Deposited ${deposited} mining item(s) into the nearby storage chests.`);
    }

    if (this.getDepositableInventoryItems().length === 0) {
      return true;
    }

    this.markStorageBlockedForToday();
    this.bot.chat('все занято');
    await this.enterShelterAndCloseDoor();
    return false;
  }

  private shouldKeepItemAfterRoute(item: Item): boolean {
    if (PICKAXE_ITEM_NAMES.includes(item.name as (typeof PICKAXE_ITEM_NAMES)[number])) {
      return true;
    }

    if (WEAPON_ITEM_NAMES.has(item.name) || KEPT_FOOD_ITEM_NAMES.has(item.name)) {
      return true;
    }

    return item.name === 'torch';
  }

  private getDepositableInventoryItems(): Item[] {
    return this.bot.inventory.items().filter((item) => !this.shouldKeepItemAfterRoute(item));
  }

  private needsInventoryUnload(): boolean {
    return (
      this.chestInventoryManager.getFreeInventorySlots() <= this.minimumFreeInventorySlots ||
      this.getDepositableInventoryItems().length >= 24
    );
  }

  private isMineComplete(): boolean {
    return this.minePlanComplete;
  }

  private getTargetMineDepth(): number {
    return Math.max(1, Math.floor(this.settings.shaft.targetDepthY));
  }

  private getMineEntryPosition(): Vec3 {
    const doorPosition = this.getShelterDoorPosition();
    const interiorAnchor = this.getShelterInteriorAnchor(doorPosition);
    const outsideApproach = this.getOutsideDoorApproachPosition(doorPosition, interiorAnchor);
    const outward = outsideApproach.minus(doorPosition);
    const direction = new Vec3(
      Math.sign(outward.x) || 0,
      0,
      Math.sign(outward.z) || 1,
    );

    return outsideApproach.plus(direction.scaled(3));
  }

  private getFirstHubCenter(): Vec3 {
    const staircaseBottom = this.getStairFloor(this.getTargetMineDepth());
    const direction = this.getMineDirection();

    return staircaseBottom.plus(direction.scaled(2));
  }

  private getLayerHubCenter(layerIndex: number): Vec3 {
    const firstHub = this.getFirstHubCenter();
    const direction = this.getMineDirection();

    return new Vec3(
      firstHub.x + direction.x * this.layerForwardStep * layerIndex,
      firstHub.y - this.layerDepthStep * layerIndex,
      firstHub.z + direction.z * this.layerForwardStep * layerIndex,
    );
  }

  private getStairFloor(depth: number): Vec3 {
    const entry = this.getMineEntryPosition();
    const direction = this.getMineDirection();

    return new Vec3(
      entry.x + direction.x * depth,
      entry.y - depth,
      entry.z + direction.z * depth,
    );
  }

  private getBranchFloor(layerIndex: number, branchIndex: number, step: number): Vec3 {
    const hubCenter = this.getLayerHubCenter(layerIndex);
    const direction = this.getBranchDirection(branchIndex);

    return new Vec3(
      hubCenter.x + direction.x * step,
      hubCenter.y,
      hubCenter.z + direction.z * step,
    );
  }

  private getMineDirection(): Vec3 {
    const doorPosition = this.getShelterDoorPosition();
    const interiorAnchor = this.getShelterInteriorAnchor(doorPosition);
    const outsideApproach = this.getOutsideDoorApproachPosition(doorPosition, interiorAnchor);
    const outward = outsideApproach.minus(doorPosition);

    return new Vec3(Math.sign(outward.x) || 0, 0, Math.sign(outward.z) || 1);
  }

  private getMineRightDirection(): Vec3 {
    const direction = this.getMineDirection();
    return new Vec3(direction.z, 0, -direction.x);
  }

  private getBranchDirection(branchIndex: number): Vec3 {
    const directions = [
      new Vec3(0, 0, -1),
      new Vec3(1, 0, 0),
      new Vec3(0, 0, 1),
      new Vec3(-1, 0, 0),
    ];

    return directions[branchIndex] ?? directions[0]!;
  }

  private getCorridorExcavationPositions(floor: Vec3): Vec3[] {
    const positions: Vec3[] = [];
    const right = this.getCorridorRightDirection(floor);

    for (let widthOffset = 0; widthOffset < this.settings.shaft.shaftWidth; widthOffset += 1) {
      const sideOffset = right.scaled(widthOffset);

      for (let heightOffset = 0; heightOffset < this.settings.shaft.shaftHeight; heightOffset += 1) {
        positions.push(floor.plus(sideOffset).offset(0, heightOffset, 0));
      }
    }

    return positions;
  }

  private getCorridorRightDirection(floor: Vec3): Vec3 {
    const matchingBranchIndex = this.findMatchingBranchIndexForFloor(floor);

    if (matchingBranchIndex !== null) {
      const direction = this.getBranchDirection(matchingBranchIndex);
      return new Vec3(direction.z, 0, -direction.x);
    }

    return this.getMineRightDirection();
  }

  private findMatchingBranchIndexForFloor(floor: Vec3): number | null {
    for (let branchIndex = 0; branchIndex < this.branchCount; branchIndex += 1) {
      const direction = this.getBranchDirection(branchIndex);
      const hubCenter = this.getLayerHubCenter(this.currentLayerIndex);
      const delta = floor.minus(hubCenter);

      if (
        (direction.x !== 0 && Math.sign(delta.x) === direction.x && delta.z === 0) ||
        (direction.z !== 0 && Math.sign(delta.z) === direction.z && delta.x === 0)
      ) {
        return branchIndex;
      }
    }

    return null;
  }

  private getHubFloorPositions(hubCenter: Vec3): Vec3[] {
    const positions: Vec3[] = [];

    for (let dx = -this.hubRadius; dx <= this.hubRadius; dx += 1) {
      for (let dz = -this.hubRadius; dz <= this.hubRadius; dz += 1) {
        positions.push(hubCenter.offset(dx, 0, dz));
      }
    }

    return positions;
  }

  private getAdjacentInspectionPositions(floor: Vec3): Vec3[] {
    const positions: Vec3[] = [];
    const right = this.getMineRightDirection();
    const direction = this.getMineDirection();
    const floorPositions = this.getCorridorExcavationPositions(floor);

    for (const position of floorPositions) {
      positions.push(position.plus(right));
      positions.push(position.minus(right));
      positions.push(position.plus(direction));
      positions.push(position.minus(direction));
      positions.push(position.offset(0, 1, 0));
      positions.push(position.offset(0, -1, 0));
    }

    return positions;
  }

  private hasExposedCaveNearby(floor: Vec3): boolean {
    return this.getAdjacentInspectionPositions(floor).some((position) => {
      const block = this.bot.blockAt(position);
      return block !== null && PASSABLE_BLOCK_NAMES.has(block.name);
    });
  }

  private async placeHubTorches(hubCenter: Vec3): Promise<void> {
    const torchItem = this.findInventoryItem('torch');

    if (!torchItem) {
      return;
    }

    const placements = this.getCardinalOffsets().map((offset) => hubCenter.plus(offset));

    for (const placement of placements) {
      const supportBlock = this.bot.blockAt(placement.offset(0, -1, 0));
      const targetBlock = this.bot.blockAt(placement);

      if (
        !supportBlock ||
        supportBlock.boundingBox !== 'block' ||
        (targetBlock && !PASSABLE_BLOCK_NAMES.has(targetBlock.name))
      ) {
        continue;
      }

      try {
        await this.bot.equip(torchItem, 'hand');
        await this.bot.lookAt(placement.offset(0.5, 0.2, 0.5), true).catch(() => undefined);
        await this.bot.placeBlock(supportBlock, new Vec3(0, 1, 0));
      } catch {
        continue;
      }
    }
  }

  private isOreBlock(blockName: string): boolean {
    return blockName.endsWith('_ore') || blockName === 'ancient_debris';
  }

  private isLiquidBlock(blockName: string): boolean {
    return blockName.includes('water') || blockName.includes('lava');
  }

  private isStonePickaxeInsufficient(block: Block): boolean {
    const stonePickaxeId = this.bot.registry.itemsByName.stone_pickaxe?.id;
    const harvestTools = (block as Block & { harvestTools?: Record<number, boolean | string> }).harvestTools;

    if (stonePickaxeId === undefined || !harvestTools) {
      return false;
    }

    const supportedToolIds = Object.keys(harvestTools)
      .map((key) => Number.parseInt(key, 10))
      .filter((value) => Number.isFinite(value));

    if (supportedToolIds.length === 0) {
      return false;
    }

    return !supportedToolIds.includes(stonePickaxeId);
  }

  private advanceToNextBranch(): void {
    this.currentBranchProgress = 0;
    this.currentBranchIndex += 1;

    if (this.currentBranchIndex < this.branchCount) {
      this.saveProgress();
      return;
    }

    this.currentBranchIndex = 0;
    this.currentLayerIndex += 1;

    if (this.getLayerHubCenter(this.currentLayerIndex).y <= this.minimumMiningY) {
      this.minePlanComplete = true;
    }

    this.saveProgress();
  }

  private restoreProgress(): void {
    try {
      const progress = this.progressStore.load(this.bot.username);

      if (!progress) {
        return;
      }

      this.staircaseProgress = progress.staircaseProgress;
      this.currentLayerIndex = progress.currentLayerIndex;
      this.currentBranchIndex = progress.currentBranchIndex;
      this.currentBranchProgress = progress.currentBranchProgress;
      this.minePlanComplete = progress.minePlanComplete;
      this.logger.info(
        `Restored mine progress: staircase=${this.staircaseProgress}, layer=${this.currentLayerIndex + 1}, branch=${this.currentBranchIndex + 1}, step=${this.currentBranchProgress}.`,
      );
    } catch (error) {
      this.logger.warn(`Could not restore mine progress: ${String(error)}.`);
    }
  }

  private saveProgress(): void {
    const progress: MineRoutineProgress = {
      staircaseProgress: this.staircaseProgress,
      currentLayerIndex: this.currentLayerIndex,
      currentBranchIndex: this.currentBranchIndex,
      currentBranchProgress: this.currentBranchProgress,
      minePlanComplete: this.minePlanComplete,
    };

    try {
      this.progressStore.save(this.bot.username, progress);
    } catch (error) {
      this.logger.warn(`Could not persist mine progress: ${String(error)}.`);
    }
  }

  private getBranchLabel(branchIndex: number): string {
    return ['north', 'east', 'south', 'west'][branchIndex] ?? `branch-${branchIndex}`;
  }

  private async reportUnbreakableBlock(position: Vec3): Promise<void> {
    const key = `${position.x}:${position.y}:${position.z}`;

    if (this.reportedBlockedPositions.has(key)) {
      return;
    }

    this.reportedBlockedPositions.add(key);
    this.bot.chat(`не могу сломать блок ${position.x} ${position.y} ${position.z}`);
  }

  private countTorchFuelItems(): number {
    return this.countInventoryItems('coal') + this.countInventoryItems('charcoal');
  }

  private countInventoryItems(itemId: string): number {
    return this.bot.inventory.items().reduce((total, item) => {
      return item.name === itemId ? total + item.count : total;
    }, 0);
  }

  private countTotalPlanks(): number {
    return PLANK_ITEM_NAMES.reduce((total, itemId) => total + this.countInventoryItems(itemId), 0);
  }

  private findInventoryItem(itemName: string): Item | null {
    return this.bot.inventory.items().find((item) => item.name === itemName) ?? null;
  }

  private findBestPickaxe(): Item | null {
    for (const itemName of PICKAXE_ITEM_NAMES) {
      const found = this.findInventoryItem(itemName);

      if (found) {
        return found;
      }
    }

    return null;
  }

  private hasBetterThanStonePickaxe(): boolean {
    return ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe'].some((itemName) =>
      Boolean(this.findInventoryItem(itemName)),
    );
  }

  private requireNearbyCraftingTable(): Block {
    const craftingTable = this.findNearbyCraftingTable();

    if (!craftingTable) {
      throw new Error('Could not find a crafting table near the rally point for the mining routine.');
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

  private shouldPauseForNightlyShelter(): boolean {
    return this.bot.isSleeping || this.nightTimingService.shouldReturnToShelter(this.bot.time.timeOfDay ?? null);
  }

  private isStorageBlockedForToday(): boolean {
    const currentDay = this.getCurrentMineDay();
    return currentDay !== null && this.storageBlockedDay === currentDay;
  }

  private markStorageBlockedForToday(): void {
    const currentDay = this.getCurrentMineDay();

    if (currentDay !== null) {
      this.storageBlockedDay = currentDay;
    }
  }

  private getCurrentMineDay(): number | null {
    const normalizedTimeOfDay = this.getNormalizedTimeOfDay();
    const explicitDay = this.getExplicitMineDay();

    if (this.inferredMineDay === null) {
      this.inferredMineDay = explicitDay ?? 0;
    } else if (
      normalizedTimeOfDay !== null &&
      this.observedTimeOfDay !== null &&
      normalizedTimeOfDay < this.observedTimeOfDay
    ) {
      this.inferredMineDay += 1;
    }

    if (explicitDay !== null && explicitDay > this.inferredMineDay) {
      this.inferredMineDay = explicitDay;
    }

    if (normalizedTimeOfDay !== null) {
      this.observedTimeOfDay = normalizedTimeOfDay;
    }

    if (this.inferredMineDay !== null) {
      return this.inferredMineDay;
    }

    return explicitDay;
  }

  private getExplicitMineDay(): number | null {
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
      this.logger.info('Mining bot could not leave the shelter through the door yet. Retrying shortly.');
    }

    return exited;
  }

  private async waitForScenarioWindow(): Promise<void> {
    this.ensureScenarioActive();
    await this.waitUntilTaskMayProceed();
    this.ensureScenarioActive();
  }

  private ensureScenarioActive(): void {
    if (!this.isScenarioActive()) {
      throw new Error('Mine scenario is no longer active.');
    }
  }

  private async enterShelterAndCloseDoor(): Promise<void> {
    if (this.isBotInsideShelter()) {
      const doorPosition = this.getShelterDoorPosition();
      await this.closeShelterDoorIfOpen(doorPosition);
      return;
    }

    const doorPosition = this.getShelterDoorPosition();
    const interiorAnchor = this.getShelterInteriorAnchor(doorPosition);

    await this.gotoPosition(interiorAnchor, 1).catch(() => undefined);

    if (!this.isBotInsideShelter()) {
      await this.openShelterDoorIfNeeded(doorPosition);
      await this.stepTowards(interiorAnchor, 16);
    }

    if (!this.isBotInsideShelter()) {
      await this.gotoPosition(interiorAnchor, 1).catch(() => undefined);
    }

    await this.closeShelterDoorIfOpen(doorPosition);
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

  private getCardinalAndVerticalOffsets(): Vec3[] {
    return [
      ...this.getCardinalOffsets(),
      new Vec3(0, 1, 0),
      new Vec3(0, -1, 0),
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

  private toVec3(position: BotRallyPoint): Vec3 {
    return new Vec3(position.x, position.y, position.z);
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

  private isMissingIngredientCraftError(error: unknown): boolean {
    return this.stringifyError(error).toLowerCase().includes('missing ingredient');
  }

  private isRetryableNavigationInterruption(error: unknown): boolean {
    const message = this.stringifyError(error).toLowerCase();

    return (
      message.includes('goal was changed before it could be completed') ||
      message.includes('path was stopped before it could be completed') ||
      message.includes('the desired goal was not reached')
    );
  }

  private async moveNearIfNeeded(target: Vec3, range: number): Promise<void> {
    if (!this.bot.entity) {
      return;
    }

    if (this.bot.entity.position.distanceTo(target) <= range + 0.5) {
      return;
    }

    await this.gotoPosition(target, range).catch((error) => {
      this.logger.warn(
        `Could not reach the target at ${target.x} ${target.y} ${target.z}: ${this.stringifyError(error)}.`,
      );
    });
  }
}
