import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileMineRoleSettingsProvider } from '../../../src/infrastructure/config/FileMineRoleSettingsProvider';
import { DomainError } from '../../../src/domain/shared/errors/DomainError';

test('FileMineRoleSettingsProvider loads and maps a valid mine config', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'mine-bot-mine-config-'));
  const configPath = join(tempDir, 'mine.json');
  const previousCwd = process.cwd();
  const previousEnv = {
    MINE_ROLE_CONFIG_PATH: process.env.MINE_ROLE_CONFIG_PATH,
  };

  try {
    writeFileSync(
      configPath,
      JSON.stringify({
        shaft: {
          targetDepthY: 20,
          shaftHeight: 3,
          shaftWidth: 2,
          shaftLength: 24,
        },
      }),
      'utf8',
    );

    process.chdir(tempDir);
    process.env.MINE_ROLE_CONFIG_PATH = './mine.json';

    const provider = new FileMineRoleSettingsProvider();
    const settings = provider.load();

    assert.deepEqual(settings, {
      shaft: {
        targetDepthY: 20,
        shaftHeight: 3,
        shaftWidth: 2,
        shaftLength: 24,
      },
    });
  } finally {
    process.chdir(previousCwd);
    process.env.MINE_ROLE_CONFIG_PATH = previousEnv.MINE_ROLE_CONFIG_PATH;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('FileMineRoleSettingsProvider rejects malformed shaft values', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'mine-bot-mine-config-'));
  const configPath = join(tempDir, 'mine.json');
  const previousCwd = process.cwd();
  const previousEnv = {
    MINE_ROLE_CONFIG_PATH: process.env.MINE_ROLE_CONFIG_PATH,
  };

  try {
    writeFileSync(
      configPath,
      JSON.stringify({
        shaft: {
          targetDepthY: 'bad',
          shaftHeight: 3,
          shaftWidth: 2,
          shaftLength: 24,
        },
      }),
      'utf8',
    );

    process.chdir(tempDir);
    process.env.MINE_ROLE_CONFIG_PATH = './mine.json';

    const provider = new FileMineRoleSettingsProvider();
    assert.throws(() => provider.load(), DomainError);
  } finally {
    process.chdir(previousCwd);
    process.env.MINE_ROLE_CONFIG_PATH = previousEnv.MINE_ROLE_CONFIG_PATH;
    rmSync(tempDir, { recursive: true, force: true });
  }
});
