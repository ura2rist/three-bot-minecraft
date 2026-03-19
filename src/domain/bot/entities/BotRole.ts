export type BotRole = 'farm' | 'trading' | 'mine';

export const SUPPORTED_BOT_ROLES: readonly BotRole[] = ['farm', 'trading', 'mine'] as const;
