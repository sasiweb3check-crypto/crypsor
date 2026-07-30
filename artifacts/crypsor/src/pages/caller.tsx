/**
 * Pro Caller Page — shows only Very Good (≥75) and Good (55–74) tokens
 * sorted by Pro Score by default.
 */
import { useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  Copy, ExternalLink, Twitter, Send, Globe,
  TrendingUp, Zap, Shield, ShieldCheck, ShieldOff,
  Star, Users, BarChart2,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  cn, truncateAddress, formatCompactUsd, formatTimeAgo,
  getGmgnUrl, safeSymbol,
} from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Socials { twitter?: string; telegram?: string; website?: string; }
type RunStatus   = "PUMPING" | "RAN" | "SLOW" | "FLAT" | "DEAD";
type QualityLabel = "very_good" | "good" | "below";
type SortKey     = "proScore" | "calledAt" | "ath" | "gain" | "intel" | "calledMc";

interface ProToken {
  id: number;
  address: string;
  chain: string;
  name: string | null;
  symbol: string | null;
  logoUri: string | null;
  status: string;
  calledAt: string;
  calledMcUsd: number | null;
  calledIntel: number | null;
  calledKol: number;
  calledSmart: number;
  calledKolSmartScore: number | null;
  currentMcUsd: number | null;
  gainSinceCall: number | null;
  athMultiple: number | null;
  runStatus: RunStatus;
  proScore: number;
  qualityLabel: QualityLabel;
  currentKol: number;
  currentSmart: number;
  currentIntel: number | null;
  lastSnapshotAt: string | null;
  secMintRenounced: boolean | null;
  secFreezeRenounced: boolean | null;
  secIsHoneypot: boolean | null;
  socials: Socials;
}

interface ProStats {
  total: number;
  winRate: number;
  x1Count: number;
  x2Count: number;
  x3Count: number;
  x5Count: number;
  x10Count: number;
  x100Count: number;
  x200Count: number;
  bestAth: number | null;
  veryGoodCount: number;
  qualityCount: number;
}

// ── Run-status badge ──────────────────────────────────────────────────────────

const RUN_META: Record<RunStatus, { label: string; color: string; glow: string }> = {
  PUMPING: { label: "Pumping", color: "#22c55e", glow: "#22c55e30" },
  RAN:     { label: "Ran",     color: "#3b82f6", glow: "#3b82f630" },
  SLOW:    { label: "Slow",    color: "#f59e0b", glow: "#f59e0b30" },
  FLAT:    { label: "Flat",    color: "#484f58", glow: "#484f5830" },
  DEAD:    { label: "Dead",    color: "#ef4444", glow: "#ef444430" },
};

function RunBadge({ status }: { status: RunStatus }) {
  const m = RUN_META[status] ?? RUN_META.FLAT;
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[8px] font-black tracking-widest uppercase rounded-sm"
      style={{ color: m.color, background: m.glow, border: `1px solid ${m.color}30` }}
    >
      <span className="w-1 h-1 rounded-full shrink-0" style={{ background: m.color }} />
      {m.label}
    </span>
  );
}

// ── Quality badge ─────────────────────────────────────────────────────────────

