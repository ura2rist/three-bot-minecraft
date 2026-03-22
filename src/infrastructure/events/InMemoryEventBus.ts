import { ApplicationEvent, EventBus, EventHandler } from '../../application/shared/events/EventBus';

export class InMemoryEventBus<TEvent extends ApplicationEvent> implements EventBus<TEvent> {
  private readonly handlers = new Map<TEvent['type'], Set<EventHandler<TEvent>>>();

  async publish(event: TEvent): Promise<void> {
    const handlers = this.handlers.get(event.type);

    if (!handlers) {
      return;
    }

    for (const handler of handlers) {
      await handler(event);
    }
  }

  subscribe<TType extends TEvent['type']>(
    type: TType,
    handler: EventHandler<Extract<TEvent, { type: TType }>>,
  ): () => void {
    const existingHandlers = this.handlers.get(type) ?? new Set<EventHandler<TEvent>>();
    existingHandlers.add(handler as EventHandler<TEvent>);
    this.handlers.set(type, existingHandlers);

    return () => {
      existingHandlers.delete(handler as EventHandler<TEvent>);

      if (existingHandlers.size === 0) {
        this.handlers.delete(type);
      }
    };
  }
}
