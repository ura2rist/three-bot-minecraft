import { BotClient } from '../ports/BotClient';
import { BotFleetConfigurationProvider } from '../ports/BotFleetConfigurationProvider';
import { Logger } from '../../shared/ports/Logger';

export class StartBotsUseCase {
  constructor(
    private readonly configurationProvider: BotFleetConfigurationProvider,
    private readonly botClient: BotClient,
    private readonly logger: Logger,
  ) {}

  async execute(): Promise<void> {
    const fleetConfiguration = this.configurationProvider.load();

    for (const configuration of fleetConfiguration.bots) {
      this.logger.info(
        `Scheduling bot "${configuration.role}" (${configuration.username}) for ${configuration.host}:${configuration.port}`,
      );
    }

    await Promise.all(fleetConfiguration.bots.map((configuration) => this.botClient.connect(configuration)));
  }
}
