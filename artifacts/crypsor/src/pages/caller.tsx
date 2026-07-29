import { useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  Copy, ExternalLink, Radio, TrendingUp,
  Star, Users, Zap, Clock, ArrowUpDown,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  cn, truncateAddress, formatCompactUsd, formatTimeAgo,
  getGmgnUrl, safeSymbol, safeName,
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
  firstDetectedAt: string | null;
  marketCapUsd: number | null;
  snapshotMcUsd: number | null;
  snapshotAt: string | null;
  gainPct: number | null;
  athGainPct: number | null;
  holderCount: number | null;
  holderKolCount: number | null;
  holderSmartCount: number | null;
  intelligenceScore: number | null;
  qualityLabel: string | null;
  kolSmartScore: number | null;
  holderVelocityScore: number | null;
  mcGrowthScore: number | null;
  liquidityUsd: number | null;
  intelligenceUpdatedAt: string | null;
}

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
  if (Math.abs(x) >= 2) return `${pct > 0 ? "+" : ""}${x.toFixed(1)}×`;
  return `${pct > 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

function TokenLogo({ logoUri, address, symbol }: {
  logoUri?: string | null; address: string; symbol?: string | null;
}) {
  const fallback = `https://ui-avatars.com/api/?name=${encodeURIComponent(
    (symbol?.slice(0, 2) || "?").replace(/[^\x00-\x7F]/g, "") || "?"
  )}&background=0d1117&color=f59e0b&size=40&bold=true`;
  const [src, setSrc] = useState(logoUri || fallback);
  return (
    <img
      src={src}
      alt=""
      onError={() => setSrc(fallback)}
      className="w-8 h-8 shrink-0 rounded-sm object-cover border border-[#21262d]"
    />
  );
}

// ── Qualifying token card ─────────────────────────────────────────────────────

function CallerCard({ token, onClick }: { token: CallerToken; onClick: () => void }) {
  const { toast } = useToast();
  const q = QUALITY[token.qualityLabel ?? ""] ?? { color: "#484f58", bg: "" };

  const copy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(token.address);
    toast({ title: "Copied", description: truncateAddress(token.address) });
  };
  const gmgn = (e: React.MouseEvent) => {
    e.stopPropagation();
    window.open(getGmgnUrl(token.chain, token.address), "_blank", "noopener");
  };

  const intel = Math.round(token.intelligenceScore ?? 0);

  return (
    <div
      onClick={onClick}
      className="group flex flex-col gap-0 border border-[#21262d] hover:border-[#30363d] bg-[#0d1117] hover:bg-[#0f1419] transition-colors cursor-pointer overflow-hidden"
    >
      {/* Intel bar accent */}
      <div
        className="h-0.5 w-full transition-all duration-500"
        style={{ backgroundColor: q.color, opacity: 0.6 }}
      />

      <div className="p-3.5 flex flex-col gap-3">
        {/* Header */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <TokenLogo logoUri={token.logoUri} address={token.address} symbol={token.symbol} />
            <div className="min-w-0">
              <div className="text-[#e6edf3] font-bold text-sm truncate leading-tight">
                {safeSymbol(token.symbol, token.address)}
              </div>
              <div className="text-[#484f58] text-[10px] truncate mt-0.5">
                {safeName(token.name, token.symbol, token.address)}
              </div>
            </div>
          </div>
          {/* Intel score */}
          <div className="shrink-0 flex flex-col items-end gap-0.5">
            <span
              className="text-xl font-black tabular-nums leading-none"
              style={{ color: q.color }}
            >
              {intel}
            </span>
            <span className="text-[8px] text-[#484f58] tracking-widest">INTEL</span>
          </div>
        </div>

        {/* Quality + KOL/Smart */}
        <div className="flex items-center gap-2">
          <QualityBadge label={token.qualityLabel} />
          <div className="flex-1" />
          {(token.holderKolCount ?? 0) > 0 && (
            <span className="flex items-center gap-1 text-[9px] text-[#8b949e]">
              <Star className="w-2.5 h-2.5 text-[#f59e0b]" />
              <span className="text-[#f59e0b] font-bold">{token.holderKolCount}</span>
              <span className="text-[#484f58]">KOL</span>
            </span>
          )}
          {(token.holderSmartCount ?? 0) > 0 && (
            <span className="flex items-center gap-1 text-[9px] text-[#8b949e]">
              <Users className="w-2.5 h-2.5 text-[#3b82f6]" />
              <span className="text-[#3b82f6] font-bold">{token.holderSmartCount}</span>
              <span className="text-[#484f58]">Smart</span>
            </span>
          )}
        </div>

        {/* MC row */}
        <div className="flex items-center justify-between pt-2.5 border-t border-[#1c2128]">
          <div>
            <div className="text-[8px] text-[#484f58] uppercase tracking-widest mb-0.5">MC at snapshot</div>
            <div className="text-[#c9d1d9] text-xs font-bold tabular-nums">
              {token.snapshotMcUsd ? formatCompactUsd(token.snapshotMcUsd) : "—"}
            </div>
          </div>
          <div className="text-right">
            <div className="text-[8px] text-[#484f58] uppercase tracking-widest mb-0.5">ATH gain</div>
            <div className={cn("text-xs font-bold tabular-nums", gainColor(token.athGainPct))}>
              {fmtGain(token.athGainPct)}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between">
          <span className="text-[9px] text-[#484f58] flex items-center gap-1">
            <Clock className="w-2.5 h-2.5" />
            {formatTimeAgo(token.firstDetectedAt)}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={copy}
              title="Copy CA"
              className="text-[#30363d] hover:text-[#f59e0b] transition-colors"
            >
              <Copy className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={gmgn}
              title="Open GMGN"
              className="text-[#30363d] hover:text-[#f59e0b] transition-colors"
            >
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

function SortButton({
  label, active, asc, onClick,
}: { label: string; active: boolean; asc: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-1 text-[9px] font-bold uppercase tracking-widest px-2 py-1 border transition-colors",
        active
          ? "border-[#f59e0b]/40 bg-[#f59e0b]/8 text-[#f59e0b]"
          : "border-[#21262d] text-[#484f58] hover:text-[#8b949e] hover:border-[#30363d]",
      )}
    >
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
      No tokens called yet — alerts fire when intel ≥ 90 with KOL/Smart holders
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
              <tr
                key={t.id}
                onClick={() => onNavigate(t.id)}
                className={cn(
                  "border-b border-[#1c2128] last:border-0 cursor-pointer transition-colors",
                  i % 2 === 0 ? "bg-[#0d1117]" : "bg-[#080c10]",
                  "hover:bg-[#0f1419]",
                )}
              >
                {/* Token */}
                <td className="px-3 py-2.5">
                  <div className="flex items-center gap-2 min-w-0">
                    <TokenLogo logoUri={t.logoUri} address={t.address} symbol={t.symbol} />
                    <div className="min-w-0">
                      <div className="text-[#e6edf3] font-bold truncate max-w-[100px]">
                        {safeSymbol(t.symbol, t.address)}
                      </div>
                      <div className="text-[#484f58] text-[9px] truncate max-w-[100px]">
                        {formatTimeAgo(t.calledAt)}
                      </div>
                    </div>
                  </div>
                </td>
                {/* Quality */}
                <td className="px-3 py-2.5 whitespace-nowrap">
                  <QualityBadge label={t.qualityLabel} />
                </td>
                {/* Intel */}
                <td className="px-3 py-2.5 whitespace-nowrap">
                  <div className="flex items-center gap-1">
                    <Zap className="w-2.5 h-2.5" style={{ color: q.color }} />
                    <span className="font-bold tabular-nums" style={{ color: q.color }}>
                      {Math.round(t.calledIntel)}
                    </span>
                  </div>
                </td>
                {/* KOL / Smart */}
                <td className="px-3 py-2.5 whitespace-nowrap">
                  <div className="flex items-center gap-2 text-[#8b949e]">
                    {t.calledKol > 0 && (
                      <span className="flex items-center gap-0.5">
                        <Star className="w-2.5 h-2.5 text-[#f59e0b]" />
                        <span className="text-[#f59e0b] font-bold">{t.calledKol}</span>
                      </span>
                    )}
                    {t.calledSmart > 0 && (
                      <span className="flex items-center gap-0.5">
                        <Users className="w-2.5 h-2.5 text-[#3b82f6]" />
                        <span className="text-[#3b82f6] font-bold">{t.calledSmart}</span>
                      </span>
                    )}
                    {t.calledKol === 0 && t.calledSmart === 0 && (
                      <span className="text-[#30363d]">—</span>
                    )}
                  </div>
                </td>
                {/* MC Called */}
                <td className="px-3 py-2.5 whitespace-nowrap">
                  <span className="text-[#8b949e] tabular-nums font-mono text-[10px]">
                    {t.calledMcUsd ? formatCompactUsd(t.calledMcUsd) : "—"}
                  </span>
                </td>
                {/* MC Now */}
                <td className="px-3 py-2.5 whitespace-nowrap">
                  <span className="text-[#c9d1d9] tabular-nums font-mono text-[10px]">
                    {t.currentMcUsd ? formatCompactUsd(t.currentMcUsd) : "—"}
                  </span>
                </td>
                {/* Gain */}
                <td className="px-3 py-2.5 whitespace-nowrap">
                  <span className={cn("font-bold tabular-nums", gainColor(t.gainSinceCall))}>
                    {fmtGain(t.gainSinceCall)}
                  </span>
                </td>
                {/* Actions */}
                <td className="px-3 py-2.5">
                  <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(t.address);
                        toast({ title: "Copied", description: truncateAddress(t.address) });
                      }}
                      className="text-[#30363d] hover:text-[#f59e0b] transition-colors"
                      title="Copy CA"
                    >
                      <Copy className="w-3 h-3" />
                    </button>
                    <button
                      onClick={() => window.open(getGmgnUrl(t.chain, t.address), "_blank", "noopener")}
                      className="text-[#30363d] hover:text-[#f59e0b] transition-colors"
                      title="Open GMGN"
                    >
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

export default function Caller() {
  const [, navigate] = useLocation();
  const [sortKey, setSortKey]   = useState<SortKey>("calledAt");
  const [sortAsc, setSortAsc]   = useState(false);

  const { data: qualData, isLoading: qLoading } = useQuery<{ total: number; tokens: CallerToken[] }>({
    queryKey: ["caller-tokens"],
    queryFn:  () => fetch(`${import.meta.env.BASE_URL}api/caller/tokens`).then(r => r.json()),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const { data: histData, isLoading: hLoading } = useQuery<{ total: number; tokens: HistoryToken[] }>({
    queryKey: ["caller-history", sortKey, sortAsc ? "asc" : "desc"],
    queryFn:  () =>
      fetch(`${import.meta.env.BASE_URL}api/caller/history?sort=${sortKey}&order=${sortAsc ? "asc" : "desc"}`)
        .then(r => r.json()),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const qualifying = qualData?.tokens ?? [];
  const history    = histData?.tokens ?? [];

  const setSort = (key: SortKey) => {
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
            Intel ≥ 90 · KOL or Smart required
          </p>
        </div>
        <div className="flex flex-col items-end gap-1 text-right">
          <span className="text-[#f59e0b] font-black text-xl tabular-nums">{qualData?.total ?? "—"}</span>
          <span className="text-[#484f58] text-[8px] uppercase tracking-widest">qualifying now</span>
        </div>
      </div>

      {/* ── Qualifying tokens ─────────────────────────────────────────────── */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Zap className="w-3 h-3 text-[#f59e0b]" />
          <span className="text-[9px] font-bold uppercase tracking-widest text-[#f59e0b]">
            Qualifying Now
          </span>
          <span className="text-[9px] text-[#30363d] font-mono">{qualifying.length}</span>
          <div className="flex-1 h-px bg-[#1c2128]" />
        </div>

        {qLoading && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-44 bg-[#0d1117] border border-[#1c2128] animate-pulse" />
            ))}
          </div>
        )}

        {!qLoading && qualifying.length === 0 && (
          <div className="p-12 text-center border border-[#1c2128]">
            <Radio className="w-6 h-6 text-[#21262d] mx-auto mb-2" />
            <div className="text-[#484f58] text-[10px] tracking-widest uppercase">
              No tokens qualifying yet
            </div>
            <div className="text-[#30363d] text-[9px] mt-1">
              Tokens appear once intel ≥ 90 with at least one KOL or Smart holder
            </div>
          </div>
        )}

        {!qLoading && qualifying.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {qualifying.map(t => (
              <CallerCard
                key={t.id}
                token={t}
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
          <span className="text-[9px] font-bold uppercase tracking-widest text-[#8b949e]">
            Called Tokens
          </span>
          <span className="text-[9px] text-[#30363d] font-mono">{history.length}</span>
          <div className="flex-1 h-px bg-[#1c2128]" />
          {/* Sort controls */}
          <div className="flex items-center gap-1.5 flex-wrap">
            {([
              { key: "calledAt" as SortKey,  label: "Recent" },
              { key: "quality"  as SortKey,  label: "Quality" },
              { key: "gain"     as SortKey,  label: "Gain" },
              { key: "intel"    as SortKey,  label: "Intel" },
              { key: "calledMc" as SortKey,  label: "MC" },
            ]).map(s => (
              <SortButton
                key={s.key}
                label={s.label}
                active={sortKey === s.key}
                asc={sortKey === s.key && sortAsc}
                onClick={() => setSort(s.key)}
              />
            ))}
          </div>
        </div>

        {hLoading && (
          <div className="space-y-1">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-12 bg-[#0d1117] border border-[#1c2128] animate-pulse" />
            ))}
          </div>
        )}

        {!hLoading && (
          <CalledTable tokens={history} onNavigate={id => navigate(`/tokens/${id}`)} />
        )}
      </div>
    </div>
  );
}
