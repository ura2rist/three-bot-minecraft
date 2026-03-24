import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileTradingRoleSettingsProvider } from '../../../src/infrastructure/config/FileTradingRoleSettingsProvider';
import { DomainError } from '../../../src/domain/shared/errors/DomainError';

test('FileTradingRoleSettingsProvider loads and maps a valid trading config', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'mine-bot-trading-config-'));
  const configPath = join(tempDir, 'trading.json');
  const previousCwd = process.cwd();
  const previousEnv = {
    TRADING_ROLE_CONFIG_PATH: process.env.TRADING_ROLE_CONFIG_PATH,
  };

  try {
    writeFileSync(
      configPath,
      JSON.stringify({
        offers: [
          {
            playerGives: [{ itemId: 'bread', amount: 2 }],
            botGives: [{ itemId: 'white_wool', amount: 1 }],
          },
        ],
      }),
      'utf8',
    );

    process.chdir(tempDir);
    process.env.TRADING_ROLE_CONFIG_PATH = './trading.json';

    const provider = new FileTradingRoleSettingsProvider();
    const settings = provider.load();

    assert.deepEqual(settings, {
      offers: [
        {
          playerGives: [{ itemId: 'bread', amount: 2 }],
          botGives: [{ itemId: 'white_wool', amount: 1 }],
        },
      ],
    });
  } finally {
    process.chdir(previousCwd);
    process.env.TRADING_ROLE_CONFIG_PATH = previousEnv.TRADING_ROLE_CONFIG_PATH;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('FileTradingRoleSettingsProvider rejects malformed trade stack amounts', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'mine-bot-trading-config-'));
  const configPath = join(tempDir, 'trading.json');
  const previousCwd = process.cwd();
  const previousEnv = {
    TRADING_ROLE_CONFIG_PATH: process.env.TRADING_ROLE_CONFIG_PATH,
  };

  try {
    writeFileSync(
      configPath,
      JSON.stringify({
        offers: [
          {
            playerGives: [{ itemId: 'bread', amount: 0 }],
            botGives: [{ itemId: 'white_wool', amount: 1 }],
          },
        ],
      }),
      'utf8',
    );

    process.chdir(tempDir);
    process.env.TRADING_ROLE_CONFIG_PATH = './trading.json';

    const provider = new FileTradingRoleSettingsProvider();
    assert.throws(() => provider.load(), DomainError);
  } finally {
    process.chdir(previousCwd);
    process.env.TRADING_ROLE_CONFIG_PATH = previousEnv.TRADING_ROLE_CONFIG_PATH;
    rmSync(tempDir, { recursive: true, force: true });
  }
});
