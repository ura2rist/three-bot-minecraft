import { MineRoutineProgress } from '../../../domain/bot/entities/MineRoutineProgress';

export interface MineRoutineProgressStore {
  load(username: string): MineRoutineProgress | null;
  save(username: string, progress: MineRoutineProgress): void;
}
