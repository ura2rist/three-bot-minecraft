import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileMineRoutineProgressStore } from '../../../src/infrastructure/config/FileMineRoutineProgressStore';
import { DomainError } from '../../../src/domain/shared/errors/DomainError';

test('FileMineRoutineProgressStore saves and loads progress by username', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'mine-bot-mine-progress-'));
  const previousCwd = process.cwd();
  const previousEnv = {
    MINE_ROUTINE_PROGRESS_PATH: process.env.MINE_ROUTINE_PROGRESS_PATH,
  };

  try {
    process.chdir(tempDir);
    process.env.MINE_ROUTINE_PROGRESS_PATH = './state/mine-progress.json';

    const store = new FileMineRoutineProgressStore();
    store.save('Gimli', {
      staircaseProgress: 20,
      currentLayerIndex: 2,
      currentBranchIndex: 3,
      currentBranchProgress: 11,
      minePlanComplete: false,
    });

    assert.deepEqual(store.load('Gimli'), {
      staircaseProgress: 20,
      currentLayerIndex: 2,
      currentBranchIndex: 3,
      currentBranchProgress: 11,
      minePlanComplete: false,
    });
    assert.equal(store.load('Unknown'), null);
  } finally {
    process.chdir(previousCwd);
    process.env.MINE_ROUTINE_PROGRESS_PATH = previousEnv.MINE_ROUTINE_PROGRESS_PATH;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('FileMineRoutineProgressStore rejects malformed saved progress', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'mine-bot-mine-progress-'));
  const previousCwd = process.cwd();
  const previousEnv = {
    MINE_ROUTINE_PROGRESS_PATH: process.env.MINE_ROUTINE_PROGRESS_PATH,
  };

  try {
    process.chdir(tempDir);
    process.env.MINE_ROUTINE_PROGRESS_PATH = './state/mine-progress.json';
    mkdirSync(join(tempDir, 'state'), { recursive: true });
    writeFileSync(
      join(tempDir, 'state', 'mine-progress.json'),
      JSON.stringify({
        Gimli: {
          staircaseProgress: 'bad',
          currentLayerIndex: 1,
          currentBranchIndex: 0,
          currentBranchProgress: 0,
          minePlanComplete: false,
        },
      }),
      'utf8',
    );

    const store = new FileMineRoutineProgressStore();
    assert.throws(() => store.load('Gimli'), DomainError);
  } finally {
    process.chdir(previousCwd);
    process.env.MINE_ROUTINE_PROGRESS_PATH = previousEnv.MINE_ROUTINE_PROGRESS_PATH;
    rmSync(tempDir, { recursive: true, force: true });
  }
});
