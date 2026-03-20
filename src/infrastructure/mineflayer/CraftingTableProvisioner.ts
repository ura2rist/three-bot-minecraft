import mineflayer from 'mineflayer';
import { Block } from 'prismarine-block';
import { Item } from 'prismarine-item';
import { Recipe } from 'prismarine-recipe';
import { Vec3 } from 'vec3';
import { BotConfiguration } from '../../domain/bot/entities/BotConfiguration';
import { Logger } from '../../application/shared/ports/Logger';
import { CraftingTableCoordinator } from './CraftingTableCoordinator';

const mineflayerPathfinder = require('../../../.vendor/mineflayer-pathfinder-master');
const Movements = mineflayerPathfinder.Movements as new (bot: mineflayer.Bot) => PathfinderMovements;
const GoalNear = mineflayerPathfinder.goals.GoalNear as new (
  x: number,
  y: number,
  z: number,
  range: number,
) => unknown;

interface PathfinderApi {
  setMovements(movements: PathfinderMovements): void;
  goto(goal: unknown): Promise<void>;
  stop(): void;
}

interface PathfinderMovements {
  canDig: boolean;
  allow1by1towers: boolean;
  allowParkour: boolean;
  allowSprinting: boolean;
  canOpenDoors: boolean;
  maxDropDown: number;
}

interface RegistryEntry {
  id: number;
}

interface RegistryLookup {
  itemsByName: Record<string, RegistryEntry | undefined>;
  blocksByName: Record<string, RegistryEntry | undefined>;
}

export type BotWithPathfinder = mineflayer.Bot & {
  pathfinder: PathfinderApi;
  registry: mineflayer.Bot['registry'] & RegistryLookup;
};

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

export class CraftingTableProvisioner {
  private readonly craftingTableSearchRadius = 4;
  private readonly resourceSearchRadius = 64;
  private readonly rallyGoalRange = 1;

  constructor(private readonly coordinator: CraftingTableCoordinator) {}

  async ensureNearRallyPoint(
    bot: BotWithPathfinder,
    configuration: BotConfiguration,
    logger: Logger,
  ): Promise<void> {
    if (!configuration.rallyPoint) {
      return;
    }

    const existingCraftingTable = this.findNearbyCraftingTable(bot, configuration);

    if (existingCraftingTable) {
      logger.info('Crafting table already exists near the rally point.');
      return;
    }

    if (!this.coordinator.isAssignedCrafter(configuration)) {
      const assignedUsername = this.coordinator.getAssignedUsername(configuration);
      logger.info(
        `Crafting table provisioning is assigned to "${assignedUsername ?? 'another bot'}". Skipping this bot.`,
      );
      return;
    }

    logger.info('This bot was selected to ensure a crafting table near the rally point.');

    await this.ensureCraftingTableItem(bot, logger);

    if (this.findNearbyCraftingTable(bot, configuration)) {
      logger.info('Crafting table appeared near the rally point while preparing resources.');
      return;
    }

    await this.placeCraftingTableNearRallyPoint(bot, configuration, logger);
  }

  private findNearbyCraftingTable(
    bot: BotWithPathfinder,
    configuration: BotConfiguration,
  ): Block | null {
    if (!configuration.rallyPoint) {
      return null;
    }

    const craftingTableId = bot.registry.blocksByName.crafting_table?.id;

    if (craftingTableId === undefined) {
      return null;
    }

    return bot.findBlock({
      matching: craftingTableId,
      maxDistance: this.craftingTableSearchRadius,
      point: new Vec3(
        configuration.rallyPoint.x,
        configuration.rallyPoint.y,
        configuration.rallyPoint.z,
      ),
    });
  }

  private async ensureCraftingTableItem(bot: BotWithPathfinder, logger: Logger): Promise<void> {
    if (this.countInventoryItems(bot, ['crafting_table']) > 0) {
      return;
    }

    if (await this.tryCraftCraftingTable(bot, logger)) {
      return;
    }

    if (await this.tryCraftPlanksFromInventoryLogs(bot, logger) && (await this.tryCraftCraftingTable(bot, logger))) {
      return;
    }

    logger.info('No crafting table or planks available. Gathering logs for crafting.');

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await this.gatherSingleLog(bot, logger);

      if (await this.tryCraftPlanksFromInventoryLogs(bot, logger) && (await this.tryCraftCraftingTable(bot, logger))) {
        return;
      }
    }

