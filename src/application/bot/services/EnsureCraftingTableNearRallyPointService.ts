import { BotConfiguration } from '../../../domain/bot/entities/BotConfiguration';
import { Logger } from '../../shared/ports/Logger';
import { CraftingTableAssignmentPolicy } from '../ports/CraftingTableAssignmentPolicy';
import { CraftingTablePlacementPort } from '../ports/CraftingTablePlacementPort';
import { ItemCraftingPort } from '../ports/ItemCraftingPort';
import { LogHarvestingPort } from '../ports/LogHarvestingPort';

export class EnsureCraftingTableNearRallyPointService {
  private readonly craftingTableWaitTimeoutMs = 180000;
  private readonly craftingTableWaitPollIntervalMs = 1000;

  constructor(
    private readonly assignmentPolicy: CraftingTableAssignmentPolicy,
    private readonly placementPort: CraftingTablePlacementPort,
    private readonly itemCraftingPort: ItemCraftingPort,
    private readonly logHarvestingPort: LogHarvestingPort,
    private readonly logger: Logger,
  ) {}

  async execute(configuration: BotConfiguration): Promise<void> {
    if (!configuration.rallyPoint) {
      return;
    }

    if (await this.placementPort.hasCraftingTableNearRallyPoint(configuration)) {
      this.logger.info('Crafting table already exists near the rally point.');
      return;
    }

    if (!this.assignmentPolicy.isAssignedCrafter(configuration)) {
      const assignedUsername = this.assignmentPolicy.getAssignedUsername(configuration);
      this.logger.info(
        `Crafting table provisioning is assigned to "${assignedUsername ?? 'another bot'}". Waiting for the crafting table to appear near the rally point.`,
      );
      await this.waitForCraftingTableNearRallyPoint(configuration);
      return;
    }

    this.logger.info('This bot was selected to ensure a crafting table near the rally point.');
    await this.ensureCraftingTableItem();

    if (await this.placementPort.hasCraftingTableNearRallyPoint(configuration)) {
      this.logger.info('Crafting table appeared near the rally point while preparing resources.');
      return;
    }

    await this.placementPort.placeCraftingTableNearRallyPoint(configuration);
  }

  private async waitForCraftingTableNearRallyPoint(configuration: BotConfiguration): Promise<void> {
    const deadline = Date.now() + this.craftingTableWaitTimeoutMs;

    while (Date.now() < deadline) {
      if (await this.placementPort.hasCraftingTableNearRallyPoint(configuration)) {
        this.logger.info('Crafting table appeared near the rally point while waiting for the assigned bot.');
        return;
      }

      await this.delay(this.craftingTableWaitPollIntervalMs);
    }

    throw new Error('Ой, не могу найти верстак рядом с точкой сбора.');
  }

  private async ensureCraftingTableItem(): Promise<void> {
    if (await this.itemCraftingPort.hasItem('crafting_table')) {
      return;
    }

    if (await this.itemCraftingPort.craftCraftingTable()) {
      return;
    }

    if (
      (await this.itemCraftingPort.craftPlanksFromInventoryLogs()) &&
      (await this.itemCraftingPort.craftCraftingTable())
    ) {
      return;
    }

    this.logger.info('No crafting table or planks available. Gathering logs for crafting.');

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await this.logHarvestingPort.gatherNearestLog();

      if (
        (await this.itemCraftingPort.craftPlanksFromInventoryLogs()) &&
        (await this.itemCraftingPort.craftCraftingTable())
      ) {
        return;
      }
    }

    throw new Error('Failed to gather enough resources to craft a crafting table.');
  }

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
