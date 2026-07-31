/**
 * Trader Mode paper book — local entries/exits aiming for 3×+.
 * Mark-to-market against live Runner MC when available.
 */

export type TraderPosition = {
  id: string;
  tokenId: number;
  address: string;
  symbol: string;
  name: string | null;
  logoUri: string | null;
  /** USD size of the paper bet */
  stakeUsd: number;
  entryMcUsd: number;
  entryAt: string;
  /** Optional planned exit multiple (default 3) */
  targetMultiple: number;
  exitMcUsd?: number;
  exitAt?: string;
  note?: string;
};

export type TraderBook = {
  version: 1;
  bankrollUsd: number;
  positions: TraderPosition[];
};

const KEY = "crypsor:trader-book:v1";
const DEFAULT_BANKROLL = 1_000;

function uid() {
  return `tp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function loadBook(): TraderBook {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { version: 1, bankrollUsd: DEFAULT_BANKROLL, positions: [] };
    const parsed = JSON.parse(raw) as TraderBook;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.positions)) {
      return { version: 1, bankrollUsd: DEFAULT_BANKROLL, positions: [] };
    }
    return {
      version: 1,
      bankrollUsd: Number(parsed.bankrollUsd) > 0 ? Number(parsed.bankrollUsd) : DEFAULT_BANKROLL,
      positions: parsed.positions,
    };
  } catch {
    return { version: 1, bankrollUsd: DEFAULT_BANKROLL, positions: [] };
  }
}

export function saveBook(book: TraderBook): void {
  localStorage.setItem(KEY, JSON.stringify(book));
}

export function openPosition(
  book: TraderBook,
  input: {
    tokenId: number;
    address: string;
    symbol: string;
    name: string | null;
    logoUri: string | null;
    entryMcUsd: number;
    stakeUsd: number;
    targetMultiple?: number;
    note?: string;
  },
): TraderBook {
  const stake = Math.max(1, Math.min(input.stakeUsd, book.bankrollUsd));
  const pos: TraderPosition = {
    id: uid(),
    tokenId: input.tokenId,
    address: input.address,
    symbol: input.symbol,
    name: input.name,
    logoUri: input.logoUri,
    stakeUsd: stake,
    entryMcUsd: input.entryMcUsd,
    entryAt: new Date().toISOString(),
    targetMultiple: input.targetMultiple ?? 3,
    note: input.note,
  };
  const next: TraderBook = {
    ...book,
    bankrollUsd: Math.max(0, book.bankrollUsd - stake),
    positions: [pos, ...book.positions],
  };
  saveBook(next);
  return next;
}

export function closePosition(
  book: TraderBook,
  positionId: string,
  exitMcUsd: number,
): TraderBook {
  const pos = book.positions.find(p => p.id === positionId);
  if (!pos || pos.exitAt) return book;
  const multiple = pos.entryMcUsd > 0 ? exitMcUsd / pos.entryMcUsd : 1;
  const proceeds = pos.stakeUsd * multiple;
  const next: TraderBook = {
    ...book,
    bankrollUsd: book.bankrollUsd + proceeds,
    positions: book.positions.map(p =>
      p.id === positionId
        ? { ...p, exitMcUsd, exitAt: new Date().toISOString() }
        : p,
    ),
  };
  saveBook(next);
  return next;
}

export function setBankroll(book: TraderBook, bankrollUsd: number): TraderBook {
  const next = { ...book, bankrollUsd: Math.max(0, bankrollUsd) };
  saveBook(next);
  return next;
}

export function positionMultiple(pos: TraderPosition, liveMc: number | null | undefined): number {
  const mark = pos.exitMcUsd ?? liveMc ?? pos.entryMcUsd;
  if (!pos.entryMcUsd || pos.entryMcUsd <= 0) return 1;
  return mark / pos.entryMcUsd;
}

export function positionPnlUsd(pos: TraderPosition, liveMc: number | null | undefined): number {
  return pos.stakeUsd * positionMultiple(pos, liveMc) - pos.stakeUsd;
}

export function isOpen(pos: TraderPosition): boolean {
  return !pos.exitAt;
}

export function hitTarget(pos: TraderPosition, liveMc: number | null | undefined): boolean {
  return positionMultiple(pos, liveMc) >= (pos.targetMultiple || 3);
}

export type BookStats = {
  openCount: number;
  closedCount: number;
  openPnl: number;
  realizedPnl: number;
  hits3x: number;
  bestMultiple: number;
  equity: number;
};

export function computeBookStats(
  book: TraderBook,
  liveMcByTokenId: Record<number, number | null | undefined>,
): BookStats {
  let openPnl = 0;
  let realizedPnl = 0;
  let openCount = 0;
  let closedCount = 0;
  let hits3x = 0;
  let bestMultiple = 1;
  let openMark = 0;

  for (const p of book.positions) {
    const live = liveMcByTokenId[p.tokenId];
    const mult = positionMultiple(p, live);
    bestMultiple = Math.max(bestMultiple, mult);
    if (mult >= 3) hits3x++;
    if (isOpen(p)) {
      openCount++;
      openPnl += positionPnlUsd(p, live);
      openMark += p.stakeUsd * mult;
    } else {
      closedCount++;
      realizedPnl += positionPnlUsd(p, p.exitMcUsd);
    }
  }

  return {
    openCount,
    closedCount,
    openPnl,
    realizedPnl,
    hits3x,
    bestMultiple,
    equity: book.bankrollUsd + openMark,
  };
}
