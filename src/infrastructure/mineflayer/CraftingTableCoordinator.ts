import { BotConfiguration } from '../../domain/bot/entities/BotConfiguration';

export class CraftingTableCoordinator {
  private readonly assignments = new Map<string, string>();

  prepareFleet(configurations: readonly BotConfiguration[]): void {
    this.assignments.clear();

    const groupedConfigurations = new Map<string, BotConfiguration[]>();

    for (const configuration of configurations) {
      if (!configuration.rallyPoint) {
        continue;
      }

      const rallyKey = this.getRallyKey(configuration);

      if (!rallyKey) {
        continue;
      }

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
    const rallyKey = this.getRallyKey(configuration);

    if (!rallyKey) {
      return undefined;
    }

    return this.assignments.get(rallyKey);
  }

  isAssignedCrafter(configuration: BotConfiguration): boolean {
    const assignedUsername = this.getAssignedUsername(configuration);
    return assignedUsername === undefined || assignedUsername === configuration.username;
  }

  private getRallyKey(configuration: BotConfiguration): string | undefined {
    if (!configuration.rallyPoint) {
      return undefined;
    }

    return `${configuration.rallyPoint.x}:${configuration.rallyPoint.y}:${configuration.rallyPoint.z}`;
  }
}
