import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { LightAuthBotAuthenticator } from '../../../src/infrastructure/mineflayer/LightAuthBotAuthenticator';
import { BotConfiguration } from '../../../src/domain/bot/entities/BotConfiguration';
import { TestLogger } from '../../helpers/TestLogger';

class FakeAuthBot extends EventEmitter {
  public readonly sentMessages: string[] = [];

  chat(message: string): void {
    this.sentMessages.push(message);
    const attempt = this.sentMessages.length;

    setImmediate(() => {
      if (attempt === 1) {
        return;
      }

      if (attempt === 2) {
        this.emit('messagestr', ' Вы не зарегистрированы! Сначала используйте /register для регистрации.');
        return;
      }

      if (attempt === 3) {
        this.emit('messagestr', ' Регистрация прошла успешно.');
        return;
      }

      if (attempt === 4) {
        this.emit('messagestr', ' Вы успешно вошли в аккаунт! С возвращением.');
      }
    });
  }
}

class FakeIpLimitAuthBot extends EventEmitter {
  public readonly sentMessages: string[] = [];

  chat(message: string): void {
    this.sentMessages.push(message);

    setImmediate(() => {
      if (this.sentMessages.length === 1) {
        this.emit('messagestr', ' Вы достигли лимита аккаунтов для этого IP-адреса.');
      }
    });
  }
}

test('LightAuthBotAuthenticator retries register when login reports that the account is not registered', async () => {
  const previousEnv = {
    LIGHTAUTH_COMMAND_DELAY_MS: process.env.LIGHTAUTH_COMMAND_DELAY_MS,
    LIGHTAUTH_TIMEOUT_MS: process.env.LIGHTAUTH_TIMEOUT_MS,
  };

  try {
    process.env.LIGHTAUTH_COMMAND_DELAY_MS = '0';
    process.env.LIGHTAUTH_TIMEOUT_MS = '50';
    const logger = new TestLogger();
    const authenticator = new LightAuthBotAuthenticator(logger);
    const bot = new FakeAuthBot();
    const configuration = new BotConfiguration({
      role: 'farm',
      host: 'localhost',
      port: 25565,
      username: 'Gamgee1',
      password: 'secret',
      auth: 'offline',
    });

    await authenticator.authenticate(bot as never, configuration);

    assert.deepEqual(bot.sentMessages, [
      '/register secret secret',
      '/login secret',
      '/register secret secret',
      '/login secret',
    ]);
    assert.equal(
      logger.getEntries().some(
        (entry) =>
          entry.level === 'warn' &&
          entry.message.includes('account is not registered'),
      ),
      true,
    );
  } finally {
    process.env.LIGHTAUTH_COMMAND_DELAY_MS = previousEnv.LIGHTAUTH_COMMAND_DELAY_MS;
    process.env.LIGHTAUTH_TIMEOUT_MS = previousEnv.LIGHTAUTH_TIMEOUT_MS;
  }
});

test('LightAuthBotAuthenticator fails immediately when registration hits the IP account limit', async () => {
  const previousEnv = {
    LIGHTAUTH_COMMAND_DELAY_MS: process.env.LIGHTAUTH_COMMAND_DELAY_MS,
    LIGHTAUTH_TIMEOUT_MS: process.env.LIGHTAUTH_TIMEOUT_MS,
  };

  try {
    process.env.LIGHTAUTH_COMMAND_DELAY_MS = '0';
    process.env.LIGHTAUTH_TIMEOUT_MS = '50';
    const logger = new TestLogger();
    const authenticator = new LightAuthBotAuthenticator(logger);
    const bot = new FakeIpLimitAuthBot();
    const configuration = new BotConfiguration({
      role: 'farm',
      host: 'localhost',
      port: 25565,
      username: 'Gamge',
      password: 'secret',
      auth: 'offline',
    });

    await assert.rejects(
      authenticator.authenticate(bot as never, configuration),
      /lightauth register failed:.*лимита аккаунтов/i,
    );

    assert.deepEqual(bot.sentMessages, ['/register secret secret']);
  } finally {
    process.env.LIGHTAUTH_COMMAND_DELAY_MS = previousEnv.LIGHTAUTH_COMMAND_DELAY_MS;
    process.env.LIGHTAUTH_TIMEOUT_MS = previousEnv.LIGHTAUTH_TIMEOUT_MS;
  }
});
