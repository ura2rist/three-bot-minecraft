import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileBotFleetConfigurationProvider } from '../../../src/infrastructure/config/FileBotFleetConfigurationProvider';
import { DomainError } from '../../../src/domain/shared/errors/DomainError';

test('FileBotFleetConfigurationProvider loads and maps a valid fleet config', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'mine-bot-config-'));
  const configPath = join(tempDir, 'bots.config.json');
  const previousCwd = process.cwd();
  const previousEnv = {
    BOTS_CONFIG_PATH: process.env.BOTS_CONFIG_PATH,
    BOT_HOST: process.env.BOT_HOST,
    BOT_PORT: process.env.BOT_PORT,
    BOT_AUTH: process.env.BOT_AUTH,
    BOT_VERSION: process.env.BOT_VERSION,
  };

  try {
    writeFileSync(
      configPath,
      JSON.stringify({
        bots: [
          {
            role: 'mine',
            username: 'Gimli',
            password: 'secret',
            rallyPoint: { x: 215, y: 64, z: -77 },
          },
        ],
      }),
      'utf8',
    );

    process.chdir(tempDir);
    process.env.BOTS_CONFIG_PATH = './bots.config.json';
    process.env.BOT_HOST = 'localhost';
    process.env.BOT_PORT = '25565';
    process.env.BOT_AUTH = 'offline';
    process.env.BOT_VERSION = '1.21.4';

    const provider = new FileBotFleetConfigurationProvider();
    const fleet = provider.load();

    assert.equal(fleet.bots[0]?.host, 'localhost');
    assert.equal(fleet.bots[0]?.username, 'Gimli');
    assert.deepEqual(fleet.bots[0]?.rallyPoint, { x: 215, y: 64, z: -77 });
  } finally {
    process.chdir(previousCwd);
    process.env.BOTS_CONFIG_PATH = previousEnv.BOTS_CONFIG_PATH;
    process.env.BOT_HOST = previousEnv.BOT_HOST;
    process.env.BOT_PORT = previousEnv.BOT_PORT;
    process.env.BOT_AUTH = previousEnv.BOT_AUTH;
    process.env.BOT_VERSION = previousEnv.BOT_VERSION;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('FileBotFleetConfigurationProvider rejects an unsupported auth type', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'mine-bot-config-'));
  const configPath = join(tempDir, 'bots.config.json');
  const previousCwd = process.cwd();
  const previousEnv = {
    BOTS_CONFIG_PATH: process.env.BOTS_CONFIG_PATH,
    BOT_HOST: process.env.BOT_HOST,
    BOT_PORT: process.env.BOT_PORT,
    BOT_AUTH: process.env.BOT_AUTH,
  };

  try {
    writeFileSync(
      configPath,
      JSON.stringify({
        bots: [{ role: 'mine', username: 'Gimli', password: 'secret' }],
      }),
      'utf8',
    );

    process.chdir(tempDir);
    process.env.BOTS_CONFIG_PATH = './bots.config.json';
    process.env.BOT_HOST = 'localhost';
    process.env.BOT_PORT = '25565';
    process.env.BOT_AUTH = 'invalid';

    const provider = new FileBotFleetConfigurationProvider();
    assert.throws(() => provider.load(), DomainError);
  } finally {
    process.chdir(previousCwd);
    process.env.BOTS_CONFIG_PATH = previousEnv.BOTS_CONFIG_PATH;
    process.env.BOT_HOST = previousEnv.BOT_HOST;
    process.env.BOT_PORT = previousEnv.BOT_PORT;
    process.env.BOT_AUTH = previousEnv.BOT_AUTH;
    rmSync(tempDir, { recursive: true, force: true });
  }
});
