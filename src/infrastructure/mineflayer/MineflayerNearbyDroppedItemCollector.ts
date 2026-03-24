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
  private readonly pickupAttemptLimit = 4;
  private readonly pickupStepDistance = 0.5;
  private readonly pickupGoalRange = 1;
  private collectionPromise: Promise<boolean> | null = null;
  private intervalId: NodeJS.Timeout | null = null;
  private backgroundCollectionSuppressedUntil = 0;

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
      if (Date.now() < this.backgroundCollectionSuppressedUntil) {
        return;
      }

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

  pauseBackgroundCollectionFor(durationMs: number): void {
    this.backgroundCollectionSuppressedUntil = Math.max(
      this.backgroundCollectionSuppressedUntil,
      Date.now() + Math.max(0, durationMs),
    );
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

      const wasCollected = await this.tryCollectDroppedItem(
        droppedItem.position,
        center,
        horizontalRange,
        verticalRange,
      );

      if (!wasCollected) {
        return collectedAny;
      }

      collectedAny = true;
    }
  }

  private async tryCollectDroppedItem(
    droppedItemPosition: Vec3,
    center: Vec3,
    horizontalRange: number,
    verticalRange: number,
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= this.pickupAttemptLimit; attempt += 1) {
      const droppedItem = this.findNearestDroppedItem(center, horizontalRange, verticalRange);

      if (!droppedItem) {
        return true;
      }

      const targetPosition =
        attempt === 1 ? droppedItem.position : this.buildPickupStepTarget(droppedItem.position);

      if (!targetPosition) {
        return false;
      }

      try {
        await this.gotoPosition(
          targetPosition,
          attempt === 1 ? this.pickupGoalRange : this.pickupStepDistance,
        );
      } catch (error) {
        if (!this.hasDroppedItemNearby(center, horizontalRange, verticalRange)) {
          return true;
        }

        if (attempt === this.pickupAttemptLimit) {
          this.logger.warn(
            `Skipping dropped-item collection near ${droppedItem.position.x.toFixed(1)} ${droppedItem.position.y.toFixed(1)} ${droppedItem.position.z.toFixed(1)} after ${this.pickupAttemptLimit} attempts: ${this.stringifyError(error)}`,
          );
          return false;
        }

        continue;
      }

      await this.bot.waitForTicks(5);

      if (!this.hasDroppedItemNearby(center, horizontalRange, verticalRange)) {
        return true;
      }
    }

    this.logger.warn(
      `Skipping dropped-item collection near ${droppedItemPosition.x.toFixed(1)} ${droppedItemPosition.y.toFixed(1)} ${droppedItemPosition.z.toFixed(1)} because the item stayed out of reach after ${this.pickupAttemptLimit} attempts.`,
    );
    return false;
  }

  private buildPickupStepTarget(targetPosition: Vec3): Vec3 | null {
    if (!this.bot.entity) {
      return null;
    }

    const currentPosition = this.bot.entity.position;
    const dx = targetPosition.x - currentPosition.x;
    const dz = targetPosition.z - currentPosition.z;
    const horizontalDistance = Math.sqrt(dx * dx + dz * dz);

    if (horizontalDistance < 0.001) {
      return targetPosition;
    }

    const stepDistance = Math.min(this.pickupStepDistance, horizontalDistance);
    return new Vec3(
      currentPosition.x + (dx / horizontalDistance) * stepDistance,
      targetPosition.y,
      currentPosition.z + (dz / horizontalDistance) * stepDistance,
    );
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
