import { TradingRoleSettings } from '../../../domain/bot/entities/RoleSettings';

export interface TradingRoleSettingsProvider {
  load(): TradingRoleSettings;
}
