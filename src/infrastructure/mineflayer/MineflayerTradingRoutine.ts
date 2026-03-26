import { Block } from 'prismarine-block';
import { Item } from 'prismarine-item';
import { Vec3 } from 'vec3';
import {
  TradeItemStackSettings,
  TradeOfferSettings,
  TradingRoleSettings,
} from '../../domain/bot/entities/RoleSettings';
import { Logger } from '../../application/shared/ports/Logger';
import { BotRallyPoint } from '../../domain/bot/entities/BotConfiguration';
import { NightlyShelterTimingService } from '../../application/bot/services/NightlyShelterTimingService';
import { BlockPosition, ShelterLayoutService } from '../../application/bot/services/ShelterLayoutService';
import { BotWithPathfinder } from './MineflayerPortsShared';
import {
  ChestRestockRequest,
  MineflayerChestInventoryManager,
} from './MineflayerChestInventoryManager';

interface TradePair {
  input: TradeItemStackSettings;
  output: TradeItemStackSettings;
  key: string;
}

export class MineflayerTradingRoutine {
  private readonly standbyDoorDistance = 4;
  private readonly minimumFreeInventorySlots = 2;
  private readonly maximumTradeStockStacks = 2;
  private readonly idleCheckTicks = 20;
  private readonly standbyRange = 1;
  private readonly shelterDoorSearchRadius = 8;
  private readonly shelterDoorEntryAttempts = 3;
  private readonly postTradeDropPickupDelayMs = 15000;
  private readonly nightTimingService = new NightlyShelterTimingService();
  private readonly chestInventoryManager: MineflayerChestInventoryManager;
  private readonly shelterLayout = new ShelterLayoutService({
    width: 9,
    length: 6,
    wallHeight: 3,
    roofAccessStepZ: 1,
  });
  private readonly trackedTradePairs: TradePair[];
  private readonly temporarilyDepletedOutputItems = new Set<string>();
  private readonly pendingCollectedInputs = new Map<string, number>();
  private readonly observedInventoryCounts = new Map<string, number>();
  private readonly alwaysKeptItemNames = new Set([
    'wooden_sword',
    'stone_sword',
    'iron_sword',
    'diamond_sword',
    'netherite_sword',
    'cooked_mutton',
    'cooked_beef',
    'cooked_porkchop',
    'cooked_chicken',
    'baked_potato',
  ]);

  constructor(
    private readonly bot: BotWithPathfinder,
    private readonly logger: Logger,
    private readonly rallyPoint: BotRallyPoint,
    private readonly settings: TradingRoleSettings,
    private readonly gotoPosition: (target: Vec3, range: number) => Promise<void>,
    private readonly isScenarioActive: () => boolean,
    private readonly waitUntilTaskMayProceed: () => Promise<void>,
    private readonly onTradeOutputDropped: (delayMs: number) => void = () => undefined,
  ) {
    this.chestInventoryManager = new MineflayerChestInventoryManager(bot, logger, gotoPosition);
    this.trackedTradePairs = this.createTradePairs(settings.offers);
    this.resetObservedInputCounts();
  }

  async maintain(): Promise<void> {
    if (this.trackedTradePairs.length === 0) {
      this.logger.info('Trading routine is configured with no trade pairs. Skipping the main trading loop.');
      return;
    }

    while (this.isScenarioActive()) {
      await this.waitForScenarioWindow();

      if (!this.isScenarioActive()) {
        return;
      }

      if (this.shouldPauseForNightlyShelter()) {
        this.resetObservedInputCounts();
        await this.bot.waitForTicks(this.idleCheckTicks);
        continue;
      }

      const inventoryMaintained = await this.maintainTradingInventory();

      if (inventoryMaintained) {
        this.resetObservedInputCounts();
      }

      if (!this.isScenarioActive() || this.shouldPauseForNightlyShelter()) {
        continue;
      }

      await this.moveToStandbyPosition();
      await this.processTradesFromCollectedItems();
      await this.bot.waitForTicks(this.idleCheckTicks);
    }
  }

  private async maintainTradingInventory(): Promise<boolean> {
    const needsCleanup = this.chestInventoryManager.getFreeInventorySlots() <= this.minimumFreeInventorySlots;
    const restockRequests = this.buildRestockRequests();
    const needsRestock = restockRequests.length > 0;

    if (!needsCleanup && !needsRestock) {
      return false;
    }

    this.logger.info('Trading inventory needs maintenance. Heading to the storage chests near the rally point.');
    const storageOrigin = this.toVec3(this.rallyPoint);

    await this.waitForScenarioWindow();
    const exitedShelter = await this.ensureOutsideShelter();

    if (!exitedShelter) {
      return false;
    }

    if (needsCleanup) {
      const deposited = await this.chestInventoryManager.depositUnneededItems(
        storageOrigin,
        (item) => this.shouldKeepItemDuringCleanup(item),
      );

      if (deposited > 0) {
        this.logger.info(`Deposited ${deposited} unneeded item(s) into the nearby storage chests.`);
      }
    }

    if (needsRestock) {
      const withdrawn = await this.chestInventoryManager.restockItems(storageOrigin, restockRequests);
      const withdrawnSummary = [...withdrawn.entries()]
        .map(([itemId, amount]) => `${itemId}=${amount}`)
        .join(', ');

      this.updateTemporarilyDepletedOutputs(restockRequests, withdrawn);

      if (withdrawnSummary.length > 0) {
        this.logger.info(`Restocked trade goods from nearby chests: ${withdrawnSummary}.`);
      } else {
        this.logger.warn('Could not restock the configured trade goods from nearby chests yet.');
      }
    }

    return true;
  }

