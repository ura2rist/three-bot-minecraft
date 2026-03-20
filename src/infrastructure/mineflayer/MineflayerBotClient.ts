import mineflayer from 'mineflayer';
import { BotClient } from '../../application/bot/ports/BotClient';
import { BotConfiguration } from '../../domain/bot/entities/BotConfiguration';
import { Logger } from '../../application/shared/ports/Logger';
import { LightAuthBotAuthenticator } from './LightAuthBotAuthenticator';

type BotWithClient = mineflayer.Bot & {
  _client: mineflayer.Bot['_client'] & {
    _lastDisconnectReason?: string;
  };
};

export class MineflayerBotClient implements BotClient {
  private readonly rallyHorizontalTolerance = 1.5;
  private readonly rallyVerticalTolerance = 1.5;
  private readonly rallyTimeoutMs = this.parseInteger(process.env.BOT_RALLY_TIMEOUT_MS, 120000);
  private readonly movementControlTickMs = 100;
  private readonly loginTimeoutMs = this.parseInteger(process.env.BOT_LOGIN_TIMEOUT_MS, 20000);
  private readonly spawnTimeoutMs = this.parseInteger(process.env.BOT_SPAWN_TIMEOUT_MS, 20000);
  private readonly retryDelayMs = this.parseInteger(process.env.BOT_CONNECT_RETRY_DELAY_MS, 7000);
  private readonly maxRetries = this.parseInteger(process.env.BOT_CONNECT_MAX_RETRIES, 2);

  constructor(private readonly logger: Logger) {}

  async connect(configuration: BotConfiguration): Promise<void> {
    let attempt = 0;

    while (attempt <= this.maxRetries) {
      try {
        await this.connectOnce(configuration);
        return;
      } catch (error) {
        const isLastAttempt = attempt >= this.maxRetries;

        if (!this.isConnectionThrottled(error) || isLastAttempt) {
          throw error;
        }

        this.logger
          .child(configuration.role)
          .warn(
            `Server throttled the connection. Retrying in ${this.retryDelayMs}ms (attempt ${attempt + 2}/${this.maxRetries + 1}).`,
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
      physicsEnabled: false,
    }) as BotWithClient;
    const authenticator = new LightAuthBotAuthenticator(logger);
    let hasSpawned = false;
    let configurationSettingsSent = false;

    const sendConfigurationSettings = () => {
      if (configurationSettingsSent || bot._client.state !== 'configuration') {
        return;
      }

      bot.setSettings({});
      configurationSettingsSent = true;
      logger.info('Client settings packet sent during configuration phase.');
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
      hasSpawned = true;
      logger.info('Bot spawned in the world.');
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
    });

    bot._client.on('compress', () => {
      logger.info('Compression packet received.');
    });

    bot._client.on('finish_configuration', () => {
      logger.info('Finish configuration packet received.');
    });

    bot.on('end', (reason) => {
      logger.info(`Bot connection ended: ${reason ?? 'unknown reason'}`);
    });

    bot.on('kicked', (reason) => {
      logger.error(`Bot was kicked: ${String(reason)}`);
    });

    bot.on('error', (error) => {
      logger.error('Mineflayer client error.', error);
    });

    await this.waitForLogin(bot, configuration);

    try {
      await authenticator.authenticate(bot, configuration);
    } catch (error) {
      logger.error('LightAuth authorization failed.', error);
      bot.end();
      throw error;
    }

    if (!hasSpawned) {
      await this.waitForSpawn(bot, configuration);
    }

    await this.sendGreeting(bot, logger);
    void this.moveToRallyPoint(bot, configuration, logger).catch((error) => {
      logger.error('Failed to reach the rally point after spawn.', error);
    });
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

  private isConnectionThrottled(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    const message = error.message.toLowerCase();

    return message.includes('connection throttled') || message.includes('please wait before reconnecting');
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

    bot.physicsEnabled = true;
    let lastYaw: number | null = null;
    let stalledTicks = 0;
    const deadline = Date.now() + this.rallyTimeoutMs;

    try {
      while (Date.now() < deadline) {
        if (bot._client.state !== 'play' || !bot.entity) {
          throw new Error(`Bot is no longer connected. Current state: ${String(bot._client.state)}.`);
        }

        const currentPosition = bot.entity.position;
        const deltaX = configuration.rallyPoint.x - currentPosition.x;
        const deltaY = configuration.rallyPoint.y - currentPosition.y;
        const deltaZ = configuration.rallyPoint.z - currentPosition.z;
        const horizontalDistance = Math.hypot(deltaX, deltaZ);

        if (
          horizontalDistance <= this.rallyHorizontalTolerance &&
          Math.abs(deltaY) <= this.rallyVerticalTolerance
        ) {
          logger.info(
            `Reached rally point at ${currentPosition.x.toFixed(2)} ${currentPosition.y.toFixed(2)} ${currentPosition.z.toFixed(2)}.`,
          );
          return;
        }

        const desiredYaw = Math.atan2(-deltaX, -deltaZ);

        if (
          lastYaw === null ||
          Math.abs(this.normalizeAngle(desiredYaw - lastYaw)) > 0.18
        ) {
          await bot.look(desiredYaw, 0, true);
          lastYaw = desiredYaw;
        }

        const horizontalSpeed = Math.hypot(bot.entity.velocity.x, bot.entity.velocity.z);
        stalledTicks = horizontalSpeed < 0.02 ? stalledTicks + 1 : 0;

        bot.setControlState('forward', true);
        bot.setControlState('sprint', horizontalDistance > 6);
        bot.setControlState('jump', deltaY > 0.6 || stalledTicks >= 5);

        await this.delay(this.movementControlTickMs);
      }

      throw new Error(
        `Timed out after ${this.rallyTimeoutMs}ms before reaching ${configuration.rallyPoint.x} ${configuration.rallyPoint.y} ${configuration.rallyPoint.z}.`,
      );
    } finally {
      bot.clearControlStates();
      bot.physicsEnabled = false;
    }
  }

  private waitForChatBlockMessage(bot: BotWithClient, timeoutMs: number): Promise<boolean> {
    const patterns = [
      'нужно немного пройтись',
      'не можете выполнить это действие',
      'не можете писать в чат',
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

  private normalizeAngle(angle: number): number {
    let normalized = angle;

    while (normalized <= -Math.PI) {
      normalized += Math.PI * 2;
    }

    while (normalized > Math.PI) {
      normalized -= Math.PI * 2;
    }

    return normalized;
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
}
