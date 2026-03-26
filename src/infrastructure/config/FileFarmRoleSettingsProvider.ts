import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FarmRoleSettingsProvider } from '../../application/bot/ports/FarmRoleSettingsProvider';
import { FarmPlotSettings, FarmPointSettings, FarmRoleSettings } from '../../domain/bot/entities/RoleSettings';
import { DomainError } from '../../domain/shared/errors/DomainError';

interface RawFarmPointSettings {
  x?: unknown;
  y?: unknown;
  z?: unknown;
}

interface RawFarmPlotSettings {
  itemId?: unknown;
  points?: unknown;
}

interface RawFarmRoleSettings {
  farms?: unknown;
}

export class FileFarmRoleSettingsProvider implements FarmRoleSettingsProvider {
  load(): FarmRoleSettings {
    const configPath = resolve(
      process.cwd(),
      process.env.FARM_ROLE_CONFIG_PATH ?? 'configs/roles/farm.json',
    );

    if (!existsSync(configPath)) {
      throw new DomainError(`Farm role config file was not found: ${configPath}`);
    }

    const rawFile = readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(rawFile) as RawFarmRoleSettings;

    if (!Array.isArray(parsed.farms)) {
      throw new DomainError('Farm role config must contain a "farms" array.');
    }

    return {
      farms: parsed.farms.map((farm, index) => this.mapFarm(farm, index)),
    };
  }

  private mapFarm(rawFarm: unknown, index: number): FarmPlotSettings {
    if (typeof rawFarm !== 'object' || rawFarm === null) {
      throw new DomainError(`Farm config entry at index ${index} must be an object.`);
    }

    const candidate = rawFarm as RawFarmPlotSettings;
    const itemId = typeof candidate.itemId === 'string' ? candidate.itemId.trim() : '';

    if (itemId.length === 0) {
      throw new DomainError(`Farm config entry at index ${index}: itemId must be a non-empty string.`);
    }

    if (!Array.isArray(candidate.points)) {
      throw new DomainError(`Farm config entry at index ${index}: points must be an array.`);
    }

    return {
      itemId,
      points: candidate.points.map((point, pointIndex) => this.mapPoint(point, index, pointIndex)),
    };
  }

  private mapPoint(rawPoint: unknown, farmIndex: number, pointIndex: number): FarmPointSettings {
    if (typeof rawPoint !== 'object' || rawPoint === null) {
      throw new DomainError(
        `Farm config entry at index ${farmIndex}: points[${pointIndex}] must be an object.`,
      );
    }

    const candidate = rawPoint as RawFarmPointSettings;
    const x = typeof candidate.x === 'number' ? candidate.x : Number.NaN;
    const y = typeof candidate.y === 'number' ? candidate.y : Number.NaN;
    const z = typeof candidate.z === 'number' ? candidate.z : Number.NaN;

    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      throw new DomainError(
        `Farm config entry at index ${farmIndex}: points[${pointIndex}] must contain finite x, y and z coordinates.`,
      );
    }

    return { x, y, z };
  }
}
