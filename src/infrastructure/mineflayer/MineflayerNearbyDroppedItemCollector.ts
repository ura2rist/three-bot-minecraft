import { Vec3 } from 'vec3';
import { Logger } from '../../application/shared/ports/Logger';
import { BotWithPathfinder } from './MineflayerPortsShared';

const DROPPED_ITEM_ENTITY_NAMES = new Set(['item', 'Item', 'item_stack']);

interface DroppedItemEntity {
  name?: string;
  displayName?: string;
  getDroppedItem?(): unknown | null;
  position: Vec3;
}

export class MineflayerNearbyDroppedItemCollector {
  private readonly scanIntervalMs = 750;
  private readonly defaultHorizontalRange = 4;
  private readonly defaultVerticalRange = 2;
  private collectionPromise: Promise<boolean> | null = null;
  private intervalId: NodeJS.Timeout | null = null;

  constructor(
    private readonly bot: BotWithPathfinder,
    private readonly logger: Logger,
    private readonly gotoPosition: (target: Vec3, range: number) => Promise<void>,
    private readonly mayCollectInBackground: () => boolean = () => true,
  ) {}

  start(): void {
    if (this.intervalId) {
      return;
    }

    this.intervalId = setInterval(() => {
      if (!this.mayCollectInBackground()) {
        return;
      }

      void this.collectAroundBot().catch((error) => {
        this.logger.error('Failed to collect nearby dropped items.', error);
      });
    }, this.scanIntervalMs);
  }

  stop(): void {
    if (!this.intervalId) {
      return;
    }

    clearInterval(this.intervalId);
    this.intervalId = null;
  }

  async collectAroundBot(): Promise<boolean> {
    if (!this.bot.entity) {
      return false;
    }

    return this.collectAround(this.bot.entity.position, this.defaultHorizontalRange, this.defaultVerticalRange);
  }

  async collectAround(center: Vec3, horizontalRange = 4, verticalRange = 2): Promise<boolean> {
    if (this.collectionPromise) {
      return this.collectionPromise;
    }

    const collectionPromise = this.performCollection(center, horizontalRange, verticalRange).finally(() => {
      if (this.collectionPromise === collectionPromise) {
        this.collectionPromise = null;
      }
    });

    this.collectionPromise = collectionPromise;
    return collectionPromise;
  }

  hasDroppedItemNearby(center: Vec3, horizontalRange = 4, verticalRange = 2): boolean {
    return this.findNearestDroppedItem(center, horizontalRange, verticalRange) !== null;
  }

  private async performCollection(
    center: Vec3,
    horizontalRange: number,
    verticalRange: number,
  ): Promise<boolean> {
    let collectedAny = false;

    while (true) {
      const droppedItem = this.findNearestDroppedItem(center, horizontalRange, verticalRange);

      if (!droppedItem) {
        return collectedAny;
      }

      try {
        await this.gotoPosition(droppedItem.position, 1);
      } catch (error) {
        if (!this.hasDroppedItemNearby(center, horizontalRange, verticalRange)) {
          return collectedAny;
        }

        this.logger.warn(
          `Skipping dropped-item collection attempt near ${droppedItem.position.x.toFixed(1)} ${droppedItem.position.y.toFixed(1)} ${droppedItem.position.z.toFixed(1)}: ${this.stringifyError(error)}`,
        );
        return collectedAny;
      }

      collectedAny = true;
      await this.bot.waitForTicks(5);
    }
  }

  private findNearestDroppedItem(
    center: Vec3,
    horizontalRange: number,
    verticalRange: number,
  ): DroppedItemEntity | null {
    return Object.values(this.bot.entities as Record<string, DroppedItemEntity | undefined>)
      .filter((entity): entity is DroppedItemEntity => this.isDroppedItemEntity(entity))
      .filter((entity) => this.isWithinCollectionRange(entity.position, center, horizontalRange, verticalRange))
      .sort((left, right) => this.distanceSquared(left.position, center) - this.distanceSquared(right.position, center))[0] ?? null;
  }

  private isDroppedItemEntity(entity: DroppedItemEntity | undefined): entity is DroppedItemEntity {
    if (!entity) {
      return false;
    }

    if (DROPPED_ITEM_ENTITY_NAMES.has(entity.name ?? '')) {
      return true;
    }

    if (entity.displayName === 'Item Stack') {
      return true;
    }

    if (typeof entity.getDroppedItem !== 'function') {
      return false;
    }

    try {
      return entity.getDroppedItem() !== null;
    } catch {
      return false;
    }
  }

  private isWithinCollectionRange(
    position: Vec3,
    center: Vec3,
    horizontalRange: number,
    verticalRange: number,
  ): boolean {
    const dx = position.x - center.x;
    const dz = position.z - center.z;
    const horizontalDistance = Math.sqrt(dx * dx + dz * dz);
    const verticalDistance = Math.abs(position.y - center.y);

    return horizontalDistance <= horizontalRange && verticalDistance <= verticalRange;
  }

  private distanceSquared(left: Vec3, right: Vec3): number {
    const dx = left.x - right.x;
    const dy = left.y - right.y;
    const dz = left.z - right.z;

    return dx * dx + dy * dy + dz * dz;
  }

  private stringifyError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }
}
