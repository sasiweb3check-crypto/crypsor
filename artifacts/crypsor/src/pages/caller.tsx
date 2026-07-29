import { useState, useMemo } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  Copy, ExternalLink, Zap, TrendingUp, Users, Star,
  Radio, AlertTriangle, CheckCircle2, Sparkles, ChevronUp, ChevronDown,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  cn, truncateAddress, formatCompactUsd, formatGain, formatTimeAgo,
  getGmgnUrl, safeSymbol, safeName,
} from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────────

type FactorTag =
  | "GOOD_MOMENTUM" | "GOOD_LIQUIDITY" | "GOOD_SMART_MONEY"
  | "SURPRISE_ACCUMULATION" | "SURPRISE_HOLDER_SURGE"
  | "DUMP_LIQUIDITY_DRAIN" | "DUMP_HOLDER_EXODUS" | "DUMP_STALE_PUMP";

interface CallerToken {
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
  athMarketCapUsd: number | null;
  calledAtMcUsd: number | null;
  gainPct: number | null;
  athGainPct: number | null;
  holderCount: number | null;
  holderKolCount: number | null;
  holderSmartCount: number | null;
  intelligenceScore: number | null;
  qualityLabel: string | null;
  compositeScore: number;
  factors: FactorTag[];
  subScores: {
    mcGrowth: number; volIntensity: number; holderVelocity: number;
    kolSmart: number; liquidityHealth: number;
  };
  ageHours: number;
}

