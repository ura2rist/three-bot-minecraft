import mineflayer from 'mineflayer';
import { BotClient } from '../../application/bot/ports/BotClient';
import { BotConfiguration } from '../../domain/bot/entities/BotConfiguration';
import { Logger } from '../../application/shared/ports/Logger';
import { LightAuthBotAuthenticator } from './LightAuthBotAuthenticator';
import { CraftingTableCoordinator } from './CraftingTableCoordinator';
import { CraftingTableProvisioner } from './CraftingTableProvisioner';

const mineflayerPathfinder = require('../../../.vendor/mineflayer-pathfinder-master');
const pathfinderPlugin = mineflayerPathfinder.pathfinder as (bot: mineflayer.Bot) => void;
const Movements = mineflayerPathfinder.Movements as new (bot: mineflayer.Bot) => PathfinderMovements;
const GoalNear = mineflayerPathfinder.goals.GoalNear as new (
  x: number,
  y: number,
  z: number,
  range: number,
) => unknown;

interface PathfinderApi {
  setMovements(movements: PathfinderMovements): void;
  goto(goal: unknown): Promise<void>;
  stop(): void;
}

interface PathfinderMovements {
  canDig: boolean;
  allow1by1towers: boolean;
  allowParkour: boolean;
  allowSprinting: boolean;
  canOpenDoors: boolean;
  maxDropDown: number;
}

interface StringEventBot {
  on(event: string, listener: (...args: unknown[]) => void): void;
}

type BotWithClient = mineflayer.Bot & {
  pathfinder: PathfinderApi;
  _client: mineflayer.Bot['_client'] & {
    _lastDisconnectReason?: string;
  };
};

export class MineflayerBotClient implements BotClient {
  private readonly rallyGoalRange = 1;
  private readonly rallyTimeoutMs = this.parseInteger(process.env.BOT_RALLY_TIMEOUT_MS, 120000);
  private readonly rallyRetryDelayMs = this.parseInteger(process.env.BOT_RALLY_RETRY_DELAY_MS, 3000);
  private readonly rallySingleAttemptTimeoutMs = this.parseInteger(
    process.env.BOT_RALLY_SINGLE_ATTEMPT_TIMEOUT_MS,
    15000,
  );
  private readonly rallyStabilizationTicks = this.parseInteger(
    process.env.BOT_RALLY_STABILIZATION_TICKS,
    20,
  );
  private readonly configurationFallbackDelayMs = this.parseInteger(
    process.env.BOT_CONFIGURATION_FALLBACK_DELAY_MS,
    1500,
  );
  private readonly loginTimeoutMs = this.parseInteger(process.env.BOT_LOGIN_TIMEOUT_MS, 20000);
  private readonly spawnTimeoutMs = this.parseInteger(process.env.BOT_SPAWN_TIMEOUT_MS, 20000);
  private readonly retryDelayMs = this.parseInteger(process.env.BOT_CONNECT_RETRY_DELAY_MS, 7000);
  private readonly maxRetries = this.parseInteger(process.env.BOT_CONNECT_MAX_RETRIES, 2);
  private readonly craftingTableCoordinator = new CraftingTableCoordinator();
  private readonly craftingTableProvisioner = new CraftingTableProvisioner(this.craftingTableCoordinator);

  constructor(private readonly logger: Logger) {}

  prepareFleet(configurations: readonly BotConfiguration[]): void {
    this.craftingTableCoordinator.prepareFleet(configurations);

    for (const configuration of configurations) {
      const assignedUsername = this.craftingTableCoordinator.getAssignedUsername(configuration);

      if (!assignedUsername || !configuration.rallyPoint || assignedUsername !== configuration.username) {
        continue;
      }

      this.logger.info(
        `Crafting table provisioning near ${configuration.rallyPoint.x} ${configuration.rallyPoint.y} ${configuration.rallyPoint.z} is assigned to "${configuration.username}".`,
      );
    }
  }

  async connect(configuration: BotConfiguration): Promise<void> {
    let attempt = 0;

    while (attempt <= this.maxRetries) {
      try {
        await this.connectOnce(configuration);
        return;
      } catch (error) {
        const isLastAttempt = attempt >= this.maxRetries;

        if (!this.isRetryableConnectionError(error) || isLastAttempt) {
          throw error;
        }

        this.logger
          .child(configuration.role)
          .warn(
            `Bot startup failed with a retryable connection error. Retrying in ${this.retryDelayMs}ms (attempt ${attempt + 2}/${this.maxRetries + 1}).`,
          );

        await this.delay(this.retryDelayMs);
      }

      attempt += 1;
    }
  }

