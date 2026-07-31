/**
 * Wallet intel report — search a wallet, enrich GMGN profile,
 * show Crypsor labels / win-rate / observed trades.
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useParams } from "wouter";
import {
  ArrowLeft, Copy, RefreshCw, Search, Brain,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn, truncateAddress, formatTimeAgo } from "@/lib/utils";
import {
  WALLET_INTEL_KEY, fetchWalletIntelReport,
  type WalletIntelReport, type WalletTokenEvent,
} from "@/lib/wallet-intel-api";

const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function labelColor(label: string): string {
  switch (label) {
    case "diamond": return "text-[var(--cryp-mint)]";
    case "accumulator": return "text-[var(--cryp-teal)]";
    case "solid": return "text-[var(--cryp-text)]";
    case "whale": return "text-[var(--cryp-warn)]";
    case "flipper":
    case "dump": return "text-[var(--cryp-loss)]";
    default: return "text-[var(--cryp-mute)]";
  }
}

function EventRow({ e }: { e: WalletTokenEvent }) {
  return (
    <li
      className="py-2.5 space-y-1"
      style={{ borderBottom: "1px solid var(--cryp-line)" }}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <span className="font-display text-[13px] font-bold">
            ${e.symbol || "?"}
          </span>
          <span className={cn(
            "ml-2 text-[10px] font-bold uppercase tracking-wider",
            e.role === "win" ? "text-[var(--cryp-mint)]"
              : e.role === "loss" ? "text-[var(--cryp-loss)]"
                : "text-[var(--cryp-mute)]",
          )}>
            {e.role}
          </span>
        </div>
        <span className={cn("text-[11px] font-bold uppercase", labelColor(e.ourLabelAt ?? "noise"))}>
          {e.ourLabelAt ?? "—"}
        </span>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] font-mono-num text-[var(--cryp-mute)]">
        {e.behaviourScoreAt != null && <span>Score {Math.round(e.behaviourScoreAt)}</span>}
        {e.holdPct != null && <span>Hold {e.holdPct < 0.01 ? e.holdPct.toFixed(3) : e.holdPct.toFixed(2)}%</span>}
        {e.buyCount != null && <span>B{e.buyCount}</span>}
        {e.sellCount != null && <span>S{e.sellCount}</span>}
        {e.athMultiple != null && <span>ATH {e.athMultiple.toFixed(2)}×</span>}
        {e.hit2x === true && <span className="text-[var(--cryp-mint)]">2×</span>}
        {e.entryServed && <span>ENTRY</span>}
        {e.updatedAt && <span>{formatTimeAgo(e.updatedAt)} ago</span>}
      </div>
    </li>
  );
}

function ReportBody({ data, onRefresh, refreshing }: {
  data: WalletIntelReport;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const { toast } = useToast();
  const c = data.crypsor;
  const g = data.gmgn;
  const observed = useMemo(
    () => data.events.filter(e => e.role === "observed"),
    [data.events],
  );

  return (
    <div className="space-y-3">
      <section className="call-card space-y-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-widest text-[var(--cryp-mute)]">Wallet</div>
            <button
              type="button"
              className="font-mono-num text-[13px] text-[var(--cryp-text)] hover:text-[var(--cryp-mint)] break-all text-left"
              onClick={() => {
                void navigator.clipboard.writeText(data.walletAddress);
                toast({ title: "Copied", description: truncateAddress(data.walletAddress) });
              }}
            >
              {data.walletAddress}
              <Copy className="inline w-3 h-3 ml-1.5 opacity-60" />
            </button>
          </div>
          <button
            type="button"
            className="call-action shrink-0"
            disabled={refreshing}
            onClick={onRefresh}
          >
            <RefreshCw className={cn("w-3.5 h-3.5", refreshing && "animate-spin")} />
            Enrich
          </button>
        </div>
        {data.note && (
          <p className="text-[11px] text-[var(--cryp-mute)] leading-relaxed">{data.note}</p>
        )}
      </section>

      {/* Crypsor intel */}
      <section className="call-card space-y-2">
        <div className="flex items-center gap-2">
          <Brain className="w-4 h-4 text-[var(--cryp-mint)]" />
          <h2 className="font-display text-[13px] font-bold uppercase tracking-widest">
            Crypsor label
          </h2>
        </div>
        {c ? (
          <>
            <div className="flex items-baseline justify-between gap-2">
              <span className={cn("font-display text-[22px] font-extrabold uppercase", labelColor(c.ourLabel))}>
                {c.ourLabel}
              </span>
              <span className="font-mono-num text-[18px] font-bold text-[var(--cryp-mint)]">
                {c.winRate != null ? `${(c.winRate * 100).toFixed(0)}%` : "—"}
                <span className="text-[11px] text-[var(--cryp-mute)] font-normal ml-1">WR</span>
              </span>
            </div>
            <div className="grid grid-cols-3 gap-2 text-[12px]">
              <div>
                <div className="text-[9px] uppercase tracking-widest text-[var(--cryp-mute)]">Score</div>
                <div className="font-mono-num font-bold mt-0.5">{Math.round(c.behaviourScore)}</div>
              </div>
              <div>
                <div className="text-[9px] uppercase tracking-widest text-[var(--cryp-mute)]">Weight</div>
                <div className="font-mono-num font-bold mt-0.5">{c.weightage.toFixed(1)}</div>
              </div>
              <div>
                <div className="text-[9px] uppercase tracking-widest text-[var(--cryp-mute)]">W / L</div>
                <div className="font-mono-num font-bold mt-0.5">{c.wins} / {c.losses}</div>
              </div>
              <div>
                <div className="text-[9px] uppercase tracking-widest text-[var(--cryp-mute)]">Tokens</div>
                <div className="font-mono-num font-bold mt-0.5">{c.tokensSeen}</div>
              </div>
              <div>
                <div className="text-[9px] uppercase tracking-widest text-[var(--cryp-mute)]">Sightings</div>
                <div className="font-mono-num font-bold mt-0.5">{c.sightings}</div>
              </div>
              <div>
                <div className="text-[9px] uppercase tracking-widest text-[var(--cryp-mute)]">Avg hold</div>
                <div className="font-mono-num font-bold mt-0.5">
                  {c.avgHoldPct != null ? `${c.avgHoldPct.toFixed(2)}%` : "—"}
                </div>
              </div>
            </div>
            {c.lastReason && (
              <div className="text-[11px] text-[var(--cryp-mute)]">{c.lastReason}</div>
            )}
          </>
        ) : data.liveJudgment ? (
          <div className="space-y-1">
            <div className={cn("font-display text-[18px] font-bold uppercase", labelColor(data.liveJudgment.ourLabel))}>
              {data.liveJudgment.ourLabel}
              <span className="ml-2 text-[11px] font-normal text-[var(--cryp-mute)]">preview</span>
            </div>
            <div className="text-[11px] font-mono-num text-[var(--cryp-mute)]">
              Score {data.liveJudgment.behaviourScore} · Hold {data.liveJudgment.holdPct.toFixed(2)}%
              · B{data.liveJudgment.buyCount}/S{data.liveJudgment.sellCount}
              {data.liveJudgment.symbol ? ` · $${data.liveJudgment.symbol}` : ""}
            </div>
            <div className="text-[11px] text-[var(--cryp-mute)]">{data.liveJudgment.note}</div>
          </div>
        ) : (
          <div className="text-[12px] text-[var(--cryp-mute)] py-4 text-center">
            No Crypsor intel yet — enrich + wait for holder background job
          </div>
        )}
      </section>

      {/* GMGN enricher */}
      <section className="call-card space-y-2">
        <h2 className="font-display text-[13px] font-bold uppercase tracking-widest">
          GMGN profile
        </h2>
        {g ? (
          <div className="grid grid-cols-2 gap-2 text-[12px]">
            <div>
              <div className="text-[9px] uppercase tracking-widest text-[var(--cryp-mute)]">GMGN WR</div>
              <div className="font-mono-num font-bold mt-0.5">
                {g.winRate != null ? `${(g.winRate * 100).toFixed(0)}%` : "—"}
              </div>
            </div>
            <div>
              <div className="text-[9px] uppercase tracking-widest text-[var(--cryp-mute)]">Total PnL</div>
              <div className="font-mono-num font-bold mt-0.5">
                {g.totalPnlUsd != null ? `$${Math.round(g.totalPnlUsd).toLocaleString()}` : "—"}
              </div>
            </div>
            <div>
              <div className="text-[9px] uppercase tracking-widest text-[var(--cryp-mute)]">Trades</div>
              <div className="font-mono-num font-bold mt-0.5">{g.totalTradeCount ?? "—"}</div>
            </div>
            <div>
              <div className="text-[9px] uppercase tracking-widest text-[var(--cryp-mute)]">SOL</div>
              <div className="font-mono-num font-bold mt-0.5">
                {g.solBalance != null ? g.solBalance.toFixed(2) : "—"}
              </div>
            </div>
            {g.labels.length > 0 && (
              <div className="col-span-2">
                <div className="text-[9px] uppercase tracking-widest text-[var(--cryp-mute)]">Tags</div>
                <div className="text-[11px] mt-0.5 text-[var(--cryp-mute)]">{g.labels.join(" · ")}</div>
              </div>
            )}
            {(g.twitterUsername || g.twitterName) && (
              <div className="col-span-2 text-[11px] text-[var(--cryp-teal)]">
                @{g.twitterUsername || g.twitterName}
              </div>
            )}
          </div>
        ) : (
          <div className="text-[12px] text-[var(--cryp-mute)] py-3 text-center">
            Tap Enrich to pull GMGN wallet profile
          </div>
        )}
      </section>

      {/* Observed tokens */}
      <section className="call-card">
        <div className="flex items-center gap-2 mb-1">
          <h2 className="font-display text-[13px] font-bold uppercase tracking-widest">
            Observed tokens
          </h2>
          <span className="ml-auto text-[11px] font-mono-num text-[var(--cryp-mute)]">
            {data.summary.observedTokens} · {data.summary.winEvents}W / {data.summary.lossEvents}L
          </span>
        </div>
        {observed.length === 0 && data.events.length === 0 ? (
          <div className="text-[12px] text-[var(--cryp-mute)] py-6 text-center">
            No token events stored yet
          </div>
        ) : (
          <ul>
            {data.events.map((e, i) => (
              <EventRow key={`${e.tokenId}-${e.role}-${i}`} e={e} />
            ))}
          </ul>
        )}
      </section>

      {data.trackedBuys.length > 0 && (
        <section className="call-card">
          <h2 className="font-display text-[13px] font-bold uppercase tracking-widest mb-1">
            Your tracked buys
          </h2>
          <p className="text-[11px] text-[var(--cryp-mute)] mb-2">
            Buys from walletdatasource sensor list (not Crypsor holder intel)
          </p>
          <ul>
            {data.trackedBuys.map((b, i) => (
              <li
                key={`${b.tokenId}-${i}`}
                className="flex items-center justify-between py-2 text-[12px]"
                style={{ borderBottom: "1px solid var(--cryp-line)" }}
              >
                <span className="font-bold">${b.symbol || "?"}</span>
                <span className="font-mono-num text-[var(--cryp-mute)]">
                  {b.athMultiple != null ? `${b.athMultiple.toFixed(1)}×` : "—"}
                  {b.boughtAt ? ` · ${formatTimeAgo(b.boughtAt)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

export default function WalletIntelPage() {
  const params = useParams<{ address?: string }>();
  const [, setLocation] = useLocation();
  const [input, setInput] = useState(params.address ?? "");
  const [refreshTick, setRefreshTick] = useState(0);
  const address = (params.address ?? "").trim();
  const valid = SOL_RE.test(address);

  useEffect(() => {
    if (params.address) setInput(params.address);
  }, [params.address]);

  const { data, isLoading, isFetching, isError, error, refetch } = useQuery({
    queryKey: [...WALLET_INTEL_KEY(address, true), refreshTick],
    queryFn: () => fetchWalletIntelReport(address, true),
    enabled: valid,
    staleTime: 30_000,
    retry: 2,
  });

  const submit = (e?: React.FormEvent) => {
    e?.preventDefault();
    const a = input.trim();
    if (!SOL_RE.test(a)) return;
    setLocation(`/wallet/${a}`);
  };

  return (
    <div className="px-4 pt-3 pb-10 space-y-4 max-w-lg mx-auto w-full">
      <button
        type="button"
        onClick={() => setLocation("/")}
        className="inline-flex items-center gap-1.5 text-[12px] font-bold uppercase tracking-widest text-[var(--cryp-mute)] hover:text-[var(--cryp-mint)]"
      >
        <ArrowLeft className="w-4 h-4" />
        Calls
      </button>

      <header className="fade-up">
        <h1 className="font-display text-[20px] font-extrabold tracking-tight">
          Wallet intel
        </h1>
        <p className="text-[12px] text-[var(--cryp-mute)] mt-1 leading-relaxed">
          Search a wallet → GMGN enrich + Crypsor labels / win-rate / observed trades
        </p>
      </header>

      <form onSubmit={submit} className="flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Solana wallet address"
          className="flex-1 min-w-0 px-3 py-2.5 rounded-xl text-[13px] font-mono-num"
          style={{
            background: "rgba(16,27,36,0.95)",
            border: "1px solid var(--cryp-line)",
            color: "var(--cryp-text)",
          }}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
        />
        <button type="submit" className="call-action shrink-0" disabled={!SOL_RE.test(input.trim())}>
          <Search className="w-3.5 h-3.5" />
          Go
        </button>
      </form>

      {address && !valid && (
        <div className="text-[12px] text-[var(--cryp-loss)]">Invalid Solana address</div>
      )}

      {valid && isLoading && !data && (
        <div className="call-card shimmer-card h-48" />
      )}

      {valid && isError && !data && (
        <div className="call-card text-center py-8 space-y-2">
          <div className="text-[13px] text-[var(--cryp-loss)]">Couldn’t load report</div>
          <div className="text-[11px] text-[var(--cryp-mute)]">
            {error instanceof Error ? error.message : "Retry"}
          </div>
          <button type="button" className="call-action mx-auto" onClick={() => void refetch()}>
            Retry
          </button>
        </div>
      )}

      {data && (
        <ReportBody
          data={data}
          refreshing={isFetching}
          onRefresh={() => {
            setRefreshTick(t => t + 1);
            void refetch();
          }}
        />
      )}
    </div>
  );
}
