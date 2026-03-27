import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MineRoleSettingsProvider } from '../../application/bot/ports/MineRoleSettingsProvider';
import { MineRoleSettings } from '../../domain/bot/entities/RoleSettings';
import { DomainError } from '../../domain/shared/errors/DomainError';

interface RawMineShaftSettings {
  targetDepthY?: unknown;
  shaftHeight?: unknown;
  shaftWidth?: unknown;
  shaftLength?: unknown;
}

interface RawMineRoleSettings {
  shaft?: unknown;
}

export class FileMineRoleSettingsProvider implements MineRoleSettingsProvider {
  load(): MineRoleSettings {
    const configPath = resolve(
      process.cwd(),
      process.env.MINE_ROLE_CONFIG_PATH ?? 'configs/roles/mine.json',
    );

    if (!existsSync(configPath)) {
      throw new DomainError(`Mine role config file was not found: ${configPath}`);
    }

    const rawFile = readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(rawFile) as RawMineRoleSettings;

    if (typeof parsed.shaft !== 'object' || parsed.shaft === null) {
      throw new DomainError('Mine role config must contain a "shaft" object.');
    }

    return {
      shaft: this.mapShaft(parsed.shaft),
    };
  }

  private mapShaft(rawShaft: unknown): MineRoleSettings['shaft'] {
    const candidate = rawShaft as RawMineShaftSettings;
    const targetDepthY = this.requirePositiveInteger(candidate.targetDepthY, 'shaft.targetDepthY');
    const shaftHeight = this.requirePositiveInteger(candidate.shaftHeight, 'shaft.shaftHeight');
    const shaftWidth = this.requirePositiveInteger(candidate.shaftWidth, 'shaft.shaftWidth');
    const shaftLength = this.requirePositiveInteger(candidate.shaftLength, 'shaft.shaftLength');

    return {
      targetDepthY,
      shaftHeight,
      shaftWidth,
      shaftLength,
    };
  }

  private requirePositiveInteger(value: unknown, fieldPath: string): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      throw new DomainError(`Mine role config field "${fieldPath}" must be a positive integer.`);
    }

    return value;
  }
}
