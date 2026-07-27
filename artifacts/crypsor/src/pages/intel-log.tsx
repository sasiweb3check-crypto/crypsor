import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Brain, ArrowUpRight, ArrowDownRight, Minus, Filter, RefreshCw, ChevronRight } from "lucide-react";
import { cn, formatTimeAgo } from "@/lib/utils";

const BASE = import.meta.env.BASE_URL;

// ── Types ─────────────────────────────────────────────────────────────────────

interface SubScores {
  mcGrowth:        number;
  volumeIntensity: number;
  holderVelocity:  number;
  kolSmart:        number;
  liquidityHealth: number;
}

interface LogEntry {
  id:                    number;
  tokenId?:              number;
  tokenAddress?:         string;
  computedAt:            string;
  trigger:               string;
  intelligenceScore:     number;
  prevIntelligenceScore: number | null;
  scoreDelta:            number | null;
  subScores:             SubScores | { mcGrowth: { score: number }; volumeIntensity: { score: number }; holderVelocity: { score: number }; kolSmart: { score: number }; liquidityHealth: { score: number } };
  ageHours:              number;
  ageMultiplier:         number;
  marketCapUsd:          string | null;
  volume24hUsd?:         string | null;
  liquidityUsd?:         string | null;
  holderCount?:          number | null;
  holderKolCount?:       number | null;
  holderSmartCount?:     number | null;
  totalBuys?:            number | null;
  smartBuys?:            number | null;
  labeledFraction?:      number | null;
  cohort?: {
    ageGroup:              string;
    cohortSize:            number;
    volumePercentile:      number | null;
    holderVelocityPerHour: number | null;
  };
  graduation?: {
    consecutive:    number | null;
    thresholdMet:   boolean | null;
    requiredStreak: number;
  };
  statusBefore:  string;
  statusAfter:   string;
  statusChanged: boolean;
}

interface TokenIntelResponse {
  token: { id: number; address: string; name: string | null; symbol: string | null; status: string; intelligenceScore: number | null };
  weights: Record<string, number>;
  graduationRules: Record<string, number>;
  total: number;
  entries: LogEntry[];
}

