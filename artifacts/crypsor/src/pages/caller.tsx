import { useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  Copy, ExternalLink, Radio, Zap, Star, Users,
  ToggleLeft, ToggleRight, TrendingUp, Clock,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  cn, truncateAddress, formatCompactUsd, formatTimeAgo,
  getGmgnUrl, safeSymbol, safeName,
} from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────────

type SignalKey =
  | "intel_score" | "kol_smart" | "holder_velocity"
  | "low_mc" | "ath_gap" | "distributed";

interface RunnerToken {
  id: number;
  address: string;
  chain: string;
  name: string | null;
  symbol: string | null;
  logoUri: string | null;
  status: string;
  firstDetectedAt: string;
  detectedPriceUsd: string | null;
  currentPriceUsd: string | null;
  marketCapUsd: number | null;
  calledAtMcUsd: number | null;
  gainPct: number | null;
  athGainPct: number | null;
  holderCount: number | null;
  holderKolCount: number | null;
  holderSmartCount: number | null;
  top10Pct: number | null;
  intelligenceScore: number | null;
  qualityLabel: string | null;
  kolSmartScore: number | null;
  holderVelocityScore: number | null;
  snapshotCount: number;
  runnerScore: number;
  signals: SignalKey[];
}

interface CallerResponse {
  total: number;
  useAgeBased: boolean;
  tokens: RunnerToken[];
}

// ── Signal config ─────────────────────────────────────────────────────────────

const SIGNAL_META: Record<SignalKey, { label: string; pts: number; color: string }> = {
  intel_score:      { label: "Intel >75",       pts: 38, color: "#f59e0b" },
  kol_smart:        { label: "KOL/Smart >45",   pts: 32, color: "#a78bfa" },
  holder_velocity:  { label: "Velocity >75",    pts: 22, color: "#3b82f6" },
  low_mc:           { label: "MC <$15K",         pts: 18, color: "#10b981" },
  ath_gap:          { label: "ATH Gap >120%",   pts: 15, color: "#f97316" },
  distributed:      { label: "Top10 <68%",       pts: 12, color: "#22c55e" },
};

const CORE_SIGNALS: SignalKey[]    = ["intel_score", "kol_smart", "holder_velocity", "low_mc"];
const AGE_SIGNALS:  SignalKey[]    = ["ath_gap", "distributed"];
const MAX_CORE = 38 + 32 + 22 + 18;          // 110
const MAX_AGE  = 15 + 12;                     // 27

// ── Score tier ────────────────────────────────────────────────────────────────

