import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TradingRoleSettingsProvider } from '../../application/bot/ports/TradingRoleSettingsProvider';
import {
  TradeItemStackSettings,
  TradeOfferSettings,
  TradingRoleSettings,
} from '../../domain/bot/entities/RoleSettings';
import { DomainError } from '../../domain/shared/errors/DomainError';

interface RawTradeItemStackSettings {
  itemId?: unknown;
  amount?: unknown;
}

interface RawTradeOfferSettings {
  playerGives?: unknown;
  botGives?: unknown;
}

interface RawTradingRoleSettings {
  offers?: unknown;
}

export class FileTradingRoleSettingsProvider implements TradingRoleSettingsProvider {
  load(): TradingRoleSettings {
    const configPath = resolve(
      process.cwd(),
      process.env.TRADING_ROLE_CONFIG_PATH ?? 'configs/roles/trading.json',
    );

    if (!existsSync(configPath)) {
      throw new DomainError(`Trading role config file was not found: ${configPath}`);
    }

    const rawFile = readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(rawFile) as RawTradingRoleSettings;

    if (!Array.isArray(parsed.offers)) {
      throw new DomainError('Trading role config must contain an "offers" array.');
    }

    return {
      offers: parsed.offers.map((offer, index) => this.mapOffer(offer, index)),
    };
  }

  private mapOffer(rawOffer: unknown, index: number): TradeOfferSettings {
    if (typeof rawOffer !== 'object' || rawOffer === null) {
      throw new DomainError(`Trading offer at index ${index} must be an object.`);
    }

    const candidate = rawOffer as RawTradeOfferSettings;

    return {
      playerGives: this.mapStacks(candidate.playerGives, index, 'playerGives'),
      botGives: this.mapStacks(candidate.botGives, index, 'botGives'),
    };
  }

  private mapStacks(
    rawStacks: unknown,
    offerIndex: number,
    fieldName: 'playerGives' | 'botGives',
  ): TradeItemStackSettings[] {
    if (!Array.isArray(rawStacks) || rawStacks.length === 0) {
      throw new DomainError(
        `Trading offer at index ${offerIndex}: ${fieldName} must be a non-empty array.`,
      );
    }

    return rawStacks.map((rawStack, stackIndex) =>
      this.mapStack(rawStack, offerIndex, fieldName, stackIndex),
    );
  }

  private mapStack(
    rawStack: unknown,
    offerIndex: number,
    fieldName: 'playerGives' | 'botGives',
    stackIndex: number,
  ): TradeItemStackSettings {
    if (typeof rawStack !== 'object' || rawStack === null) {
      throw new DomainError(
        `Trading offer at index ${offerIndex}: ${fieldName}[${stackIndex}] must be an object.`,
      );
    }

    const candidate = rawStack as RawTradeItemStackSettings;
    const itemId = typeof candidate.itemId === 'string' ? candidate.itemId.trim() : '';
    const amount =
      typeof candidate.amount === 'number' && Number.isInteger(candidate.amount)
        ? candidate.amount
        : Number.NaN;

    if (itemId.length === 0) {
      throw new DomainError(
        `Trading offer at index ${offerIndex}: ${fieldName}[${stackIndex}].itemId must be a non-empty string.`,
      );
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      throw new DomainError(
        `Trading offer at index ${offerIndex}: ${fieldName}[${stackIndex}].amount must be a positive integer.`,
      );
    }

    return { itemId, amount };
  }
}
