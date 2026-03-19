import { DomainError } from '../../shared/errors/DomainError';
import { BotConfiguration } from './BotConfiguration';

export class BotFleetConfiguration {
  public readonly bots: readonly BotConfiguration[];

  constructor(bots: BotConfiguration[]) {
    if (bots.length === 0) {
      throw new DomainError('At least one bot configuration is required.');
    }

    if (bots.length > 3) {
      throw new DomainError('No more than 3 bots are allowed in one application instance.');
    }

    const roles = new Set<string>();

    for (const bot of bots) {
      if (roles.has(bot.role)) {
        throw new DomainError(`Bot role "${bot.role}" must be unique.`);
      }

      roles.add(bot.role);
    }

    this.bots = bots;
  }
}
