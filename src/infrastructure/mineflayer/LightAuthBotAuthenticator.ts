import type { Bot } from 'mineflayer';
import { BotConfiguration } from '../../domain/bot/entities/BotConfiguration';
import { Logger } from '../../application/shared/ports/Logger';

type AuthStage = 'register' | 'login';

interface MessageMatcher {
  successPatterns: readonly string[];
  nonFatalPatterns?: readonly string[];
  failurePatterns: readonly string[];
}

const REGISTER_MATCHER: MessageMatcher = {
  successPatterns: [
    'successfully registered',
    'registered successfully',
    'you have been registered',
    'registration successful',
    'регистрация прошла успешно',
    'теперь вы вошли в аккаунт',
  ],
  nonFatalPatterns: [
    'already registered',
    'already have an account',
    'please login',
    'use /login',
    'вы уже зарегистрированы',
    'уже зарегистрирован',
    'используйте /login',
    'войдите в аккаунт',
  ],
  failurePatterns: [
    'passwords do not match',
    'password too short',
    'password too weak',
    'registration failed',
    'пароли не совпадают',
    'пароль слишком короткий',
    'регистрация не удалась',
  ],
};

const LOGIN_MATCHER: MessageMatcher = {
  successPatterns: [
    'successfully logged in',
    'login successful',
    'logged in successfully',
    'authenticated',
    'you are now logged in',
    'already logged in',
    'вы успешно вошли в аккаунт',
    'успешно вошли в аккаунт',
    'с возвращением',
  ],
  failurePatterns: [
    'wrong password',
    'incorrect password',
    'invalid password',
    'login failed',
    'not registered',
    'неверный пароль',
    'ошибка входа',
    'вы не зарегистрированы',
  ],
};

export class LightAuthBotAuthenticator {
  private readonly registerCommand = process.env.LIGHTAUTH_REGISTER_COMMAND ?? '/register';
  private readonly loginCommand = process.env.LIGHTAUTH_LOGIN_COMMAND ?? '/login';
  private readonly commandDelayMs = this.parseInteger(
    process.env.LIGHTAUTH_COMMAND_DELAY_MS,
    1500,
  );
  private readonly timeoutMs = this.parseInteger(process.env.LIGHTAUTH_TIMEOUT_MS, 15000);

  constructor(private readonly logger: Logger) {}

  async authenticate(bot: Bot, configuration: BotConfiguration): Promise<void> {
    const logger = this.logger.child(`lightauth:${configuration.role}`);
    const password = configuration.password;

    logger.info(`Starting LightAuth flow for "${configuration.username}".`);

    await this.delay(this.commandDelayMs);

    bot.chat(`${this.registerCommand} ${password} ${password}`);
    logger.info(`Register command sent: ${this.registerCommand} <hidden> <hidden>`);

    const registerResult = await this.waitForStage(bot, logger, 'register', REGISTER_MATCHER);

    if (registerResult === 'timeout') {
      logger.warn('No explicit LightAuth register response received. Continuing to login.');
    }

    await this.delay(this.commandDelayMs);

    bot.chat(`${this.loginCommand} ${password}`);
    logger.info(`Login command sent: ${this.loginCommand} <hidden>`);

    await this.waitForStage(bot, logger, 'login', LOGIN_MATCHER);
    logger.info('Authorization successful.');
  }

  private async waitForStage(
    bot: Bot,
    logger: Logger,
    stage: AuthStage,
    matcher: MessageMatcher,
  ): Promise<'success' | 'non-fatal' | 'timeout'> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        cleanup();

        if (stage === 'register') {
          resolve('timeout');
          return;
        }

        reject(new Error(`LightAuth ${stage} timed out after ${this.timeoutMs}ms.`));
      }, this.timeoutMs);

      const handler = (message: string) => {
        const normalized = this.normalizeMessage(message);

        if (!normalized) {
          return;
        }

        if (this.matches(normalized, matcher.failurePatterns)) {
          cleanup();
          reject(new Error(`LightAuth ${stage} failed: ${message}`));
          return;
        }

        if (matcher.nonFatalPatterns && this.matches(normalized, matcher.nonFatalPatterns)) {
          cleanup();
          logger.warn(`LightAuth ${stage} returned non-fatal response: ${message}`);
          resolve('non-fatal');
          return;
        }

        if (this.matches(normalized, matcher.successPatterns)) {
          cleanup();
          logger.info(`LightAuth ${stage} succeeded: ${message}`);
          resolve('success');
        }
      };

      const cleanup = () => {
        clearTimeout(timeoutId);
        bot.off('messagestr', handler);
      };

      bot.on('messagestr', handler);
    });
  }

  private matches(message: string, patterns: readonly string[]): boolean {
    return patterns.some((pattern) => message.includes(pattern));
  }

  private normalizeMessage(message: string): string {
    return message.replace(/\u00A7./g, '').trim().toLowerCase();
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