  private async moveToStandbyPosition(): Promise<void> {
    const standbyPosition = this.getStandbyPositionOutsideShelter();

    if (!standbyPosition || !this.bot.entity) {
      return;
    }

    if (this.bot.entity.position.distanceTo(standbyPosition) <= this.standbyRange + 0.5) {
      return;
    }

    try {
      await this.waitForScenarioWindow();
      const exitedShelter = await this.ensureOutsideShelter();

      if (!exitedShelter) {
        return;
      }

      await this.gotoPosition(standbyPosition, this.standbyRange);
    } catch (error) {
      this.logger.info(`Could not reach the trading standby position yet: ${this.stringifyError(error)}.`);
    }
  }

  private async processTradesFromCollectedItems(): Promise<void> {
    for (const pair of this.trackedTradePairs) {
      const currentCount = this.countInventoryItems(pair.input.itemId);
      const previousCount = this.observedInventoryCounts.get(pair.key) ?? currentCount;
      const positiveDelta = Math.max(0, currentCount - previousCount);

      if (positiveDelta > 0) {
        const nextPendingCount = (this.pendingCollectedInputs.get(pair.key) ?? 0) + positiveDelta;
        this.pendingCollectedInputs.set(pair.key, nextPendingCount);
        this.logger.info(
          `Collected ${positiveDelta} ${pair.input.itemId} for trading. Pending ${pair.input.itemId}: ${nextPendingCount}.`,
        );
      }

      this.observedInventoryCounts.set(pair.key, currentCount);

      while ((this.pendingCollectedInputs.get(pair.key) ?? 0) >= pair.input.amount) {
        const inventoryOutput = this.findInventoryItem(pair.output.itemId);

        if (!inventoryOutput || inventoryOutput.count < pair.output.amount) {
          this.logger.warn(
            `Trade output ${pair.output.itemId} is missing or insufficient. The bot will restock before completing more trades.`,
          );
          return;
        }

        await this.bot.toss(inventoryOutput.type, null, pair.output.amount);
        this.onTradeOutputDropped(this.postTradeDropPickupDelayMs);
        this.pendingCollectedInputs.set(
          pair.key,
          (this.pendingCollectedInputs.get(pair.key) ?? 0) - pair.input.amount,
        );
        this.logger.info(
          `Completed a trade: received ${pair.input.amount} ${pair.input.itemId} and tossed ${pair.output.amount} ${pair.output.itemId}.`,
        );
      }
    }
  }

  private buildRestockRequests(): ChestRestockRequest[] {
    const uniqueOutputItemIds = new Map<string, number>();

    for (const pair of this.trackedTradePairs) {
      const maxStackSize = 64;
      const desiredCount = Math.min(maxStackSize * this.maximumTradeStockStacks, maxStackSize * this.maximumTradeStockStacks);
      uniqueOutputItemIds.set(
        pair.output.itemId,
        Math.max(uniqueOutputItemIds.get(pair.output.itemId) ?? 0, desiredCount),
      );
    }

    return [...uniqueOutputItemIds.entries()]
      .filter(([itemId, desiredCount]) => {
        const currentCount = this.countInventoryItems(itemId);

        if (currentCount <= 0) {
          this.temporarilyDepletedOutputItems.delete(itemId);
        }

        if (this.temporarilyDepletedOutputItems.has(itemId) && currentCount > 0) {
          return false;
        }

        return currentCount < desiredCount;
      })
      .map(([itemId, targetCount]) => ({ itemId, targetCount }));
  }

  private updateTemporarilyDepletedOutputs(
    requests: readonly ChestRestockRequest[],
    withdrawn: ReadonlyMap<string, number>,
  ): void {
    for (const request of requests) {
      const currentCount = this.countInventoryItems(request.itemId);

      if (currentCount <= 0) {
        this.temporarilyDepletedOutputItems.delete(request.itemId);
        continue;
      }

      if (currentCount >= request.targetCount) {
        this.temporarilyDepletedOutputItems.delete(request.itemId);
        continue;
      }

      const withdrawnCount = withdrawn.get(request.itemId) ?? 0;

      if (withdrawnCount <= 0 || currentCount < request.targetCount) {
        this.temporarilyDepletedOutputItems.add(request.itemId);
      }
    }
  }

  private shouldKeepItemDuringCleanup(item: Item): boolean {
    if (this.alwaysKeptItemNames.has(item.name)) {
      return true;
    }

    return this.trackedTradePairs.some((pair) => pair.output.itemId === item.name);
  }

