import { DomainError } from '../../shared/errors/DomainError';
import { BotRole, SUPPORTED_BOT_ROLES } from './BotRole';

export type BotAuth = 'offline' | 'microsoft';

export interface BotConfigurationProps {
  role: BotRole;
  host: string;
  port: number;
  username: string;
  password?: string;
  version?: string;
  auth: BotAuth;
}

export class BotConfiguration {
  public readonly role: BotRole;
  public readonly host: string;
  public readonly port: number;
  public readonly username: string;
  public readonly password?: string;
  public readonly version?: string;
  public readonly auth: BotAuth;

  constructor(props: BotConfigurationProps) {
    const role = props.role;
    const host = props.host.trim();
    const username = props.username.trim();
    const password = props.password?.trim();
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

    if (!Number.isInteger(props.port) || props.port < 1 || props.port > 65535) {
      throw new DomainError(`Bot "${role}": port must be an integer between 1 and 65535.`);
    }

    this.role = role;
    this.host = host;
    this.port = props.port;
    this.username = username;
    this.password = password || undefined;
    this.version = version || undefined;
    this.auth = props.auth;
  }
}
