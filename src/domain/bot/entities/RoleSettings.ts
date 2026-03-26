export interface FarmPointSettings {
  x: number;
  y: number;
  z: number;
}

export interface FarmPlotSettings {
  itemId: string;
  points: FarmPointSettings[];
}

export interface FarmRoleSettings {
  farms: FarmPlotSettings[];
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
