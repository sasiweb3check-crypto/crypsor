/**
 * Trader Mode — paper book for 3×+ entries/exits with Dex the desk companion.
 */
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Crosshair, LogOut, Plus, Target, Wallet } from "lucide-react";
import { TraderCompanion } from "@/components/trader/companion";
import { useToast } from "@/hooks/use-toast";
import {
  computeBookStats,
  closePosition,
  hitTarget,
  isOpen,
  loadBook,
  openPosition,
  positionMultiple,
  positionPnlUsd,
  setBankroll,
  type TraderBook,
  type TraderPosition,
} from "@/lib/trader-book";
import {
  fetchRunnerFeed,
  RUNNER_FEED_KEY,
  type RunnerToken,
} from "@/lib/runner-api";
import {
  cn, formatCompactUsd, safeImageUrl, safeSymbol, truncateAddress,
} from "@/lib/utils";

function StatTile({
  label, value, hint, accent,
}: { label: string; value: string; hint?: string; accent?: string }) {
  return (
    <div className="desk-card px-4 py-3.5 fade-up">
      <div className="text-[10px] tracking-[0.18em] uppercase text-[var(--cryp-mute)]">{label}</div>
      <div
        className="font-display font-mono-num text-2xl font-bold mt-1.5 tracking-tight"
        style={{ color: accent ?? "var(--cryp-text)" }}
      >
        {value}
      </div>
      {hint && <div className="text-[11px] text-[var(--cryp-mute)] mt-1">{hint}</div>}
    </div>
  );
}

function liveMcMap(feed: RunnerToken[]): Record<number, number | null> {
  const m: Record<number, number | null> = {};
  for (const t of feed) m[t.id] = t.currentMcUsd;
  return m;
}

