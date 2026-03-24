import { Block } from 'prismarine-block';
import { Vec3 } from 'vec3';
import { LogHarvestingPort } from '../../application/bot/ports/LogHarvestingPort';
import { RetryableTargetSelectionError } from '../../application/shared/errors/RetryableTargetSelectionError';
import { Logger } from '../../application/shared/ports/Logger';
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

const AXE_PRIORITY: readonly string[] = [
  'netherite_axe',
  'diamond_axe',
  'iron_axe',
  'stone_axe',
  'golden_axe',
  'wooden_axe',
] as const;

export class MineflayerLogHarvestingPort implements LogHarvestingPort {
  private readonly resourceSearchRadius = 64;
  private readonly maxLogCandidates = 128;
  private readonly maxHarvestableLogHeightFromGround = 4;
  private readonly pickupWaitMs = 3000;
  private readonly pickupHorizontalRange = 6;
  private readonly pickupVerticalRange = 4;

  constructor(
    private readonly bot: BotWithPathfinder,
    private readonly logger: Logger,
    private readonly gotoPosition: (target: Vec3, range: number) => Promise<void>,
    private readonly nearbyDroppedItemCollector: MineflayerNearbyDroppedItemCollector,
    private readonly waitUntilTaskMayProceed: () => Promise<void> = async () => undefined,
    private readonly isThreatResponseActive: () => boolean = () => false,
  ) {}

  async gatherNearestLog(): Promise<void> {
    await this.waitForTaskPriority();
    const logBlockIds = [...LOG_TO_PLANK_ITEM.keys()]
      .map((logName) => this.bot.registry.blocksByName[logName]?.id)
      .filter((logId): logId is number => logId !== undefined);

    const candidatePositions = this.bot.findBlocks({
      matching: logBlockIds,
      maxDistance: this.resourceSearchRadius,
      count: this.maxLogCandidates,
    });
    const candidateLogs = candidatePositions
      .map((position) => this.bot.blockAt(position))
      .filter((block): block is Block => block !== null)
      .filter((block) => this.isHarvestableLogBlock(block))
      .sort((left, right) => {
        return (
          this.calculateDistanceSquared(left.position) -
          this.calculateDistanceSquared(right.position)
        );
      });

    if (candidateLogs.length === 0) {
      throw new Error(
        `No supported log blocks up to ${this.maxHarvestableLogHeightFromGround} blocks above the ground were found within ${this.resourceSearchRadius} blocks.`,
      );
    }

    let lastRetryableError: RetryableTargetSelectionError | null = null;

    for (const targetLog of candidateLogs) {
      try {
        await this.gatherLogBlock(targetLog);
        return;
      } catch (error) {
        if (!(error instanceof RetryableTargetSelectionError)) {
          throw error;
        }

        lastRetryableError = error;
        this.logger.warn(
          `Skipping log block ${targetLog.name} at ${targetLog.position.x} ${targetLog.position.y} ${targetLog.position.z}: ${error.message}`,
        );
      }
    }

    throw lastRetryableError ?? new Error('Could not gather any reachable log block from the current search set.');
  }

  private async gatherLogBlock(targetLog: Block): Promise<void> {
    const groundY = this.findGroundY(targetLog.position);

    if (groundY === null) {
      throw new RetryableTargetSelectionError(
        `Could not determine the ground level for log block "${targetLog.name}".`,
      );
    }

    this.logger.info(
      `Gathering log block ${targetLog.name} at ${targetLog.position.x} ${targetLog.position.y} ${targetLog.position.z}.`,
    );

    if (!this.canDigFromCurrentPosition(targetLog.position)) {
      const approachPosition = new Vec3(targetLog.position.x, groundY + 1, targetLog.position.z);

      try {
        await this.navigateTo(approachPosition, 3);
      } catch (error) {
        if (this.isRetryableLogTargetError(error)) {
          throw new RetryableTargetSelectionError(this.stringifyError(error));
        }

        throw error;
      }
    }

    if (!this.bot.canDigBlock(targetLog)) {
      throw new RetryableTargetSelectionError(
        `Cannot dig log block "${targetLog.name}" at the target position.`,
      );
    }

    const logsBeforeDig = this.countInventoryLogs();
    await this.prepareHeldItemForLogHarvesting();
    await this.bot.lookAt(targetLog.position.offset(0.5, 0.5, 0.5), true);
    await this.bot.dig(targetLog, true);
    const collectedLog = await this.collectDroppedLog(targetLog.position, logsBeforeDig);

    if (!collectedLog) {
      throw new RetryableTargetSelectionError(
        `The dropped log item from ${targetLog.name} at ${targetLog.position.x} ${targetLog.position.y} ${targetLog.position.z} was not collected.`,
      );
    }

    this.logger.info(`Gathered log block ${targetLog.name}.`);
  }

  private isHarvestableLogBlock(block: Block): boolean {
    if (!this.isLogBlock(block.name)) {
      return false;
    }

    const groundY = this.findGroundY(block.position);

    if (groundY === null) {
      return false;
    }

    return block.position.y - groundY <= this.maxHarvestableLogHeightFromGround;
  }

  private isLogBlock(blockName: string): boolean {
    return LOG_TO_PLANK_ITEM.has(blockName);
  }

  private findGroundY(position: Vec3): number | null {
    for (let offset = 1; offset <= this.maxHarvestableLogHeightFromGround + 4; offset += 1) {
      const belowBlock = this.bot.blockAt(position.offset(0, -offset, 0));

      if (!belowBlock) {
        return null;
      }

      if (belowBlock.boundingBox === 'block' && !this.isLogBlock(belowBlock.name)) {
        return belowBlock.position.y;
      }
    }

    return null;
  }

