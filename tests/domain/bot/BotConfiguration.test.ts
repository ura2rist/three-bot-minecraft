import test from 'node:test';
import assert from 'node:assert/strict';
import { BotConfiguration } from '../../../src/domain/bot/entities/BotConfiguration';
import { DomainError } from '../../../src/domain/shared/errors/DomainError';

test('BotConfiguration trims values and preserves a valid rally point', () => {
  const configuration = new BotConfiguration({
    role: 'mine',
    host: ' localhost ',
    port: 25565,
    username: ' Gimli ',
    password: ' secret ',
    rallyPoint: { x: 215, y: 64, z: -77 },
    version: ' 1.21.4 ',
    auth: 'offline',
  });

  assert.equal(configuration.host, 'localhost');
  assert.equal(configuration.username, 'Gimli');
  assert.equal(configuration.password, 'secret');
  assert.equal(configuration.version, '1.21.4');
  assert.deepEqual(configuration.rallyPoint, { x: 215, y: 64, z: -77 });
});

test('BotConfiguration rejects an empty password', () => {
  assert.throws(
    () =>
      new BotConfiguration({
        role: 'farm',
        host: 'localhost',
        port: 25565,
        username: 'Gamgee',
        password: '   ',
        auth: 'offline',
      }),
    DomainError,
  );
});

test('BotConfiguration rejects an invalid port', () => {
  assert.throws(
    () =>
      new BotConfiguration({
        role: 'trading',
        host: 'localhost',
        port: 70000,
        username: 'Lawrence',
        password: 'secret',
        auth: 'offline',
      }),
    DomainError,
  );
});
