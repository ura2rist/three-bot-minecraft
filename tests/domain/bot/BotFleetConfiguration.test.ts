import test from 'node:test';
import assert from 'node:assert/strict';
import { BotConfiguration } from '../../../src/domain/bot/entities/BotConfiguration';
import { BotFleetConfiguration } from '../../../src/domain/bot/entities/BotFleetConfiguration';
import { DomainError } from '../../../src/domain/shared/errors/DomainError';

const createBot = (role: 'farm' | 'mine' | 'trading', username: string) =>
  new BotConfiguration({
    role,
    host: 'localhost',
    port: 25565,
    username,
    password: 'secret',
    auth: 'offline',
  });

test('BotFleetConfiguration rejects duplicate roles', () => {
  assert.throws(
    () => new BotFleetConfiguration([createBot('mine', 'Gimli'), createBot('mine', 'OtherGimli')]),
    DomainError,
  );
});

test('BotFleetConfiguration rejects more than three bots', () => {
  assert.throws(
    () =>
      new BotFleetConfiguration([
        createBot('farm', 'Gamgee'),
        createBot('mine', 'Gimli'),
        createBot('trading', 'Lawrence'),
        new BotConfiguration({
          role: 'farm',
          host: 'localhost',
          port: 25565,
          username: 'Another',
          password: 'secret',
          auth: 'offline',
        }),
      ]),
    DomainError,
  );
});

test('BotFleetConfiguration accepts one bot per supported role', () => {
  const fleet = new BotFleetConfiguration([
    createBot('farm', 'Gamgee'),
    createBot('mine', 'Gimli'),
    createBot('trading', 'Lawrence'),
  ]);

  assert.equal(fleet.bots.length, 3);
});
