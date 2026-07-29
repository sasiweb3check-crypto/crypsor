import { useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  Copy, ExternalLink, Radio, TrendingUp,
  Star, Users, Zap, Clock, ArrowUpDown, Flame,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  cn, truncateAddress, formatCompactUsd, formatTimeAgo,
  getGmgnUrl, safeSymbol, safeName,
} from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────────

interface HistoryToken {
  id: number;
  address: string;
  chain: string;
  name: string | null;
  symbol: string | null;
  logoUri: string | null;
  status: string;
  calledAt: string;
  calledMcUsd: number | null;
  calledIntel: number;
  calledKol: number;
  calledSmart: number;
  currentMcUsd: number | null;
  gainSinceCall: number | null;
  athGainPct: number | null;
  qualityLabel: string | null;
  intelligenceScore: number | null;
  holderKolCount: number | null;
  holderSmartCount: number | null;
}

// ── Quality label config ──────────────────────────────────────────────────────

const QUALITY: Record<string, { color: string; bg: string }> = {
  Elite:      { color: "#f59e0b", bg: "bg-[#f59e0b]/10" },
  Excellent:  { color: "#22c55e", bg: "bg-[#22c55e]/10" },
  Strong:     { color: "#3b82f6", bg: "bg-[#3b82f6]/10" },
  Good:       { color: "#8b5cf6", bg: "bg-[#8b5cf6]/10" },
  Average:    { color: "#8b949e", bg: "bg-[#8b949e]/10" },
  Speculative:{ color: "#f97316", bg: "bg-[#f97316]/10" },
  Weak:       { color: "#484f58", bg: "bg-[#484f58]/10" },
};

