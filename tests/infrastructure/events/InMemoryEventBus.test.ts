import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryEventBus } from '../../../src/infrastructure/events/InMemoryEventBus';
import { BotActivityEvent } from '../../../src/application/bot/events/BotActivityEvent';

test('InMemoryEventBus publishes events to subscribers in order', async () => {
  const bus = new InMemoryEventBus<BotActivityEvent>();
  const received: string[] = [];

  bus.subscribe('bot.rally.started', async (event: BotActivityEvent) => {
    received.push(event.payload.username);
  });

  await bus.publish({
    type: 'bot.rally.started',
    payload: { username: 'Gimli' },
  });

  assert.deepEqual(received, ['Gimli']);
});

test('InMemoryEventBus unsubscribe removes the handler', async () => {
  const bus = new InMemoryEventBus<BotActivityEvent>();
  let calls = 0;
  const unsubscribe = bus.subscribe('bot.died', async () => {
    calls += 1;
  });

  unsubscribe();
  await bus.publish({
    type: 'bot.died',
    payload: { username: 'Gimli' },
  });

  assert.equal(calls, 0);
});