function PositionRow({
  pos,
  liveMc,
  token,
  selected,
  onSelect,
  onExit,
}: {
  pos: TraderPosition;
  liveMc: number | null | undefined;
  token?: RunnerToken;
  selected: boolean;
  onSelect: () => void;
  onExit: () => void;
}) {
  const mult = positionMultiple(pos, liveMc);
  const pnl = positionPnlUsd(pos, liveMc);
  const open = isOpen(pos);
  const targetHit = hitTarget(pos, liveMc);
  const img = safeImageUrl(pos.logoUri, pos.address, pos.symbol);

  return (
    <article
      className={cn(
        "desk-card p-4 transition-transform duration-200 hover:-translate-y-0.5 cursor-pointer fade-up",
        selected && "ring-1 ring-[var(--cryp-teal)]",
      )}
      onClick={onSelect}
    >
      <div className="flex items-start gap-3">
        <img
          src={img}
          alt=""
          className="w-10 h-10 object-cover shrink-0"
          style={{ background: "var(--cryp-elevated)" }}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-display text-[14px] font-bold">{safeSymbol(pos.symbol, pos.address)}</h3>
            {open ? (
              <span
                className="text-[9px] font-bold tracking-wider uppercase px-1.5 py-0.5"
                style={{
                  color: targetHit ? "var(--cryp-ink)" : "var(--cryp-mint)",
                  background: targetHit ? "var(--cryp-gain)" : "rgba(61,154,139,0.16)",
                }}
              >
                {targetHit ? "3×+" : "Open"}
              </span>
            ) : (
              <span className="text-[9px] font-bold tracking-wider uppercase text-[var(--cryp-mute)]">
                Closed
              </span>
            )}
            {token && (
              <span className="text-[9px] text-[var(--cryp-mute)] uppercase tracking-wider">
                {token.runner.phase} · snaps {token.runner.signals.snapCount ?? 0}/5
              </span>
            )}
          </div>
          <div className="grid grid-cols-4 gap-2 mt-2.5">
            <div>
              <div className="text-[9px] uppercase tracking-wider text-[var(--cryp-mute)]">Entry</div>
              <div className="font-mono-num text-[12px]">{formatCompactUsd(pos.entryMcUsd)}</div>
            </div>
            <div>
              <div className="text-[9px] uppercase tracking-wider text-[var(--cryp-mute)]">Mult</div>
              <div
                className="font-mono-num text-[12px] font-bold"
                style={{ color: mult >= 3 ? "var(--cryp-gain)" : mult < 1 ? "var(--cryp-loss)" : "var(--cryp-text)" }}
              >
                {mult.toFixed(2)}×
              </div>
            </div>
            <div>
              <div className="text-[9px] uppercase tracking-wider text-[var(--cryp-mute)]">P&L</div>
              <div
                className="font-mono-num text-[12px] font-bold"
                style={{ color: pnl >= 0 ? "var(--cryp-gain)" : "var(--cryp-loss)" }}
              >
                {pnl >= 0 ? "+" : ""}{Math.round(pnl)}
              </div>
            </div>
            <div>
              <div className="text-[9px] uppercase tracking-wider text-[var(--cryp-mute)]">Stake</div>
              <div className="font-mono-num text-[12px]">${Math.round(pos.stakeUsd)}</div>
            </div>
          </div>
          {open && (
            <button
              type="button"
              className="mt-3 inline-flex items-center gap-1.5 text-[10px] font-bold tracking-widest uppercase px-2.5 py-1.5"
              style={{ background: "rgba(232,93,93,0.12)", color: "var(--cryp-loss)" }}
              onClick={(e) => { e.stopPropagation(); onExit(); }}
            >
              <LogOut className="w-3 h-3" /> Exit @ live
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

export default function TraderPage() {
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [book, setBook] = useState<TraderBook>(() => loadBook());
  const [focusId, setFocusId] = useState<string | null>(null);
  const [stake, setStake] = useState(50);
  const [target, setTarget] = useState(3);
  const [pickId, setPickId] = useState<number | null>(null);
  const [justEntered, setJustEntered] = useState(false);
  const [justExited, setJustExited] = useState<{ multiple: number; symbol: string } | null>(null);
  const [tab, setTab] = useState<"open" | "closed" | "candidates">("open");

  const { data: feedData, isLoading } = useQuery({
    queryKey: RUNNER_FEED_KEY,
    queryFn: () => fetchRunnerFeed(200),
    refetchInterval: 12_000,
    placeholderData: keepPreviousData,
  });
  const feed = feedData?.tokens ?? [];
  const live = useMemo(() => liveMcMap(feed), [feed]);
  const stats = useMemo(() => computeBookStats(book, live), [book, live]);
  const focus = book.positions.find(p => p.id === focusId) ?? book.positions.find(isOpen) ?? null;

  const candidates = useMemo(() => {
    return feed
      .filter(t => t.runner.phase === "heating" || t.runner.phase === "entry" || t.runner.phase === "radar")
      .filter(t => !book.positions.some(p => isOpen(p) && p.tokenId === t.id))
      .slice(0, 24);
  }, [feed, book.positions]);

  const openPos = book.positions.filter(isOpen);
  const closedPos = book.positions.filter(p => !isOpen(p));

  function handleEnter(t: RunnerToken) {
    if (!t.currentMcUsd || t.currentMcUsd <= 0) {
      toast({ title: "No live MC", description: "Wait for a price tick.", variant: "destructive" });
      return;
    }
    if (book.bankrollUsd < 1) {
      toast({ title: "Bankroll empty", description: "Top up or close a winner.", variant: "destructive" });
      return;
    }
    if ((t.runner.signals.snapCount ?? 0) < 5 && t.runner.phase !== "entry") {
      toast({
        title: "Dex says wait",
        description: `Only ${t.runner.signals.snapCount ?? 0}/5 snaps — observation first.`,
      });
    }
    const next = openPosition(book, {
      tokenId: t.id,
      address: t.address,
      symbol: safeSymbol(t.symbol, t.address) || "?",
      name: t.name,
      logoUri: t.logoUri,
      entryMcUsd: t.currentMcUsd,
      stakeUsd: stake,
      targetMultiple: target,
    });
    setBook(next);
    setJustEntered(true);
    setJustExited(null);
    setFocusId(next.positions[0]?.id ?? null);
    setTab("open");
    setPickId(null);
    window.setTimeout(() => setJustEntered(false), 14_000);
    toast({ title: `Entered ${safeSymbol(t.symbol, t.address)}`, description: `Target ${target}× · stake $${stake}` });
  }

  function handleExit(pos: TraderPosition) {
    const mc = live[pos.tokenId] ?? pos.entryMcUsd;
    const mult = positionMultiple(pos, mc);
    const next = closePosition(book, pos.id, mc);
    setBook(next);
    setJustExited({ multiple: mult, symbol: pos.symbol });
    setJustEntered(false);
    window.setTimeout(() => setJustExited(null), 16_000);
    toast({
      title: `Exited ${pos.symbol}`,
      description: `${mult.toFixed(2)}× · ${mult >= 3 ? "Target cleared" : "Closed"}`,
    });
  }

  return (
    <div className="px-4 md:px-6 lg:px-8 py-5 md:py-8 space-y-5 md:space-y-6">
      <header className="fade-up">
        <div className="font-display text-[11px] font-bold tracking-[0.22em] uppercase text-[var(--cryp-teal)]">
          Trader Mode
        </div>
        <h1 className="font-display text-3xl md:text-4xl font-extrabold tracking-tight mt-1">
          Your book. His watch.
        </h1>
        <p className="text-[var(--cryp-mute)] text-[13px] md:text-[14px] mt-2 max-w-2xl">
          Place entries, hunt 3×+, bank exits. Dex watches the tape — observation snaps, heating, and what not to do.
        </p>
      </header>

      <TraderCompanion
        ctx={{
          book,
          feed,
          focus,
          justEntered,
          justExited,
        }}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatTile label="Equity" value={`$${Math.round(stats.equity).toLocaleString()}`} hint="Cash + open marks" accent="var(--cryp-mint)" />
        <StatTile label="Bankroll" value={`$${Math.round(book.bankrollUsd).toLocaleString()}`} hint="Dry powder" />
        <StatTile
          label="Open P&L"
          value={`${stats.openPnl >= 0 ? "+" : ""}$${Math.round(stats.openPnl)}`}
          accent={stats.openPnl >= 0 ? "var(--cryp-gain)" : "var(--cryp-loss)"}
          hint={`${stats.openCount} open`}
        />
        <StatTile
          label="3× Hits"
          value={String(stats.hits3x)}
          hint={`Best ${stats.bestMultiple.toFixed(1)}× · realized $${Math.round(stats.realizedPnl)}`}
          accent="var(--cryp-gain)"
        />
      </div>

      <div className="desk-card p-4 md:p-5 fade-up">
        <div className="flex flex-wrap items-end gap-3 md:gap-4">
          <label className="space-y-1">
            <span className="text-[10px] tracking-[0.18em] uppercase text-[var(--cryp-mute)] flex items-center gap-1">
              <Wallet className="w-3 h-3" /> Stake USD
            </span>
            <input
              type="number"
              min={1}
              max={book.bankrollUsd}
              value={stake}
              onChange={e => setStake(Math.max(1, Number(e.target.value) || 1))}
              className="w-28 bg-[var(--cryp-ink)] border border-[var(--cryp-line)] px-2.5 py-2 font-mono-num text-[13px] text-[var(--cryp-text)]"
            />
          </label>
          <label className="space-y-1">
            <span className="text-[10px] tracking-[0.18em] uppercase text-[var(--cryp-mute)] flex items-center gap-1">
              <Target className="w-3 h-3" /> Target ×
            </span>
            <input
              type="number"
              min={1.5}
              max={20}
              step={0.5}
              value={target}
              onChange={e => setTarget(Math.max(1.5, Number(e.target.value) || 3))}
              className="w-24 bg-[var(--cryp-ink)] border border-[var(--cryp-line)] px-2.5 py-2 font-mono-num text-[13px] text-[var(--cryp-text)]"
            />
          </label>
          <label className="space-y-1">
            <span className="text-[10px] tracking-[0.18em] uppercase text-[var(--cryp-mute)]">Bankroll</span>
            <input
              type="number"
              min={0}
              value={book.bankrollUsd}
              onChange={e => setBook(setBankroll(book, Number(e.target.value) || 0))}
              className="w-32 bg-[var(--cryp-ink)] border border-[var(--cryp-line)] px-2.5 py-2 font-mono-num text-[13px] text-[var(--cryp-text)]"
            />
          </label>
          <p className="text-[11px] text-[var(--cryp-mute)] pb-2 max-w-sm">
            Paper stakes only. Dex won't let the system ping ENTRY before 5 snaps — match that discipline.
          </p>
        </div>
      </div>

      <div className="flex gap-2 flex-wrap">
        {([
          ["open", `Open (${openPos.length})`],
          ["closed", `Closed (${closedPos.length})`],
          ["candidates", "Candidates"],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className="text-[10px] font-bold tracking-[0.16em] uppercase px-3 py-2 transition-colors"
            style={{
              background: tab === id ? "var(--cryp-teal)" : "transparent",
              color: tab === id ? "var(--cryp-ink)" : "var(--cryp-mute)",
              border: tab === id ? "1px solid var(--cryp-teal)" : "1px solid var(--cryp-line)",
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "candidates" && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {isLoading && !feed.length && (
            <div className="desk-card p-6 text-[var(--cryp-mute)] text-sm">Loading runner tape…</div>
          )}
          {!isLoading && candidates.length === 0 && (
            <div className="desk-card p-6 text-[var(--cryp-mute)] text-sm">
              No fresh candidates — Dex is still watching radar.
            </div>
          )}
          {candidates.map(t => {
            const snaps = t.runner.signals.snapCount ?? 0;
            const selected = pickId === t.id;
            return (
              <article key={t.id} className="desk-card p-4 fade-up">
                <div className="flex items-start gap-3">
                  <img
                    src={safeImageUrl(t.logoUri, t.address, t.symbol)}
                    alt=""
                    className="w-10 h-10 object-cover"
                    style={{ background: "var(--cryp-elevated)" }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <button
                        type="button"
                        className="font-display text-[14px] font-bold hover:text-[var(--cryp-mint)]"
                        onClick={() => setLocation(`/tokens/${t.id}`)}
                      >
                        {safeSymbol(t.symbol, t.address)}
                      </button>
                      <span className="text-[9px] uppercase tracking-wider text-[var(--cryp-mute)]">
                        {t.runner.phase} · {t.velocity.toFixed(2)}× · {snaps}/5 snaps
                      </span>
                    </div>
                    <div className="text-[11px] text-[var(--cryp-mute)] mt-1 truncate">
                      {truncateAddress(t.address)} · MC {formatCompactUsd(t.currentMcUsd)}
                    </div>
                    {(t.runner.blockers ?? []).length > 0 && (
                      <div className="text-[11px] text-[var(--cryp-warn)] mt-1">
                        Dex: {t.runner.blockers[0]}
                      </div>
                    )}
                    <div className="flex gap-2 mt-3">
                      <button
                        type="button"
                        className="inline-flex items-center gap-1.5 text-[10px] font-bold tracking-widest uppercase px-2.5 py-1.5"
                        style={{ background: "var(--cryp-teal)", color: "var(--cryp-ink)" }}
                        onClick={() => handleEnter(t)}
                      >
                        <Plus className="w-3 h-3" /> Enter
                      </button>
                      <button
                        type="button"
                        className="inline-flex items-center gap-1.5 text-[10px] font-bold tracking-widest uppercase px-2.5 py-1.5"
                        style={{
                          border: "1px solid var(--cryp-line)",
                          color: selected ? "var(--cryp-mint)" : "var(--cryp-mute)",
                        }}
                        onClick={() => setPickId(selected ? null : t.id)}
                      >
                        <Crosshair className="w-3 h-3" /> Watch
                      </button>
                    </div>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {tab === "open" && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {openPos.length === 0 && (
            <div className="desk-card p-6 text-[var(--cryp-mute)] text-sm">
              No open positions. Pull a candidate when Heating has tape — aim 3×.
            </div>
          )}
          {openPos.map(p => (
            <PositionRow
              key={p.id}
              pos={p}
              liveMc={live[p.tokenId]}
              token={feed.find(t => t.id === p.tokenId)}
              selected={focus?.id === p.id}
              onSelect={() => setFocusId(p.id)}
              onExit={() => handleExit(p)}
            />
          ))}
        </div>
      )}

      {tab === "closed" && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {closedPos.length === 0 && (
            <div className="desk-card p-6 text-[var(--cryp-mute)] text-sm">
              Closed book is empty. First 3× pays for the coffee.
            </div>
          )}
          {closedPos.map(p => (
            <PositionRow
              key={p.id}
              pos={p}
              liveMc={p.exitMcUsd}
              selected={false}
              onSelect={() => setFocusId(p.id)}
              onExit={() => undefined}
            />
          ))}
        </div>
      )}
    </div>
  );
}
