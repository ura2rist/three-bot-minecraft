import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileFarmRoleSettingsProvider } from '../../../src/infrastructure/config/FileFarmRoleSettingsProvider';
import { DomainError } from '../../../src/domain/shared/errors/DomainError';

test('FileFarmRoleSettingsProvider loads and maps a valid farm config', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'mine-bot-farm-config-'));
  const configPath = join(tempDir, 'farm.json');
  const previousCwd = process.cwd();
  const previousEnv = {
    FARM_ROLE_CONFIG_PATH: process.env.FARM_ROLE_CONFIG_PATH,
  };

  try {
    writeFileSync(
      configPath,
      JSON.stringify({
        farms: [
          {
            itemId: 'wheat_seeds',
            points: [{ x: 10, y: 64, z: -5 }],
          },
        ],
      }),
      'utf8',
    );

    process.chdir(tempDir);
    process.env.FARM_ROLE_CONFIG_PATH = './farm.json';

    const provider = new FileFarmRoleSettingsProvider();
    const settings = provider.load();

    assert.deepEqual(settings, {
      farms: [
        {
          itemId: 'wheat_seeds',
          points: [{ x: 10, y: 64, z: -5 }],
        },
      ],
    });
  } finally {
    process.chdir(previousCwd);
    process.env.FARM_ROLE_CONFIG_PATH = previousEnv.FARM_ROLE_CONFIG_PATH;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('FileFarmRoleSettingsProvider rejects malformed farm points', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'mine-bot-farm-config-'));
  const configPath = join(tempDir, 'farm.json');
  const previousCwd = process.cwd();
  const previousEnv = {
    FARM_ROLE_CONFIG_PATH: process.env.FARM_ROLE_CONFIG_PATH,
  };

  try {
    writeFileSync(
      configPath,
      JSON.stringify({
        farms: [
          {
            itemId: 'wheat_seeds',
            points: [{ x: 'bad', y: 64, z: -5 }],
          },
        ],
      }),
      'utf8',
    );

    process.chdir(tempDir);
    process.env.FARM_ROLE_CONFIG_PATH = './farm.json';

    const provider = new FileFarmRoleSettingsProvider();
    assert.throws(() => provider.load(), DomainError);
  } finally {
    process.chdir(previousCwd);
    process.env.FARM_ROLE_CONFIG_PATH = previousEnv.FARM_ROLE_CONFIG_PATH;
    rmSync(tempDir, { recursive: true, force: true });
  }
});
