import { EventEmitter } from "node:events";

// ── Event payloads ────────────────────────────────────────────────────────────

export interface TokenBoughtEvent {
  tokenId: number;
  tokenAddress: string;
  chain: string;
  walletId: number;
  priceUsd: string | null;
  amount: string | null;
  txHash: string | null;
  boughtAt: Date;
}

export interface PriceUpdatedEvent {
  tokenId: number;
  tokenAddress: string;
  chain: string;
  priceUsd: string;
  marketCapUsd: string | null;
  athPriceUsd: string;
}

export interface TokenSoldEvent {
  tokenId: number;
  tokenAddress: string;
  chain: string;
  walletId: number;
  priceUsd: string | null;
  amount: string | null;
  txHash: string | null;
  soldAt: Date;
}

export interface ProjectionUpdatedEvent {
  tokenId: number;
  tokenAddress: string;
  gainPct: number | null;
  athGainPct: number | null;
  buyPressure: number;
  status: string;
}

export interface TokenDeletedEvent {
  tokenId: number;
  tokenAddress: string;
}

export interface HoldersUpdatedEvent {
  tokenId:      number;
  tokenAddress: string;
  count:        number;
  source:       "background" | "live";
}

/** Rich event for the live feed tape — emitted by monitor (buy/sell) and social-intel-service */
export interface FeedItemEvent {
  id:   string;
  type: "buy" | "sell" | "social_buzz";
  ts:   string;
  token: {
    id:               number;
    address:          string;
    name:             string | null;
    symbol:           string | null;
    status:           string | null;
    imageStatus:      string | null;
    gainPct:          number | null;
    marketCapUsd:     string | null;
    intelligenceScore: number | null;
  };
  buy?: {
    walletLabel:   string | null;
    walletAddress: string | null;
    amount:        string | null;
    priceUsd:      string | null;
    txHash:        string | null;
  };
  sell?: {
    walletLabel:   string | null;
    walletAddress: string | null;
    amount:        string | null;
    priceUsd:      string | null;
    txHash:        string | null;
  };
  social?: {
    viralityScore:    number;
    sentimentScore:   number;
    noveltyScore:     number;
    redditMentions1h: number;
    redditMentions24h: number;
    newsMentions2h:   number;
    newsMentions24h:  number;
    headline?:        string;
    source?:          string;
    link?:            string;
  };
}

// ── Typed event bus ───────────────────────────────────────────────────────────

type BusMap = {
  "token:bought":          [TokenBoughtEvent];
  "price:updated":         [PriceUpdatedEvent];
  "token:sold":            [TokenSoldEvent];
  "projection:updated":    [ProjectionUpdatedEvent];
  "token:deleted":         [TokenDeletedEvent];
  "holders:updated":       [HoldersUpdatedEvent];
  "feed:item":             [FeedItemEvent];
};

class TypedBus extends EventEmitter {
  emit<K extends keyof BusMap>(event: K, ...args: BusMap[K]): boolean {
    return super.emit(event, ...args);
  }
  on<K extends keyof BusMap>(event: K, listener: (...args: BusMap[K]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
}

export const eventBus = new TypedBus();
eventBus.setMaxListeners(30);