function QualityBadge({ label, score }: { label: QualityLabel; score: number }) {
  if (label === "very_good") {
    return (
      <span
        className="inline-flex items-center gap-1 px-2 py-0.5 text-[9px] font-black tracking-wider uppercase rounded-full"
        style={{
          background: "linear-gradient(135deg, #f59e0b22, #22c55e22)",
          border: "1px solid #f59e0b50",
          color: "#f59e0b",
        }}
      >
        <Star className="w-2.5 h-2.5" fill="currentColor" />
        Very Good · {score.toFixed(0)}
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 text-[9px] font-black tracking-wider uppercase rounded-full"
      style={{
        background: "#3b82f615",
        border: "1px solid #3b82f640",
        color: "#3b82f6",
      }}
    >
      <BarChart2 className="w-2.5 h-2.5" />
      Good · {score.toFixed(0)}
    </span>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function gainColor(v: number | null | undefined) {
  if (v == null) return "text-[#484f58]";
  if (v > 0)  return "text-[#22c55e]";
  if (v < 0)  return "text-[#ef4444]";
  return "text-[#8b949e]";
}

function fmtGain(pct: number | null | undefined): string {
  if (pct == null) return "—";
  const x = pct / 100 + 1;
  if (Math.abs(x) >= 2)   return `${pct > 0 ? "+" : ""}${x.toFixed(1)}×`;
  if (pct >= 0)           return `+${pct.toFixed(1)}%`;
  return `${pct.toFixed(1)}%`;
}

function fmtAth(x: number | null | undefined): string {
  if (x == null) return "—";
  if (x >= 2)   return `${x.toFixed(1)}×`;
  const pct = (x - 1) * 100;
  if (pct >= 0) return `+${pct.toFixed(0)}%`;
  return `${pct.toFixed(0)}%`;
}

function SecurityIcons({
  mint, freeze, honeypot,
}: { mint: boolean | null; freeze: boolean | null; honeypot: boolean | null }) {
  if (honeypot === true) return (
    <span title="Honeypot detected" style={{ color: "#ef4444" }}>
      <ShieldOff className="w-3 h-3" />
    </span>
  );
  if (mint === true || freeze === true) return (
    <span title={`Renounced: ${[mint && "mint", freeze && "freeze"].filter(Boolean).join(" + ")}`}
      style={{ color: "#22c55e" }}>
      <ShieldCheck className="w-3 h-3" />
    </span>
  );
  return <Shield className="w-3 h-3" style={{ color: "#30363d" }} />;
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
      className="w-9 h-9 shrink-0 rounded-lg object-cover"
      style={{ border: "1px solid rgba(255,255,255,0.08)" }} />
  );
}

// ── Stats chip ────────────────────────────────────────────────────────────────

function StatChip({
  label, value, sub, accent, large,
}: {
  label: string; value: string | number; sub?: string;
  accent?: string; large?: boolean;
}) {
  const color = accent ?? "#8b949e";
  return (
    <div
      className="flex flex-col items-center justify-center px-3 py-2.5 rounded-xl gap-0.5"
      style={{
        background: `${color}0c`,
        border: `1px solid ${color}25`,
        minWidth: large ? 72 : 58,
      }}
    >
      {sub && <div className="text-[7px] text-[#484f58] uppercase tracking-widest">{sub}</div>}
      <div className={cn(
        "font-black tracking-tight",
        large ? "text-2xl" : "text-lg",
      )} style={{ color }}>
        {value}
      </div>
      <div className="text-[7px] uppercase tracking-widest" style={{ color: `${color}99` }}>
        {label}
      </div>
    </div>
  );
}

// ── Sort button ───────────────────────────────────────────────────────────────

function SortBtn({
  label, active, asc, onClick,
}: { label: string; active: boolean; asc: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-0.5 px-2 py-0.5 rounded text-[8px] font-bold uppercase tracking-widest transition-all"
      style={
        active
          ? { background: "#f59e0b20", color: "#f59e0b", border: "1px solid #f59e0b40" }
          : { background: "transparent", color: "#484f58", border: "1px solid #21262d" }
      }
    >
      {label}
      {active && (
        <span className="text-[7px]" style={{ color: "#f59e0b80" }}>
          {asc ? "↑" : "↓"}
        </span>
      )}
    </button>
  );
}

// ── Token row ─────────────────────────────────────────────────────────────────

function TokenRow({ t, onNavigate }: { t: ProToken; onNavigate: () => void }) {
  const { toast } = useToast();
  const sym = safeSymbol(t.symbol, t.address);

  const isVeryGood = t.qualityLabel === "very_good";
  const borderColor = isVeryGood ? "#f59e0b22" : "#3b82f618";
  const accentColor = isVeryGood ? "#f59e0b" : "#3b82f6";
  const bgGlow     = isVeryGood ? "#f59e0b06" : "transparent";

  return (
    <div
      onClick={onNavigate}
      className="relative flex items-center gap-3 px-3 py-3 rounded-xl cursor-pointer transition-all duration-150 group"
      style={{
        background: bgGlow,
        border: `1px solid ${borderColor}`,
      }}
      onMouseEnter={e => (e.currentTarget.style.borderColor = accentColor + "55")}
      onMouseLeave={e => (e.currentTarget.style.borderColor = borderColor)}
    >
      {/* Quality accent strip */}
      <div
        className="absolute left-0 top-2 bottom-2 w-0.5 rounded-r"
        style={{ background: isVeryGood
          ? "linear-gradient(180deg,#f59e0b,#22c55e)"
          : "linear-gradient(180deg,#3b82f6,#6366f1)" }}
      />

      {/* Logo */}
      <TokenLogo logoUri={t.logoUri} address={t.address} symbol={t.symbol} />

      {/* Name + badges */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[11px] font-bold text-white truncate max-w-[100px]">{sym}</span>
          <RunBadge status={t.runStatus} />
          <QualityBadge label={t.qualityLabel} score={t.proScore} />
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-[9px] text-[#484f58]">
            MC {formatCompactUsd(t.calledMcUsd)} → {formatCompactUsd(t.currentMcUsd)}
          </span>
          {/* KOL / Smart indicators */}
          {t.currentKol > 0 && (
            <span className="text-[8px] font-bold" style={{ color: "#a855f7" }}>
              K{t.currentKol}
            </span>
          )}
          {t.currentSmart > 0 && (
            <span className="text-[8px] font-bold" style={{ color: "#06b6d4" }}>
              S{t.currentSmart}
            </span>
          )}
          <SecurityIcons
            mint={t.secMintRenounced}
            freeze={t.secFreezeRenounced}
            honeypot={t.secIsHoneypot}
          />
        </div>
      </div>

      {/* Gain + ATH + age (right column) */}
      <div className="flex flex-col items-end gap-0.5 shrink-0">
        {/* ATH multiple */}
        <div className="flex items-center gap-1">
          <span className="text-[8px] text-[#484f58] uppercase tracking-widest">ATH</span>
          <span
            className="text-[11px] font-black"
            style={{ color: t.athMultiple != null && t.athMultiple >= 2 ? "#f59e0b" : "#8b949e" }}
          >
            {fmtAth(t.athMultiple)}
          </span>
        </div>
        {/* Gain since call */}
        <span className={cn("text-[10px] font-bold", gainColor(t.gainSinceCall))}>
          {fmtGain(t.gainSinceCall)}
        </span>
        {/* Age */}
        <span className="text-[8px] text-[#30363d]">{formatTimeAgo(t.calledAt)}</span>
      </div>

      {/* External link + copy — visible on hover */}
      <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
        <button
          onClick={e => {
            e.stopPropagation();
            navigator.clipboard.writeText(t.address);
            toast({ title: "Copied", description: t.address.slice(0, 20) + "…" });
          }}
          className="p-1 rounded hover:bg-white/5"
        >
          <Copy className="w-3 h-3 text-[#484f58]" />
        </button>
        <a
          href={getGmgnUrl(t.chain, t.address)} target="_blank" rel="noopener noreferrer"
          onClick={e => e.stopPropagation()}
          className="p-1 rounded hover:bg-white/5"
        >
          <ExternalLink className="w-3 h-3 text-[#484f58]" />
        </a>
        {t.socials.twitter && (
          <a href={t.socials.twitter} target="_blank" rel="noopener noreferrer"
            onClick={e => e.stopPropagation()} className="p-1 rounded hover:bg-white/5">
            <Twitter className="w-3 h-3 text-[#484f58]" />
          </a>
        )}
        {t.socials.telegram && (
          <a href={t.socials.telegram} target="_blank" rel="noopener noreferrer"
            onClick={e => e.stopPropagation()} className="p-1 rounded hover:bg-white/5">
            <Send className="w-3 h-3 text-[#484f58]" />
          </a>
        )}
      </div>
    </div>
  );
}

// ── Quality filter tab ────────────────────────────────────────────────────────

type QualityFilter = "quality" | "very_good" | "all";

function FilterTab({
  label, active, count, onClick,
}: { label: string; active: boolean; count?: number; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 px-3 py-1 rounded-lg text-[9px] font-bold uppercase tracking-widest transition-all"
      style={
        active
          ? { background: "#f59e0b20", color: "#f59e0b", border: "1px solid #f59e0b40" }
          : { background: "transparent", color: "#484f58", border: "1px solid #21262d" }
      }
    >
      {label}
      {count != null && (
        <span
          className="px-1 rounded-full text-[7px] font-black"
          style={{ background: active ? "#f59e0b30" : "#21262d", color: active ? "#f59e0b" : "#484f58" }}
        >
          {count}
        </span>
      )}
    </button>
  );
}

// ── Pro Score bar ─────────────────────────────────────────────────────────────

function ProScoreBar({ score }: { score: number }) {
  const isVG = score >= 75;
  const isG  = score >= 55;
  const color = isVG ? "#f59e0b" : isG ? "#3b82f6" : "#484f58";
  return (
    <div className="h-0.5 rounded-full overflow-hidden" style={{ background: "#21262d", width: 40 }}>
      <div
        className="h-full rounded-full transition-all duration-500"
        style={{ width: `${Math.min(100, score)}%`, background: color }}
      />
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

const BASE_URL = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

export default function Caller() {
  const [, navigate] = useLocation();
  const [sortKey, setSortKey]         = useState<SortKey>("proScore");
  const [sortAsc, setSortAsc]         = useState(false);
  const [qualityFilter, setQF]        = useState<QualityFilter>("quality");

  function setSort(key: SortKey) {
    if (key === sortKey) setSortAsc(v => !v);
    else { setSortKey(key); setSortAsc(false); }
  }

  // ── Data fetching ──────────────────────────────────────────────────────────

  const { data: stats } = useQuery<ProStats>({
    queryKey: ["proStats"],
    queryFn:  () => fetch(`${BASE_URL}/api/pro/stats`).then(r => r.json()),
    refetchInterval: 30_000,
    staleTime:       20_000,
  });

  const { data: historyData, isLoading } = useQuery<{ total: number; totalAll: number; tokens: ProToken[] }>({
    queryKey: ["proHistory", qualityFilter, sortKey, sortAsc ? "asc" : "desc"],
    queryFn:  () =>
      fetch(`${BASE_URL}/api/pro/history?quality=${qualityFilter}&sort=${sortKey}&order=${sortAsc ? "asc" : "desc"}`)
        .then(r => r.json()),
    refetchInterval: 30_000,
    staleTime:       20_000,
  });

  const tokens     = historyData?.tokens ?? [];
  // Use stats.total as the canonical "called" count — it covers ALL pro_calls
  // including tokens that have since died (not filtered by current MC).
  const totalCalled = stats?.total ?? historyData?.totalAll ?? 0;
  const veryGoodCt = stats?.veryGoodCount ?? 0;
  const goodCt     = (stats?.qualityCount ?? 0) - veryGoodCt;

  // Client-side sort on top of server sort (ensures stable ordering during transitions)
  const sorted = [...tokens].sort((a, b) => {
    let diff = 0;
    if      (sortKey === "ath")      diff = (b.athMultiple ?? 0)           - (a.athMultiple ?? 0);
    else if (sortKey === "gain")     diff = (b.gainSinceCall ?? -Infinity)  - (a.gainSinceCall ?? -Infinity);
    else if (sortKey === "intel")    diff = (b.currentIntel ?? 0)           - (a.currentIntel ?? 0);
    else if (sortKey === "calledMc") diff = (b.calledMcUsd ?? 0)            - (a.calledMcUsd ?? 0);
    else if (sortKey === "calledAt") diff = new Date(b.calledAt).getTime()  - new Date(a.calledAt).getTime();
    else                             diff = (b.proScore ?? 0)               - (a.proScore ?? 0);
    return sortAsc ? -diff : diff;
  });

  const bestAth    = stats?.bestAth ?? null;
  const winRate    = stats?.winRate ?? 0;

  return (
    <div className="flex flex-col min-h-0 flex-1 gap-3 px-3 py-3 max-w-2xl mx-auto w-full">

      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Zap className="w-4 h-4" style={{ color: "#f59e0b" }} />
            <span className="text-[13px] font-black uppercase tracking-widest text-white">
              Pro Intel
            </span>
            <span
              className="px-1.5 py-0.5 rounded text-[8px] font-black uppercase tracking-wider"
              style={{ background: "#f59e0b20", color: "#f59e0b", border: "1px solid #f59e0b30" }}
            >
              Very Good + Good only
            </span>
          </div>
          <p className="text-[9px] text-[#484f58] mt-0.5">
            Intel ≥ 80 · KOL/Smart · MC ≥ $5K at call · Pro scored
          </p>
        </div>
        <div className="text-right">
          <div className="text-[11px] font-black text-white">{totalCalled}</div>
          <div className="text-[8px] text-[#484f58] uppercase tracking-widest">called</div>
        </div>
      </div>

      {/* ── Stats row ─────────────────────────────────────────────────────── */}
      <div className="flex gap-1.5 flex-wrap">
        <StatChip label="Win Rate" value={`${winRate}%`} accent="#22c55e" large />
        <StatChip label="Very Good" value={veryGoodCt} accent="#f59e0b" />
        <StatChip label="Good" value={goodCt} accent="#3b82f6" />
        <div className="w-px self-stretch" style={{ background: "#21262d" }} />
        <StatChip label="2×" value={stats?.x2Count ?? "—"} sub="ATH" />
        <StatChip label="3×" value={stats?.x3Count ?? "—"} />
        <StatChip label="5×" value={stats?.x5Count ?? "—"} />
        <StatChip label="10×" value={stats?.x10Count ?? "—"} accent={stats?.x10Count ? "#f59e0b" : undefined} />
        <StatChip label="100×" value={stats?.x100Count ?? "—"} accent={stats?.x100Count ? "#ef4444" : undefined} />
        <div className="w-px self-stretch" style={{ background: "#21262d" }} />
        <StatChip label="Best ATH" value={bestAth != null ? `${bestAth.toFixed(1)}×` : "—"} accent="#f59e0b" large />
      </div>

      {/* ── Filter + Sort row ─────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        {/* Quality filter tabs */}
        <div className="flex items-center gap-1.5">
          <FilterTab
            label="Quality" active={qualityFilter === "quality"}
            count={(stats?.qualityCount ?? 0)}
            onClick={() => setQF("quality")}
          />
          <FilterTab
            label="⭐ Very Good" active={qualityFilter === "very_good"}
            count={veryGoodCt}
            onClick={() => setQF("very_good")}
          />
          <FilterTab
            label="All" active={qualityFilter === "all"}
            count={totalCalled}
            onClick={() => setQF("all")}
          />
        </div>

        {/* Sort buttons */}
        <div className="flex items-center gap-1">
          {([
            { key: "proScore" as SortKey, label: "Score" },
            { key: "calledAt" as SortKey, label: "Recent" },
            { key: "ath"      as SortKey, label: "ATH" },
            { key: "gain"     as SortKey, label: "Gain" },
            { key: "intel"    as SortKey, label: "Intel" },
          ]).map(s => (
            <SortBtn key={s.key} label={s.label}
              active={sortKey === s.key} asc={sortKey === s.key && sortAsc}
              onClick={() => setSort(s.key)} />
          ))}
        </div>
      </div>

      {/* ── Pro Score legend ───────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 px-3 py-2 rounded-lg"
        style={{ background: "#0d1117", border: "1px solid #21262d" }}>
        <div className="flex items-center gap-1.5">
          <Star className="w-2.5 h-2.5" style={{ color: "#f59e0b" }} fill="#f59e0b" />
          <span className="text-[8px] font-bold" style={{ color: "#f59e0b" }}>Very Good</span>
          <span className="text-[7px] text-[#484f58]">≥ 75</span>
        </div>
        <div className="flex items-center gap-1.5">
          <BarChart2 className="w-2.5 h-2.5" style={{ color: "#3b82f6" }} />
          <span className="text-[8px] font-bold" style={{ color: "#3b82f6" }}>Good</span>
          <span className="text-[7px] text-[#484f58]">55–74</span>
        </div>
        <div className="w-px self-stretch" style={{ background: "#21262d" }} />
        <span className="text-[7px] text-[#30363d]">
          Intel strength · MC/Liq · ATH · Gain momentum · Run status · Risk
        </span>
      </div>

      {/* ── Token list ────────────────────────────────────────────────────── */}
      {isLoading ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-16 rounded-xl animate-pulse"
              style={{ background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.05)" }} />
          ))}
        </div>
      ) : sorted.length === 0 ? (
        <div className="flex flex-col items-center justify-center flex-1 py-20 gap-3">
          <TrendingUp className="w-10 h-10" style={{ color: "#21262d" }} />
          <div className="text-[10px] uppercase tracking-widest text-[#484f58]">
            No {qualityFilter === "very_good" ? "Very Good" : qualityFilter === "quality" ? "quality" : ""} tokens yet
          </div>
          <div className="text-[9px] text-[#30363d]">
            Tokens with Intel ≥ 80 + KOL/Smart + Pro Score ≥ 55 appear here
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {sorted.map(t => (
            <TokenRow key={t.id} t={t}
              onNavigate={() => navigate(`/tokens/${t.id}`)} />
          ))}
        </div>
      )}

      {/* ── Footer ────────────────────────────────────────────────────────── */}
      {sorted.length > 0 && (
        <div className="flex items-center justify-center gap-2 pt-1">
          <Zap className="w-2.5 h-2.5 text-[#30363d]" />
          <span className="text-[8px] text-[#30363d] tracking-widest uppercase">
            {sorted.length} shown · Pro Score updated every 5 min · ATH from called MC
          </span>
        </div>
      )}
    </div>
  );
}
