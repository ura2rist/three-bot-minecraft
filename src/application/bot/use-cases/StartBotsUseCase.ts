import { BotClient } from '../ports/BotClient';
import { BotFleetConfigurationProvider } from '../ports/BotFleetConfigurationProvider';
import { Logger } from '../../shared/ports/Logger';

export class StartBotsUseCase {
  constructor(
    private readonly configurationProvider: BotFleetConfigurationProvider,
    private readonly botClient: BotClient,
    private readonly logger: Logger,
    private readonly startupDelayMs = 5000,
  ) {}

  async execute(): Promise<void> {
    const fleetConfiguration = this.configurationProvider.load();
    const failures: unknown[] = [];

    for (let index = 0; index < fleetConfiguration.bots.length; index += 1) {
      const configuration = fleetConfiguration.bots[index];

      this.logger.info(
        `Scheduling bot "${configuration.role}" (${configuration.username}) for ${configuration.host}:${configuration.port}`,
      );

      try {
        await this.botClient.connect(configuration);
      } catch (error) {
        failures.push(error);
      }

      const isLastBot = index === fleetConfiguration.bots.length - 1;

      if (!isLastBot) {
        this.logger.info(`Waiting ${this.startupDelayMs}ms before starting next bot.`);
        await new Promise((resolve) => setTimeout(resolve, this.startupDelayMs));
      }
    }

    if (failures.length > 0) {
      for (const failure of failures) {
        this.logger.error('Bot startup failed.', failure);
      }

      throw new Error(`${failures.length} bot(s) failed during startup or authorization.`);
    }
  }
}
