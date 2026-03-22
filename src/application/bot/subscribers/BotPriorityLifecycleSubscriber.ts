import { BotActivityEvent } from '../events/BotActivityEvent';
import { BotPriorityCoordinator } from '../services/BotPriorityCoordinator';
import { EventBus } from '../../shared/events/EventBus';

export class BotPriorityLifecycleSubscriber {
  constructor(
    private readonly eventBus: EventBus<BotActivityEvent>,
    private readonly coordinator: BotPriorityCoordinator,
  ) {}

  subscribe(): Array<() => void> {
    return [
      this.eventBus.subscribe('bot.rally.started', () => {
        this.coordinator.onRallyStarted();
      }),
      this.eventBus.subscribe('bot.rally.completed', () => {
        this.coordinator.onRallyCompleted();
      }),
      this.eventBus.subscribe('bot.respawned', () => {
        this.coordinator.onRespawned();
      }),
      this.eventBus.subscribe('bot.died', () => {
        this.coordinator.onBotDied();
      }),
      this.eventBus.subscribe('bot.task.started', (event) => {
        this.coordinator.onTaskStarted(event.payload.task);
      }),
      this.eventBus.subscribe('bot.task.completed', (event) => {
        this.coordinator.onTaskCompleted(event.payload.task);
      }),
    ];
  }
}