  private shouldPauseForNightlyShelter(): boolean {
    return this.bot.isSleeping || this.nightTimingService.shouldReturnToShelter(this.bot.time.timeOfDay ?? null);
  }

  private async waitForScenarioWindow(): Promise<void> {
    this.ensureScenarioActive();
    await this.waitUntilTaskMayProceed();
    this.ensureScenarioActive();
  }

  private ensureScenarioActive(): void {
    if (!this.isScenarioActive()) {
      throw new Error('Trading routine was cancelled.');
    }
  }

  private resetObservedInputCounts(): void {
    this.observedInventoryCounts.clear();

    for (const pair of this.trackedTradePairs) {
      this.observedInventoryCounts.set(pair.key, this.countInventoryItems(pair.input.itemId));
    }
  }

  private createTradePairs(offers: readonly TradeOfferSettings[]): TradePair[] {
    const pairs: TradePair[] = [];

    for (const [offerIndex, offer] of offers.entries()) {
      const pairCount = Math.min(offer.playerGives.length, offer.botGives.length);

      for (let pairIndex = 0; pairIndex < pairCount; pairIndex += 1) {
        const input = offer.playerGives[pairIndex];
        const output = offer.botGives[pairIndex];

        if (!input || !output) {
          continue;
        }

        pairs.push({
          input,
          output,
          key: `${offerIndex}:${pairIndex}:${input.itemId}->${output.itemId}`,
        });
      }
    }

    return pairs;
  }

  private getStandbyPositionOutsideShelter(): Vec3 | null {
    const doorBlock = this.findNearestShelterDoor();

    if (!doorBlock) {
      return null;
    }

    const xDistanceToRally = doorBlock.position.x - this.rallyPoint.x;
    const zDistanceToRally = doorBlock.position.z - this.rallyPoint.z;
    const moveAlongX = Math.abs(xDistanceToRally) >= Math.abs(zDistanceToRally);
    const step = moveAlongX
      ? new Vec3(Math.sign(xDistanceToRally) || 1, 0, 0)
      : new Vec3(0, 0, Math.sign(zDistanceToRally) || 1);

    return new Vec3(
      doorBlock.position.x + step.x * this.standbyDoorDistance,
      this.rallyPoint.y,
      doorBlock.position.z + step.z * this.standbyDoorDistance,
    );
  }

  private async ensureOutsideShelter(): Promise<boolean> {
    if (!this.isBotWithinShelterBounds()) {
      return true;
    }

    const exited = await this.exitShelterThroughDoor();

    if (!exited) {
      this.logger.info('Trading bot could not leave the shelter through the door yet. Retrying shortly.');
    }

    return exited;
  }

  private async exitShelterThroughDoor(): Promise<boolean> {
    const doorBlock = this.findNearestShelterDoor();

    if (!doorBlock) {
      return false;
    }

    const doorPosition = doorBlock.position;
    const interiorAnchor = this.getShelterInteriorAnchor(doorPosition);
    const outsideApproach = this.getOutsideDoorApproachPosition(doorPosition, interiorAnchor);

    for (let attempt = 1; attempt <= this.shelterDoorEntryAttempts; attempt += 1) {
      if (interiorAnchor) {
        await this.gotoPosition(interiorAnchor, 1).catch(() => undefined);
      }

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

  private findNearestShelterDoor(): Block | null {
    if (!this.bot.entity) {
      return null;
    }

    const rallyCenter = this.toVec3(this.rallyPoint);
    let nearestDoor = null;
    let nearestDistance = Number.POSITIVE_INFINITY;

    for (let dx = -8; dx <= 8; dx += 1) {
      for (let dy = -1; dy <= 2; dy += 1) {
        for (let dz = -8; dz <= 8; dz += 1) {
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

  private getShelterInteriorAnchor(doorPosition: Vec3): Vec3 | null {
    return this.getDoorApproachPositions(doorPosition)
      .find((position) => this.isInsideShelterArea(position)) ?? null;
  }

  private getOutsideDoorApproachPosition(doorPosition: Vec3, interiorAnchor: Vec3 | null): Vec3 {
    if (interiorAnchor) {
      const outwardOffset = doorPosition.minus(interiorAnchor);
      return doorPosition.plus(outwardOffset);
    }

    return this.getDoorApproachPositions(doorPosition)
      .find((position) => !this.isInsideShelterArea(position)) ??
      doorPosition;
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

  private toBlockPosition(position: Vec3): BlockPosition {
    return {
      x: Math.floor(position.x),
      y: Math.floor(position.y),
      z: Math.floor(position.z),
    };
  }

  private isDoorBlock(block: Block): boolean {
    return block.name.endsWith('_door');
  }

  private countInventoryItems(itemId: string): number {
    return this.bot.inventory.items().reduce((total, item) => {
      return item.name === itemId ? total + item.count : total;
    }, 0);
  }

  private findInventoryItem(itemId: string): Item | undefined {
    return this.bot.inventory.items().find((item) => item.name === itemId);
  }

  private toVec3(position: BotRallyPoint): Vec3 {
    return new Vec3(position.x, position.y, position.z);
  }

  private stringifyError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }
}