function tier(score: number) {
  if (score >= 90) return { label: "STRONG RUNNER", color: "#22c55e",  bg: "bg-[#22c55e]/8",  border: "border-[#22c55e]/25" };
  if (score >= 70) return { label: "RUNNER",         color: "#f59e0b",  bg: "bg-[#f59e0b]/8",  border: "border-[#f59e0b]/25" };
  if (score >= 50) return { label: "WATCH",          color: "#3b82f6",  bg: "bg-[#3b82f6]/8",  border: "border-[#3b82f6]/25" };
  return                   { label: "WEAK",          color: "#8b949e",  bg: "bg-transparent",   border: "border-[#30363d]" };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function gainColor(pct: number | null | undefined) {
  if (pct == null) return "text-[#484f58]";
  if (pct > 0) return "text-[#22c55e]";
  if (pct < 0) return "text-[#ef4444]";
  return "text-[#8b949e]";
}

function fmtX(pct: number | null | undefined) {
  if (pct == null) return "—";
  const x = pct / 100 + 1;
  if (x >= 2) return `+${x.toFixed(1)}X`;
  if (pct >= 0) return `+${pct.toFixed(1)}%`;
  return `${pct.toFixed(1)}%`;
}

function TokenLogo({ logoUri, address, symbol }: {
  logoUri?: string | null; address: string; symbol?: string | null;
}) {
  const fallback = `https://ui-avatars.com/api/?name=${encodeURIComponent(
    (symbol?.slice(0, 2) || "?").replace(/[^\x00-\x7F]/g, "") || "?"
  )}&background=161b22&color=f59e0b&size=40&bold=true`;
  const [src, setSrc] = useState(logoUri || fallback);
  return (
    <img
      src={src}
      alt=""
      onError={() => setSrc(fallback)}
      className="w-9 h-9 shrink-0 border border-[#21262d] object-cover"
    />
  );
}

// ── Score bar ─────────────────────────────────────────────────────────────────

function ScoreBar({ score, color }: { score: number; color: string }) {
  return (
    <div className="flex items-center gap-2 w-full">
      <div className="flex-1 h-1 bg-[#21262d] overflow-hidden">
        <div
          className="h-full transition-all duration-500"
          style={{ width: `${score}%`, backgroundColor: color }}
        />
      </div>
      <span
        className="text-sm font-black tabular-nums leading-none shrink-0 w-8 text-right"
        style={{ color }}
      >
        {score}
      </span>
    </div>
  );
}

// ── Runner card ───────────────────────────────────────────────────────────────

function RunnerCard({ token, useAgeBased, onClick }: {
  token: RunnerToken;
  useAgeBased: boolean;
  onClick: () => void;
}) {
  const { toast } = useToast();
  const t = tier(token.runnerScore);

  const copy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(token.address);
    toast({ title: "Copied", description: truncateAddress(token.address) });
  };
  const gmgn = (e: React.MouseEvent) => {
    e.stopPropagation();
    window.open(getGmgnUrl(token.chain, token.address), "_blank", "noopener");
  };

  const coreHit  = token.signals.filter(s => CORE_SIGNALS.includes(s));
  const ageHit   = token.signals.filter(s => AGE_SIGNALS.includes(s));
  const allHit   = [...coreHit, ...ageHit];

  return (
    <div
      onClick={onClick}
      className={cn(
        "group relative flex flex-col gap-3 p-4 border cursor-pointer",
        "bg-[#0d1117] hover:bg-[#0f1419] transition-colors duration-100",
        t.border,
      )}
    >
      {/* Tier badge */}
      <div className="absolute top-3 right-3 text-[8px] font-black tracking-widest"
        style={{ color: t.color }}>
        {t.label}
      </div>

      {/* Token header */}
      <div className="flex items-center gap-2.5 pr-20">
        <TokenLogo logoUri={token.logoUri} address={token.address} symbol={token.symbol} />
        <div className="flex-1 min-w-0">
          <div className="text-[#e6edf3] font-bold text-sm truncate leading-tight">
            {safeSymbol(token.symbol, token.address)}
          </div>
          <div className="text-[#484f58] text-[10px] truncate mt-0.5">
            {safeName(token.name, token.symbol, token.address)}
          </div>
        </div>
      </div>

      {/* Score bar */}
      <ScoreBar score={token.runnerScore} color={t.color} />

      {/* Signal chips */}
      <div className="flex flex-wrap gap-1">
        {allHit.map(s => (
          <span
            key={s}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[8px] font-bold tracking-wider border"
            style={{
              color:            SIGNAL_META[s].color,
              borderColor:      SIGNAL_META[s].color + "40",
              backgroundColor:  SIGNAL_META[s].color + "12",
            }}
          >
            +{SIGNAL_META[s].pts} {SIGNAL_META[s].label}
          </span>
        ))}
        {useAgeBased && token.snapshotCount < 3 && ageHit.length === 0 && (
          <span className="text-[8px] text-[#30363d] italic">
            age signals need {3 - token.snapshotCount} more snaps
          </span>
        )}
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 pt-1 border-t border-[#1c2128]">
        <div>
          <div className="text-[8px] text-[#484f58] uppercase tracking-widest">Called MC</div>
          <div className="text-[#c9d1d9] text-[11px] font-bold tabular-nums">
            {token.calledAtMcUsd ? formatCompactUsd(token.calledAtMcUsd) : "—"}
          </div>
        </div>
        <div>
          <div className="text-[8px] text-[#484f58] uppercase tracking-widest">Current MC</div>
          <div className="text-[#c9d1d9] text-[11px] font-bold tabular-nums">
            {token.marketCapUsd ? formatCompactUsd(token.marketCapUsd) : "—"}
          </div>
        </div>
        <div>
          <div className="text-[8px] text-[#484f58] uppercase tracking-widest">Gain</div>
          <div className={cn("text-[11px] font-bold tabular-nums", gainColor(token.gainPct))}>
            {fmtX(token.gainPct)}
          </div>
        </div>
        <div>
          <div className="text-[8px] text-[#484f58] uppercase tracking-widest">ATH</div>
          <div className={cn("text-[11px] font-bold tabular-nums", gainColor(token.athGainPct))}>
            {fmtX(token.athGainPct)}
          </div>
        </div>
      </div>

      {/* Footer row */}
      <div className="flex items-center justify-between pt-1 border-t border-[#1c2128]">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1 text-[9px] text-[#8b949e]">
            <Star className="w-2.5 h-2.5 text-[#f59e0b]" />
            KOL <span className="text-[#c9d1d9] font-bold ml-0.5">{token.holderKolCount ?? 0}</span>
          </span>
          <span className="flex items-center gap-1 text-[9px] text-[#8b949e]">
            <Users className="w-2.5 h-2.5 text-[#3b82f6]" />
            Smart <span className="text-[#c9d1d9] font-bold ml-0.5">{token.holderSmartCount ?? 0}</span>
          </span>
          {token.intelligenceScore != null && (
            <span className="flex items-center gap-1 text-[9px]">
              <Zap className="w-2.5 h-2.5 text-[#f59e0b]" />
              <span className="text-[#f59e0b] font-bold">{Math.round(token.intelligenceScore)}</span>
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <span className="text-[9px] text-[#484f58]">
            <Clock className="w-2.5 h-2.5 inline mr-0.5" />
            {formatTimeAgo(token.firstDetectedAt)}
          </span>
          <button
            onClick={copy}
            title="Copy address"
            className="text-[#30363d] hover:text-[#f59e0b] transition-colors"
          >
            <Copy className="w-3 h-3" />
          </button>
          <button
            onClick={gmgn}
            title="Open on GMGN"
            className="text-[#30363d] hover:text-[#f59e0b] transition-colors"
          >
            <ExternalLink className="w-3 h-3" />
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function Caller() {
  const [, navigate]     = useLocation();
  const [ageBased, setAgeBased] = useState(true);

  const { data, isLoading, error } = useQuery<CallerResponse>({
    queryKey: ["caller-tokens", ageBased],
    queryFn:  () =>
      fetch(`${import.meta.env.BASE_URL}api/caller/tokens?ageBased=${ageBased}`)
        .then(r => r.json()),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const tokens = data?.tokens ?? [];
  const strong  = tokens.filter(t => t.runnerScore >= 90);
  const runner  = tokens.filter(t => t.runnerScore >= 70 && t.runnerScore < 90);
  const watch   = tokens.filter(t => t.runnerScore >= 50 && t.runnerScore < 70);
  const weak    = tokens.filter(t => t.runnerScore < 50);

  return (
    <div className="space-y-6">

      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-bold text-[#f59e0b] tracking-widest uppercase flex items-center gap-2">
            <Radio className="w-4 h-4" />
            Caller
          </h1>
          <p className="text-[#484f58] text-[10px] mt-0.5 tracking-widest uppercase">
            Runner potential · {data?.total ?? 0} scored tokens
          </p>
        </div>

        {/* Age-scoring toggle */}
        <button
          onClick={() => setAgeBased(v => !v)}
          className={cn(
            "flex items-center gap-2 px-3 h-8 border text-[9px] font-bold uppercase tracking-widest transition-colors shrink-0",
            ageBased
              ? "border-[#f59e0b]/40 bg-[#f59e0b]/8 text-[#f59e0b]"
              : "border-[#30363d] bg-transparent text-[#484f58] hover:text-[#8b949e]",
          )}
        >
          {ageBased
            ? <ToggleRight className="w-4 h-4" />
            : <ToggleLeft  className="w-4 h-4" />}
          Age Signals
        </button>
      </div>

      {/* ── Score legend ──────────────────────────────────────────────────── */}
      <div className="flex flex-wrap gap-3">
        {[
          { label: "Core signals",    items: CORE_SIGNALS },
          { label: "Age signals",     items: AGE_SIGNALS,  dim: !ageBased },
        ].map(group => (
          <div key={group.label} className={cn("flex items-center gap-2 flex-wrap", group.dim && "opacity-30")}>
            <span className="text-[8px] text-[#484f58] uppercase tracking-widest whitespace-nowrap">{group.label}:</span>
            {group.items.map(s => (
              <span
                key={s}
                className="text-[8px] font-bold px-1.5 py-0.5 border tracking-wider"
                style={{
                  color:           SIGNAL_META[s].color,
                  borderColor:     SIGNAL_META[s].color + "35",
                  backgroundColor: SIGNAL_META[s].color + "10",
                }}
              >
                +{SIGNAL_META[s].pts} {SIGNAL_META[s].label}
              </span>
            ))}
          </div>
        ))}
      </div>

      {/* ── Loading / error ────────────────────────────────────────────────── */}
      {isLoading && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-52 bg-[#0d1117] border border-[#1c2128] animate-pulse" />
          ))}
        </div>
      )}

      {error && (
        <div className="p-8 text-center text-[#ef4444] text-xs border border-[#ef4444]/20 bg-[#ef4444]/5">
          Failed to load runner signals.
        </div>
      )}

      {!isLoading && !error && tokens.length === 0 && (
        <div className="p-16 text-center border border-[#1c2128]">
          <Radio className="w-8 h-8 text-[#21262d] mx-auto mb-3" />
          <div className="text-[#484f58] text-xs tracking-widest uppercase">No runners scored yet</div>
          <div className="text-[#30363d] text-[9px] mt-1">
            Tokens appear here once the intelligence engine runs
          </div>
        </div>
      )}

      {/* ── Sections ──────────────────────────────────────────────────────── */}
      {[
        { label: "Strong Runners",  color: "#22c55e", tokens: strong },
        { label: "Runners",         color: "#f59e0b", tokens: runner },
        { label: "Watch",           color: "#3b82f6", tokens: watch  },
        { label: "Weak",            color: "#8b949e", tokens: weak   },
      ].filter(s => s.tokens.length > 0).map(section => (
        <div key={section.label} className="space-y-2">
          <div className="flex items-center gap-2">
            <TrendingUp className="w-3 h-3" style={{ color: section.color }} />
            <span
              className="text-[9px] font-bold uppercase tracking-widest"
              style={{ color: section.color }}
            >
              {section.label}
            </span>
            <span className="text-[9px] text-[#30363d] font-mono">{section.tokens.length}</span>
            <div className="flex-1 h-px bg-[#1c2128]" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {section.tokens.map(t => (
              <RunnerCard
                key={t.id}
                token={t}
                useAgeBased={ageBased}
                onClick={() => navigate(`/tokens/${t.id}`)}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