interface CallerResponse {
  total: number;
  tokens: CallerToken[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function gainColor(pct: number | null | undefined) {
  if (pct == null) return "text-[#8b949e]";
  if (pct > 0) return "text-[#22c55e]";
  if (pct < 0) return "text-[#ef4444]";
  return "text-[#8b949e]";
}

function fmtGain(pct: number | null | undefined) {
  if (pct == null) return "—";
  const x = (pct / 100) + 1;
  if (x >= 2) return `+${x.toFixed(1)}X`;
  if (pct >= 0) return `+${pct.toFixed(1)}%`;
  return `${pct.toFixed(1)}%`;
}

const FACTOR_META: Record<FactorTag, { label: string; color: string; kind: "good" | "surprise" | "dump" }> = {
  GOOD_MOMENTUM:         { label: "Momentum",     color: "text-[#22c55e] bg-[#22c55e]/10 border-[#22c55e]/25", kind: "good" },
  GOOD_LIQUIDITY:        { label: "Liquidity",    color: "text-[#10b981] bg-[#10b981]/10 border-[#10b981]/25", kind: "good" },
  GOOD_SMART_MONEY:      { label: "Smart Money",  color: "text-[#3b82f6] bg-[#3b82f6]/10 border-[#3b82f6]/25", kind: "good" },
  SURPRISE_ACCUMULATION: { label: "Accumulating", color: "text-[#a78bfa] bg-[#a78bfa]/10 border-[#a78bfa]/25", kind: "surprise" },
  SURPRISE_HOLDER_SURGE: { label: "Holder Surge", color: "text-[#f59e0b] bg-[#f59e0b]/10 border-[#f59e0b]/25", kind: "surprise" },
  DUMP_LIQUIDITY_DRAIN:  { label: "Liq Drain",    color: "text-[#ef4444] bg-[#ef4444]/10 border-[#ef4444]/25", kind: "dump" },
  DUMP_HOLDER_EXODUS:    { label: "Exodus",        color: "text-[#ef4444] bg-[#ef4444]/10 border-[#ef4444]/25", kind: "dump" },
  DUMP_STALE_PUMP:       { label: "Stale Pump",   color: "text-[#f97316] bg-[#f97316]/10 border-[#f97316]/25", kind: "dump" },
};

function alertKind(factors: FactorTag[]): "good" | "surprise" | "dump" | "none" {
  if (factors.some(f => FACTOR_META[f]?.kind === "dump")) return "dump";
  if (factors.some(f => FACTOR_META[f]?.kind === "surprise")) return "surprise";
  if (factors.some(f => FACTOR_META[f]?.kind === "good")) return "good";
  return "none";
}

const ALERT_STYLES = {
  good:     { border: "border-[#22c55e]/20", glow: "shadow-[0_0_12px_rgba(34,197,94,0.07)]",     icon: CheckCircle2,  iconColor: "text-[#22c55e]",  label: "GOOD SETUP",   labelColor: "text-[#22c55e]" },
  surprise: { border: "border-[#a78bfa]/20", glow: "shadow-[0_0_12px_rgba(167,139,250,0.07)]",   icon: Sparkles,      iconColor: "text-[#a78bfa]",  label: "SURPRISE",     labelColor: "text-[#a78bfa]" },
  dump:     { border: "border-[#ef4444]/20", glow: "shadow-[0_0_12px_rgba(239,68,68,0.07)]",     icon: AlertTriangle, iconColor: "text-[#ef4444]",  label: "DUMP WARNING", labelColor: "text-[#ef4444]" },
  none:     { border: "border-[#30363d]",     glow: "",                                             icon: Radio,         iconColor: "text-[#8b949e]",  label: "SIGNAL",       labelColor: "text-[#8b949e]" },
};

function ScoreRing({ score }: { score: number }) {
  const r = 14;
  const circ = 2 * Math.PI * r;
  const filled = (score / 100) * circ;
  const color = score >= 70 ? "#22c55e" : score >= 50 ? "#f59e0b" : score >= 30 ? "#f97316" : "#ef4444";
  return (
    <svg width={36} height={36} viewBox="0 0 36 36" className="shrink-0">
      <circle cx={18} cy={18} r={r} fill="none" stroke="#1f2937" strokeWidth={3} />
      <circle cx={18} cy={18} r={r} fill="none" stroke={color} strokeWidth={3}
        strokeDasharray={`${filled} ${circ}`}
        strokeLinecap="round"
        transform="rotate(-90 18 18)"
        style={{ transition: "stroke-dasharray 0.4s ease" }}
      />
      <text x={18} y={22} textAnchor="middle" fontSize={9} fontWeight="700" fill={color} fontFamily="monospace">
        {Math.round(score)}
      </text>
    </svg>
  );
}

function TokenLogoSmall({ logoUri, address, symbol }: { logoUri?: string | null; address: string; symbol?: string | null }) {
  const [src, setSrc] = useState(logoUri || `https://ui-avatars.com/api/?name=${encodeURIComponent((symbol?.slice(0, 2) || "?"))}&background=1a2030&color=f59e0b&size=40`);
  return (
    <img src={src} alt="" onError={() => setSrc(`https://ui-avatars.com/api/?name=${encodeURIComponent((symbol?.slice(0, 2) || "?"))}&background=1a2030&color=f59e0b&size=40`)}
      className="w-8 h-8 shrink-0 border border-[#30363d] object-cover" />
  );
}

// ── Performer card (top section) ──────────────────────────────────────────────

function PerformerCard({ token, onClick }: { token: CallerToken; onClick: () => void }) {
  const { toast } = useToast();
  const kind = alertKind(token.factors);
  const style = ALERT_STYLES[kind];
  const AlertIcon = style.icon;

  const copyAddress = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(token.address);
    toast({ title: "Copied", description: truncateAddress(token.address) });
  };

  const openGmgn = (e: React.MouseEvent) => {
    e.stopPropagation();
    window.open(getGmgnUrl(token.chain, token.address), "_blank", "noopener");
  };

  return (
    <div
      onClick={onClick}
      className={cn(
        "relative overflow-hidden bg-[#0d1117] border cursor-pointer transition-all duration-150 hover:bg-[#161b22] hover:-translate-y-0.5 active:translate-y-0 p-4 flex flex-col gap-3 min-w-[200px]",
        style.border, style.glow
      )}
    >
      {/* Kind badge */}
      <div className={cn("absolute top-0 right-0 px-2 py-1 text-[8px] font-bold tracking-widest border-b border-l flex items-center gap-1", style.border)}>
        <AlertIcon className={cn("w-2.5 h-2.5", style.iconColor)} />
        <span className={style.labelColor}>{style.label}</span>
      </div>

      {/* Header row */}
      <div className="flex items-start gap-2.5 pr-20">
        <TokenLogoSmall logoUri={token.logoUri} address={token.address} symbol={token.symbol} />
        <div className="flex-1 min-w-0">
          <div className="text-[#c9d1d9] font-bold text-sm leading-none truncate">
            {safeSymbol(token.symbol, token.address)}
          </div>
          <div className="text-[#8b949e] text-[10px] mt-0.5 truncate">{safeName(token.name, token.symbol, token.address)}</div>
          <div className="flex items-center gap-1.5 mt-1.5">
            <span className="text-[#484f58] text-[10px] font-mono">{truncateAddress(token.address)}</span>
            <button onClick={copyAddress} className="text-[#484f58] hover:text-[#f59e0b] transition-colors">
              <Copy className="w-2.5 h-2.5" />
            </button>
            <button onClick={openGmgn} className="text-[#484f58] hover:text-[#f59e0b] transition-colors">
              <ExternalLink className="w-2.5 h-2.5" />
            </button>
          </div>
        </div>
        <ScoreRing score={token.compositeScore} />
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
        <div>
          <div className="text-[9px] text-[#484f58] uppercase tracking-widest">Called at MC</div>
          <div className="text-[#c9d1d9] text-[11px] font-bold tabular-nums">
            {token.calledAtMcUsd ? formatCompactUsd(token.calledAtMcUsd) : "—"}
          </div>
        </div>
        <div>
          <div className="text-[9px] text-[#484f58] uppercase tracking-widest">Current MC</div>
          <div className="text-[#c9d1d9] text-[11px] font-bold tabular-nums">
            {token.marketCapUsd ? formatCompactUsd(token.marketCapUsd) : "—"}
          </div>
        </div>
        <div>
          <div className="text-[9px] text-[#484f58] uppercase tracking-widest">Gain</div>
          <div className={cn("text-[11px] font-bold tabular-nums", gainColor(token.gainPct))}>
            {fmtGain(token.gainPct)}
          </div>
        </div>
        <div>
          <div className="text-[9px] text-[#484f58] uppercase tracking-widest">ATH</div>
          <div className={cn("text-[11px] font-bold tabular-nums", gainColor(token.athGainPct))}>
            {fmtGain(token.athGainPct)}
          </div>
        </div>
      </div>

      {/* KOL / Smart / Intel row */}
      <div className="flex items-center gap-3 pt-1 border-t border-[#21262d]">
        <div className="flex items-center gap-1">
          <Star className="w-3 h-3 text-[#f59e0b]" />
          <span className="text-[10px] text-[#8b949e]">KOL <span className="text-[#c9d1d9] font-bold">{token.holderKolCount ?? 0}</span></span>
        </div>
        <div className="flex items-center gap-1">
          <Users className="w-3 h-3 text-[#3b82f6]" />
          <span className="text-[10px] text-[#8b949e]">Smart <span className="text-[#c9d1d9] font-bold">{token.holderSmartCount ?? 0}</span></span>
        </div>
        {token.intelligenceScore != null && (
          <div className="ml-auto flex items-center gap-1">
            <Zap className="w-3 h-3 text-[#f59e0b]" />
            <span className="text-[10px] text-[#f59e0b] font-bold">{Math.round(token.intelligenceScore)}</span>
          </div>
        )}
      </div>

      {/* Factor tags */}
      {token.factors.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {token.factors.map(f => (
            <span key={f} className={cn("text-[8px] font-bold px-1.5 py-0.5 border tracking-widest", FACTOR_META[f].color)}>
              {FACTOR_META[f].label.toUpperCase()}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Table row ─────────────────────────────────────────────────────────────────

function TableRow({ token, onClick }: { token: CallerToken; onClick: () => void }) {
  const { toast } = useToast();
  const kind = alertKind(token.factors);
  const style = ALERT_STYLES[kind];

  const copyAddress = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(token.address);
    toast({ title: "Copied" });
  };

  const openGmgn = (e: React.MouseEvent) => {
    e.stopPropagation();
    window.open(getGmgnUrl(token.chain, token.address), "_blank", "noopener");
  };

  return (
    <tr
      onClick={onClick}
      className="border-b border-[#21262d] hover:bg-[#161b22] cursor-pointer transition-colors group"
    >
      {/* Token */}
      <td className="px-4 py-3">
        <div className="flex items-center gap-2.5">
          <TokenLogoSmall logoUri={token.logoUri} address={token.address} symbol={token.symbol} />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-[#c9d1d9] text-xs font-bold truncate">{safeSymbol(token.symbol, token.address)}</span>
              {token.factors.length > 0 && (
                <span className={cn("text-[7px] font-bold px-1 py-px border tracking-widest", style.border, style.labelColor)}>
                  {style.label}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1 mt-0.5">
              <span className="text-[#484f58] text-[10px] font-mono">{truncateAddress(token.address)}</span>
              <button onClick={copyAddress} className="opacity-0 group-hover:opacity-100 text-[#484f58] hover:text-[#f59e0b] transition-all">
                <Copy className="w-2.5 h-2.5" />
              </button>
              <button onClick={openGmgn} className="opacity-0 group-hover:opacity-100 text-[#484f58] hover:text-[#f59e0b] transition-all">
                <ExternalLink className="w-2.5 h-2.5" />
              </button>
            </div>
          </div>
        </div>
      </td>

      {/* Score */}
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <ScoreRing score={token.compositeScore} />
          {token.intelligenceScore != null && (
            <div className="flex items-center gap-1">
              <Zap className="w-3 h-3 text-[#f59e0b] shrink-0" />
              <span className="text-[#f59e0b] text-[11px] font-bold tabular-nums">{Math.round(token.intelligenceScore)}</span>
            </div>
          )}
        </div>
      </td>

      {/* KOL / Smart */}
      <td className="px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="text-[10px]"><span className="text-[#8b949e]">KOL </span><span className="text-[#c9d1d9] font-bold">{token.holderKolCount ?? 0}</span></span>
          <span className="text-[10px]"><span className="text-[#8b949e]">Smart </span><span className="text-[#c9d1d9] font-bold">{token.holderSmartCount ?? 0}</span></span>
        </div>
      </td>

      {/* Called at MC */}
      <td className="px-4 py-3 tabular-nums text-[11px] text-[#c9d1d9] font-mono">
        {token.calledAtMcUsd ? formatCompactUsd(token.calledAtMcUsd) : "—"}
      </td>

      {/* Current MC */}
      <td className="px-4 py-3 tabular-nums text-[11px] text-[#c9d1d9] font-mono">
        {token.marketCapUsd ? formatCompactUsd(token.marketCapUsd) : "—"}
      </td>

      {/* Gain */}
      <td className={cn("px-4 py-3 tabular-nums text-[11px] font-bold", gainColor(token.gainPct))}>
        {fmtGain(token.gainPct)}
      </td>

      {/* ATH Gain */}
      <td className={cn("px-4 py-3 tabular-nums text-[11px] font-bold", gainColor(token.athGainPct))}>
        {fmtGain(token.athGainPct)}
      </td>

      {/* Factors */}
      <td className="px-4 py-3">
        <div className="flex flex-wrap gap-1">
          {token.factors.slice(0, 2).map(f => (
            <span key={f} className={cn("text-[7px] font-bold px-1.5 py-0.5 border tracking-widest", FACTOR_META[f].color)}>
              {FACTOR_META[f].label.toUpperCase()}
            </span>
          ))}
          {token.factors.length > 2 && (
            <span className="text-[7px] text-[#484f58] px-1 py-0.5">+{token.factors.length - 2}</span>
          )}
        </div>
      </td>

      {/* Age */}
      <td className="px-4 py-3 text-[10px] text-[#8b949e]">
        {formatTimeAgo(token.firstDetectedAt)}
      </td>
    </tr>
  );
}

// ── Sort helpers ──────────────────────────────────────────────────────────────

type SortKey = "compositeScore" | "intelligenceScore" | "gainPct" | "athGainPct" | "calledAtMcUsd" | "marketCapUsd";

function SortHeader({ label, field, sort, setSort }: {
  label: string; field: SortKey;
  sort: { key: SortKey; dir: "asc" | "desc" };
  setSort: (s: { key: SortKey; dir: "asc" | "desc" }) => void;
}) {
  const active = sort.key === field;
  return (
    <th
      className={cn(
        "px-4 py-3 text-left text-[9px] uppercase tracking-widest cursor-pointer select-none whitespace-nowrap",
        active ? "text-[#f59e0b]" : "text-[#484f58] hover:text-[#8b949e]",
      )}
      onClick={() => setSort({ key: field, dir: active && sort.dir === "desc" ? "asc" : "desc" })}
    >
      <span className="flex items-center gap-1">
        {label}
        {active ? (
          sort.dir === "desc" ? <ChevronDown className="w-3 h-3" /> : <ChevronUp className="w-3 h-3" />
        ) : null}
      </span>
    </th>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Caller() {
  const [, navigate] = useLocation();
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "compositeScore", dir: "desc" });
  const [filterKind, setFilterKind] = useState<"all" | "good" | "surprise" | "dump">("all");

  const { data, isLoading, error, refetch } = useQuery<CallerResponse>({
    queryKey: ["caller-tokens"],
    queryFn: () => fetch(`${import.meta.env.BASE_URL}api/caller/tokens`).then(r => r.json()),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const tokens = useMemo(() => {
    if (!data?.tokens) return [];
    let list = [...data.tokens];

    // Filter by kind
    if (filterKind !== "all") {
      list = list.filter(t => alertKind(t.factors) === filterKind);
    }

    // Sort
    list.sort((a, b) => {
      const av = (a[sort.key] ?? 0) as number;
      const bv = (b[sort.key] ?? 0) as number;
      return sort.dir === "desc" ? bv - av : av - bv;
    });

    return list;
  }, [data, sort, filterKind]);

  // Top performers: top 5 by compositeScore with factors
  const performers = useMemo(() => {
    if (!data?.tokens) return [];
    return [...data.tokens]
      .filter(t => t.factors.length > 0)
      .sort((a, b) => b.compositeScore - a.compositeScore)
      .slice(0, 5);
  }, [data]);

  const KIND_TABS = [
    { value: "all",      label: "ALL",      count: data?.tokens?.length ?? 0 },
    { value: "good",     label: "GOOD",     count: data?.tokens?.filter(t => alertKind(t.factors) === "good").length ?? 0 },
    { value: "surprise", label: "SURPRISE", count: data?.tokens?.filter(t => alertKind(t.factors) === "surprise").length ?? 0 },
    { value: "dump",     label: "DUMP",     count: data?.tokens?.filter(t => alertKind(t.factors) === "dump").length ?? 0 },
  ] as const;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-[#f59e0b] tracking-widest uppercase flex items-center gap-2">
            <Radio className="w-4 h-4" />
            Caller
          </h1>
          <p className="text-[#484f58] text-[10px] mt-0.5 tracking-widest uppercase">
            Composite score · {data?.total ?? 0} tokens tracked
          </p>
        </div>
        <button
          onClick={() => refetch()}
          className="text-[9px] font-bold uppercase tracking-widest px-3 h-7 border border-[#30363d] text-[#8b949e] hover:text-[#f59e0b] hover:border-[#f59e0b]/40 transition-colors"
        >
          Refresh
        </button>
      </div>

      {/* Top performers */}
      {performers.length > 0 && (
        <div>
          <div className="text-[9px] text-[#484f58] uppercase tracking-widest mb-2 flex items-center gap-1.5">
            <TrendingUp className="w-3 h-3 text-[#f59e0b]" />
            Top Performers
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            {performers.map(t => (
              <PerformerCard key={t.id} token={t} onClick={() => navigate(`/tokens/${t.id}`)} />
            ))}
          </div>
        </div>
      )}

      {/* Filter tabs + table */}
      <div className="border border-[#30363d] bg-[#0d1117] overflow-hidden">
        {/* Tab bar */}
        <div className="flex items-center border-b border-[#30363d] overflow-x-auto">
          {KIND_TABS.map(tab => (
            <button
              key={tab.value}
              onClick={() => setFilterKind(tab.value as typeof filterKind)}
              className={cn(
                "flex items-center gap-1.5 px-4 py-3 text-[9px] font-bold uppercase tracking-widest whitespace-nowrap border-b-2 transition-colors",
                filterKind === tab.value
                  ? "border-[#f59e0b] text-[#f59e0b]"
                  : "border-transparent text-[#484f58] hover:text-[#8b949e]",
              )}
            >
              {tab.label}
              <span className={cn(
                "text-[8px] px-1.5 py-0.5 rounded-sm font-mono",
                filterKind === tab.value ? "bg-[#f59e0b]/15 text-[#f59e0b]" : "bg-[#1f2937] text-[#484f58]",
              )}>
                {tab.count}
              </span>
            </button>
          ))}
        </div>

        {/* Table */}
        {isLoading ? (
          <div className="p-8 text-center text-[#484f58] text-xs tracking-widest uppercase">Loading…</div>
        ) : error ? (
          <div className="p-8 text-center text-[#ef4444] text-xs">Failed to load caller data.</div>
        ) : tokens.length === 0 ? (
          <div className="p-12 text-center">
            <Radio className="w-8 h-8 text-[#30363d] mx-auto mb-3" />
            <div className="text-[#484f58] text-xs tracking-widest uppercase">No tokens scored yet</div>
            <div className="text-[#30363d] text-[10px] mt-1">Tokens appear here once the intelligence engine runs</div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-[#21262d]">
                  <th className="px-4 py-3 text-left text-[9px] text-[#484f58] uppercase tracking-widest">Token</th>
                  <SortHeader label="Score" field="compositeScore" sort={sort} setSort={setSort} />
                  <th className="px-4 py-3 text-left text-[9px] text-[#484f58] uppercase tracking-widest">KOL / Smart</th>
                  <SortHeader label="Called at MC" field="calledAtMcUsd" sort={sort} setSort={setSort} />
                  <SortHeader label="Current MC" field="marketCapUsd" sort={sort} setSort={setSort} />
                  <SortHeader label="Gain" field="gainPct" sort={sort} setSort={setSort} />
                  <SortHeader label="ATH Gain" field="athGainPct" sort={sort} setSort={setSort} />
                  <th className="px-4 py-3 text-left text-[9px] text-[#484f58] uppercase tracking-widest">Signal</th>
                  <th className="px-4 py-3 text-left text-[9px] text-[#484f58] uppercase tracking-widest">Age</th>
                </tr>
              </thead>
              <tbody>
                {tokens.map(t => (
                  <TableRow key={t.id} token={t} onClick={() => navigate(`/tokens/${t.id}`)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
