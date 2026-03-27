import { MineRoleSettings } from '../../../domain/bot/entities/RoleSettings';

export interface MineRoleSettingsProvider {
  load(): MineRoleSettings;
}
