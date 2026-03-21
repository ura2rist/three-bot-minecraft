import { Vec3 } from 'vec3';
import { BotWithPathfinder } from './MineflayerPortsShared';

interface DroppedItemEntity {
  name?: string;
  objectType?: string;
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
    private readonly gotoPosition: (target: Vec3, range: number) => Promise<void>,
  ) {}

  start(): void {
    if (this.intervalId) {
      return;
    }

    this.intervalId = setInterval(() => {
      void this.collectAroundBot().catch(() => undefined);
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

      await this.gotoPosition(droppedItem.position, 1);
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

    return entity.name === 'item' || entity.objectType === 'Item Stack';
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
}
