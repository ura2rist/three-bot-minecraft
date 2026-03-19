export interface FarmProductSettings {
  itemId: string;
  slotCount: number;
}

export interface FarmRoleSettings {
  products: FarmProductSettings[];
}

export interface MineShaftSettings {
  targetDepthY: number;
  shaftHeight: number;
  shaftWidth: number;
  shaftLength: number;
}

export interface MineRoleSettings {
  shaft: MineShaftSettings;
}

export interface TradeItemStackSettings {
  itemId: string;
  amount: number;
}

export interface TradeOfferSettings {
  playerGives: TradeItemStackSettings[];
  botGives: TradeItemStackSettings[];
}

export interface TradingRoleSettings {
  offers: TradeOfferSettings[];
}
