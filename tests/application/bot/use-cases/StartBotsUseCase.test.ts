import test from 'node:test';
import assert from 'node:assert/strict';
import { StartBotsUseCase } from '../../../../src/application/bot/use-cases/StartBotsUseCase';
import { BotFleetConfiguration } from '../../../../src/domain/bot/entities/BotFleetConfiguration';
import { BotConfiguration } from '../../../../src/domain/bot/entities/BotConfiguration';
import { TestLogger } from '../../../helpers/TestLogger';

const createBot = (role: 'farm' | 'mine' | 'trading', username: string) =>
  new BotConfiguration({
    role,
    host: 'localhost',
    port: 25565,
    username,
    password: 'secret',
    auth: 'offline',
  });

test('StartBotsUseCase prepares the fleet and connects bots in order', async () => {
  const connected: string[] = [];
  let prepared = false;
  const useCase = new StartBotsUseCase(
    {
      load: () =>
        new BotFleetConfiguration([
          createBot('farm', 'Gamgee'),
          createBot('mine', 'Gimli'),
        ]),
    },
    {
      prepareFleet: () => {
        prepared = true;
      },
      connect: async (configuration: BotConfiguration) => {
        connected.push(configuration.username);
      },
    },
    new TestLogger(),
    0,
  );

  await useCase.execute();
  assert.equal(prepared, true);
  assert.deepEqual(connected, ['Gamgee', 'Gimli']);
});

test('StartBotsUseCase throws when one or more bot startups fail', async () => {
  const useCase = new StartBotsUseCase(
    {
      load: () =>
        new BotFleetConfiguration([
          createBot('farm', 'Gamgee'),
          createBot('mine', 'Gimli'),
        ]),
    },
    {
      prepareFleet: () => undefined,
      connect: async (configuration: BotConfiguration) => {
        if (configuration.username === 'Gimli') {
          throw new Error('boom');
        }
      },
    },
    new TestLogger(),
    0,
  );

  await assert.rejects(() => useCase.execute(), /1 bot\(s\) failed during startup or authorization/);
});
