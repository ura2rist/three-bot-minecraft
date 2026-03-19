import mineflayer from 'mineflayer';
import { BotClient } from '../../application/bot/ports/BotClient';
import { BotConfiguration } from '../../domain/bot/entities/BotConfiguration';
import { Logger } from '../../application/shared/ports/Logger';

export class MineflayerBotClient implements BotClient {
  constructor(private readonly logger: Logger) {}

  async connect(configuration: BotConfiguration): Promise<void> {
    const bot = mineflayer.createBot({
      host: configuration.host,
      port: configuration.port,
      username: configuration.username,
      version: configuration.version,
      auth: configuration.auth,
    });

    bot.on('login', () => {
      this.logger.info(`Bot "${configuration.role}" logged in as "${configuration.username}".`);
    });

    bot.on('spawn', () => {
      this.logger.info(`Bot "${configuration.role}" spawned in the world.`);
    });

    bot.on('chat', (username, message) => {
      if (username === configuration.username) {
        return;
      }

      this.logger.info(`[${configuration.role}] [CHAT] ${username}: ${message}`);
    });

    bot.on('end', (reason) => {
      this.logger.info(`Bot "${configuration.role}" connection ended: ${reason ?? 'unknown reason'}`);
    });

    bot.on('kicked', (reason) => {
      this.logger.error(`Bot "${configuration.role}" was kicked: ${String(reason)}`);
    });

    bot.on('error', (error) => {
      this.logger.error(`Mineflayer client error for bot "${configuration.role}".`, error);
    });

    await new Promise<void>((resolve, reject) => {
      bot.once('spawn', () => resolve());
      bot.once('error', (error) => reject(error));
      bot.once('kicked', (reason) =>
        reject(new Error(`Bot "${configuration.role}" was kicked before spawn: ${String(reason)}`)),
      );
      bot.once('end', () =>
        reject(new Error(`Bot "${configuration.role}" disconnected before spawn.`)),
      );
    });
  }
}
