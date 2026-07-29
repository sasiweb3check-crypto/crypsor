import { useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  Copy, ExternalLink, ArrowUpDown, Twitter, Send, Globe,
  Star, Users, Zap, Flame, TrendingUp, BarChart2,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  cn, truncateAddress, formatCompactUsd, formatTimeAgo,
  getGmgnUrl, safeSymbol, safeName,
} from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Socials { twitter?: string; telegram?: string; website?: string; }

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
  postmortemLabel: "GOOD_SETUP" | "SURPRISE_SIGNAL" | "DUMP_WARNING" | "NONE";
  socials: Socials;
}

interface CallerStats {
  total: number;
  winRate: number;
  x2Count: number;
  x3Count: number;
  x5Count: number;
  minAthGain: number;
  maxAthGain: number;
}

// ── Postmortem badge ──────────────────────────────────────────────────────────

const PM_META = {
  GOOD_SETUP:      { label: "Good",     color: "#22c55e", dot: "#22c55e" },
  SURPRISE_SIGNAL: { label: "Surprise", color: "#f59e0b", dot: "#f59e0b" },
  DUMP_WARNING:    { label: "Dump",     color: "#ef4444", dot: "#ef4444" },
  NONE:            { label: "Neutral",  color: "#484f58", dot: "#484f58" },
};

