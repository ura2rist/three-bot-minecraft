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
      plugins: {
        physics: false,
      },
    }) as BotWithClient;
    const authenticator = new LightAuthBotAuthenticator(logger);
    let hasSpawned = false;

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
    });

    bot._client.on('compress', () => {
      logger.info('Compression packet received.');
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