    throw new Error('Failed to gather enough resources to craft a crafting table.');
  }

  private async tryCraftCraftingTable(bot: BotWithPathfinder, logger: Logger): Promise<boolean> {
    const craftingTableItemId = bot.registry.itemsByName.crafting_table?.id;

    if (craftingTableItemId === undefined) {
      throw new Error('Crafting table item id is unavailable in the current registry.');
    }

    const recipe = this.getRecipe(bot, craftingTableItemId, 1);

    if (!recipe) {
      return false;
    }

    await bot.craft(recipe, 1);
    logger.info('Crafted a crafting table.');
    return true;
  }

  private async tryCraftPlanksFromInventoryLogs(bot: BotWithPathfinder, logger: Logger): Promise<boolean> {
    for (const [logItemName, plankItemName] of LOG_TO_PLANK_ITEM.entries()) {
      if (this.countInventoryItems(bot, [logItemName]) < 1) {
        continue;
      }

      const plankItemId = bot.registry.itemsByName[plankItemName]?.id;

      if (plankItemId === undefined) {
        continue;
      }

      const recipe = this.getRecipe(bot, plankItemId, 4);

      if (!recipe) {
        continue;
      }

      await bot.craft(recipe, 1);
      logger.info(`Crafted planks from ${logItemName}.`);
      return true;
    }

    return false;
  }

  private async gatherSingleLog(bot: BotWithPathfinder, logger: Logger): Promise<void> {
    const logBlockIds = [...LOG_TO_PLANK_ITEM.keys()]
      .map((logName) => bot.registry.blocksByName[logName]?.id)
      .filter((logId): logId is number => logId !== undefined);

    const targetLog = bot.findBlock({
      matching: logBlockIds,
      maxDistance: this.resourceSearchRadius,
      count: 1,
    });

    if (!targetLog) {
      throw new Error(`No reachable log blocks were found within ${this.resourceSearchRadius} blocks.`);
    }

    logger.info(
      `Gathering log block ${targetLog.name} at ${targetLog.position.x} ${targetLog.position.y} ${targetLog.position.z}.`,
    );

    await this.gotoPosition(bot, targetLog.position, 2);

    if (!bot.canDigBlock(targetLog)) {
      throw new Error(`Cannot dig log block "${targetLog.name}" at the target position.`);
    }

    await bot.lookAt(targetLog.position.offset(0.5, 0.5, 0.5), true);
    await bot.dig(targetLog, true);
    logger.info(`Gathered log block ${targetLog.name}.`);
  }

  private async placeCraftingTableNearRallyPoint(
    bot: BotWithPathfinder,
    configuration: BotConfiguration,
    logger: Logger,
  ): Promise<void> {
    const craftingTableItem = this.findInventoryItem(bot, 'crafting_table');

    if (!craftingTableItem) {
      throw new Error('Crafting table item is missing after crafting.');
    }

    const placement = this.findPlacementCandidate(bot, configuration);

    if (!placement) {
      throw new Error('Could not find a valid placement spot for the crafting table near the rally point.');
    }

    await this.gotoPosition(bot, placement.referenceBlock.position, 2);
    await bot.equip(craftingTableItem, 'hand');
    await bot.lookAt(placement.placePosition.offset(0.5, 0.5, 0.5), true);
    await bot.placeBlock(placement.referenceBlock, new Vec3(0, 1, 0));

    logger.info(
      `Placed a crafting table at ${placement.placePosition.x} ${placement.placePosition.y} ${placement.placePosition.z}.`,
    );
  }

  private findPlacementCandidate(
    bot: BotWithPathfinder,
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
            const placeBlock = bot.blockAt(placePosition);
            const referenceBlock = bot.blockAt(referencePosition);

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

  private createMovements(bot: BotWithPathfinder): PathfinderMovements {
    const movements = new Movements(bot);
    movements.canDig = false;
    movements.allow1by1towers = false;
    movements.allowParkour = true;
    movements.allowSprinting = true;
    movements.canOpenDoors = true;
    movements.maxDropDown = 4;
    return movements;
  }

  private async gotoPosition(bot: BotWithPathfinder, target: Vec3, range: number): Promise<void> {
    bot.pathfinder.setMovements(this.createMovements(bot));
    await bot.pathfinder.goto(new GoalNear(target.x, target.y, target.z, range));
    bot.pathfinder.stop();
  }

  private getRecipe(bot: BotWithPathfinder, itemId: number, minResultCount: number): Recipe | undefined {
    return bot.recipesFor(itemId, null, minResultCount, null)[0];
  }

  private countInventoryItems(bot: BotWithPathfinder, itemNames: readonly string[]): number {
    return bot.inventory
      .items()
      .filter((item) => itemNames.includes(item.name))
      .reduce((total, item) => total + item.count, 0);
  }

  private findInventoryItem(bot: BotWithPathfinder, itemName: string): Item | undefined {
    return bot.inventory.items().find((item) => item.name === itemName);
  }
}
