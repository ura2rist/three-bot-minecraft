export interface ItemCraftingPort {
  hasItem(itemName: string): Promise<boolean>;
  craftCraftingTable(): Promise<boolean>;
  craftPlanksFromInventoryLogs(): Promise<boolean>;
}
