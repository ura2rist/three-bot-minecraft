import { BotConfiguration } from '../../../domain/bot/entities/BotConfiguration';

export interface BotClient {
  connect(configuration: BotConfiguration): Promise<void>;
}
