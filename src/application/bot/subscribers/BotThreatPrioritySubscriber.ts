import { BotActivityEvent } from '../events/BotActivityEvent';
import { BotPriorityCoordinator } from '../services/BotPriorityCoordinator';
import { EventBus } from '../../shared/events/EventBus';

export class BotThreatPrioritySubscriber {
  constructor(
    private readonly eventBus: EventBus<BotActivityEvent>,
    private readonly coordinator: BotPriorityCoordinator,
  ) {}

  subscribe(): Array<() => void> {
    return [
      this.eventBus.subscribe('bot.threat.engaged', () => {
        this.coordinator.onThreatEngaged();
      }),
      this.eventBus.subscribe('bot.threat.resolved', () => {
        this.coordinator.onThreatResolved();
      }),
    ];
  }
}
