import { Item } from 'prismarine-item';
import { Logger } from '../../application/shared/ports/Logger';
import { BotWithPathfinder } from './MineflayerPortsShared';

const MAX_FOOD_POINTS = 20;
const LOW_HEALTH_THRESHOLD = 12;
const CRITICAL_FOOD_THRESHOLD = 4;
const EMERGENCY_HEALTH_THRESHOLD = 6;
const RESERVED_FOOD_NAMES = new Set(['golden_apple', 'enchanted_golden_apple']);
const RISKY_FOOD_NAMES = new Set([
  'spider_eye',
  'poisonous_potato',
  'pufferfish',
  'rotten_flesh',
  'chicken',
  'chorus_fruit',
  'suspicious_stew',
]);

interface FoodInfo {
  foodPoints: number;
  effectiveQuality: number;
}

export class MineflayerAutoEatController {
  private consumePromise: Promise<void> | null = null;
  private started = false;

  constructor(
    private readonly bot: BotWithPathfinder,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (this.started) {
      return;
    }

    this.started = true;
    this.bot.on('health', this.handleHealth);
    void this.evaluateAndEat();
  }

  stop(): void {
    if (!this.started) {
      return;
    }

    this.started = false;
    this.bot.off('health', this.handleHealth);
  }

  private readonly handleHealth = (): void => {
    void this.evaluateAndEat();
  };

  private async evaluateAndEat(): Promise<void> {
    if (!this.started || this.consumePromise || !this.shouldEat()) {
      return;
    }

    const food = this.findBestFood();

    if (!food) {
      return;
    }

    const consumePromise = this.consumeFood(food).finally(() => {
      if (this.consumePromise === consumePromise) {
        this.consumePromise = null;
      }
    });

    this.consumePromise = consumePromise;
    await consumePromise;
  }

  private shouldEat(): boolean {
    if (!this.bot.entity || !this.bot.isAlive || this.bot.isSleeping) {
      return false;
    }

    if (typeof this.bot.food !== 'number' || typeof this.bot.health !== 'number') {
      return false;
    }

    if (this.bot.food <= CRITICAL_FOOD_THRESHOLD) {
      return true;
    }

    return this.bot.health <= LOW_HEALTH_THRESHOLD && this.bot.food < MAX_FOOD_POINTS;
  }

  private findBestFood(): Item | undefined {
    const inventoryItems = this.bot.inventory.items();
    const ordinaryFoods = inventoryItems.filter((item) => this.isSafeFood(item));

    if (ordinaryFoods.length > 0) {
      return this.pickBestFoodCandidate(ordinaryFoods);
    }

    const emergencyFoods = inventoryItems.filter((item) => this.isEmergencyFood(item));

    if (this.isEmergencyCondition() && emergencyFoods.length > 0) {
      return this.pickBestFoodCandidate(emergencyFoods);
    }

    return undefined;
  }

  private pickBestFoodCandidate(items: Item[]): Item | undefined {
    return items
      .slice()
      .sort((left, right) => {
        const leftFood = this.getFoodInfo(left);
        const rightFood = this.getFoodInfo(right);

        if (!leftFood || !rightFood) {
          return 0;
        }

        if (rightFood.effectiveQuality !== leftFood.effectiveQuality) {
          return rightFood.effectiveQuality - leftFood.effectiveQuality;
        }

        if (rightFood.foodPoints !== leftFood.foodPoints) {
          return rightFood.foodPoints - leftFood.foodPoints;
        }

        return right.count - left.count;
      })[0];
  }

  private isSafeFood(item: Item): boolean {
    if (RESERVED_FOOD_NAMES.has(item.name) || RISKY_FOOD_NAMES.has(item.name)) {
      return false;
    }

    return !!this.getFoodInfo(item);
  }

  private isEmergencyFood(item: Item): boolean {
    return !!this.getFoodInfo(item);
  }

  private isEmergencyCondition(): boolean {
    return this.bot.food <= CRITICAL_FOOD_THRESHOLD || this.bot.health <= EMERGENCY_HEALTH_THRESHOLD;
  }

  private getFoodInfo(item: Item): FoodInfo | null {
    const foodsByName = this.bot.registry.foodsByName as Record<string, FoodInfo | undefined> | undefined;

    return foodsByName?.[item.name] ?? null;
  }

  private async consumeFood(item: Item): Promise<void> {
    try {
      await this.bot.equip(item, 'hand');
      this.logger.info(
        `Low hunger or health detected. Eating ${item.name} (health: ${this.bot.health}, food: ${this.bot.food}).`,
      );
      await this.bot.consume();
    } catch (error) {
      this.logger.warn(`Could not eat ${item.name}: ${this.stringifyError(error)}.`);
    }
  }

  private stringifyError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }
}
