import { Block } from 'prismarine-block';
import { Item } from 'prismarine-item';
import { Vec3 } from 'vec3';
import { CraftingTablePlacementPort } from '../../application/bot/ports/CraftingTablePlacementPort';
import { Logger } from '../../application/shared/ports/Logger';
import { BotConfiguration } from '../../domain/bot/entities/BotConfiguration';
import { BotWithPathfinder } from './MineflayerPortsShared';

export class MineflayerCraftingTablePlacementPort implements CraftingTablePlacementPort {
  private readonly craftingTableSearchRadius = 4;

  constructor(
    private readonly bot: BotWithPathfinder,
    private readonly logger: Logger,
    private readonly gotoPosition: (target: Vec3, range: number) => Promise<void>,
  ) {}

  async hasCraftingTableNearRallyPoint(configuration: BotConfiguration): Promise<boolean> {
    return this.findNearbyCraftingTable(configuration) !== null;
  }

  async placeCraftingTableNearRallyPoint(configuration: BotConfiguration): Promise<void> {
    const craftingTableItem = this.findInventoryItem('crafting_table');

    if (!craftingTableItem) {
      throw new Error('Crafting table item is missing after crafting.');
    }

    const placement = this.findPlacementCandidate(configuration);

    if (!placement) {
      throw new Error('Could not find a valid placement spot for the crafting table near the rally point.');
    }

    await this.gotoPosition(placement.referenceBlock.position, 2);
    await this.bot.equip(craftingTableItem, 'hand');
    await this.bot.lookAt(placement.placePosition.offset(0.5, 0.5, 0.5), true);
    await this.bot.placeBlock(placement.referenceBlock, new Vec3(0, 1, 0));

    this.logger.info(
      `Placed a crafting table at ${placement.placePosition.x} ${placement.placePosition.y} ${placement.placePosition.z}.`,
    );
  }

  private findNearbyCraftingTable(configuration: BotConfiguration): Block | null {
    if (!configuration.rallyPoint) {
      return null;
    }

    const craftingTableId = this.bot.registry.blocksByName.crafting_table?.id;

    if (craftingTableId === undefined) {
      return null;
    }

    return this.bot.findBlock({
      matching: craftingTableId,
      maxDistance: this.craftingTableSearchRadius,
      point: new Vec3(
        configuration.rallyPoint.x,
        configuration.rallyPoint.y,
        configuration.rallyPoint.z,
      ),
    });
  }

  private findPlacementCandidate(
    configuration: BotConfiguration,
  ): { referenceBlock: Block; placePosition: Vec3 } | null {
    if (!configuration.rallyPoint) {
      return null;
    }

    const { x, y, z } = configuration.rallyPoint;

    for (let distance = 0; distance <= 3; distance += 1) {
      for (let dx = -distance; dx <= distance; dx += 1) {
        for (let dz = -distance; dz <= distance; dz += 1) {
          for (let dy = -1; dy <= 1; dy += 1) {
            const placePosition = new Vec3(x + dx, y + dy, z + dz);
            const referencePosition = placePosition.offset(0, -1, 0);
            const placeBlock = this.bot.blockAt(placePosition);
            const referenceBlock = this.bot.blockAt(referencePosition);

            if (!placeBlock || !referenceBlock) {
              continue;
            }

            if (placeBlock.name !== 'air') {
              continue;
            }

            if (referenceBlock.boundingBox !== 'block') {
              continue;
            }

            return { referenceBlock, placePosition };
          }
        }
      }
    }

    return null;
  }

  private findInventoryItem(itemName: string): Item | undefined {
    return this.bot.inventory.items().find((item) => item.name === itemName);
  }
}
