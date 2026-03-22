import { BotConfiguration } from '../../../domain/bot/entities/BotConfiguration';
import { BotRole } from '../../../domain/bot/entities/BotRole';

const LEADER_ROLE_PRIORITY: readonly BotRole[] = ['farm', 'mine', 'trading'] as const;

export class DeterministicMicroBaseAssignmentPolicy {
  private leaderUsername: string | null = null;

  prepareFleet(configurations: readonly BotConfiguration[]): void {
    this.leaderUsername = null;

    for (const role of LEADER_ROLE_PRIORITY) {
      const leader = configurations.find((configuration) => configuration.role === role);

      if (!leader) {
        continue;
      }

      this.leaderUsername = leader.username;
      return;
    }
  }

  isLeader(configuration: BotConfiguration): boolean {
    return this.leaderUsername !== null && configuration.username === this.leaderUsername;
  }

  getLeaderUsername(): string | null {
    return this.leaderUsername;
  }
}
