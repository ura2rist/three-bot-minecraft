import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { MineflayerLogHarvestingPort } from '../../../src/infrastructure/mineflayer/MineflayerLogHarvestingPort';
import { TestLogger } from '../../helpers/TestLogger';

function createBlock(name: string, position: Vec3, boundingBox: 'block' | 'empty' = 'block') {
  return {
    name,
    position,
    boundingBox,
  };
}

test('MineflayerLogHarvestingPort aggregates skipped log candidates into a single warning', async () => {
  const logger = new TestLogger();
  const firstLogPosition = new Vec3(5, 64, 0);
  const secondLogPosition = new Vec3(6, 64, 0);
  const blocks = new Map<string, ReturnType<typeof createBlock>>([
    ['5,64,0', createBlock('oak_log', firstLogPosition)],
    ['6,64,0', createBlock('dark_oak_log', secondLogPosition)],
    ['5,63,0', createBlock('stone', firstLogPosition.offset(0, -1, 0))],
    ['6,63,0', createBlock('stone', secondLogPosition.offset(0, -1, 0))],
  ]);

  const bot = {
    entity: {
      position: new Vec3(0, 64, 0),
    },
    registry: {
      blocksByName: {
        oak_log: { id: 1 },
        dark_oak_log: { id: 2 },
      },
    },
    findBlocks: () => [firstLogPosition, secondLogPosition],
    blockAt: (position: Vec3) => blocks.get(`${position.x},${position.y},${position.z}`) ?? null,
    canDigBlock: () => false,
    inventory: {
      items: () => [],
    },
  };

  const harvestingPort = new MineflayerLogHarvestingPort(
    bot as never,
    logger,
    async () => {
      throw new Error('No path to the goal!');
    },
    {
      hasDroppedItemNearby: () => false,
      collectAround: async () => false,
    } as never,
  );

  await assert.rejects(
    async () => harvestingPort.gatherNearestLog(),
    /Cannot dig log block|No path to the goal!/i,
  );

  const warningEntries = logger.getEntries().filter((entry) => entry.level === 'warn');
  assert.equal(warningEntries.length, 1);
  assert.match(
    warningEntries[0]?.message ?? '',
    /Skipped 2 unreachable log candidate\(s\) while searching for a reachable tree\./,
  );
  assert.match(warningEntries[0]?.message ?? '', /oak_log at 5 64 0/);
  assert.match(warningEntries[0]?.message ?? '', /dark_oak_log at 6 64 0/);
});
