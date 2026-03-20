import { BotConfiguration } from '../../../domain/bot/entities/BotConfiguration';

export interface CraftingTableAssignmentPolicy {
  prepareFleet(configurations: readonly BotConfiguration[]): void;
  getAssignedUsername(configuration: BotConfiguration): string | undefined;
  isAssignedCrafter(configuration: BotConfiguration): boolean;
}
