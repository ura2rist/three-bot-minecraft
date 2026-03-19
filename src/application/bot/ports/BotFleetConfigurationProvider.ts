import { BotFleetConfiguration } from '../../../domain/bot/entities/BotFleetConfiguration';

export interface BotFleetConfigurationProvider {
  load(): BotFleetConfiguration;
}
