import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Flame, TrendingUp, Users, Zap, ExternalLink, ChevronUp, ChevronDown } from "lucide-react";
import {
  cn, formatCompactUsd, formatGain, formatTimeAgo,
  safeSymbol, safeName, safeImageUrl, getGmgnUrl, truncateAddress,
} from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────────

interface CallerToken {
  id: number;
  address: string;
  chain: string;
  name: string | null;
  symbol: string | null;
  logoUri: string | null;
  status: string;
  marketCapUsd: string | null;
  gainPct: number | null;
  athGainPct: number | null;
  mcGrowthScore: number;
  holderVelocityScore: number;
  kolSmartScore: number;
  holderTop10Pct: number;
  holderKolCount: number;
  holderSmartCount: number;
  holderCount: number;
  callerScore: number;
  callerPhase: string;
  callerLabel: string;
  holderSnapshotCount: number;
  athGap: number | null;
  firstDetectedAt: string;
  lastHoldersUpdatedAt: string | null;
}

interface CallerResponse {
  data: CallerToken[];
  total: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const LABEL_TABS = [
  { value: "",                 label: "ALL" },
  { value: "STRONG MOON CALL", label: "🚀 STRONG MOON" },
  { value: "GOOD CALL",        label: "✅ GOOD CALL" },
  { value: "WATCH",            label: "👁 WATCH" },
  { value: "SKIP",             label: "⛔ SKIP" },
];

const PHASE_TABS = [
  { value: "",            label: "All Phases" },
  { value: "Early Degen", label: "Early Degen" },
  { value: "Survival",    label: "Survival" },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function labelStyle(label: string) {
  switch (label) {
    case "STRONG MOON CALL": return "text-[#a78bfa] bg-[#a78bfa]/10 border-[#a78bfa]/30";
    case "GOOD CALL":        return "text-[#22c55e] bg-[#22c55e]/10 border-[#22c55e]/30";
    case "WATCH":            return "text-[#f59e0b] bg-[#f59e0b]/10 border-[#f59e0b]/30";
    default:                 return "text-[#8b949e] bg-[#8b949e]/08 border-[#30363d]";
  }
}

function phaseStyle(phase: string) {
  return phase === "Survival"
    ? "text-[#60a5fa] bg-[#60a5fa]/10 border-[#60a5fa]/20"
    : "text-[#f97316] bg-[#f97316]/10 border-[#f97316]/20";
}

function scoreBar(score: number, color: string) {
  return (
    <div className="flex items-center gap-1.5">
      <div className="w-14 h-1 bg-[#30363d] relative overflow-hidden">
        <div
          className="absolute inset-y-0 left-0 transition-all"
          style={{ width: `${Math.min(100, score)}%`, background: color }}
        />
      </div>
      <span className="text-[10px] tabular-nums text-[#8b949e]">{Math.round(score)}</span>
    </div>
  );
}

function gainColor(pct: number | null | undefined) {
  if (pct == null) return "text-[#8b949e]";
  if (pct > 0) return "text-[#22c55e]";
  if (pct < 0) return "text-[#ef4444]";
  return "text-[#8b949e]";
}

function CallerScoreRing({ score, label }: { score: number; label: string }) {
  const size = 44;
  const r = 18;
  const circ = 2 * Math.PI * r;
  const fill = circ * (1 - score / 100);

  const color =
    label === "STRONG MOON CALL" ? "#a78bfa" :
    label === "GOOD CALL"        ? "#22c55e" :
    label === "WATCH"            ? "#f59e0b" : "#484f58";

  return (
    <div className="relative flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="absolute inset-0 -rotate-90" style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#21262d" strokeWidth="3" />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none"
          stroke={color} strokeWidth="3"
          strokeDasharray={`${circ}`}
          strokeDashoffset={fill}
          strokeLinecap="butt"
          style={{ transition: "stroke-dashoffset 0.4s ease" }}
        />
      </svg>
      <span className="text-xs font-bold tabular-nums" style={{ color }}>{score}</span>
    </div>
  );
}

function TokenLogo({ logoUri, address, symbol }: { logoUri?: string | null; address: string; symbol?: string | null }) {
  const [src, setSrc] = useState(() => safeImageUrl(logoUri, address, symbol));
  const [idx, setIdx] = useState(0);
  const fallbacks = [
    `https://static.jup.ag/images/tokens/${address}.png`,
    `https://ui-avatars.com/api/?name=${encodeURIComponent((symbol?.slice(0, 2) || "?").replace(/[^\x00-\x7F]/g, "").trim() || "?")}&background=1a2030&color=f59e0b&size=64`,
  ];
  return (
    <img
      src={src} alt=""
      className="w-8 h-8 shrink-0 border border-[#30363d] bg-[#161b22]"
      style={{ borderRadius: 0 }}
      onError={() => {
        const next = fallbacks[idx];
        if (next && src !== next) { setSrc(next); setIdx(i => i + 1); }
      }}
    />
  );
}

function LiveAge({ dateStr }: { dateStr: string | null | undefined }) {
  const [text, setText] = useState(() => formatTimeAgo(dateStr));
  useEffect(() => {
    setText(formatTimeAgo(dateStr));
    const id = setInterval(() => setText(formatTimeAgo(dateStr)), 10_000);
    return () => clearInterval(id);
  }, [dateStr]);
  return <span>{text || "—"}</span>;
}

// ── Summary Stat ──────────────────────────────────────────────────────────────

function StatPill({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="flex flex-col items-center px-4 py-2 bg-[#161b22] border border-[#30363d]">
      <span className="text-xl font-bold tabular-nums" style={{ color }}>{value}</span>
      <span className="text-[9px] text-[#484f58] uppercase tracking-widest mt-0.5">{label}</span>
    </div>
  );
}

// ── Mobile Card ───────────────────────────────────────────────────────────────

function MobileCallerCard({ token, onClick }: { token: CallerToken; onClick: () => void }) {
  return (
    <div
      className="bg-[#161b22] border-b border-[#30363d] px-4 py-3 cursor-pointer hover:bg-[#1c2128] transition-colors"
      onClick={onClick}
    >
      <div className="flex items-center gap-3 mb-2">
        <CallerScoreRing score={token.callerScore} label={token.callerLabel} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <TokenLogo logoUri={token.logoUri} address={token.address} symbol={token.symbol} />
            <div className="min-w-0">
              <div className="text-[#f59e0b] font-bold text-sm truncate">{safeSymbol(token.symbol, token.address)}</div>
              <div className="text-[#484f58] text-[10px] truncate">{safeName(token.name, token.symbol, token.address)}</div>
            </div>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <span className={cn("text-[9px] font-bold px-1.5 py-0.5 border tracking-widest", labelStyle(token.callerLabel))}>
            {token.callerLabel}
          </span>
          <span className={cn("text-[9px] px-1.5 py-0.5 border", phaseStyle(token.callerPhase))}>
            {token.callerPhase}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-2 text-[10px]">
        <div>
          <div className="text-[#484f58] uppercase tracking-widest mb-0.5">MC</div>
          <div className="text-[#c9d1d9] font-bold">{formatCompactUsd(token.marketCapUsd)}</div>
        </div>
        <div>
          <div className="text-[#484f58] uppercase tracking-widest mb-0.5">Gain</div>
          <div className={cn("font-bold tabular-nums", gainColor(token.gainPct))}>{formatGain(token.gainPct)}</div>
        </div>
        <div>
          <div className="text-[#484f58] uppercase tracking-widest mb-0.5">ATH</div>
          <div className={cn("font-bold tabular-nums", gainColor(token.athGainPct))}>{formatGain(token.athGainPct)}</div>
        </div>
        <div>
          <div className="text-[#484f58] uppercase tracking-widest mb-0.5">Snaps</div>
          <div className="text-[#c9d1d9] font-bold">{token.holderSnapshotCount}</div>
        </div>
      </div>

      <div className="flex items-center gap-3 mt-2">
        {token.holderKolCount > 0 && <span className="text-[#f59e0b] text-[10px] font-bold">KOL {token.holderKolCount}</span>}
        {token.holderSmartCount > 0 && <span className="text-[#60a5fa] text-[10px] font-bold">SMART {token.holderSmartCount}</span>}
        <span className="ml-auto text-[#484f58] text-[10px]"><LiveAge dateStr={token.firstDetectedAt} /></span>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function DegenCaller() {
  const [, navigate] = useLocation();
  const [labelFilter, setLabelFilter] = useState("");
  const [phaseFilter, setPhaseFilter] = useState("");
  const [showSignals, setShowSignals] = useState(false);

  const params = new URLSearchParams();
  if (labelFilter) params.set("label", labelFilter);
  if (phaseFilter) params.set("phase", phaseFilter);
  params.set("limit", "200");

  const { data, isLoading, isFetching } = useQuery<CallerResponse>({
    queryKey: ["caller", labelFilter, phaseFilter],
    queryFn: () =>
      fetch(`${import.meta.env.BASE_URL}api/caller?${params.toString()}`).then(r => r.json()),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const tokens = data?.data ?? [];

  // Summary counts
  const strongCount  = tokens.filter(t => t.callerLabel === "STRONG MOON CALL").length;
  const goodCount    = tokens.filter(t => t.callerLabel === "GOOD CALL").length;
  const watchCount   = tokens.filter(t => t.callerLabel === "WATCH").length;
  const survivalCount = tokens.filter(t => t.callerPhase === "Survival").length;

  return (
    <div className="flex flex-col h-full">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="border-b border-[#30363d] px-4 py-3 bg-[#0d1117] sticky top-0 z-10">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <Flame className="w-4 h-4 text-[#f97316]" />
            <div>
              <div className="text-[#c9d1d9] font-bold text-sm uppercase tracking-widest">Degen Caller</div>
              <div className="text-[#484f58] text-[10px] mt-0.5">
                Two-phase caller score · Early Degen (1–4 snaps) → Survival (5+ snaps)
              </div>
            </div>
          </div>
          {isFetching && !isLoading && (
            <span className="text-[9px] text-[#484f58] uppercase tracking-widest animate-pulse">refreshing…</span>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto custom-scrollbar">
        {/* ── Summary strip ────────────────────────────────────────────── */}
        <div className="flex gap-px px-4 py-3 border-b border-[#30363d] overflow-x-auto no-scrollbar">
          <StatPill label="🚀 Strong Moon" value={strongCount}   color="#a78bfa" />
          <StatPill label="✅ Good Call"   value={goodCount}     color="#22c55e" />
          <StatPill label="👁 Watch"       value={watchCount}    color="#f59e0b" />
          <StatPill label="⚡ Survival"   value={survivalCount} color="#60a5fa" />
          <StatPill label="Total"          value={tokens.length} color="#c9d1d9" />
        </div>

        {/* ── Filters ──────────────────────────────────────────────────── */}
        <div className="flex flex-col gap-2 px-4 py-2.5 border-b border-[#30363d]">
          {/* Label filter */}
          <div className="flex gap-1 overflow-x-auto no-scrollbar">
            {LABEL_TABS.map(t => (
              <button
                key={t.value}
                onClick={() => setLabelFilter(t.value)}
                className={cn(
                  "text-[9px] font-bold px-2.5 py-1 border tracking-widest uppercase whitespace-nowrap shrink-0 transition-all",
                  labelFilter === t.value
                    ? "bg-[#f59e0b]/10 border-[#f59e0b]/40 text-[#f59e0b]"
                    : "border-[#30363d] text-[#8b949e] hover:text-[#c9d1d9] hover:border-[#484f58]",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
          {/* Phase filter */}
          <div className="flex items-center gap-2">
            <span className="text-[9px] text-[#484f58] uppercase tracking-widest shrink-0">Phase:</span>
            <div className="flex gap-1">
              {PHASE_TABS.map(t => (
                <button
                  key={t.value}
                  onClick={() => setPhaseFilter(t.value)}
                  className={cn(
                    "text-[9px] px-2.5 py-1 border tracking-widest whitespace-nowrap shrink-0 transition-all",
                    phaseFilter === t.value
                      ? "bg-[#60a5fa]/10 border-[#60a5fa]/40 text-[#60a5fa]"
                      : "border-[#30363d] text-[#8b949e] hover:text-[#c9d1d9] hover:border-[#484f58]",
                  )}
                >
                  {t.value === "" ? "All" : t.label}
                </button>
              ))}
            </div>

            {/* Toggle sub-signals */}
            <button
              onClick={() => setShowSignals(v => !v)}
              className="ml-auto flex items-center gap-1 text-[9px] text-[#484f58] hover:text-[#8b949e] transition-colors"
            >
              <Zap className="w-2.5 h-2.5" />
              {showSignals ? "Hide signals" : "Show signals"}
              {showSignals ? <ChevronUp className="w-2.5 h-2.5" /> : <ChevronDown className="w-2.5 h-2.5" />}
            </button>
          </div>
        </div>

        {/* ── Empty / loading ───────────────────────────────────────────── */}
        {isLoading && (
          <div className="flex items-center justify-center py-20">
            <div className="text-[#484f58] text-xs uppercase tracking-widest animate-pulse">Loading…</div>
          </div>
        )}

        {!isLoading && tokens.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <Flame className="w-8 h-8 text-[#30363d]" />
            <div className="text-[#484f58] text-xs uppercase tracking-widest">No tokens scored yet</div>
            <div className="text-[#30363d] text-[10px] max-w-xs text-center">
              Caller scores are computed on every holder snapshot. Check back once the pipeline runs a cycle.
            </div>
          </div>
        )}

        {/* ── Mobile list ───────────────────────────────────────────────── */}
        {!isLoading && tokens.length > 0 && (
          <>
            {/* Mobile */}
            <div className="md:hidden">
              {tokens.map(token => (
                <MobileCallerCard
                  key={token.id}
                  token={token}
                  onClick={() => navigate(`/tokens/${token.id}`)}
                />
              ))}
            </div>

            {/* Desktop table */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="border-b border-[#30363d] bg-[#161b22] sticky top-0">
                    <th className="px-3 py-2.5 text-left text-[9px] font-bold uppercase tracking-widest text-[#484f58] w-8">#</th>
                    <th className="px-3 py-2.5 text-left text-[9px] font-bold uppercase tracking-widest text-[#484f58]">Score</th>
                    <th className="px-3 py-2.5 text-left text-[9px] font-bold uppercase tracking-widest text-[#484f58]">Token</th>
                    <th className="px-3 py-2.5 text-left text-[9px] font-bold uppercase tracking-widest text-[#484f58]">Call</th>
                    <th className="px-3 py-2.5 text-left text-[9px] font-bold uppercase tracking-widest text-[#484f58]">Phase</th>
                    <th className="px-3 py-2.5 text-right text-[9px] font-bold uppercase tracking-widest text-[#484f58]">Snaps</th>
                    <th className="px-3 py-2.5 text-right text-[9px] font-bold uppercase tracking-widest text-[#484f58]">MC</th>
                    <th className="px-3 py-2.5 text-right text-[9px] font-bold uppercase tracking-widest text-[#484f58]">Gain</th>
                    <th className="px-3 py-2.5 text-right text-[9px] font-bold uppercase tracking-widest text-[#484f58]">ATH%</th>
                    {showSignals && <>
                      <th className="px-3 py-2.5 text-right text-[9px] font-bold uppercase tracking-widest text-[#484f58]">ATH Gap</th>
                      <th className="px-3 py-2.5 text-right text-[9px] font-bold uppercase tracking-widest text-[#484f58]">MC Growth</th>
                      <th className="px-3 py-2.5 text-right text-[9px] font-bold uppercase tracking-widest text-[#484f58]">Holder Vel</th>
                      <th className="px-3 py-2.5 text-right text-[9px] font-bold uppercase tracking-widest text-[#484f58]">KOL/Smart</th>
                      <th className="px-3 py-2.5 text-right text-[9px] font-bold uppercase tracking-widest text-[#484f58]">Top10%</th>
                    </>}
                    <th className="px-3 py-2.5 text-right text-[9px] font-bold uppercase tracking-widest text-[#484f58]">KOL</th>
                    <th className="px-3 py-2.5 text-right text-[9px] font-bold uppercase tracking-widest text-[#484f58]">Smart</th>
                    <th className="px-3 py-2.5 text-right text-[9px] font-bold uppercase tracking-widest text-[#484f58]">Age</th>
                    <th className="px-3 py-2.5 text-[9px] font-bold uppercase tracking-widest text-[#484f58]"></th>
                  </tr>
                </thead>
                <tbody>
                  {tokens.map((token, i) => (
                    <tr
                      key={token.id}
                      className="border-b border-[#21262d] hover:bg-[#161b22] cursor-pointer transition-colors group"
                      onClick={() => navigate(`/tokens/${token.id}`)}
                    >
                      {/* Rank */}
                      <td className="px-3 py-2.5 text-[#484f58] tabular-nums text-right">{i + 1}</td>

                      {/* Score ring */}
                      <td className="px-3 py-2.5">
                        <CallerScoreRing score={token.callerScore} label={token.callerLabel} />
                      </td>

                      {/* Token */}
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-2 min-w-0">
                          <TokenLogo logoUri={token.logoUri} address={token.address} symbol={token.symbol} />
                          <div className="min-w-0">
                            <div className="text-[#f59e0b] font-bold truncate">{safeSymbol(token.symbol, token.address)}</div>
                            <div className="text-[#484f58] text-[10px] truncate">{safeName(token.name, token.symbol, token.address)}</div>
                          </div>
                        </div>
                      </td>

                      {/* Call label */}
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        <span className={cn("text-[9px] font-bold px-1.5 py-0.5 border tracking-widest", labelStyle(token.callerLabel))}>
                          {token.callerLabel}
                        </span>
                      </td>

                      {/* Phase */}
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        <span className={cn("text-[9px] px-1.5 py-0.5 border", phaseStyle(token.callerPhase))}>
                          {token.callerPhase}
                        </span>
                      </td>

                      {/* Snapshot count */}
                      <td className="px-3 py-2.5 text-right tabular-nums">
                        <span className={cn(
                          "font-bold",
                          token.holderSnapshotCount >= 5 ? "text-[#60a5fa]" : "text-[#8b949e]",
                        )}>
                          {token.holderSnapshotCount}
                        </span>
                      </td>

                      {/* MC */}
                      <td className="px-3 py-2.5 text-right tabular-nums text-[#c9d1d9]">
                        {formatCompactUsd(token.marketCapUsd)}
                      </td>

                      {/* Gain */}
                      <td className={cn("px-3 py-2.5 text-right tabular-nums font-bold", gainColor(token.gainPct))}>
                        {formatGain(token.gainPct)}
                      </td>

                      {/* ATH gain */}
                      <td className={cn("px-3 py-2.5 text-right tabular-nums font-bold", gainColor(token.athGainPct))}>
                        {formatGain(token.athGainPct)}
                      </td>

                      {/* Signal sub-columns (toggle) */}
                      {showSignals && <>
                        <td className="px-3 py-2.5 text-right tabular-nums text-[#8b949e]">
                          {token.athGap != null ? `${token.athGap.toFixed(0)}%` : "—"}
                        </td>
                        <td className="px-3 py-2.5">
                          {scoreBar(token.mcGrowthScore, "#22c55e")}
                        </td>
                        <td className="px-3 py-2.5">
                          {scoreBar(token.holderVelocityScore, "#60a5fa")}
                        </td>
                        <td className="px-3 py-2.5">
                          {scoreBar(token.kolSmartScore, "#f59e0b")}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-[#8b949e]">
                          {token.holderTop10Pct > 0 ? `${token.holderTop10Pct.toFixed(1)}%` : "—"}
                        </td>
                      </>}

                      {/* KOL / Smart */}
                      <td className="px-3 py-2.5 text-right tabular-nums">
                        {token.holderKolCount > 0
                          ? <span className="text-[#f59e0b] font-bold">{token.holderKolCount}</span>
                          : <span className="text-[#30363d]">—</span>}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">
                        {token.holderSmartCount > 0
                          ? <span className="text-[#60a5fa] font-bold">{token.holderSmartCount}</span>
                          : <span className="text-[#30363d]">—</span>}
                      </td>

                      {/* Age */}
                      <td className="px-3 py-2.5 text-right text-[#484f58] whitespace-nowrap">
                        <LiveAge dateStr={token.firstDetectedAt} />
                      </td>

                      {/* GMGN link */}
                      <td className="px-3 py-2.5" onClick={e => e.stopPropagation()}>
                        <a
                          href={getGmgnUrl(token.chain, token.address)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[#30363d] hover:text-[#8b949e] opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
