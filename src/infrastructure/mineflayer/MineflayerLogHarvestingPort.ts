import { Block } from 'prismarine-block';
import { Vec3 } from 'vec3';
import { LogHarvestingPort } from '../../application/bot/ports/LogHarvestingPort';
import { Logger } from '../../application/shared/ports/Logger';
import { BotWithPathfinder } from './MineflayerPortsShared';

const LOG_TO_PLANK_ITEM = new Map<string, string>([
  ['oak_log', 'oak_planks'],
  ['spruce_log', 'spruce_planks'],
  ['birch_log', 'birch_planks'],
  ['jungle_log', 'jungle_planks'],
  ['acacia_log', 'acacia_planks'],
  ['dark_oak_log', 'dark_oak_planks'],
  ['mangrove_log', 'mangrove_planks'],
  ['cherry_log', 'cherry_planks'],
  ['pale_oak_log', 'pale_oak_planks'],
  ['crimson_stem', 'crimson_planks'],
  ['warped_stem', 'warped_planks'],
]);

export class MineflayerLogHarvestingPort implements LogHarvestingPort {
  private readonly resourceSearchRadius = 64;
  private readonly maxLogCandidates = 128;
  private readonly maxHarvestableLogHeightFromGround = 4;

  constructor(
    private readonly bot: BotWithPathfinder,
    private readonly logger: Logger,
    private readonly gotoPosition: (target: Vec3, range: number) => Promise<void>,
  ) {}

  async gatherNearestLog(): Promise<void> {
    const logBlockIds = [...LOG_TO_PLANK_ITEM.keys()]
      .map((logName) => this.bot.registry.blocksByName[logName]?.id)
      .filter((logId): logId is number => logId !== undefined);

    const candidatePositions = this.bot.findBlocks({
      matching: logBlockIds,
      maxDistance: this.resourceSearchRadius,
      count: this.maxLogCandidates,
    });
    const targetLog = candidatePositions
      .map((position) => this.bot.blockAt(position))
      .filter((block): block is Block => block !== null)
      .filter((block) => this.isHarvestableLogBlock(block))
      .sort((left, right) => {
        return (
          this.calculateDistanceSquared(left.position) -
          this.calculateDistanceSquared(right.position)
        );
      })[0];

    if (!targetLog) {
      throw new Error(
        `No supported log blocks up to ${this.maxHarvestableLogHeightFromGround} blocks above the ground were found within ${this.resourceSearchRadius} blocks.`,
      );
    }

    this.logger.info(
      `Gathering log block ${targetLog.name} at ${targetLog.position.x} ${targetLog.position.y} ${targetLog.position.z}.`,
    );

    await this.gotoPosition(targetLog.position, 2);

    if (!this.bot.canDigBlock(targetLog)) {
      throw new Error(`Cannot dig log block "${targetLog.name}" at the target position.`);
    }

    await this.bot.lookAt(targetLog.position.offset(0.5, 0.5, 0.5), true);
    await this.bot.dig(targetLog, true);
    this.logger.info(`Gathered log block ${targetLog.name}.`);
  }

  private isHarvestableLogBlock(block: Block): boolean {
    if (!this.isLogBlock(block.name)) {
      return false;
    }

    const groundY = this.findGroundY(block.position);

    if (groundY === null) {
      return false;
    }

    return block.position.y - groundY <= this.maxHarvestableLogHeightFromGround;
  }

  private isLogBlock(blockName: string): boolean {
    return LOG_TO_PLANK_ITEM.has(blockName);
  }

  private findGroundY(position: Vec3): number | null {
    for (let offset = 1; offset <= this.maxHarvestableLogHeightFromGround + 4; offset += 1) {
      const belowBlock = this.bot.blockAt(position.offset(0, -offset, 0));

      if (!belowBlock) {
        return null;
      }

      if (belowBlock.boundingBox === 'block' && !this.isLogBlock(belowBlock.name)) {
        return belowBlock.position.y;
      }
    }

    return null;
  }

  private calculateDistanceSquared(target: Vec3): number {
    const dx = this.bot.entity.position.x - target.x;
    const dy = this.bot.entity.position.y - target.y;
    const dz = this.bot.entity.position.z - target.z;

    return dx * dx + dy * dy + dz * dz;
  }
}
