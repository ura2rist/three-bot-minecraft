import { StartBotsUseCase } from '../../application/bot/use-cases/StartBotsUseCase';
import { FileBotFleetConfigurationProvider } from '../../infrastructure/config/FileBotFleetConfigurationProvider';
import { FileFarmRoleSettingsProvider } from '../../infrastructure/config/FileFarmRoleSettingsProvider';
import { FileTradingRoleSettingsProvider } from '../../infrastructure/config/FileTradingRoleSettingsProvider';
import { ConsoleLogger } from '../../infrastructure/logging/ConsoleLogger';
import { MineflayerBotClient } from '../../infrastructure/mineflayer/MineflayerBotClient';

export async function bootstrapBot(): Promise<void> {
  const logger = new ConsoleLogger();
  const configurationProvider = new FileBotFleetConfigurationProvider();
  const farmRoleSettingsProvider = new FileFarmRoleSettingsProvider();
  const tradingRoleSettingsProvider = new FileTradingRoleSettingsProvider();
  const botClient = new MineflayerBotClient(
    logger,
    tradingRoleSettingsProvider,
    farmRoleSettingsProvider,
  );
  const startupDelayMs = Number.parseInt(process.env.BOT_START_DELAY_MS ?? '5000', 10);
  const useCase = new StartBotsUseCase(
    configurationProvider,
    botClient,
    logger,
    Number.isFinite(startupDelayMs) ? startupDelayMs : 5000,
  );

  try {
    await useCase.execute();
  } catch (error) {
    logger.error('Bot bootstrap failed.', error);
    process.exitCode = 1;
  }
}
