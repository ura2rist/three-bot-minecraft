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

interface ChestInspectionSweep {
  startedAt: number;
  inspectedKeys: Set<string>;
}

export class MineflayerChestInventoryManager {
  private readonly chestSearchRadius = 12;
  private readonly directInteractionPadding = 0.5;
  private readonly chestApproachRange = 1;
  private readonly chestInspectionSweepWindowMs = 60000;
  private readonly inspectionSweepsByOrigin = new Map<string, ChestInspectionSweep>();

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

    for (const chestBlock of this.prioritizeChestBlocksForInspection(storageOrigin, chests)) {
      const pendingItems = this.bot.inventory.items().filter((item) => !shouldKeepItem(item));

      if (pendingItems.length === 0) {
        break;
      }

      const chest = await this.openChest(chestBlock, storageOrigin);

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

    for (const chestBlock of this.prioritizeChestBlocksForInspection(storageOrigin, chests)) {
      if (pendingRequests.every((request) => request.remaining <= 0)) {
        break;
      }

      const chest = await this.openChest(chestBlock, storageOrigin);

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

    const chestsByCanonicalPosition = new Map<string, Block>();

    for (const chestBlock of positions
      .map((position) => this.bot.blockAt(position))
      .filter((block): block is Block => block !== null)
      .sort((left, right) => origin.distanceTo(left.position) - origin.distanceTo(right.position))) {
      const canonicalPosition = this.getCanonicalChestPosition(chestBlock);
      const canonicalKey = `${canonicalPosition.x}:${canonicalPosition.y}:${canonicalPosition.z}`;

      if (!chestsByCanonicalPosition.has(canonicalKey)) {
        chestsByCanonicalPosition.set(canonicalKey, chestBlock);
      }
    }

    return [...chestsByCanonicalPosition.values()];
  }

  private async openChest(chestBlock: Block, storageOrigin: Vec3): Promise<ChestWindow | null> {
    let lastError: unknown = null;
    let lineOfSightBlocked = false;

    try {
      for (const approachPosition of this.getChestApproachPositions(chestBlock)) {
        try {
          await this.gotoPosition(approachPosition, this.chestApproachRange);
        } catch (error) {
          lastError = error;
          continue;
        }

        if (!this.hasDirectInteractionLineOfSight(chestBlock)) {
          lineOfSightBlocked = true;
          continue;
        }

        try {
          return (await this.bot.openChest(chestBlock)) as unknown as ChestWindow;
        } catch (error) {
          lastError = error;
        }
      }
    } finally {
      this.markChestAsInspected(storageOrigin, chestBlock);
    }

    if (lineOfSightBlocked) {
      this.logger.warn(
        `Could not open a chest at ${chestBlock.position.x} ${chestBlock.position.y} ${chestBlock.position.z}: it is not in direct line of sight.`,
      );
      return null;
    }

    this.logger.warn(
      `Could not open a chest at ${chestBlock.position.x} ${chestBlock.position.y} ${chestBlock.position.z}: ${this.stringifyError(lastError)}.`,
    );
    return null;
  }

  private stringifyError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }

  private hasDirectInteractionLineOfSight(targetBlock: Block): boolean {
    if (!this.bot.entity) {
      return false;
    }

    const world = this.bot.world as {
      raycast?: (origin: Vec3, direction: Vec3, range: number) => { position?: Vec3 } | null;
    };

    if (typeof world.raycast !== 'function') {
      return true;
    }

    const eyeHeight = typeof this.bot.entity.height === 'number' ? this.bot.entity.height : 1.62;
    const eyePosition = this.bot.entity.position.offset(0, eyeHeight, 0);
    const targetPoints = [
      targetBlock.position.offset(0.5, 0.5, 0.5),
      targetBlock.position.offset(0.5, 0.25, 0.5),
      targetBlock.position.offset(0.5, 0.75, 0.5),
    ];

    return targetPoints.some((targetPoint) => {
      const direction = targetPoint.minus(eyePosition);
      const distance = direction.norm();

      if (distance <= 0) {
        return true;
      }

      const hit = world.raycast?.(
        eyePosition,
        direction.scaled(1 / distance),
        distance + this.directInteractionPadding,
      );

      return !!hit?.position && hit.position.equals(targetBlock.position);
    });
  }

  private getChestApproachPositions(chestBlock: Block): Vec3[] {
    const candidates = [
      ...this.getCardinalOffsets().map((offset) => chestBlock.position.plus(offset)),
      ...this.getCardinalOffsets().map((offset) => chestBlock.position.plus(offset).offset(0, -1, 0)),
    ];
    const uniqueCandidates = [...new Map(
      candidates.map((candidate) => [`${candidate.x}:${candidate.y}:${candidate.z}`, candidate]),
    ).values()];
    const origin = this.bot.entity?.position ?? chestBlock.position;

    return uniqueCandidates.sort(
      (left, right) => left.distanceSquared(origin) - right.distanceSquared(origin),
    );
  }

  private getCardinalOffsets(): Vec3[] {
    return [
      new Vec3(1, 0, 0),
      new Vec3(-1, 0, 0),
      new Vec3(0, 0, 1),
      new Vec3(0, 0, -1),
    ];
  }

  private getCanonicalChestPosition(chestBlock: Block): Vec3 {
    const connectedChestPositions = [
      chestBlock.position,
      ...this.getCardinalOffsets()
        .map((offset) => chestBlock.position.plus(offset))
        .filter((position) => {
          const candidate = this.bot.blockAt(position);

          return !!candidate && candidate.name === chestBlock.name;
        }),
    ];

    return connectedChestPositions.sort((left, right) => {
      if (left.x !== right.x) {
        return left.x - right.x;
      }

      if (left.y !== right.y) {
        return left.y - right.y;
      }

      return left.z - right.z;
    })[0]!;
  }

  private prioritizeChestBlocksForInspection(storageOrigin: Vec3, chestBlocks: readonly Block[]): Block[] {
    const sweep = this.getInspectionSweep(storageOrigin);
    const freshBlocks = chestBlocks.filter((chestBlock) => {
      return !sweep.inspectedKeys.has(this.getChestInspectionKey(chestBlock));
    });

    if (freshBlocks.length > 0) {
      return freshBlocks;
    }

    sweep.startedAt = Date.now();
    sweep.inspectedKeys.clear();
    return [...chestBlocks];
  }

  private getChestInspectionKey(chestBlock: Block): string {
    const canonicalPosition = this.getCanonicalChestPosition(chestBlock);
    return `${canonicalPosition.x}:${canonicalPosition.y}:${canonicalPosition.z}`;
  }

  private getInspectionSweep(storageOrigin: Vec3): ChestInspectionSweep {
    const originKey = this.getStorageOriginKey(storageOrigin);
    const now = Date.now();
    const existingSweep = this.inspectionSweepsByOrigin.get(originKey);

    if (existingSweep && now - existingSweep.startedAt < this.chestInspectionSweepWindowMs) {
      return existingSweep;
    }

    const nextSweep: ChestInspectionSweep = {
      startedAt: now,
      inspectedKeys: new Set<string>(),
    };
    this.inspectionSweepsByOrigin.set(originKey, nextSweep);
    return nextSweep;
  }

  private markChestAsInspected(storageOrigin: Vec3, chestBlock: Block): void {
    this.getInspectionSweep(storageOrigin).inspectedKeys.add(this.getChestInspectionKey(chestBlock));
  }

  private getStorageOriginKey(storageOrigin: Vec3): string {
    return `${Math.floor(storageOrigin.x)}:${Math.floor(storageOrigin.y)}:${Math.floor(storageOrigin.z)}`;
  }
}