  private async connectOnce(configuration: BotConfiguration): Promise<void> {
    const logger = this.logger.child(configuration.role);
    const bot = mineflayer.createBot({
      host: configuration.host,
      port: configuration.port,
      username: configuration.username,
      version: configuration.version,
      auth: configuration.auth,
    }) as BotWithClient;
    bot.loadPlugin(pathfinderPlugin);

    const authenticator = new LightAuthBotAuthenticator(logger);
    let hasSpawned = false;
    let isAuthenticated = false;
    let spawnCount = 0;
    let configurationSettingsSent = false;
    let configurationFallbackTriggered = false;
    let rallyNavigationPromise: Promise<void> | null = null;
    let rallyNavigationAttempt = 0;

    const sendConfigurationSettings = () => {
      if (configurationSettingsSent || bot._client.state !== 'configuration') {
        return;
      }

      bot.setSettings({});
      configurationSettingsSent = true;
      logger.info('Client settings packet sent during configuration phase.');
    };
    const stopRallyNavigation = (reason: string) => {
      if (!configuration.rallyPoint) {
        return;
      }

      rallyNavigationAttempt += 1;
      rallyNavigationPromise = null;
      bot.pathfinder.stop();
      logger.info(`Stopped rally navigation: ${reason}.`);
    };
    const startRallyNavigation = (force = false) => {
      if (!configuration.rallyPoint) {
        return;
      }

      if (force && rallyNavigationPromise) {
        stopRallyNavigation('restarting route after respawn');
      }

      if (rallyNavigationPromise) {
        return;
      }

      const attempt = rallyNavigationAttempt + 1;
      rallyNavigationAttempt = attempt;

      rallyNavigationPromise = this.moveToRallyPoint(bot, configuration, logger)
        .then(async () => {
          await this.craftingTableProvisioner.ensureNearRallyPoint(bot, configuration, logger);
        })
        .catch((error) => {
          if (attempt !== rallyNavigationAttempt) {
            return;
          }

          logger.error('Failed to reach the rally point after spawn.', error);
        })
        .finally(() => {
          if (attempt === rallyNavigationAttempt) {
            rallyNavigationPromise = null;
          }
        });
    };

    bot._client.on('connect', () => {
      logger.info('TCP connection established.');
    });

    bot.on('inject_allowed', () => {
      logger.info('Mineflayer injection allowed.');
    });

    bot.on('login', () => {
      logger.info(`Bot logged in as "${configuration.username}".`);
    });

    bot.on('spawn', () => {
      spawnCount += 1;
      hasSpawned = true;
      logger.info(spawnCount === 1 ? 'Bot spawned in the world.' : 'Bot respawned in the world.');

      if (isAuthenticated) {
        startRallyNavigation(true);
      }
    });

    bot.on('death', () => {
      logger.warn('Bot died. Rally navigation will restart after respawn.');
      stopRallyNavigation('bot died');
    });

    bot.on('chat', (username, message) => {
      if (username === configuration.username) {
        return;
      }

      logger.info(`[CHAT] ${username}: ${message}`);
    });

    bot.on('messagestr', (message) => {
      logger.info(`[SERVER] ${message}`);
    });

    bot._client.on('disconnect', (packet: { reason?: unknown }) => {
      bot._client._lastDisconnectReason = String(packet.reason ?? 'unknown disconnect reason');
      logger.warn(`Disconnect packet received: ${bot._client._lastDisconnectReason}`);
    });

    bot._client.on('login', () => {
      logger.info('Low-level login packet received.');
    });

    bot._client.on('success', () => {
      logger.info('Low-level login success packet received.');
      setTimeout(sendConfigurationSettings, 0);
      setTimeout(() => {
        if (bot._client.state !== 'configuration' || configurationFallbackTriggered) {
          return;
        }

        configurationFallbackTriggered = true;
        logger.warn(
          `Client is still in configuration after ${this.configurationFallbackDelayMs}ms. Sending fallback handshake packets.`,
        );
        this.tryWriteConfigurationPacket(bot, 'finish_configuration', logger);
        this.tryWriteConfigurationPacket(bot, 'accept_code_of_conduct', logger);
      }, this.configurationFallbackDelayMs);
    });

    bot._client.on('compress', () => {
      logger.info('Compression packet received.');
    });

    // bot._client.on('keep_alive', () => {
    //   logger.info(`Keep-alive packet received in state "${String(bot._client.state)}".`);
    // });

    // bot._client.on('registry_data', () => {
    //   logger.info('Registry data packet received.');
    // });

    bot._client.on('feature_flags', () => {
      logger.info('Feature flags packet received.');
    });

    bot._client.on('code_of_conduct', () => {
      logger.info('Code of conduct packet received.');
    });

    bot._client.on('show_dialog', () => {
      logger.info('Show dialog packet received.');
    });

    bot._client.on('finish_configuration', () => {
      logger.info('Finish configuration packet received.');
    });

    const stringEventBot = bot as unknown as StringEventBot;

    // stringEventBot.on('goal_reached', () => {
    //   logger.info('Pathfinder goal reached.');
    // });

    stringEventBot.on('path_reset', (reason) => {
      if (reason === 'chunk_loaded' || reason === 'stuck') {
        return;
      }

      logger.warn(`Pathfinder reset the path: ${reason}.`);
    });

    // stringEventBot.on('path_update', (...args) => {
    //   const [result] = args as [{ status: string; path: unknown[] }];
    //   logger.info(`Pathfinder update: ${result.status}, nodes=${result.path.length}.`);
    // });

    bot.on('end', (reason) => {
      logger.info(`Bot connection ended: ${reason ?? 'unknown reason'}`);
    });

    bot.on('kicked', (reason) => {
      logger.error(`Bot was kicked: ${String(reason)}`);
    });

    bot.on('error', (error) => {
      logger.error('Mineflayer client error.', error);
    });

    try {
      await this.waitForLogin(bot, configuration);

      await authenticator.authenticate(bot, configuration);
      isAuthenticated = true;

      if (!hasSpawned) {
        await this.waitForSpawn(bot, configuration);
      }

      if (configuration.rallyPoint) {
        startRallyNavigation();
        return;
      }

      await this.sendGreeting(bot, logger);
    } catch (error) {
      if (error instanceof Error && error.message.toLowerCase().includes('lightauth')) {
        logger.error('LightAuth authorization failed.', error);
      }

      await this.disconnectBot(bot, logger);
      throw error;
    }
  }

