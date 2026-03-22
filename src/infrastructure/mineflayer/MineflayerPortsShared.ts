import mineflayer from 'mineflayer';

export interface PathfinderApi {
  thinkTimeout?: number;
  tickTimeout?: number;
  searchRadius?: number;
  setMovements(movements: PathfinderMovements): void;
  goto(goal: unknown): Promise<void>;
  stop(): void;
}

export interface PathfinderMovements {
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

interface FoodRegistryEntry {
  foodPoints: number;
  effectiveQuality: number;
}

interface RegistryLookup {
  itemsByName: Record<string, RegistryEntry | undefined>;
  blocksByName: Record<string, RegistryEntry | undefined>;
  foodsByName: Record<string, FoodRegistryEntry | undefined>;
}

export type BotWithPathfinder = mineflayer.Bot & {
  pathfinder: PathfinderApi;
  isAlive: boolean;
  registry: mineflayer.Bot['registry'] & RegistryLookup;
};