  private calculateDistanceSquared(target: Vec3): number {
    const dx = this.bot.entity.position.x - target.x;
    const dy = this.bot.entity.position.y - target.y;
    const dz = this.bot.entity.position.z - target.z;

    return dx * dx + dy * dy + dz * dz;
  }

  private canDigFromCurrentPosition(target: Vec3): boolean {
    return this.calculateDistanceSquared(target) <= 16;
  }

  private async collectDroppedLog(dropPosition: Vec3, logsBeforeDig: number): Promise<boolean> {
    if (this.countInventoryLogs() > logsBeforeDig) {
      return true;
    }

    const deadline = Date.now() + this.pickupWaitMs;
    await this.bot.waitForTicks(5);

    while (Date.now() < deadline) {
      const hasDroppedItemsBeforeAttempt = this.nearbyDroppedItemCollector.hasDroppedItemNearby(
        dropPosition,
        this.pickupHorizontalRange,
        this.pickupVerticalRange,
      );

      try {
        const collectedAny = await this.nearbyDroppedItemCollector.collectAround(
          dropPosition,
          this.pickupHorizontalRange,
          this.pickupVerticalRange,
        );

        if (this.countInventoryLogs() > logsBeforeDig) {
          return true;
        }

        const hasDroppedItemsAfterAttempt = this.nearbyDroppedItemCollector.hasDroppedItemNearby(
          dropPosition,
          this.pickupHorizontalRange,
          this.pickupVerticalRange,
        );

        if (!hasDroppedItemsAfterAttempt) {
          return false;
        }

        if (hasDroppedItemsBeforeAttempt || collectedAny) {
          this.logger.warn(
            `Dropped items near ${dropPosition.x} ${dropPosition.y} ${dropPosition.z} stayed out of reach after several pickup attempts. Continuing with the next resource target.`,
          );
          return false;
        }
      } catch (error) {
        if (
          !this.nearbyDroppedItemCollector.hasDroppedItemNearby(
            dropPosition,
            this.pickupHorizontalRange,
            this.pickupVerticalRange,
          )
        ) {
          this.logger.warn(
            `Dropped items are no longer visible near ${dropPosition.x} ${dropPosition.y} ${dropPosition.z}.`,
          );
          return false;
        }

        this.logger.warn(
          `Could not collect dropped items near ${dropPosition.x} ${dropPosition.y} ${dropPosition.z}: ${this.stringifyError(error)}.`,
        );

        if (
          hasDroppedItemsBeforeAttempt &&
          this.nearbyDroppedItemCollector.hasDroppedItemNearby(
            dropPosition,
            this.pickupHorizontalRange,
            this.pickupVerticalRange,
          )
        ) {
          return false;
        }
      }

      if (
        !this.nearbyDroppedItemCollector.hasDroppedItemNearby(
          dropPosition,
          this.pickupHorizontalRange,
          this.pickupVerticalRange,
        )
      ) {
        return false;
      }

      await this.bot.waitForTicks(5);
    }

    this.logger.warn(
      `Timed out while waiting to pick up drops near ${dropPosition.x} ${dropPosition.y} ${dropPosition.z}.`,
    );
    return false;
  }

  private async navigateTo(target: Vec3, range: number): Promise<void> {
    while (true) {
      await this.waitForTaskPriority();

      try {
        await this.gotoPosition(target, range);
        return;
      } catch (error) {
        if (this.isThreatResponseActive() && this.isRetryablePriorityInterruption(error)) {
          this.logger.info(
            `Pausing log harvesting because combat has higher priority: ${this.stringifyError(error)}.`,
          );
          await this.waitForTaskPriority();
          continue;
        }

        throw error;
      }
    }
  }

  private async waitForTaskPriority(): Promise<void> {
    await this.waitUntilTaskMayProceed();
  }

  private isRetryablePriorityInterruption(error: unknown): boolean {
    const message = this.stringifyError(error).toLowerCase();

    return (
      message.includes('goal changed') ||
      message.includes('path was stopped') ||
      message.includes('path stopped before it could be completed')
    );
  }

  private isRetryableLogTargetError(error: unknown): boolean {
    const message = this.stringifyError(error).toLowerCase();

    return (
      message.includes('took to long to decide path to goal') ||
      message.includes('no path to the goal') ||
      message.includes('goal was not actually reached') ||
      message.includes('timed out')
    );
  }

  private countInventoryLogs(): number {
    return this.bot.inventory
      .items()
      .filter((item) => LOG_TO_PLANK_ITEM.has(item.name))
      .reduce((total, item) => total + item.count, 0);
  }

  private async prepareHeldItemForLogHarvesting(): Promise<void> {
    const bestAxe = this.findBestAxe();

    if (bestAxe) {
      if (this.bot.heldItem?.type === bestAxe.type) {
        return;
      }

      try {
        await this.bot.equip(bestAxe, 'hand');
      } catch (error) {
        this.logger.warn(`Could not equip an axe before chopping logs: ${this.stringifyError(error)}.`);
      }

      return;
    }

    if (!this.bot.heldItem) {
      return;
    }

    try {
      await this.bot.unequip('hand');
    } catch (error) {
      this.logger.warn(`Could not clear the held item before chopping logs: ${this.stringifyError(error)}.`);
    }
  }

  private findBestAxe() {
    const inventoryItems = this.bot.inventory.items();

    for (const itemName of AXE_PRIORITY) {
      const axe = inventoryItems.find((item) => item.name === itemName);

      if (axe) {
        return axe;
      }
    }

    return undefined;
  }

  private stringifyError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }
}
