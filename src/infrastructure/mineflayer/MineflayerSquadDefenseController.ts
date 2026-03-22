import { Entity } from 'prismarine-entity';
import { BotActivityEvent } from '../../application/bot/events/BotActivityEvent';
import { Logger } from '../../application/shared/ports/Logger';
import { MineflayerCombatService } from './MineflayerCombatService';
import { BotWithPathfinder } from './MineflayerPortsShared';

export class MineflayerSquadDefenseController {
  private attackPromise: Promise<void> | null = null;
  private started = false;

  constructor(
    private readonly bot: BotWithPathfinder,
    private readonly logger: Logger,
    private readonly friendlyUsernames: ReadonlySet<string>,
    private readonly gotoPosition: (target: { x: number; y: number; z: number }, range: number) => Promise<void>,
    private readonly combatService: MineflayerCombatService,
    private readonly canInterruptWithThreatResponse: () => boolean,
    private readonly publishEvent: (event: BotActivityEvent) => Promise<void>,
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

    if (this.isFriendlySource(source)) {
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
    if (this.isFriendlySource(entity)) {
      return false;
    }

    if (entity.type === 'player') {
      const username = entity.username;
      return typeof username === 'string' && !this.friendlyUsernames.has(username);
    }

    return entity.kind?.toLowerCase().includes('hostile') ?? false;
  }

  private isFriendlySource(entity: Entity): boolean {
    if (this.isFriendlyEntity(entity)) {
      return true;
    }

    const username = entity.username;

    if (typeof username === 'string' && this.friendlyUsernames.has(username)) {
      return true;
    }

    return Object.values(this.bot.players).some((player) => {
      return player.entity?.id === entity.id && this.friendlyUsernames.has(player.username);
    });
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

    await this.combatService.equipWeaponIfAvailable();

    this.logger.warn(
      `Detected a threat ${source.displayName ?? source.name ?? 'unknown'} near the squad. Engaging.`,
    );

    const threatName = source.displayName ?? source.name ?? 'unknown';
    const mayInterruptCurrentTask = this.canInterruptWithThreatResponse();

    if (mayInterruptCurrentTask) {
      await this.publishEvent({
        type: 'bot.threat.engaged',
        payload: {
          username: this.bot.username,
          threatName,
        },
      });
    }

    try {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        if (!this.bot.entity || !source.isValid) {
          return;
        }

        const distance = this.bot.entity.position.distanceTo(source.position);

        if (distance > 12) {
          return;
        }

        if (distance > 3) {
          if (!mayInterruptCurrentTask) {
            this.logger.info(
              `Holding the current route because threat response is lower priority until the rally point is reached.`,
            );
            return;
          }

          await this.gotoPosition(source.position, 2).catch(() => undefined);
        }

        if (!source.isValid) {
          return;
        }

        await this.combatService.attackTarget(source);
        await this.bot.waitForTicks(10);
      }
    } finally {
      if (mayInterruptCurrentTask) {
        await this.publishEvent({
          type: 'bot.threat.resolved',
          payload: {
            username: this.bot.username,
            threatName,
          },
        });
      }
    }
  }
}