function QualityBadge({ label }: { label: string | null }) {
  if (!label) return null;
  const q = QUALITY[label] ?? { color: "#484f58", bg: "bg-[#484f58]/10" };
  return (
    <span
      className={cn("inline-flex items-center px-1.5 py-0.5 text-[9px] font-black tracking-widest uppercase", q.bg)}
      style={{ color: q.color }}
    >
      {label}
    </span>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function gainColor(v: number | null | undefined) {
  if (v == null) return "text-[#484f58]";
  if (v > 0) return "text-[#22c55e]";
  if (v < 0) return "text-[#ef4444]";
  return "text-[#8b949e]";
}

function fmtGain(pct: number | null | undefined) {
  if (pct == null) return "—";
  const x = pct / 100 + 1;
  if (x >= 2) return `+${x.toFixed(1)}×`;
  if (pct >= 0) return `+${pct.toFixed(1)}%`;
  return `${pct.toFixed(1)}%`;
}

function TokenLogo({ logoUri, address, symbol }: {
  logoUri?: string | null; address: string; symbol?: string | null;
}) {
  const fallback = `https://ui-avatars.com/api/?name=${encodeURIComponent(
    (symbol?.slice(0, 2) || "?").replace(/[^\x00-\x7F]/g, "") || "?"
  )}&background=0d1117&color=f59e0b&size=40&bold=true`;
  const [src, setSrc] = useState(logoUri || fallback);
  return (
    <img src={src} alt="" onError={() => setSrc(fallback)}
      className="w-8 h-8 shrink-0 rounded-sm object-cover border border-[#21262d]" />
  );
}

// ── Top performer card ────────────────────────────────────────────────────────

function PerformerCard({ token, rank, onClick }: {
  token: HistoryToken; rank: number; onClick: () => void;
}) {
  const { toast } = useToast();
  const q = QUALITY[token.qualityLabel ?? ""] ?? { color: "#484f58", bg: "" };
  const gain = token.gainSinceCall;
  const isHot = (gain ?? 0) >= 500;

  const copy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(token.address);
    toast({ title: "Copied", description: truncateAddress(token.address) });
  };
  const gmgn = (e: React.MouseEvent) => {
    e.stopPropagation();
    window.open(getGmgnUrl(token.chain, token.address), "_blank", "noopener");
  };

  return (
    <div
      onClick={onClick}
      className="group flex flex-col gap-0 border border-[#21262d] hover:border-[#30363d] bg-[#0d1117] hover:bg-[#0f1419] transition-colors cursor-pointer overflow-hidden"
    >
      {/* Gain accent bar */}
      <div className="h-0.5 w-full" style={{ backgroundColor: gain && gain > 0 ? "#22c55e" : "#484f58", opacity: 0.5 }} />

      <div className="p-3.5 flex flex-col gap-3">
        {/* Header */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="relative shrink-0">
              <TokenLogo logoUri={token.logoUri} address={token.address} symbol={token.symbol} />
              {rank <= 3 && (
                <span className="absolute -top-1 -left-1 text-[8px] font-black leading-none w-3.5 h-3.5 flex items-center justify-center rounded-full"
                  style={{ backgroundColor: rank === 1 ? "#f59e0b" : rank === 2 ? "#8b949e" : "#cd7f32", color: "#000" }}>
                  {rank}
                </span>
              )}
            </div>
            <div className="min-w-0">
              <div className="text-[#e6edf3] font-bold text-sm truncate leading-tight flex items-center gap-1">
                {safeSymbol(token.symbol, token.address)}
                {isHot && <Flame className="w-3 h-3 text-[#f59e0b] shrink-0" />}
              </div>
              <div className="text-[#484f58] text-[10px] truncate mt-0.5">
                {safeName(token.name, token.symbol, token.address)}
              </div>
            </div>
          </div>
          {/* Gain */}
          <div className="shrink-0 text-right">
            <div className={cn("text-lg font-black tabular-nums leading-none", gainColor(gain))}>
              {fmtGain(gain)}
            </div>
            <div className="text-[8px] text-[#484f58] tracking-widest mt-0.5">GAIN</div>
          </div>
        </div>

        {/* Quality + KOL/Smart */}
        <div className="flex items-center gap-2">
          <QualityBadge label={token.qualityLabel} />
          <div className="flex-1" />
          {token.calledKol > 0 && (
            <span className="flex items-center gap-1 text-[9px]">
              <Star className="w-2.5 h-2.5 text-[#f59e0b]" />
              <span className="text-[#f59e0b] font-bold">{token.calledKol}</span>
            </span>
          )}
          {token.calledSmart > 0 && (
            <span className="flex items-center gap-1 text-[9px]">
              <Users className="w-2.5 h-2.5 text-[#3b82f6]" />
              <span className="text-[#3b82f6] font-bold">{token.calledSmart}</span>
            </span>
          )}
        </div>

        {/* MC row */}
        <div className="flex items-center justify-between pt-2.5 border-t border-[#1c2128]">
          <div>
            <div className="text-[8px] text-[#484f58] uppercase tracking-widest mb-0.5">Called at</div>
            <div className="text-[#8b949e] text-[10px] font-mono tabular-nums">
              {token.calledMcUsd ? formatCompactUsd(token.calledMcUsd) : "—"}
            </div>
          </div>
          <div className="text-[#30363d]">→</div>
          <div className="text-right">
            <div className="text-[8px] text-[#484f58] uppercase tracking-widest mb-0.5">Now</div>
            <div className="text-[#c9d1d9] text-[10px] font-mono tabular-nums font-bold">
              {token.currentMcUsd ? formatCompactUsd(token.currentMcUsd) : "—"}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1 text-[9px] text-[#484f58]">
            <Zap className="w-2.5 h-2.5" style={{ color: q.color }} />
            <span style={{ color: q.color }}>{Math.round(token.calledIntel)}</span>
            <span className="text-[#30363d] ml-1">
              <Clock className="w-2.5 h-2.5 inline mr-0.5" />
              {formatTimeAgo(token.calledAt)}
            </span>
          </span>
          <div className="flex items-center gap-2">
            <button onClick={copy} title="Copy CA"
              className="text-[#30363d] hover:text-[#f59e0b] transition-colors">
              <Copy className="w-3.5 h-3.5" />
            </button>
            <button onClick={gmgn} title="Open GMGN"
              className="text-[#30363d] hover:text-[#f59e0b] transition-colors">
              <ExternalLink className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Called tokens table ───────────────────────────────────────────────────────

type SortKey = "calledAt" | "quality" | "gain" | "intel" | "calledMc";

function SortButton({ label, active, asc, onClick }: {
  label: string; active: boolean; asc: boolean; onClick: () => void;
}) {
  return (
    <button onClick={onClick}
      className={cn(
        "flex items-center gap-1 text-[9px] font-bold uppercase tracking-widest px-2 py-1 border transition-colors",
        active
          ? "border-[#f59e0b]/40 bg-[#f59e0b]/8 text-[#f59e0b]"
          : "border-[#21262d] text-[#484f58] hover:text-[#8b949e] hover:border-[#30363d]",
      )}>
      <ArrowUpDown className="w-2.5 h-2.5" />
      {label}
      {active && <span className="text-[7px]">{asc ? "↑" : "↓"}</span>}
    </button>
  );
}

function CalledTable({ tokens, onNavigate }: { tokens: HistoryToken[]; onNavigate: (id: number) => void }) {
  const { toast } = useToast();

  if (tokens.length === 0) return (
    <div className="p-10 text-center border border-[#1c2128] text-[#484f58] text-xs tracking-widest uppercase">
      No tokens called yet
    </div>
  );

  return (
    <div className="border border-[#21262d] overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-[#21262d]">
            {["Token", "Quality", "Intel", "KOL / Smart", "MC Called", "MC Now", "Gain", ""].map(h => (
              <th key={h} className="px-3 py-2.5 text-left text-[8px] font-bold uppercase tracking-widest text-[#484f58] whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {tokens.map((t, i) => {
            const q = QUALITY[t.qualityLabel ?? ""] ?? { color: "#484f58", bg: "" };
            return (
              <tr key={t.id} onClick={() => onNavigate(t.id)}
                className={cn(
                  "border-b border-[#1c2128] last:border-0 cursor-pointer transition-colors",
                  i % 2 === 0 ? "bg-[#0d1117]" : "bg-[#080c10]",
                  "hover:bg-[#0f1419]",
                )}>
                <td className="px-3 py-2.5">
                  <div className="flex items-center gap-2 min-w-0">
                    <TokenLogo logoUri={t.logoUri} address={t.address} symbol={t.symbol} />
                    <div className="min-w-0">
                      <div className="text-[#e6edf3] font-bold truncate max-w-[100px]">
                        {safeSymbol(t.symbol, t.address)}
                      </div>
                      <div className="text-[#484f58] text-[9px]">{formatTimeAgo(t.calledAt)}</div>
                    </div>
                  </div>
                </td>
                <td className="px-3 py-2.5 whitespace-nowrap"><QualityBadge label={t.qualityLabel} /></td>
                <td className="px-3 py-2.5 whitespace-nowrap">
                  <div className="flex items-center gap-1">
                    <Zap className="w-2.5 h-2.5" style={{ color: q.color }} />
                    <span className="font-bold tabular-nums" style={{ color: q.color }}>
                      {Math.round(t.calledIntel)}
                    </span>
                  </div>
                </td>
                <td className="px-3 py-2.5 whitespace-nowrap">
                  <div className="flex items-center gap-2">
                    {t.calledKol > 0 && (
                      <span className="flex items-center gap-0.5">
                        <Star className="w-2.5 h-2.5 text-[#f59e0b]" />
                        <span className="text-[#f59e0b] font-bold text-[10px]">{t.calledKol}</span>
                      </span>
                    )}
                    {t.calledSmart > 0 && (
                      <span className="flex items-center gap-0.5">
                        <Users className="w-2.5 h-2.5 text-[#3b82f6]" />
                        <span className="text-[#3b82f6] font-bold text-[10px]">{t.calledSmart}</span>
                      </span>
                    )}
                    {t.calledKol === 0 && t.calledSmart === 0 && <span className="text-[#30363d]">—</span>}
                  </div>
                </td>
                <td className="px-3 py-2.5 whitespace-nowrap">
                  <span className="text-[#8b949e] tabular-nums font-mono text-[10px]">
                    {t.calledMcUsd ? formatCompactUsd(t.calledMcUsd) : "—"}
                  </span>
                </td>
                <td className="px-3 py-2.5 whitespace-nowrap">
                  <span className="text-[#c9d1d9] tabular-nums font-mono text-[10px]">
                    {t.currentMcUsd ? formatCompactUsd(t.currentMcUsd) : "—"}
                  </span>
                </td>
                <td className="px-3 py-2.5 whitespace-nowrap">
                  <span className={cn("font-bold tabular-nums", gainColor(t.gainSinceCall))}>
                    {fmtGain(t.gainSinceCall)}
                  </span>
                </td>
                <td className="px-3 py-2.5">
                  <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
                    <button onClick={() => {
                      navigator.clipboard.writeText(t.address);
                      toast({ title: "Copied", description: truncateAddress(t.address) });
                    }} className="text-[#30363d] hover:text-[#f59e0b] transition-colors" title="Copy CA">
                      <Copy className="w-3 h-3" />
                    </button>
                    <button onClick={() => window.open(getGmgnUrl(t.chain, t.address), "_blank", "noopener")}
                      className="text-[#30363d] hover:text-[#f59e0b] transition-colors" title="Open GMGN">
                      <ExternalLink className="w-3 h-3" />
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

type SortKey2 = "calledAt" | "quality" | "gain" | "intel" | "calledMc";

export default function Caller() {
  const [, navigate] = useLocation();
  const [sortKey, setSortKey] = useState<SortKey2>("calledAt");
  const [sortAsc, setSortAsc] = useState(false);

  const { data, isLoading } = useQuery<{ total: number; tokens: HistoryToken[] }>({
    queryKey: ["caller-history", sortKey, sortAsc ? "asc" : "desc"],
    queryFn: () =>
      fetch(`${import.meta.env.BASE_URL}api/caller/history?sort=${sortKey}&order=${sortAsc ? "asc" : "desc"}`)
        .then(r => r.json()),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const allTokens = data?.tokens ?? [];

  // Top performers: tokens with positive gain, sorted by best gain
  const performers = [...allTokens]
    .filter(t => t.gainSinceCall != null && t.gainSinceCall > 0)
    .sort((a, b) => (b.gainSinceCall ?? 0) - (a.gainSinceCall ?? 0))
    .slice(0, 12);

  const setSort = (key: SortKey2) => {
    if (sortKey === key) setSortAsc(v => !v);
    else { setSortKey(key); setSortAsc(false); }
  };

  return (
    <div className="space-y-8">

      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-bold text-[#f59e0b] tracking-widest uppercase flex items-center gap-2">
            <Radio className="w-4 h-4" />
            Caller
          </h1>
          <p className="text-[#484f58] text-[10px] mt-0.5 tracking-widest uppercase">
            Intel ≥ 90 · KOL or Smart required · MC ≥ $5K
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className="text-[#f59e0b] font-black text-xl tabular-nums">{data?.total ?? "—"}</span>
          <span className="text-[#484f58] text-[8px] uppercase tracking-widest">called tokens</span>
        </div>
      </div>

      {/* ── Top performers ────────────────────────────────────────────────── */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Flame className="w-3 h-3 text-[#f59e0b]" />
          <span className="text-[9px] font-bold uppercase tracking-widest text-[#f59e0b]">Top Performers</span>
          <span className="text-[9px] text-[#30363d] font-mono">{performers.length}</span>
          <div className="flex-1 h-px bg-[#1c2128]" />
        </div>

        {isLoading && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="h-44 bg-[#0d1117] border border-[#1c2128] animate-pulse" />
            ))}
          </div>
        )}

        {!isLoading && performers.length === 0 && (
          <div className="p-10 text-center border border-[#1c2128]">
            <Flame className="w-6 h-6 text-[#21262d] mx-auto mb-2" />
            <div className="text-[#484f58] text-[10px] tracking-widest uppercase">No performers yet</div>
            <div className="text-[#30363d] text-[9px] mt-1">Called tokens with positive gain appear here</div>
          </div>
        )}

        {!isLoading && performers.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {performers.map((t, i) => (
              <PerformerCard
                key={t.id}
                token={t}
                rank={i + 1}
                onClick={() => navigate(`/tokens/${t.id}`)}
              />
            ))}
          </div>
        )}
      </div>

      {/* ── Called tokens table ───────────────────────────────────────────── */}
      <div className="space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <TrendingUp className="w-3 h-3 text-[#8b949e]" />
          <span className="text-[9px] font-bold uppercase tracking-widest text-[#8b949e]">Called Tokens</span>
          <span className="text-[9px] text-[#30363d] font-mono">{allTokens.length}</span>
          <div className="flex-1 h-px bg-[#1c2128]" />
          <div className="flex items-center gap-1.5 flex-wrap">
            {([
              { key: "calledAt" as SortKey2, label: "Recent" },
              { key: "quality"  as SortKey2, label: "Quality" },
              { key: "gain"     as SortKey2, label: "Gain" },
              { key: "intel"    as SortKey2, label: "Intel" },
              { key: "calledMc" as SortKey2, label: "MC" },
            ]).map(s => (
              <SortButton key={s.key} label={s.label}
                active={sortKey === s.key} asc={sortKey === s.key && sortAsc}
                onClick={() => setSort(s.key)} />
            ))}
          </div>
        </div>

        {isLoading ? (
          <div className="space-y-1">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-12 bg-[#0d1117] border border-[#1c2128] animate-pulse" />
            ))}
          </div>
        ) : (
          <CalledTable tokens={allTokens} onNavigate={id => navigate(`/tokens/${id}`)} />
        )}
      </div>
    </div>
  );
}
