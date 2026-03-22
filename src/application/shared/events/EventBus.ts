export interface ApplicationEvent<TType extends string = string, TPayload = unknown> {
  type: TType;
  payload: TPayload;
}

export type EventHandler<TEvent extends ApplicationEvent = ApplicationEvent> = (
  event: TEvent,
) => void | Promise<void>;

export interface EventBus<TEvent extends ApplicationEvent = ApplicationEvent> {
  publish(event: TEvent): Promise<void>;
  subscribe<TType extends TEvent['type']>(
    type: TType,
    handler: EventHandler<Extract<TEvent, { type: TType }>>,
  ): () => void;
}
