import { BotConfiguration } from '../../../domain/bot/entities/BotConfiguration';
import { CraftingTableAssignmentPolicy } from '../ports/CraftingTableAssignmentPolicy';

export class RandomCraftingTableAssignmentPolicy implements CraftingTableAssignmentPolicy {
  private readonly assignments = new Map<string, string>();

  prepareFleet(configurations: readonly BotConfiguration[]): void {
    this.assignments.clear();

    const groupedConfigurations = new Map<string, BotConfiguration[]>();

    for (const configuration of configurations) {
      if (!configuration.rallyPoint) {
        continue;
      }

      const rallyKey = this.getRallyKey(configuration);

      if (!groupedConfigurations.has(rallyKey)) {
        groupedConfigurations.set(rallyKey, []);
      }

      groupedConfigurations.get(rallyKey)?.push(configuration);
    }

    for (const [rallyKey, candidates] of groupedConfigurations.entries()) {
      const chosenConfiguration = candidates[Math.floor(Math.random() * candidates.length)];
      this.assignments.set(rallyKey, chosenConfiguration.username);
    }
  }

  getAssignedUsername(configuration: BotConfiguration): string | undefined {
    if (!configuration.rallyPoint) {
      return undefined;
    }

    return this.assignments.get(this.getRallyKey(configuration));
  }

  isAssignedCrafter(configuration: BotConfiguration): boolean {
    const assignedUsername = this.getAssignedUsername(configuration);
    return assignedUsername === undefined || assignedUsername === configuration.username;
  }

  private getRallyKey(configuration: BotConfiguration): string {
    return `${configuration.rallyPoint?.x}:${configuration.rallyPoint?.y}:${configuration.rallyPoint?.z}`;
  }
}
