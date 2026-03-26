import { FarmRoleSettings } from '../../../domain/bot/entities/RoleSettings';

export interface FarmRoleSettingsProvider {
  load(): FarmRoleSettings;
}
