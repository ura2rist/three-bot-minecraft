import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { MineflayerAutoEatController } from '../../../src/infrastructure/mineflayer/MineflayerAutoEatController';
import { TestLogger } from '../../helpers/TestLogger';

test('MineflayerAutoEatController equips and consumes the best safe food when hunger is critical', async () => {
  const events = new EventEmitter();
  const equipped: string[] = [];
  let consumed = false;
  const bot = Object.assign(events, {
    entity: { position: { x: 0, y: 0, z: 0 } },
    isAlive: true,
    isSleeping: false,
    food: 3,
    health: 20,
    registry: {
      foodsByName: {
        bread: { foodPoints: 5, effectiveQuality: 5 },
        apple: { foodPoints: 4, effectiveQuality: 4 },
      },
    },
    inventory: {
      items: () => [
        { name: 'apple', type: 2, count: 1 },
        { name: 'bread', type: 1, count: 2 },
      ],
    },
    equip: async (item: { name: string }) => {
      equipped.push(item.name);
    },
    consume: async () => {
      consumed = true;
    },
  });

  const controller = new MineflayerAutoEatController(bot as never, new TestLogger());
  controller.start();
  events.emit('health');
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.stop();

  assert.deepEqual(equipped, ['bread']);
  assert.equal(consumed, true);
});

test('MineflayerAutoEatController ignores reserved food unless it is an emergency fallback', async () => {
  const events = new EventEmitter();
  const equipped: string[] = [];
  const bot = Object.assign(events, {
    entity: { position: { x: 0, y: 0, z: 0 } },
    isAlive: true,
    isSleeping: false,
    food: 10,
    health: 20,
    registry: {
      foodsByName: {
        golden_apple: { foodPoints: 4, effectiveQuality: 10 },
      },
    },
    inventory: {
      items: () => [{ name: 'golden_apple', type: 1, count: 1 }],
    },
    equip: async (item: { name: string }) => {
      equipped.push(item.name);
    },
    consume: async () => undefined,
  });

  const controller = new MineflayerAutoEatController(bot as never, new TestLogger());
  controller.start();
  events.emit('health');
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.stop();

  assert.deepEqual(equipped, []);
});
