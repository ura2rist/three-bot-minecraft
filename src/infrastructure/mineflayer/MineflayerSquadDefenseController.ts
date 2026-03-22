import { Entity } from 'prismarine-entity';
import { Logger } from '../../application/shared/ports/Logger';
import { BotWithPathfinder } from './MineflayerPortsShared';

export class MineflayerSquadDefenseController {
  private attackPromise: Promise<void> | null = null;
  private started = false;

  constructor(
    private readonly bot: BotWithPathfinder,
    private readonly logger: Logger,
    private readonly friendlyUsernames: ReadonlySet<string>,
    private readonly gotoPosition: (target: { x: number; y: number; z: number }, range: number) => Promise<void>,
  ) {}

  start(): void {
    if (this.started) {
      return;
    }

    this.started = true;
    this.bot.on('entityHurt', this.handleEntityHurt);
  }

  stop(): void {
    if (!this.started) {
      return;
    }

    this.started = false;
    this.bot.off('entityHurt', this.handleEntityHurt);
  }

  private readonly handleEntityHurt = (entity: Entity, source: Entity): void => {
    if (!this.shouldDefend(entity, source)) {
      return;
    }

    void this.engageThreat(source).catch((error) => {
      this.logger.error('Failed to defend a squad member from a threat.', error);
    });
  };

  private shouldDefend(entity: Entity, source: Entity | null | undefined): boolean {
    if (!source || !entity) {
      return false;
    }

    if (!this.isFriendlyEntity(entity)) {
      return false;
    }

    return this.isThreat(source);
  }

  private isFriendlyEntity(entity: Entity): boolean {
    if (entity === this.bot.entity) {
      return true;
    }

    return typeof entity.username === 'string' && this.friendlyUsernames.has(entity.username);
  }

  private isThreat(entity: Entity): boolean {
    if (entity.type === 'player') {
      const username = entity.username;
      return typeof username === 'string' && !this.friendlyUsernames.has(username);
    }

    return entity.kind?.toLowerCase().includes('hostile') ?? false;
  }

  private engageThreat(source: Entity): Promise<void> {
    if (this.attackPromise) {
      return this.attackPromise;
    }

    const attackPromise = this.performThreatResponse(source).finally(() => {
      if (this.attackPromise === attackPromise) {
        this.attackPromise = null;
      }
    });

    this.attackPromise = attackPromise;
    return attackPromise;
  }

  private async performThreatResponse(source: Entity): Promise<void> {
    if (!this.bot.entity || !source.isValid) {
      return;
    }

    const sword = this.bot.inventory.items().find((item) => item.name === 'wooden_sword');

    if (sword) {
      await this.bot.equip(sword, 'hand').catch(() => undefined);
    }

    this.logger.warn(
      `Detected a threat ${source.displayName ?? source.name ?? 'unknown'} near the squad. Engaging.`,
    );

    for (let attempt = 0; attempt < 6; attempt += 1) {
      if (!this.bot.entity || !source.isValid) {
        return;
      }

      const distance = this.bot.entity.position.distanceTo(source.position);

      if (distance > 12) {
        return;
      }

      if (distance > 3) {
        await this.gotoPosition(source.position, 2).catch(() => undefined);
      }

      if (!source.isValid) {
        return;
      }

      await this.bot.lookAt(source.position.offset(0, Math.max(source.height / 2, 0.5), 0), true);
      this.bot.attack(source);
      await this.bot.waitForTicks(10);
    }
  }
}
