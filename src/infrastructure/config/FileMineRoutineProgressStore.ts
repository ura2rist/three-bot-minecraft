import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { MineRoutineProgressStore } from '../../application/bot/ports/MineRoutineProgressStore';
import { MineRoutineProgress } from '../../domain/bot/entities/MineRoutineProgress';
import { DomainError } from '../../domain/shared/errors/DomainError';

interface RawMineRoutineProgress {
  staircaseProgress?: unknown;
  currentLayerIndex?: unknown;
  currentBranchIndex?: unknown;
  currentBranchProgress?: unknown;
  minePlanComplete?: unknown;
}

type RawMineRoutineProgressFile = Record<string, RawMineRoutineProgress>;

export class FileMineRoutineProgressStore implements MineRoutineProgressStore {
  load(username: string): MineRoutineProgress | null {
    const normalizedUsername = this.normalizeUsername(username);

    if (!normalizedUsername) {
      return null;
    }

    if (!existsSync(this.getStateFilePath())) {
      return null;
    }

    const parsed = this.readStateFile();
    const rawProgress = parsed[normalizedUsername];

    if (rawProgress === undefined) {
      return null;
    }

    return this.mapProgress(rawProgress, normalizedUsername);
  }

  save(username: string, progress: MineRoutineProgress): void {
    const normalizedUsername = this.normalizeUsername(username);

    if (!normalizedUsername) {
      throw new DomainError('Mine routine progress username must not be empty.');
    }

    const filePath = this.getStateFilePath();
    const parsed = existsSync(filePath) ? this.readStateFile() : {};
    parsed[normalizedUsername] = this.serializeProgress(progress);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(parsed, null, 2), 'utf8');
  }

  private readStateFile(): RawMineRoutineProgressFile {
    const rawFile = readFileSync(this.getStateFilePath(), 'utf8');
    const parsed = JSON.parse(rawFile) as unknown;

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new DomainError('Mine routine progress file must contain a JSON object.');
    }

    return parsed as RawMineRoutineProgressFile;
  }

  private mapProgress(rawProgress: RawMineRoutineProgress, username: string): MineRoutineProgress {
    return {
      staircaseProgress: this.requireNonNegativeInteger(
        rawProgress.staircaseProgress,
        username,
        'staircaseProgress',
      ),
      currentLayerIndex: this.requireNonNegativeInteger(
        rawProgress.currentLayerIndex,
        username,
        'currentLayerIndex',
      ),
      currentBranchIndex: this.requireNonNegativeInteger(
        rawProgress.currentBranchIndex,
        username,
        'currentBranchIndex',
      ),
      currentBranchProgress: this.requireNonNegativeInteger(
        rawProgress.currentBranchProgress,
        username,
        'currentBranchProgress',
      ),
      minePlanComplete: this.requireBoolean(rawProgress.minePlanComplete, username, 'minePlanComplete'),
    };
  }

  private serializeProgress(progress: MineRoutineProgress): RawMineRoutineProgress {
    return {
      staircaseProgress: progress.staircaseProgress,
      currentLayerIndex: progress.currentLayerIndex,
      currentBranchIndex: progress.currentBranchIndex,
      currentBranchProgress: progress.currentBranchProgress,
      minePlanComplete: progress.minePlanComplete,
    };
  }

  private requireNonNegativeInteger(value: unknown, username: string, fieldPath: string): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new DomainError(
        `Mine routine progress field "${username}.${fieldPath}" must be a non-negative integer.`,
      );
    }

    return value;
  }

  private requireBoolean(value: unknown, username: string, fieldPath: string): boolean {
    if (typeof value !== 'boolean') {
      throw new DomainError(`Mine routine progress field "${username}.${fieldPath}" must be a boolean.`);
    }

    return value;
  }

  private normalizeUsername(username: string): string {
    return username.trim();
  }

  private getStateFilePath(): string {
    return resolve(
      process.cwd(),
      process.env.MINE_ROUTINE_PROGRESS_PATH ?? 'data/mine-progress.json',
    );
  }
}