function PmBadge({ label }: { label: HistoryToken["postmortemLabel"] }) {
  const m = PM_META[label] ?? PM_META.NONE;
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[8px] font-black tracking-widest uppercase rounded-sm"
      style={{ color: m.color, background: `${m.color}18`, border: `1px solid ${m.color}30` }}
    >
      <span className="w-1 h-1 rounded-full shrink-0" style={{ background: m.dot }} />
      {m.label}
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

function fmtAth(pct: number | null | undefined): string {
  if (pct == null) return "—";
  const x = pct / 100 + 1;
  if (x >= 2)   return `${x.toFixed(1)}×`;
  if (pct >= 0) return `+${pct.toFixed(0)}%`;
  return `${pct.toFixed(0)}%`;
}

function fmtGain(pct: number | null | undefined): string {
  if (pct == null) return "—";
  const x = pct / 100 + 1;
  if (x >= 2)   return `+${x.toFixed(1)}×`;
  if (pct >= 0) return `+${pct.toFixed(1)}%`;
  return `${pct.toFixed(1)}%`;
}

function TokenLogo({ logoUri, address, symbol }: {
  logoUri?: string | null; address: string; symbol?: string | null;
}) {
  const fallback = `https://ui-avatars.com/api/?name=${encodeURIComponent(
    (symbol?.slice(0, 2) || "?").replace(/[^\x00-\x7F]/g, "") || "?"
  )}&background=0a0e1a&color=f59e0b&size=40&bold=true`;
  const [src, setSrc] = useState(logoUri || fallback);
  return (
    <img src={src} alt="" onError={() => setSrc(fallback)}
      className="w-8 h-8 shrink-0 rounded object-cover"
      style={{ border: "1px solid rgba(255,255,255,0.08)" }} />
  );
}

// ── Stats chips ───────────────────────────────────────────────────────────────

function StatChip({ label, value, sub, accent }: {
  label: string; value: string | number; sub?: string; accent?: string;
}) {
  return (
    <div
      className="flex-1 min-w-0 flex flex-col items-center justify-center px-3 py-2.5 rounded-lg"
      style={{
        background: "rgba(255,255,255,0.03)",
        border: "1px solid rgba(255,255,255,0.07)",
        minWidth: 68,
      }}
    >
      <div className="text-[8px] font-bold uppercase tracking-widest mb-1" style={{ color: "#484f58" }}>{label}</div>
      <div className="font-black tabular-nums leading-none text-sm" style={{ color: accent ?? "#e6edf3" }}>{value}</div>
      {sub && <div className="text-[7px] mt-0.5 tabular-nums" style={{ color: "#30363d" }}>{sub}</div>}
    </div>
  );
}

// ── Sort button ───────────────────────────────────────────────────────────────

type SortKey = "calledAt" | "gain" | "ath" | "intel" | "calledMc";

function SortBtn({ label, active, asc, onClick }: {
  label: string; active: boolean; asc: boolean; onClick: () => void;
}) {
  return (
    <button onClick={onClick}
      className="flex items-center gap-1 px-2 py-1 text-[8px] font-bold uppercase tracking-widest rounded transition-colors"
      style={{
        background: active ? "rgba(245,158,11,0.10)" : "rgba(255,255,255,0.03)",
        border: `1px solid ${active ? "rgba(245,158,11,0.35)" : "rgba(255,255,255,0.06)"}`,
        color: active ? "#f59e0b" : "#484f58",
      }}>
      <ArrowUpDown className="w-2 h-2" />
      {label}
      {active && <span className="text-[7px]">{asc ? "↑" : "↓"}</span>}
    </button>
  );
}

// ── Token row (mobile-optimised) ──────────────────────────────────────────────

function TokenRow({ t, onNavigate }: { t: HistoryToken; onNavigate: () => void }) {
  const { toast } = useToast();
  const athX = t.athGainPct != null ? t.athGainPct / 100 + 1 : null;
  const isHot = (athX ?? 0) >= 5;

  const copy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(t.address);
    toast({ title: "Copied", description: truncateAddress(t.address) });
  };

  const openGmgn = (e: React.MouseEvent) => {
    e.stopPropagation();
    window.open(getGmgnUrl(t.chain, t.address), "_blank", "noopener");
  };

  return (
    <div
      onClick={onNavigate}
      className="flex flex-col gap-2 cursor-pointer rounded-lg px-3 py-3 transition-all active:scale-[0.99]"
      style={{
        background: "rgba(255,255,255,0.02)",
        border: "1px solid rgba(255,255,255,0.055)",
      }}
      onMouseEnter={e => (e.currentTarget.style.background = "rgba(255,255,255,0.045)")}
      onMouseLeave={e => (e.currentTarget.style.background = "rgba(255,255,255,0.02)")}
    >
      {/* Row 1: logo + name + badge + ATH */}
      <div className="flex items-center gap-2.5">
        <TokenLogo logoUri={t.logoUri} address={t.address} symbol={t.symbol} />

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[#e6edf3] font-bold text-sm leading-none truncate">
              {safeSymbol(t.symbol, t.address)}
            </span>
            {isHot && <Flame className="w-3 h-3 text-[#f59e0b] shrink-0" />}
            <PmBadge label={t.postmortemLabel} />
          </div>
          <div className="flex items-center gap-2 mt-1">
            {t.calledKol > 0 && (
              <span className="flex items-center gap-0.5 text-[9px] text-[#f59e0b]">
                <Star className="w-2.5 h-2.5" />{t.calledKol}
              </span>
            )}
            {t.calledSmart > 0 && (
              <span className="flex items-center gap-0.5 text-[9px] text-[#3b82f6]">
                <Users className="w-2.5 h-2.5" />{t.calledSmart}
              </span>
            )}
            <span className="text-[#30363d] text-[8px]">{formatTimeAgo(t.calledAt)}</span>
          </div>
        </div>

        {/* ATH column */}
        <div className="shrink-0 text-right">
          <div className={cn("text-sm font-black tabular-nums leading-none", t.athGainPct != null && t.athGainPct > 0 ? "text-[#22c55e]" : "text-[#484f58]")}>
            {fmtAth(t.athGainPct)}
          </div>
          <div className="text-[7px] text-[#30363d] uppercase tracking-widest mt-0.5">ATH</div>
        </div>
      </div>

      {/* Row 2: MC called → now + actions */}
      <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
        {/* MC range */}
        <div className="flex items-center gap-1 text-[9px] font-mono min-w-0 flex-1">
          <span className="text-[#484f58]">{t.calledMcUsd ? formatCompactUsd(t.calledMcUsd) : "—"}</span>
          <span className="text-[#30363d]">→</span>
          <span className={cn("font-bold", gainColor(t.gainSinceCall))}>
            {t.currentMcUsd ? formatCompactUsd(t.currentMcUsd) : "—"}
          </span>
          {t.gainSinceCall != null && (
            <span className={cn("text-[8px] ml-0.5", gainColor(t.gainSinceCall))}>
              ({fmtGain(t.gainSinceCall)})
            </span>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2.5 shrink-0">
          <button onClick={copy} title="Copy CA"
            className="transition-colors" style={{ color: "#30363d" }}
            onMouseEnter={e => (e.currentTarget.style.color = "#f59e0b")}
            onMouseLeave={e => (e.currentTarget.style.color = "#30363d")}>
            <Copy className="w-3.5 h-3.5" />
          </button>
          <button onClick={openGmgn} title="GMGN"
            className="transition-colors" style={{ color: "#30363d" }}
            onMouseEnter={e => (e.currentTarget.style.color = "#22c55e")}
            onMouseLeave={e => (e.currentTarget.style.color = "#30363d")}>
            <ExternalLink className="w-3.5 h-3.5" />
          </button>
          {t.socials.twitter && (
            <a href={t.socials.twitter} target="_blank" rel="noopener noreferrer"
              title="Twitter" onClick={e => e.stopPropagation()}
              style={{ color: "#30363d" }}
              onMouseEnter={e => ((e.currentTarget as HTMLElement).style.color = "#1d9bf0")}
              onMouseLeave={e => ((e.currentTarget as HTMLElement).style.color = "#30363d")}>
              <Twitter className="w-3.5 h-3.5" />
            </a>
          )}
          {t.socials.telegram && (
            <a href={t.socials.telegram} target="_blank" rel="noopener noreferrer"
              title="Telegram" onClick={e => e.stopPropagation()}
              style={{ color: "#30363d" }}
              onMouseEnter={e => ((e.currentTarget as HTMLElement).style.color = "#24a1de")}
              onMouseLeave={e => ((e.currentTarget as HTMLElement).style.color = "#30363d")}>
              <Send className="w-3.5 h-3.5" />
            </a>
          )}
          {t.socials.website && (
            <a href={t.socials.website} target="_blank" rel="noopener noreferrer"
              title="Website" onClick={e => e.stopPropagation()}
              style={{ color: "#30363d" }}
              onMouseEnter={e => ((e.currentTarget as HTMLElement).style.color = "#8b5cf6")}
              onMouseLeave={e => ((e.currentTarget as HTMLElement).style.color = "#30363d")}>
              <Globe className="w-3.5 h-3.5" />
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function Caller() {
  const [, navigate] = useLocation();
  const [sortKey, setSortKey] = useState<SortKey>("calledAt");
  const [sortAsc, setSortAsc] = useState(false);

  const { data: stats, isLoading: statsLoading } = useQuery<CallerStats>({
    queryKey: ["caller-stats"],
    queryFn: () =>
      fetch(`${import.meta.env.BASE_URL}api/caller/stats`).then(r => r.json()),
    refetchInterval: 5 * 60_000,
    staleTime: 60_000,
  });

  const { data, isLoading } = useQuery<{ total: number; tokens: HistoryToken[] }>({
    queryKey: ["caller-history", sortKey, sortAsc ? "asc" : "desc"],
    queryFn: () =>
      fetch(`${import.meta.env.BASE_URL}api/caller/history?sort=${sortKey}&order=${sortAsc ? "asc" : "desc"}`)
        .then(r => r.json()),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const tokens = data?.tokens ?? [];

  // Sort ath locally if needed (server sorts calledAt/gain/intel/calledMc)
  const sorted = sortKey === "ath"
    ? [...tokens].sort((a, b) => {
        const diff = (b.athGainPct ?? -Infinity) - (a.athGainPct ?? -Infinity);
        return sortAsc ? -diff : diff;
      })
    : tokens;

  const setSort = (key: SortKey) => {
    if (sortKey === key) setSortAsc(v => !v);
    else { setSortKey(key); setSortAsc(false); }
  };

  const winRateColor = !stats ? "#e6edf3"
    : stats.winRate >= 60 ? "#22c55e"
    : stats.winRate >= 40 ? "#f59e0b"
    : "#ef4444";

  return (
    <div className="flex flex-col min-h-[calc(100vh-3rem)] px-3 pt-3 pb-6 gap-4 max-w-2xl mx-auto w-full">

      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-1.5 h-1.5 rounded-full bg-[#22c55e] animate-pulse" />
          <span className="text-[8px] font-bold uppercase tracking-widest text-[#484f58]">
            Intel ≥ 90 · KOL / Smart
          </span>
        </div>
        <span className="text-[#f59e0b] font-black text-sm tabular-nums">
          {stats?.total ?? data?.total ?? "—"}
          <span className="text-[8px] font-normal text-[#484f58] ml-1 uppercase tracking-widest">called</span>
        </span>
      </div>

      {/* ── Stats chips ───────────────────────────────────────────────────── */}
      <div className="flex gap-2 overflow-x-auto no-scrollbar pb-1">
        <StatChip
          label="Win Rate"
          value={statsLoading ? "—" : `${stats?.winRate ?? 0}%`}
          sub="ATH > 0%"
          accent={statsLoading ? undefined : winRateColor}
        />
        <StatChip
          label="2× Hit"
          value={statsLoading ? "—" : stats?.x2Count ?? 0}
          sub="ATH ≥ 2×"
          accent="#f59e0b"
        />
        <StatChip
          label="3× Hit"
          value={statsLoading ? "—" : stats?.x3Count ?? 0}
          sub="ATH ≥ 3×"
          accent="#f59e0b"
        />
        <StatChip
          label="5× Hit"
          value={statsLoading ? "—" : stats?.x5Count ?? 0}
          sub="ATH ≥ 5×"
          accent="#f59e0b"
        />
        <StatChip
          label="Best ATH"
          value={statsLoading || !stats ? "—" : fmtAth(stats.maxAthGain)}
          sub="all-time"
          accent="#22c55e"
        />
        <StatChip
          label="Worst"
          value={statsLoading || !stats ? "—" : fmtAth(stats.minAthGain)}
          sub="all-time"
          accent={stats && stats.minAthGain < 0 ? "#ef4444" : "#484f58"}
        />
      </div>

      {/* ── Token list ────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-3 flex-1">
        {/* Sort bar */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <BarChart2 className="w-3 h-3 text-[#30363d]" />
          <span className="text-[8px] text-[#30363d] uppercase tracking-widest">Sort</span>
          {([
            { key: "calledAt" as SortKey, label: "Recent" },
            { key: "ath"      as SortKey, label: "ATH" },
            { key: "gain"     as SortKey, label: "Gain" },
            { key: "intel"    as SortKey, label: "Intel" },
            { key: "calledMc" as SortKey, label: "MC" },
          ]).map(s => (
            <SortBtn key={s.key} label={s.label}
              active={sortKey === s.key} asc={sortKey === s.key && sortAsc}
              onClick={() => setSort(s.key)} />
          ))}
        </div>

        {/* List */}
        {isLoading ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="h-20 rounded-lg animate-pulse"
                style={{ background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.05)" }} />
            ))}
          </div>
        ) : sorted.length === 0 ? (
          <div className="flex flex-col items-center justify-center flex-1 py-20 gap-3">
            <TrendingUp className="w-10 h-10" style={{ color: "#21262d" }} />
            <div className="text-[10px] uppercase tracking-widest text-[#484f58]">No called tokens yet</div>
            <div className="text-[9px] text-[#30363d]">Tokens with intel ≥ 90 + KOL/Smart appear here</div>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {sorted.map(t => (
              <TokenRow
                key={t.id}
                t={t}
                onNavigate={() => navigate(`/tokens/${t.id}`)}
              />
            ))}
          </div>
        )}
      </div>

      {/* ── Footer note ───────────────────────────────────────────────────── */}
      {sorted.length > 0 && (
        <div className="flex items-center justify-center gap-1.5 pt-2">
          <Zap className="w-2.5 h-2.5 text-[#30363d]" />
          <span className="text-[8px] text-[#30363d] tracking-widest uppercase">
            {sorted.length} tokens · Win rate from ATH gain · Sub-$5K excluded
          </span>
        </div>
      )}
    </div>
  );
}