interface RecentResponse {
  total: number;
  entries: LogEntry[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function usd(val: string | null | undefined): string {
  if (!val) return "—";
  const n = parseFloat(val);
  if (!isFinite(n)) return "—";
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000)     return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function subScore(entry: LogEntry, key: keyof SubScores): number {
  const s = entry.subScores as any;
  const v = s[key];
  return typeof v === "object" ? (v?.score ?? 0) : (v ?? 0);
}

function scoreColor(v: number) {
  if (v >= 70) return "text-[#22c55e]";
  if (v >= 50) return "text-[#f59e0b]";
  if (v >= 30) return "text-[#fb923c]";
  return "text-[#ef4444]";
}

function scoreBg(v: number) {
  if (v >= 70) return "bg-[#22c55e]";
  if (v >= 50) return "bg-[#f59e0b]";
  if (v >= 30) return "bg-[#fb923c]";
  return "bg-[#ef4444]";
}

function triggerBadge(trigger: string) {
  if (trigger === "status_change") return "text-[#a78bfa] bg-[#a78bfa]/10 border-[#a78bfa]/30";
  if (trigger === "first")        return "text-[#60a5fa] bg-[#60a5fa]/10 border-[#60a5fa]/30";
  return "text-[#f59e0b] bg-[#f59e0b]/10 border-[#f59e0b]/30";
}

function triggerLabel(trigger: string) {
  if (trigger === "status_change") return "STATUS";
  if (trigger === "first")        return "FIRST";
  return "SCORE Δ";
}

function statusColor(s: string) {
  const m: Record<string, string> = {
    new: "text-[#60a5fa]", active: "text-[#22c55e]",
    watch: "text-[#f59e0b]", revived: "text-[#a78bfa]", archive: "text-[#8b949e]",
  };
  return m[s] ?? "text-[#8b949e]";
}

// ── Sub-score bar strip ────────────────────────────────────────────────────────

const SUB_DEFS = [
  { key: "mcGrowth"       as const, label: "MC",   weight: 35 },
  { key: "volumeIntensity"as const, label: "VOL",  weight: 25 },
  { key: "holderVelocity" as const, label: "HLDR", weight: 20 },
  { key: "kolSmart"       as const, label: "KOL",  weight: 15 },
  { key: "liquidityHealth"as const, label: "LIQ",  weight:  5 },
];

function SubScoreBar({ entry }: { entry: LogEntry }) {
  return (
    <div className="flex gap-1 items-end h-8">
      {SUB_DEFS.map(({ key, label, weight }) => {
        const v = subScore(entry, key);
        const h = Math.max(4, Math.round((v / 100) * 28));
        return (
          <div key={key} className="flex flex-col items-center gap-0.5" title={`${label} (${weight}%): ${v}`}>
            <div className="relative flex items-end" style={{ height: 28 }}>
              <div className={cn("w-4 rounded-sm transition-all", scoreBg(v))} style={{ height: h }} />
            </div>
            <span className="text-[8px] text-[#484f58] font-mono tracking-tight">{label}</span>
          </div>
        );
      })}
    </div>
  );
}

// ── Single log entry row ───────────────────────────────────────────────────────

function EntryRow({ entry, showToken }: { entry: LogEntry; showToken?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const delta = entry.scoreDelta;

  return (
    <div className="border-b border-[#30363d] last:border-0">
      {/* Main row */}
      <div
        className="flex items-center gap-3 px-4 py-3 hover:bg-[#161b22] cursor-pointer transition-colors"
        onClick={() => setExpanded(e => !e)}
      >
        {/* Trigger badge */}
        <span className={cn(
          "text-[8px] font-bold px-1.5 py-0.5 border tracking-widest uppercase shrink-0 w-16 text-center",
          triggerBadge(entry.trigger),
        )}>
          {triggerLabel(entry.trigger)}
        </span>

        {/* Token address (in global view) */}
        {showToken && entry.tokenAddress && (
          <span className="font-mono text-[10px] text-[#8b949e] shrink-0 w-28 truncate">
            {entry.tokenAddress.slice(0, 8)}…{entry.tokenAddress.slice(-4)}
          </span>
        )}

        {/* Master score */}
        <div className="flex items-center gap-1.5 shrink-0 w-20">
          <span className={cn("text-lg font-bold tabular-nums leading-none", scoreColor(entry.intelligenceScore))}>
            {entry.intelligenceScore}
          </span>
          {delta !== null && (
            <span className={cn("text-[10px] font-bold flex items-center gap-0.5",
              delta > 0 ? "text-[#22c55e]" : delta < 0 ? "text-[#ef4444]" : "text-[#8b949e]",
            )}>
              {delta > 0 ? <ArrowUpRight className="w-3 h-3" /> : delta < 0 ? <ArrowDownRight className="w-3 h-3" /> : <Minus className="w-3 h-3" />}
              {delta > 0 ? "+" : ""}{delta}
            </span>
          )}
        </div>

        {/* Sub-score bars */}
        <div className="shrink-0">
          <SubScoreBar entry={entry} />
        </div>

        {/* Status change */}
        {entry.statusChanged ? (
          <div className="flex items-center gap-1 shrink-0 text-[10px]">
            <span className={statusColor(entry.statusBefore)}>{entry.statusBefore.toUpperCase()}</span>
            <ChevronRight className="w-3 h-3 text-[#484f58]" />
            <span className={cn("font-bold", statusColor(entry.statusAfter))}>{entry.statusAfter.toUpperCase()}</span>
          </div>
        ) : (
          <span className={cn("text-[10px] shrink-0", statusColor(entry.statusAfter))}>
            {entry.statusAfter.toUpperCase()}
          </span>
        )}

        {/* MC */}
        <span className="text-[11px] text-[#8b949e] tabular-nums shrink-0 ml-auto">
          {usd(entry.marketCapUsd)}
        </span>

        {/* Age + time */}
        <div className="text-right shrink-0 w-20">
          <div className="text-[10px] text-[#8b949e]">{formatTimeAgo(entry.computedAt)}</div>
          <div className="text-[9px] text-[#484f58]">{entry.ageHours.toFixed(1)}h old · ×{entry.ageMultiplier}</div>
        </div>
      </div>

      {/* Expanded detail panel */}
      {expanded && (
        <div className="px-4 pb-4 bg-[#0d1117] border-t border-[#30363d]/60">
          <div className="pt-3 grid grid-cols-1 md:grid-cols-2 gap-4">

            {/* Sub-scores breakdown */}
            <div>
              <div className="text-[9px] text-[#484f58] tracking-widest uppercase mb-2">Sub-scores</div>
              <div className="space-y-1.5">
                {SUB_DEFS.map(({ key, label, weight }) => {
                  const v = subScore(entry, key);
                  return (
                    <div key={key} className="flex items-center gap-2">
                      <span className="text-[9px] text-[#8b949e] w-24 shrink-0">{label} <span className="text-[#484f58]">({weight}%)</span></span>
                      <div className="flex-1 h-1.5 bg-[#30363d] rounded-full overflow-hidden">
                        <div className={cn("h-full rounded-full", scoreBg(v))} style={{ width: `${v}%` }} />
                      </div>
                      <span className={cn("text-[10px] font-mono font-bold w-8 text-right", scoreColor(v))}>{v}</span>
                    </div>
                  );
                })}
              </div>
              <div className="mt-2 pt-2 border-t border-[#30363d]">
                <div className="flex items-center gap-2">
                  <span className="text-[9px] text-[#8b949e] w-24">MASTER SCORE</span>
                  <div className="flex-1 h-1.5 bg-[#30363d] rounded-full overflow-hidden">
                    <div className={cn("h-full rounded-full", scoreBg(entry.intelligenceScore))} style={{ width: `${entry.intelligenceScore}%` }} />
                  </div>
                  <span className={cn("text-[10px] font-mono font-bold w-8 text-right", scoreColor(entry.intelligenceScore))}>{entry.intelligenceScore}</span>
                </div>
                <div className="text-[9px] text-[#484f58] mt-1 ml-[104px]">
                  raw × age multiplier ×{entry.ageMultiplier} ({entry.ageHours.toFixed(1)}h old)
                </div>
              </div>
            </div>

            {/* Context inputs */}
            <div className="space-y-3">
              <div>
                <div className="text-[9px] text-[#484f58] tracking-widest uppercase mb-1.5">Market inputs</div>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    ["MC", usd(entry.marketCapUsd)],
                    ["Volume 24h", usd(entry.volume24hUsd)],
                    ["Liquidity", usd(entry.liquidityUsd)],
                  ].map(([l, v]) => (
                    <div key={l} className="bg-[#161b22] border border-[#30363d] p-1.5">
                      <div className="text-[8px] text-[#484f58] uppercase">{l}</div>
                      <div className="text-[11px] text-[#c9d1d9] font-mono mt-0.5">{v}</div>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <div className="text-[9px] text-[#484f58] tracking-widest uppercase mb-1.5">Holder inputs</div>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    ["Total",   String(entry.holderCount ?? "—")],
                    ["KOL",     String(entry.holderKolCount ?? "—")],
                    ["Smart",   String(entry.holderSmartCount ?? "—")],
                  ].map(([l, v]) => (
                    <div key={l} className="bg-[#161b22] border border-[#30363d] p-1.5">
                      <div className="text-[8px] text-[#484f58] uppercase">{l}</div>
                      <div className="text-[11px] text-[#c9d1d9] font-mono mt-0.5">{v}</div>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <div className="text-[9px] text-[#484f58] tracking-widest uppercase mb-1.5">Buy quality</div>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    ["Total buys",  String(entry.totalBuys ?? "—")],
                    ["Smart buys",  String(entry.smartBuys ?? "—")],
                    ["Labeled %",   entry.labeledFraction != null ? `${(entry.labeledFraction * 100).toFixed(0)}%` : "—"],
                  ].map(([l, v]) => (
                    <div key={l} className="bg-[#161b22] border border-[#30363d] p-1.5">
                      <div className="text-[8px] text-[#484f58] uppercase">{l}</div>
                      <div className="text-[11px] text-[#c9d1d9] font-mono mt-0.5">{v}</div>
                    </div>
                  ))}
                </div>
              </div>

              {entry.cohort && (
                <div>
                  <div className="text-[9px] text-[#484f58] tracking-widest uppercase mb-1.5">Cohort context</div>
                  <div className="grid grid-cols-2 gap-2">
                    {[
                      ["Age group",   entry.cohort.ageGroup?.toUpperCase() ?? "—"],
                      ["Cohort size", String(entry.cohort.cohortSize ?? "—")],
                      ["Vol pctile",  entry.cohort.volumePercentile != null ? `${(entry.cohort.volumePercentile * 100).toFixed(0)}%` : "—"],
                      ["Hldr vel/hr", entry.cohort.holderVelocityPerHour != null ? entry.cohort.holderVelocityPerHour.toFixed(1) : "—"],
                    ].map(([l, v]) => (
                      <div key={l} className="bg-[#161b22] border border-[#30363d] p-1.5">
                        <div className="text-[8px] text-[#484f58] uppercase">{l}</div>
                        <div className="text-[11px] text-[#c9d1d9] font-mono mt-0.5">{v}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {entry.graduation && entry.statusBefore === "new" && (
                <div>
                  <div className="text-[9px] text-[#484f58] tracking-widest uppercase mb-1.5">Graduation gate (new → active)</div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <div className="bg-[#161b22] border border-[#30363d] p-1.5 flex-1">
                      <div className="text-[8px] text-[#484f58] uppercase">Streak</div>
                      <div className="text-[11px] font-mono mt-0.5">
                        <span className={entry.graduation.consecutive ? "text-[#f59e0b]" : "text-[#8b949e]"}>
                          {entry.graduation.consecutive ?? 0}
                        </span>
                        <span className="text-[#484f58]"> / {entry.graduation.requiredStreak}</span>
                      </div>
                    </div>
                    <div className="bg-[#161b22] border border-[#30363d] p-1.5 flex-1">
                      <div className="text-[8px] text-[#484f58] uppercase">Threshold met</div>
                      <div className={cn("text-[11px] font-mono mt-0.5", entry.graduation.thresholdMet ? "text-[#22c55e]" : "text-[#ef4444]")}>
                        {entry.graduation.thresholdMet ? "YES" : "NO"} <span className="text-[#484f58]">(≥55 & 3/5 subs ≥40)</span>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Token-specific log view ────────────────────────────────────────────────────

function TokenLog({ tokenId }: { tokenId: number }) {
  const [trigger, setTrigger] = useState<string>("");

  const url = `${BASE}api/intel-log/${tokenId}${trigger ? `?trigger=${trigger}` : ""}`;
  const { data, isLoading, refetch, isFetching } = useQuery<TokenIntelResponse>({
    queryKey: ["intel-log-token", tokenId, trigger],
    queryFn: () => fetch(url).then(r => r.json()),
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
        <div className="flex items-center gap-2">
          {(["", "score_change", "status_change", "first"] as const).map(t => (
            <button
              key={t}
              onClick={() => setTrigger(t)}
              className={cn(
                "text-[9px] font-bold px-2 py-1 border tracking-widest uppercase transition-colors",
                trigger === t
                  ? "border-[#f59e0b] text-[#f59e0b] bg-[#f59e0b]/10"
                  : "border-[#30363d] text-[#484f58] hover:text-[#8b949e]",
              )}
            >
              {t === "" ? "ALL" : t === "score_change" ? "SCORE Δ" : t === "status_change" ? "STATUS" : "FIRST"}
            </button>
          ))}
        </div>
        <button onClick={() => refetch()} className="text-[#484f58] hover:text-[#8b949e] transition-colors">
          <RefreshCw className={cn("w-3.5 h-3.5", isFetching && "animate-spin")} />
        </button>
      </div>

      {isLoading ? (
        <div className="py-12 text-center text-[#484f58] text-xs">Loading…</div>
      ) : !data?.entries.length ? (
        <div className="py-12 text-center">
          <Brain className="w-8 h-8 text-[#30363d] mx-auto mb-3" />
          <div className="text-[#484f58] text-xs">No log entries yet.</div>
          <div className="text-[#30363d] text-[10px] mt-1">The intelligence engine runs every 5 minutes.</div>
        </div>
      ) : (
        <div className="border border-[#30363d]">
          {/* Column headers */}
          <div className="flex items-center gap-3 px-4 py-2 bg-[#161b22] border-b border-[#30363d]">
            <span className="text-[8px] text-[#484f58] tracking-widest uppercase w-16">Trigger</span>
            <span className="text-[8px] text-[#484f58] tracking-widest uppercase w-20">Score</span>
            <span className="text-[8px] text-[#484f58] tracking-widest uppercase">Sub-scores</span>
            <span className="text-[8px] text-[#484f58] tracking-widest uppercase ml-auto">MC</span>
            <span className="text-[8px] text-[#484f58] tracking-widest uppercase w-20 text-right">Time</span>
          </div>
          {data.entries.map(e => <EntryRow key={e.id} entry={e} />)}
        </div>
      )}
    </div>
  );
}

// ── Global (recent across all tokens) log view ────────────────────────────────

function GlobalLog() {
  const { data, isLoading, refetch, isFetching } = useQuery<RecentResponse>({
    queryKey: ["intel-log-recent"],
    queryFn:  () => fetch(`${BASE}api/intel-log?limit=100`).then(r => r.json()),
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <span className="text-[10px] text-[#484f58]">Most recent 100 changes across all tokens</span>
        <button onClick={() => refetch()} className="text-[#484f58] hover:text-[#8b949e] transition-colors">
          <RefreshCw className={cn("w-3.5 h-3.5", isFetching && "animate-spin")} />
        </button>
      </div>
      {isLoading ? (
        <div className="py-12 text-center text-[#484f58] text-xs">Loading…</div>
      ) : !data?.entries.length ? (
        <div className="py-12 text-center">
          <Brain className="w-8 h-8 text-[#30363d] mx-auto mb-3" />
          <div className="text-[#484f58] text-xs">No log entries yet.</div>
          <div className="text-[#30363d] text-[10px] mt-1">Add wallet addresses and wait for the first intelligence cycle (5 min).</div>
        </div>
      ) : (
        <div className="border border-[#30363d]">
          <div className="flex items-center gap-3 px-4 py-2 bg-[#161b22] border-b border-[#30363d]">
            <span className="text-[8px] text-[#484f58] tracking-widest uppercase w-16">Trigger</span>
            <span className="text-[8px] text-[#484f58] tracking-widest uppercase w-28">Token</span>
            <span className="text-[8px] text-[#484f58] tracking-widest uppercase w-20">Score</span>
            <span className="text-[8px] text-[#484f58] tracking-widest uppercase">Sub-scores</span>
            <span className="text-[8px] text-[#484f58] tracking-widest uppercase ml-auto">MC</span>
            <span className="text-[8px] text-[#484f58] tracking-widest uppercase w-20 text-right">Time</span>
          </div>
          {data.entries.map(e => <EntryRow key={e.id} entry={e} showToken />)}
        </div>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function IntelLog() {
  const [, setLocation] = useLocation();
  const [tokenIdInput, setTokenIdInput] = useState("");
  const [activeTokenId, setActiveTokenId] = useState<number | null>(null);

  const handleTokenSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const id = parseInt(tokenIdInput.trim(), 10);
    if (isFinite(id) && id > 0) setActiveTokenId(id);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Brain className="w-4 h-4 text-[#f59e0b]" />
            <h1 className="text-sm font-bold tracking-widest text-[#c9d1d9] uppercase">Intel Score Log</h1>
          </div>
          <p className="text-[10px] text-[#484f58]">
            Every scoring cycle that moved the intel score ≥1pt or triggered a status change — with all 5 sub-scores and inputs.
          </p>
        </div>

        {/* Weights legend */}
        <div className="flex items-center gap-3 border border-[#30363d] px-3 py-2 bg-[#161b22]">
          <span className="text-[8px] text-[#484f58] tracking-widest uppercase shrink-0">Weights</span>
          {SUB_DEFS.map(({ label, weight }) => (
            <div key={label} className="text-center">
              <div className="text-[9px] text-[#f59e0b] font-bold">{label}</div>
              <div className="text-[8px] text-[#484f58]">{weight}%</div>
            </div>
          ))}
        </div>
      </div>

      {/* Scoring rules callout */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {[
          { label: "Age multiplier", desc: "<2h ×1.30 · 2–7h ×1.00 · 7–24h ×0.97 · 24–48h ×0.92 · >48h ×0.82" },
          { label: "Graduation gate", desc: "Score ≥55 AND ≥3/5 sub-scores ≥40 for 3 consecutive cycles → new→active" },
          { label: "Archive gate", desc: "MC <$4.5K for 2 consecutive price ticks · MC ≥$20K revives directly to active" },
        ].map(({ label, desc }) => (
          <div key={label} className="border border-[#30363d] bg-[#161b22] px-3 py-2">
            <div className="text-[9px] text-[#f59e0b] uppercase tracking-widest mb-1">{label}</div>
            <div className="text-[9px] text-[#8b949e] leading-relaxed">{desc}</div>
          </div>
        ))}
      </div>

      {/* Token filter */}
      <div className="flex items-center gap-3">
        <Filter className="w-3.5 h-3.5 text-[#484f58] shrink-0" />
        <form onSubmit={handleTokenSearch} className="flex items-center gap-2">
          <input
            type="number"
            placeholder="Token ID (from token detail page)"
            value={tokenIdInput}
            onChange={e => setTokenIdInput(e.target.value)}
            className="bg-[#161b22] border border-[#30363d] text-[#c9d1d9] text-xs px-3 py-1.5 w-56 placeholder:text-[#484f58] focus:outline-none focus:border-[#f59e0b]/50"
          />
          <button
            type="submit"
            className="text-[9px] font-bold px-3 py-1.5 border border-[#f59e0b]/40 text-[#f59e0b] bg-[#f59e0b]/5 hover:bg-[#f59e0b]/10 tracking-widest uppercase transition-colors"
          >
            Filter
          </button>
          {activeTokenId && (
            <button
              type="button"
              onClick={() => { setActiveTokenId(null); setTokenIdInput(""); }}
              className="text-[9px] text-[#484f58] hover:text-[#8b949e] tracking-widest uppercase transition-colors"
            >
              Clear
            </button>
          )}
        </form>
        {activeTokenId && (
          <span className="text-[10px] text-[#f59e0b]">Showing token #{activeTokenId}</span>
        )}
      </div>

      {/* Log table */}
      {activeTokenId ? (
        <TokenLog tokenId={activeTokenId} />
      ) : (
        <GlobalLog />
      )}
    </div>
  );
}
