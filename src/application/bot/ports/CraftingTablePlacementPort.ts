import { BotConfiguration } from '../../../domain/bot/entities/BotConfiguration';

export interface CraftingTablePlacementPort {
  hasCraftingTableNearRallyPoint(configuration: BotConfiguration): Promise<boolean>;
  placeCraftingTableNearRallyPoint(configuration: BotConfiguration): Promise<void>;
}
