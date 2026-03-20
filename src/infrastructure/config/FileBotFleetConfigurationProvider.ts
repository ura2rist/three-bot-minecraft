import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { BotFleetConfigurationProvider } from '../../application/bot/ports/BotFleetConfigurationProvider';
import { BotAuth, BotConfiguration, BotRallyPoint } from '../../domain/bot/entities/BotConfiguration';
import { BotFleetConfiguration } from '../../domain/bot/entities/BotFleetConfiguration';
import { BotRole, SUPPORTED_BOT_ROLES } from '../../domain/bot/entities/BotRole';
import { DomainError } from '../../domain/shared/errors/DomainError';

dotenv.config();

interface RawBotConfiguration {
  role?: unknown;
  username?: unknown;
  password?: unknown;
  rallyPoint?: unknown;
}

interface RawFleetConfiguration {
  bots?: unknown;
}

const SUPPORTED_AUTH_VALUES: readonly BotAuth[] = ['offline', 'microsoft'] as const;

export class FileBotFleetConfigurationProvider implements BotFleetConfigurationProvider {
  load(): BotFleetConfiguration {
    const configPath = resolve(process.cwd(), process.env.BOTS_CONFIG_PATH ?? 'bots.config.json');

    if (!existsSync(configPath)) {
      throw new DomainError(`Bots config file was not found: ${configPath}`);
    }

    const rawFile = readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(rawFile) as RawFleetConfiguration;

    if (!Array.isArray(parsed.bots)) {
      throw new DomainError('Bots config file must contain a "bots" array.');
    }

    const authValue = (process.env.BOT_AUTH ?? 'offline').trim();

    if (!SUPPORTED_AUTH_VALUES.includes(authValue as BotAuth)) {
      throw new DomainError('BOT_AUTH must be either "offline" or "microsoft".');
    }

    const host = (process.env.BOT_HOST ?? '').trim();
    const port = Number.parseInt(process.env.BOT_PORT ?? '25565', 10);
    const version = process.env.BOT_VERSION?.trim() || undefined;

    return new BotFleetConfiguration(
      parsed.bots.map((rawBot, index) =>
        this.mapRawBot(rawBot, index, {
          host,
          port,
          version,
          auth: authValue as BotAuth,
        }),
      ),
    );
  }

  private mapRawBot(
    rawBot: unknown,
    index: number,
    sharedConfig: {
      host: string;
      port: number;
      version?: string;
      auth: BotAuth;
    },
  ): BotConfiguration {
    if (typeof rawBot !== 'object' || rawBot === null) {
      throw new DomainError(`Bot config at index ${index} must be an object.`);
    }

    const candidate = rawBot as RawBotConfiguration;
    const roleValue = typeof candidate.role === 'string' ? candidate.role.trim() : '';

    if (!SUPPORTED_BOT_ROLES.includes(roleValue as BotRole)) {
      throw new DomainError(
        `Bot config at index ${index}: role must be one of ${SUPPORTED_BOT_ROLES.join(', ')}.`,
      );
    }

    return new BotConfiguration({
      role: roleValue as BotRole,
      host: sharedConfig.host,
      port: sharedConfig.port,
      username: String(candidate.username ?? ''),
      password: candidate.password === undefined ? undefined : String(candidate.password),
      rallyPoint: this.mapRallyPoint(candidate.rallyPoint, roleValue as BotRole, index),
      version: sharedConfig.version,
      auth: sharedConfig.auth,
    });
  }

  private mapRallyPoint(rawRallyPoint: unknown, role: BotRole, index: number): BotRallyPoint | undefined {
    if (rawRallyPoint === undefined) {
      return undefined;
    }

    if (typeof rawRallyPoint !== 'object' || rawRallyPoint === null) {
      throw new DomainError(`Bot config at index ${index} (${role}): rallyPoint must be an object.`);
    }

    const candidate = rawRallyPoint as {
      x?: unknown;
      y?: unknown;
      z?: unknown;
    };

    return {
      x: this.parseCoordinate(candidate.x, role, index, 'x'),
      y: this.parseCoordinate(candidate.y, role, index, 'y'),
      z: this.parseCoordinate(candidate.z, role, index, 'z'),
    };
  }

  private parseCoordinate(
    rawCoordinate: unknown,
    role: BotRole,
    index: number,
    axis: 'x' | 'y' | 'z',
  ): number {
    if (typeof rawCoordinate !== 'number' || !Number.isFinite(rawCoordinate)) {
      throw new DomainError(
        `Bot config at index ${index} (${role}): rallyPoint.${axis} must be a finite number.`,
      );
    }

    return rawCoordinate;
  }
}
