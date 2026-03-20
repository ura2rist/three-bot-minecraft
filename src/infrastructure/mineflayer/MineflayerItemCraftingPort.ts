import { Recipe } from 'prismarine-recipe';
import { ItemCraftingPort } from '../../application/bot/ports/ItemCraftingPort';
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

export class MineflayerItemCraftingPort implements ItemCraftingPort {
  constructor(
    private readonly bot: BotWithPathfinder,
    private readonly logger: Logger,
  ) {}

  async hasItem(itemName: string): Promise<boolean> {
    return this.bot.inventory.items().some((item) => item.name === itemName);
  }

  async craftCraftingTable(): Promise<boolean> {
    const craftingTableItemId = this.bot.registry.itemsByName.crafting_table?.id;

    if (craftingTableItemId === undefined) {
      throw new Error('Crafting table item id is unavailable in the current registry.');
    }

    const recipe = this.getRecipe(craftingTableItemId, 1);

    if (!recipe) {
      return false;
    }

    await this.bot.craft(recipe, 1);
    this.logger.info('Crafted a crafting table.');
    return true;
  }

  async craftPlanksFromInventoryLogs(): Promise<boolean> {
    for (const [logItemName, plankItemName] of LOG_TO_PLANK_ITEM.entries()) {
      const hasLog = this.bot.inventory.items().some((item) => item.name === logItemName);

      if (!hasLog) {
        continue;
      }

      const plankItemId = this.bot.registry.itemsByName[plankItemName]?.id;

      if (plankItemId === undefined) {
        continue;
      }

      const recipe = this.getRecipe(plankItemId, 4);

      if (!recipe) {
        continue;
      }

      await this.bot.craft(recipe, 1);
      this.logger.info(`Crafted planks from ${logItemName}.`);
      return true;
    }

    return false;
  }

  private getRecipe(itemId: number, minResultCount: number): Recipe | undefined {
    return this.bot.recipesFor(itemId, null, minResultCount, null)[0];
  }
}