  private waitForLogin(bot: BotWithClient, configuration: BotConfiguration): Promise<void> {
    return new Promise((resolve, reject) => {
      if (bot._client.state === 'play') {
        resolve();
        return;
      }

      const timeoutId = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `Bot "${configuration.role}" login timed out after ${this.loginTimeoutMs}ms. Current state: ${String(bot._client.state)}.${this.formatDisconnectReason(bot)}`,
          ),
        );
      }, this.loginTimeoutMs);
      const intervalId = setInterval(() => {
        if (bot._client.state === 'play') {
          cleanup();
          resolve();
        }
      }, 100);

      const cleanup = () => {
        clearTimeout(timeoutId);
        clearInterval(intervalId);
      };
    });
  }

  private waitForSpawn(bot: BotWithClient, configuration: BotConfiguration): Promise<void> {
    return new Promise((resolve, reject) => {
      if (bot.entity) {
        resolve();
        return;
      }

      const timeoutId = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `Bot "${configuration.role}" spawn timed out after auth.${this.formatDisconnectReason(bot)}`,
          ),
        );
      }, this.spawnTimeoutMs);

      const intervalId = setInterval(() => {
        if (bot.entity) {
          cleanup();
          resolve();
        }
      }, 100);

      const cleanup = () => {
        clearTimeout(timeoutId);
        clearInterval(intervalId);
        bot.off('spawn', handleSpawn);
      };

      const handleSpawn = () => {
        cleanup();
        resolve();
      };

      bot.once('spawn', handleSpawn);
    });
  }

  private isRetryableConnectionError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    const message = error.message.toLowerCase();

    return (
      message.includes('connection throttled') ||
      message.includes('please wait before reconnecting') ||
      message.includes('timed out') ||
      message.includes('econnreset') ||
      message.includes('socketclosed') ||
      message.includes('keepaliveerror')
    );
  }

  private isRetryableRallyNavigationError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    const message = error.message.toLowerCase();

    return (
      message.includes('no path to the goal') ||
      message.includes('timed out') ||
      message.includes('timeout waiting for') ||
      message.includes('stuck') ||
      message.includes('goal changed') ||
      message.includes('path stopped') ||
      message.includes('goal was not actually reached')
    );
  }

  private formatDisconnectReason(bot: BotWithClient): string {
    if (!bot._client._lastDisconnectReason) {
      return '';
    }

    return ` Disconnect reason: ${bot._client._lastDisconnectReason}`;
  }

  private async sendGreeting(bot: BotWithClient, logger: Logger): Promise<void> {
    bot.chat('hi');
    logger.info('Sent chat message "hi".');

    const chatWasBlocked = await this.waitForChatBlockMessage(bot, 2000);

    if (!chatWasBlocked) {
      return;
    }

    logger.warn('Chat was blocked before movement. Walking briefly and retrying greeting.');
    await this.nudgeForward(bot);
    await this.delay(400);
    bot.chat('hi');
    logger.info('Retried chat message "hi" after movement.');
  }

  private async moveToRallyPoint(
    bot: BotWithClient,
    configuration: BotConfiguration,
    logger: Logger,
  ): Promise<void> {
    if (!bot.entity) {
      logger.warn('Skipping rally movement because the bot entity is not available.');
      return;
    }

    if (!configuration.rallyPoint) {
      logger.info('No rally point configured. Bot will stay at the spawn area.');
      return;
    }

    logger.info(
      `Heading to rally point ${configuration.rallyPoint.x} ${configuration.rallyPoint.y} ${configuration.rallyPoint.z}.`,
    );

    const movements = this.createRallyMovements(bot);
    const deadline = Date.now() + this.rallyTimeoutMs;

    if (this.rallyStabilizationTicks > 0) {
      await bot.waitForTicks(this.rallyStabilizationTicks);
    }

    while (Date.now() < deadline) {
      bot.pathfinder.setMovements(movements);

      try {
        await this.waitForChunksForRally(bot, logger);

        const attemptTimeoutMs = Math.min(
          this.rallySingleAttemptTimeoutMs,
          Math.max(deadline - Date.now(), 1000),
        );

        await Promise.race([
          bot.pathfinder.goto(
            new GoalNear(
              configuration.rallyPoint.x,
              configuration.rallyPoint.y,
              configuration.rallyPoint.z,
              this.rallyGoalRange,
            ),
          ),
          this.failAfter(
            attemptTimeoutMs,
            `Timed out after ${attemptTimeoutMs}ms while building or following a route to ${configuration.rallyPoint.x} ${configuration.rallyPoint.y} ${configuration.rallyPoint.z}.`,
          ),
        ]);

        if (!bot.entity) {
          throw new Error('Bot entity is unavailable after pathfinding completed.');
        }

        const distanceToGoal = this.calculateDistanceToGoal(bot, configuration);

        if (distanceToGoal > this.rallyGoalRange + 1.5) {
          throw new Error(
            `Goal was not actually reached. Remaining distance: ${distanceToGoal.toFixed(2)} blocks.`,
          );
        }

        logger.info(
          `Reached rally point at ${bot.entity.position.x.toFixed(2)} ${bot.entity.position.y.toFixed(2)} ${bot.entity.position.z.toFixed(2)}.`,
        );
        return;
      } catch (error) {
        if (!this.isRetryableRallyNavigationError(error) || Date.now() + this.rallyRetryDelayMs >= deadline) {
          throw error;
        }

        logger.warn(
          `Could not reach the rally point yet. Retrying in ${this.rallyRetryDelayMs}ms: ${this.stringifyError(error)}.`,
        );
        await this.delay(this.rallyRetryDelayMs);
      } finally {
        bot.pathfinder.stop();
      }
    }

    throw new Error(
      `Timed out after ${this.rallyTimeoutMs}ms before reaching ${configuration.rallyPoint.x} ${configuration.rallyPoint.y} ${configuration.rallyPoint.z}.`,
    );
  }

  private async waitForChunksForRally(bot: BotWithClient, logger: Logger): Promise<void> {
    try {
      await bot.waitForChunksToLoad();
    } catch (error) {
      logger.warn(
        `Chunks are still loading near the route. Continuing with the currently available world data: ${this.stringifyError(error)}.`,
      );
    }
  }

  private calculateDistanceToGoal(bot: BotWithClient, configuration: BotConfiguration): number {
    if (!bot.entity || !configuration.rallyPoint) {
      return Number.POSITIVE_INFINITY;
    }

    const dx = bot.entity.position.x - configuration.rallyPoint.x;
    const dy = bot.entity.position.y - configuration.rallyPoint.y;
    const dz = bot.entity.position.z - configuration.rallyPoint.z;

    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  private waitForChatBlockMessage(bot: BotWithClient, timeoutMs: number): Promise<boolean> {
    const patterns = [
      'РЅСѓР¶РЅРѕ РЅРµРјРЅРѕРіРѕ РїСЂРѕР№С‚РёСЃСЊ',
      'РЅРµ РјРѕР¶РµС‚Рµ РІС‹РїРѕР»РЅРёС‚СЊ СЌС‚Рѕ РґРµР№СЃС‚РІРёРµ',
      'РЅРµ РјРѕР¶РµС‚Рµ РїРёСЃР°С‚СЊ РІ С‡Р°С‚',
      'muted pre-movement chat',
      'need to walk',
    ];

    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        cleanup();
        resolve(false);
      }, timeoutMs);

      const handler = (message: string) => {
        const normalized = message.replace(/\u00A7./g, '').trim().toLowerCase();

        if (!patterns.some((pattern) => normalized.includes(pattern))) {
          return;
        }

        cleanup();
        resolve(true);
      };

      const cleanup = () => {
        clearTimeout(timeoutId);
        bot.off('messagestr', handler);
      };

      bot.on('messagestr', handler);
    });
  }

  private async nudgeForward(bot: BotWithClient): Promise<void> {
    if (!bot.entity) {
      return;
    }

    const start = bot.entity.position.clone();
    const yaw = bot.entity.yaw;
    const stepDistance = 0.3;
    const movedPosition = start.offset(-Math.sin(yaw) * stepDistance, 0, -Math.cos(yaw) * stepDistance);

    this.sendPositionPacket(bot, movedPosition, true);
    await this.delay(300);
    this.sendPositionPacket(bot, start, true);
  }

  private sendPositionPacket(bot: BotWithClient, position: { x: number; y: number; z: number }, onGround: boolean): void {
    bot._client.write('position', {
      x: position.x,
      y: position.y,
      z: position.z,
      onGround,
      flags: {
        onGround,
        hasHorizontalCollision: undefined,
      },
    });
  }

  private createRallyMovements(bot: BotWithClient): PathfinderMovements {
    const movements = new Movements(bot);
    movements.canDig = false;
    movements.allow1by1towers = false;
    movements.allowParkour = false;
    movements.allowSprinting = true;
    movements.canOpenDoors = false;
    movements.maxDropDown = 3;
    return movements;
  }

  private tryWriteConfigurationPacket(
    bot: BotWithClient,
    packetName: 'finish_configuration' | 'accept_code_of_conduct',
    logger: Logger,
  ): void {
    try {
      bot._client.write(packetName, {});
      logger.info(`Fallback packet sent: ${packetName}.`);
    } catch (error) {
      logger.warn(
        `Failed to send fallback packet "${packetName}" while in state "${String(bot._client.state)}": ${this.stringifyError(error)}`,
      );
    }
  }

  private parseInteger(value: string | undefined, fallback: number): number {
    const parsed = Number.parseInt(value ?? '', 10);

    if (!Number.isFinite(parsed)) {
      return fallback;
    }

    return parsed;
  }

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async failAfter(timeoutMs: number, message: string): Promise<never> {
    await this.delay(timeoutMs);
    throw new Error(message);
  }

  private stringifyError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }

  private async disconnectBot(bot: BotWithClient, logger: Logger): Promise<void> {
    if (bot._client.ended || bot._client.socket.destroyed) {
      return;
    }

    logger.info('Disconnecting bot after failed startup attempt.');

    await new Promise<void>((resolve) => {
      const timeoutId = setTimeout(() => {
        cleanup();
        resolve();
      }, 2000);

      const cleanup = () => {
        clearTimeout(timeoutId);
        bot.off('end', handleEnd);
      };

      const handleEnd = () => {
        cleanup();
        resolve();
      };

      bot.once('end', handleEnd);
      bot.end();
    });
  }
}
