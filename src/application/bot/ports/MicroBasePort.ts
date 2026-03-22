import { BotRallyPoint } from '../../../domain/bot/entities/BotConfiguration';

export interface MicroBasePort {
  ensureWoodenSwordNearRallyPoint(rallyPoint: BotRallyPoint): Promise<void>;
  establishAtRallyPoint(rallyPoint: BotRallyPoint): Promise<void>;
  supportLeader(leaderUsername: string, rallyPoint: BotRallyPoint): Promise<void>;
}
