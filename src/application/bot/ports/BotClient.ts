import { BotConfiguration } from '../../../domain/bot/entities/BotConfiguration';

export interface BotClient {
  prepareFleet(configurations: readonly BotConfiguration[]): void;
  connect(configuration: BotConfiguration): Promise<void>;
}
