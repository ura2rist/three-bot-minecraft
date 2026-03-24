import { Block } from 'prismarine-block';
import { Item } from 'prismarine-item';
import { Vec3 } from 'vec3';
import { Logger } from '../../application/shared/ports/Logger';
import { BotWithPathfinder } from './MineflayerPortsShared';

interface ChestWindow {
  containerItems(): Item[];
  deposit(itemType: number, metadata: number | null, amount: number): Promise<void>;
  withdraw(itemType: number, metadata: number | null, amount: number): Promise<void>;
  close(): void;
}

export interface ChestRestockRequest {
  itemId: string;
  targetCount: number;
}

export class MineflayerChestInventoryManager {
  private readonly chestSearchRadius = 12;

  constructor(
    private readonly bot: BotWithPathfinder,
    private readonly logger: Logger,
    private readonly gotoPosition: (target: Vec3, range: number) => Promise<void>,
  ) {}

  async depositUnneededItems(
    storageOrigin: Vec3,
    shouldKeepItem: (item: Item) => boolean,
  ): Promise<number> {
    const depositCandidates = this.bot.inventory.items().filter((item) => !shouldKeepItem(item));

    if (depositCandidates.length === 0) {
      return 0;
    }

    const chests = this.findNearbyChestBlocks(storageOrigin);

    if (chests.length === 0) {
      this.logger.warn(
        `Could not find any nearby chests around ${storageOrigin.x} ${storageOrigin.y} ${storageOrigin.z} for inventory cleanup.`,
      );
      return 0;
    }

    let depositedItemCount = 0;

    for (const chestBlock of chests) {
      const pendingItems = this.bot.inventory.items().filter((item) => !shouldKeepItem(item));

      if (pendingItems.length === 0) {
        break;
      }

      const chest = await this.openChest(chestBlock);

      if (!chest) {
        continue;
      }

      try {
        for (const item of pendingItems) {
          try {
            await chest.deposit(item.type, null, item.count);
            depositedItemCount += item.count;
          } catch (error) {
            this.logger.warn(
              `Could not deposit ${item.count} ${item.name} into a chest at ${chestBlock.position.x} ${chestBlock.position.y} ${chestBlock.position.z}: ${this.stringifyError(error)}.`,
            );
          }
        }
      } finally {
        chest.close();
      }
    }

    return depositedItemCount;
  }

  async restockItems(
    storageOrigin: Vec3,
    requests: readonly ChestRestockRequest[],
  ): Promise<Map<string, number>> {
    const fulfilledCounts = new Map<string, number>();
    const pendingRequests = requests
      .map((request) => ({
        ...request,
        remaining: Math.max(0, request.targetCount - this.countInventoryItems(request.itemId)),
      }))
      .filter((request) => request.remaining > 0);

    if (pendingRequests.length === 0) {
      return fulfilledCounts;
    }

    const chests = this.findNearbyChestBlocks(storageOrigin);

    if (chests.length === 0) {
      this.logger.warn(
        `Could not find any nearby chests around ${storageOrigin.x} ${storageOrigin.y} ${storageOrigin.z} for restocking.`,
      );
      return fulfilledCounts;
    }

    for (const chestBlock of chests) {
      if (pendingRequests.every((request) => request.remaining <= 0)) {
        break;
      }

      const chest = await this.openChest(chestBlock);

      if (!chest) {
        continue;
      }

      try {
        for (const request of pendingRequests) {
          if (request.remaining <= 0) {
            continue;
          }

          const chestItem = chest.containerItems().find((item) => item.name === request.itemId);

          if (!chestItem) {
            continue;
          }

          const withdrawAmount = Math.min(request.remaining, chestItem.count);

          try {
            await chest.withdraw(chestItem.type, null, withdrawAmount);
            request.remaining -= withdrawAmount;
            fulfilledCounts.set(
              request.itemId,
              (fulfilledCounts.get(request.itemId) ?? 0) + withdrawAmount,
            );
          } catch (error) {
            this.logger.warn(
              `Could not withdraw ${withdrawAmount} ${request.itemId} from a chest at ${chestBlock.position.x} ${chestBlock.position.y} ${chestBlock.position.z}: ${this.stringifyError(error)}.`,
            );
          }
        }
      } finally {
        chest.close();
      }
    }

    return fulfilledCounts;
  }

  countInventoryItems(itemId: string): number {
    return this.bot.inventory.items().reduce((total, item) => {
      return item.name === itemId ? total + item.count : total;
    }, 0);
  }

  getFreeInventorySlots(): number {
    return this.bot.inventory.emptySlotCount();
  }

  private findNearbyChestBlocks(origin: Vec3): Block[] {
    const chestIds = ['chest', 'trapped_chest']
      .map((blockName) => this.bot.registry.blocksByName[blockName]?.id)
      .filter((blockId): blockId is number => Number.isFinite(blockId));

    if (chestIds.length === 0) {
      return [];
    }

    const positions = this.bot.findBlocks({
      point: origin,
      matching: chestIds,
      maxDistance: this.chestSearchRadius,
      count: 32,
    });

    return positions
      .map((position) => this.bot.blockAt(position))
      .filter((block): block is Block => block !== null)
      .sort((left, right) => origin.distanceTo(left.position) - origin.distanceTo(right.position));
  }

  private async openChest(chestBlock: Block): Promise<ChestWindow | null> {
    try {
      await this.gotoPosition(chestBlock.position, 2);
      return (await this.bot.openChest(chestBlock)) as unknown as ChestWindow;
    } catch (error) {
      this.logger.warn(
        `Could not open a chest at ${chestBlock.position.x} ${chestBlock.position.y} ${chestBlock.position.z}: ${this.stringifyError(error)}.`,
      );
      return null;
    }
  }

  private stringifyError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }
}
