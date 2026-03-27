import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { MineflayerNearbyDroppedItemCollector } from '../../../src/infrastructure/mineflayer/MineflayerNearbyDroppedItemCollector';
import { TestLogger } from '../../helpers/TestLogger';

function createDroppedItemBot(dropPosition: Vec3) {
  const entities: Record<string, { name: string; position: Vec3 }> = {
    dropped: {
      name: 'item',
      position: dropPosition,
    },
  };

  const bot = {
    entity: {
      position: new Vec3(0, dropPosition.y, 0),
    },
    entities,
    waitForTicks: async () => undefined,
  };

  return { bot, entities };
}

test('MineflayerNearbyDroppedItemCollector retries unreachable loot with short half-step moves', async () => {
  const { bot, entities } = createDroppedItemBot(new Vec3(2, 64, 0));
  const gotoCalls: Array<{ target: Vec3; range: number }> = [];

  const collector = new MineflayerNearbyDroppedItemCollector(
    bot as never,
    new TestLogger(),
    async (target, range) => {
      gotoCalls.push({ target, range });

      if (gotoCalls.length === 1) {
        throw new Error('Goal was not actually reached');
      }

      bot.entity.position = target;

      if (gotoCalls.length === 3) {
        delete entities.dropped;
      }
    },
  );

  const collected = await collector.collectAround(new Vec3(0, 64, 0), 4, 2);

  assert.equal(collected, true, 'collector should keep retrying until the dropped item disappears');
  assert.deepEqual(
    gotoCalls.map((call) => Number(call.target.x.toFixed(2))),
    [2, 0.5, 1],
    'collector should switch to short half-step moves after the direct pickup attempt fails',
  );
  assert.deepEqual(
    gotoCalls.map((call) => call.range),
    [1, 0.5, 0.5],
    'collector should use a tighter pathfinding range for half-step pickup retries',
  );
});

test('MineflayerNearbyDroppedItemCollector gives up after several pickup retries and returns control', async () => {
  const { bot } = createDroppedItemBot(new Vec3(2, 64, 0));
  const gotoCalls: Array<{ target: Vec3; range: number }> = [];
  const logger = new TestLogger();

  const collector = new MineflayerNearbyDroppedItemCollector(
    bot as never,
    logger,
    async (target, range) => {
      gotoCalls.push({ target, range });

      if (range === 0.5) {
        bot.entity.position = target;
      }
    },
  );

  const collected = await collector.collectAround(new Vec3(0, 64, 0), 4, 2);

  assert.equal(collected, false, 'collector should stop retrying when the dropped item stays out of reach');
  assert.deepEqual(
    gotoCalls.map((call) => Number(call.target.x.toFixed(2))),
    [2, 0.5, 1, 1.5],
    'collector should cap pickup retries to a fixed number of short-step attempts',
  );
  assert.ok(
    logger.getEntries().some(
      (entry) =>
        entry.level === 'warn' &&
        entry.message.includes('because the item stayed out of reach after 4 attempts'),
    ),
    'collector should log when it gives up on an unreachable dropped item',
  );
});

test('MineflayerNearbyDroppedItemCollector temporarily suppresses a dropped item after giving up on it', async () => {
  const { bot } = createDroppedItemBot(new Vec3(2, 64, 0));
  let gotoCalls = 0;

  const collector = new MineflayerNearbyDroppedItemCollector(
    bot as never,
    new TestLogger(),
    async () => {
      gotoCalls += 1;
    },
  );

  const firstCollected = await collector.collectAround(new Vec3(0, 64, 0), 4, 2);
  const secondCollected = await collector.collectAround(new Vec3(0, 64, 0), 4, 2);

  assert.equal(firstCollected, false);
  assert.equal(secondCollected, false);
  assert.equal(
    gotoCalls,
    4,
    'collector should not immediately retry the same unreachable dropped item after it was suppressed',
  );
});
