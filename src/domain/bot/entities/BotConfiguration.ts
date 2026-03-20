import { DomainError } from '../../shared/errors/DomainError';
import { BotRole, SUPPORTED_BOT_ROLES } from './BotRole';

export type BotAuth = 'offline' | 'microsoft';

export interface BotRallyPoint {
  x: number;
  y: number;
  z: number;
}

export interface BotConfigurationProps {
  role: BotRole;
  host: string;
  port: number;
  username: string;
  password?: string;
  rallyPoint?: BotRallyPoint;
  version?: string;
  auth: BotAuth;
}

export class BotConfiguration {
  public readonly role: BotRole;
  public readonly host: string;
  public readonly port: number;
  public readonly username: string;
  public readonly password?: string;
  public readonly rallyPoint?: BotRallyPoint;
  public readonly version?: string;
  public readonly auth: BotAuth;

  constructor(props: BotConfigurationProps) {
    const role = props.role;
    const host = props.host.trim();
    const username = props.username.trim();
    const password = props.password?.trim();
    const rallyPoint = this.validateRallyPoint(role, props.rallyPoint);
    const version = props.version?.trim();

    if (!SUPPORTED_BOT_ROLES.includes(role)) {
      throw new DomainError(`Unsupported bot role "${String(role)}".`);
    }

    if (!host) {
      throw new DomainError(`Bot "${role}": host must not be empty.`);
    }

    if (!username) {
      throw new DomainError(`Bot "${role}": username must not be empty.`);
    }

    if (!password) {
      throw new DomainError(`Bot "${role}": password must not be empty for LightAuth.`);
    }

    if (!Number.isInteger(props.port) || props.port < 1 || props.port > 65535) {
      throw new DomainError(`Bot "${role}": port must be an integer between 1 and 65535.`);
    }

    this.role = role;
    this.host = host;
    this.port = props.port;
    this.username = username;
    this.password = password;
    this.rallyPoint = rallyPoint;
    this.version = version || undefined;
    this.auth = props.auth;
  }

  private validateRallyPoint(role: BotRole, rallyPoint?: BotRallyPoint): BotRallyPoint | undefined {
    if (rallyPoint === undefined) {
      return undefined;
    }

    if (
      !Number.isFinite(rallyPoint.x) ||
      !Number.isFinite(rallyPoint.y) ||
      !Number.isFinite(rallyPoint.z)
    ) {
      throw new DomainError(`Bot "${role}": rallyPoint must contain finite x, y and z coordinates.`);
    }

    return {
      x: rallyPoint.x,
      y: rallyPoint.y,
      z: rallyPoint.z,
    };
  }
}
