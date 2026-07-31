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
import { getApiBase } from "@/lib/api-base";
import {
  cn, truncateAddress, formatCompactUsd, formatTimeAgo,
  getGmgnUrl, safeSymbol,
} from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Socials { twitter?: string; telegram?: string; website?: string; }
type RunStatus   = "PUMPING" | "RAN" | "SLOW" | "FLAT" | "DEAD";
type QualityLabel = "very_good" | "good" | "below";
type SortKey     = "proScore" | "calledAt" | "ath" | "gain" | "intel" | "calledMc" | "survival";

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
  calledHolderVelocity?: number | null;
  currentMcUsd: number | null;
  gainSinceCall: number | null;
  athMultiple: number | null;
  runStatus: RunStatus;
  proScore: number;
  qualityLabel: QualityLabel;
  survivalScore?: number | null;
  entryTier?: string | null;
  scoreVersion?: string | null;
  currentKol: number;
  currentSmart: number;
  currentIntel: number | null;
  lastSnapshotAt: string | null;
  surfacedAt: string | null;
  surfacedMcUsd: number | null;
  kolSmartSource?: string | null;
  verifiedAt?: string | null;
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
  x10PlusCount?: number;
  x100Count: number;
  x200Count: number;
  bestAth: number | null;
  veryGoodCount: number;
  goodCount: number;
  qualityCount: number;
  recentCount: number;
  avgSurvival?: number | null;
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

// ── Token card ────────────────────────────────────────────────────────────────

function TokenRow({ t, onNavigate }: { t: ProToken; onNavigate: () => void }) {
  const { toast } = useToast();
  const sym = safeSymbol(t.symbol, t.address);

  const isVeryGood = t.qualityLabel === "very_good";
  const borderColor = isVeryGood ? "rgba(245,158,11,0.28)" : "rgba(59,130,246,0.22)";
  const accentColor = isVeryGood ? "#f59e0b" : "#3b82f6";
  const bgGlow = isVeryGood
    ? "linear-gradient(135deg, rgba(245,158,11,0.08) 0%, rgba(3,6,15,0.4) 55%)"
    : "linear-gradient(135deg, rgba(59,130,246,0.06) 0%, rgba(3,6,15,0.35) 55%)";

  return (
    <div
      onClick={onNavigate}
      className="relative flex flex-col gap-2.5 px-3 py-3 rounded-xl cursor-pointer transition-all duration-150 group active:scale-[0.995]"
      style={{
        background: bgGlow,
        border: `1px solid ${borderColor}`,
        boxShadow: isVeryGood ? "0 0 24px rgba(245,158,11,0.06)" : "none",
      }}
      onMouseEnter={e => (e.currentTarget.style.borderColor = accentColor + "88")}
      onMouseLeave={e => (e.currentTarget.style.borderColor = borderColor)}
    >
      {/* Quality accent strip */}
      <div
        className="absolute left-0 top-2.5 bottom-2.5 w-0.5 rounded-r"
        style={{
          background: isVeryGood
            ? "linear-gradient(180deg,#f59e0b,#22c55e)"
            : "linear-gradient(180deg,#3b82f6,#6366f1)",
        }}
      />

      {/* Top row: identity + quality */}
      <div className="flex items-start gap-3 pl-1">
        <TokenLogo logoUri={t.logoUri} address={t.address} symbol={t.symbol} />

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[12px] font-black text-white truncate max-w-[140px]">{sym}</span>
            <RunBadge status={t.runStatus} />
          </div>
          <div className="mt-1 flex items-center gap-2 flex-wrap">
            <QualityBadge label={t.qualityLabel} score={t.proScore} />
            <ProScoreBar score={t.proScore} />
          </div>
        </div>

        {/* Primary metrics — always visible */}
        <div className="flex flex-col items-end gap-0.5 shrink-0">
          <div className="flex items-center gap-1">
            <span className="text-[8px] text-[#484f58] uppercase tracking-widest">ATH</span>
            <span
              className="text-[13px] font-black tabular-nums"
              style={{ color: t.athMultiple != null && t.athMultiple >= 2 ? "#f59e0b" : "#c9d1d9" }}
            >
              {fmtAth(t.athMultiple)}
            </span>
          </div>
          <span className={cn("text-[11px] font-bold tabular-nums", gainColor(t.gainSinceCall))}>
            {fmtGain(t.gainSinceCall)}
          </span>
        </div>
      </div>

      {/* Metrics strip */}
      <div
        className="grid grid-cols-3 gap-2 pl-1 rounded-lg px-2 py-1.5"
        style={{ background: "rgba(0,0,0,0.25)", border: "1px solid rgba(255,255,255,0.04)" }}
      >
        <div>
          <div className="text-[7px] uppercase tracking-widest text-[#484f58]">Entry → Now</div>
          <div className="text-[9px] text-[#8b949e] tabular-nums truncate">
            {formatCompactUsd(t.calledMcUsd)} → {formatCompactUsd(t.currentMcUsd)}
          </div>
        </div>
        <div>
          <div className="text-[7px] uppercase tracking-widest text-[#484f58]">Smart / KOL @ call</div>
          <div className="text-[9px] font-bold tabular-nums">
            <span style={{ color: "#06b6d4" }}>S{t.calledSmart}</span>
            <span className="text-[#30363d]"> · </span>
            <span style={{ color: "#a855f7" }}>K{t.calledKol}</span>
            {(t.currentSmart !== t.calledSmart || t.currentKol !== t.calledKol) && (
              <span className="text-[#484f58] font-normal">
                {" "}(now S{t.currentSmart}·K{t.currentKol})
              </span>
            )}
          </div>
        </div>
        <div className="text-right">
          <div className="text-[7px] uppercase tracking-widest text-[#484f58]">
            Survive{t.survivalScore != null ? ` · ${Math.round(t.survivalScore)}` : ""}
          </div>
          <div className="flex items-center justify-end gap-1">
            <span className="text-[9px] text-[#8b949e]">{formatTimeAgo(t.calledAt)}</span>
            <SecurityIcons
              mint={t.secMintRenounced}
              freeze={t.secFreezeRenounced}
              honeypot={t.secIsHoneypot}
            />
          </div>
        </div>
      </div>

      {/* Actions — always visible on touch devices, hover-enhanced on desktop */}
      <div className="flex items-center gap-1 pl-1 opacity-90 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
        <button
          type="button"
          onClick={e => {
            e.stopPropagation();
            navigator.clipboard.writeText(t.address);
            toast({ title: "Copied", description: t.address.slice(0, 20) + "…" });
          }}
          className="p-1.5 rounded-md hover:bg-white/5"
          aria-label="Copy address"
        >
          <Copy className="w-3.5 h-3.5 text-[#484f58]" />
        </button>
        <a
          href={getGmgnUrl(t.chain, t.address)}
          target="_blank"
          rel="noopener noreferrer"
          onClick={e => e.stopPropagation()}
          className="p-1.5 rounded-md hover:bg-white/5"
          aria-label="Open on GMGN"
        >
          <ExternalLink className="w-3.5 h-3.5 text-[#484f58]" />
        </a>
        {t.socials.twitter && (
          <a
            href={t.socials.twitter}
            target="_blank"
            rel="noopener noreferrer"
            onClick={e => e.stopPropagation()}
            className="p-1.5 rounded-md hover:bg-white/5"
          >
            <Twitter className="w-3.5 h-3.5 text-[#484f58]" />
          </a>
        )}
        {t.socials.telegram && (
          <a
            href={t.socials.telegram}
            target="_blank"
            rel="noopener noreferrer"
            onClick={e => e.stopPropagation()}
            className="p-1.5 rounded-md hover:bg-white/5"
          >
            <Send className="w-3.5 h-3.5 text-[#484f58]" />
          </a>
        )}
        {t.socials.website && (
          <a
            href={t.socials.website}
            target="_blank"
            rel="noopener noreferrer"
            onClick={e => e.stopPropagation()}
            className="p-1.5 rounded-md hover:bg-white/5"
          >
            <Globe className="w-3.5 h-3.5 text-[#484f58]" />
          </a>
        )}
        <span className="ml-auto text-[8px] uppercase tracking-widest text-[#30363d]">Tap for detail</span>
      </div>
    </div>
  );
}

// ── Quality filter tab ────────────────────────────────────────────────────────

// ATH section filters: x5 (5–10×), x10 (10–20×), x10plus (≥20× "10× more")
type QualityFilter = "quality" | "very_good" | "good" | "recent" | "x5" | "x10" | "x10plus" | "sections";

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

// ── Main page ─────────────────────────────────────────────────────────────────

const BASE_URL = getApiBase().replace(/\/$/, "");

export default function Caller() {
  const [, navigate] = useLocation();
  const [sortKey, setSortKey]         = useState<SortKey>("proScore");
  const [sortAsc, setSortAsc]         = useState(false);
  // Default: three ATH sections (5× / 10× / 10×+)
  const [qualityFilter, setQF]        = useState<QualityFilter>("sections");

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
    refetchOnWindowFocus: true,
  });

  const isSections = qualityFilter === "sections";
  const apiQuality = qualityFilter === "recent" ? "recent"
    : isSections ? "quality"
    : qualityFilter;
  const apiSort    = qualityFilter === "recent" ? "calledAt" : sortKey;
  const apiOrder   = qualityFilter === "recent" ? "desc" : (sortAsc ? "asc" : "desc");

  const { data: historyData, isLoading } = useQuery<{ total: number; totalAll: number; tokens: ProToken[] }>({
    queryKey: ["proHistory", qualityFilter, sortKey, sortAsc ? "asc" : "desc"],
    queryFn:  () =>
      fetch(`${BASE_URL}/api/pro/history?quality=${apiQuality}&sort=${apiSort}&order=${apiOrder}&limit=150`)
        .then(r => r.json()),
    refetchInterval: 30_000,
    staleTime:       20_000,
    refetchOnWindowFocus: true,
    placeholderData: (prev) => prev,
  });

  const sorted      = historyData?.tokens ?? [];
  const sectionX5   = sorted.filter(t => (t.athMultiple ?? 0) >= 5 && (t.athMultiple ?? 0) < 10);
  const sectionX10  = sorted.filter(t => (t.athMultiple ?? 0) >= 10 && (t.athMultiple ?? 0) < 20);
  const sectionX10p = sorted.filter(t => (t.athMultiple ?? 0) >= 20);

  const totalCalled = stats?.total ?? 0;
  const veryGoodCt  = stats?.veryGoodCount ?? 0;
  const goodCt      = stats?.goodCount     ?? 0;
  const recentCt    = stats?.recentCount   ?? 0;
  const x5Ct        = stats?.x5Count ?? sectionX5.length;
  const x10Ct       = stats?.x10Count ?? sectionX10.length;
  const x10PlusCt   = stats?.x10PlusCount ?? sectionX10p.length;

  const bestAth    = stats?.bestAth ?? null;
  const winRate    = stats?.winRate ?? 0;

  return (
    <div className="flex flex-col min-h-0 flex-1 gap-3 px-3 py-3 md:px-6 md:py-5 max-w-2xl mx-auto w-full">

      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Zap className="w-4 h-4 shrink-0" style={{ color: "#f59e0b" }} />
            <span className="text-[13px] font-black uppercase tracking-widest text-white">
              Pro Intel
            </span>
            <span
              className="px-1.5 py-0.5 rounded text-[8px] font-black uppercase tracking-wider"
              style={{ background: "#f59e0b20", color: "#f59e0b", border: "1px solid #f59e0b30" }}
            >
              Score v2 · On-time
            </span>
          </div>
          <p className="text-[9px] text-[#484f58] mt-0.5">
            5× · 10× · 10×+ sections — Pro Score v2 + survival
          </p>
        </div>
        <div
          className="text-right px-2.5 py-1.5 rounded-xl shrink-0"
          style={{ background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.2)" }}
        >
          <div className="text-[14px] font-black text-[#f59e0b] tabular-nums">{totalCalled}</div>
          <div className="text-[7px] text-[#f59e0b]/70 uppercase tracking-widest">quality</div>
        </div>
      </div>

      {/* ── Stats row ─────────────────────────────────────────────────────── */}
      <div className="flex gap-1.5 overflow-x-auto no-scrollbar pb-0.5 -mx-0.5 px-0.5">
        <StatChip label="Win Rate" value={`${winRate}%`} accent="#22c55e" large />
        <StatChip label="Very Good" value={veryGoodCt} accent="#f59e0b" />
        <StatChip label="Good" value={goodCt} accent="#3b82f6" />
        <div className="w-px self-stretch shrink-0" style={{ background: "#21262d" }} />
        <StatChip label="5×" value={x5Ct} sub="band" accent="#22c55e" />
        <StatChip label="10×" value={x10Ct} sub="band" accent="#3b82f6" />
        <StatChip label="10×+" value={x10PlusCt} sub="≥20×" accent="#f59e0b" />
        <StatChip label="100×" value={stats?.x100Count ?? "—"} accent={stats?.x100Count ? "#ef4444" : undefined} />
        <div className="w-px self-stretch shrink-0" style={{ background: "#21262d" }} />
        <StatChip label="Best ATH" value={bestAth != null ? `${bestAth.toFixed(1)}×` : "—"} accent="#f59e0b" large />
        {stats?.avgSurvival != null && (
          <StatChip label="Survive" value={Math.round(stats.avgSurvival)} accent="#06b6d4" />
        )}
      </div>

      {/* ── Sticky filter + sort (mobile-friendly) ─────────────────────────── */}
      <div
        className="sticky top-12 md:top-0 z-20 -mx-3 px-3 py-2 space-y-2"
        style={{
          background: "rgba(3,6,15,0.88)",
          backdropFilter: "blur(10px)",
          borderBottom: "1px solid rgba(255,255,255,0.04)",
        }}
      >
        <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar">
          <FilterTab
            label="Sections" active={qualityFilter === "sections"}
            count={x5Ct + x10Ct + x10PlusCt}
            onClick={() => setQF("sections")}
          />
          <FilterTab
            label="5×" active={qualityFilter === "x5"}
            count={x5Ct}
            onClick={() => setQF("x5")}
          />
          <FilterTab
            label="10×" active={qualityFilter === "x10"}
            count={x10Ct}
            onClick={() => setQF("x10")}
          />
          <FilterTab
            label="10×+" active={qualityFilter === "x10plus"}
            count={x10PlusCt}
            onClick={() => setQF("x10plus")}
          />
          <FilterTab
            label="Very Good" active={qualityFilter === "very_good"}
            count={veryGoodCt}
            onClick={() => setQF("very_good")}
          />
          <FilterTab
            label="Good" active={qualityFilter === "good"}
            count={goodCt}
            onClick={() => setQF("good")}
          />
          <FilterTab
            label="All Quality" active={qualityFilter === "quality"}
            count={totalCalled}
            onClick={() => setQF("quality")}
          />
          <FilterTab
            label="Recent" active={qualityFilter === "recent"}
            count={recentCt}
            onClick={() => setQF("recent")}
          />
        </div>

        <div className="flex items-center gap-1.5">
          <span className="text-[8px] uppercase tracking-widest text-[#30363d] shrink-0">Sort</span>
          <div className="flex items-center gap-1 overflow-x-auto no-scrollbar">
            {([
              { key: "proScore" as SortKey, label: "Score" },
              { key: "survival" as SortKey, label: "Survive" },
              { key: "calledAt" as SortKey, label: "Age" },
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
      </div>

      {/* ── Pro Score legend ───────────────────────────────────────────────── */}
      <div
        className="flex items-center gap-3 px-3 py-2 rounded-xl overflow-x-auto no-scrollbar"
        style={{ background: "rgba(13,17,23,0.8)", border: "1px solid #21262d" }}
      >
        <div className="flex items-center gap-1.5 shrink-0">
          <Star className="w-2.5 h-2.5" style={{ color: "#f59e0b" }} fill="#f59e0b" />
          <span className="text-[8px] font-bold" style={{ color: "#f59e0b" }}>Very Good</span>
          <span className="text-[7px] text-[#484f58]">≥ 75</span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <BarChart2 className="w-2.5 h-2.5" style={{ color: "#3b82f6" }} />
          <span className="text-[8px] font-bold" style={{ color: "#3b82f6" }}>Good</span>
          <span className="text-[7px] text-[#484f58]">55–74</span>
        </div>
        <div className="w-px self-stretch shrink-0" style={{ background: "#21262d" }} />
        <span className="text-[7px] text-[#30363d] whitespace-nowrap">
          Entry · HV · Smart · Survival · Risk · Momentum
        </span>
      </div>

      {/* ── Token list / sections ──────────────────────────────────────────── */}
      {isLoading ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-16 rounded-xl animate-pulse"
              style={{ background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.05)" }} />
          ))}
        </div>
      ) : isSections ? (
        <div className="flex flex-col gap-5">
          {([
            { key: "x5", title: "5× Club", sub: "5× – 10× ATH from call", accent: "#22c55e", tokens: sectionX5 },
            { key: "x10", title: "10× Club", sub: "10× – 20× ATH from call", accent: "#3b82f6", tokens: sectionX10 },
            { key: "x10plus", title: "10×+ Runners", sub: "≥ 20× — well past 10×", accent: "#f59e0b", tokens: sectionX10p },
          ] as const).map(sec => (
            <section key={sec.key} className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className="px-2 py-0.5 rounded text-[10px] font-black uppercase tracking-widest"
                    style={{ background: `${sec.accent}18`, color: sec.accent, border: `1px solid ${sec.accent}40` }}
                  >
                    {sec.title}
                  </span>
                  <span className="text-[8px] text-[#484f58] truncate">{sec.sub}</span>
                </div>
                <span className="text-[10px] font-black tabular-nums" style={{ color: sec.accent }}>
                  {sec.tokens.length}
                </span>
              </div>
              {sec.tokens.length === 0 ? (
                <div className="text-[9px] text-[#30363d] px-1 py-3">No tokens in this band yet</div>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {sec.tokens.map(t => (
                    <TokenRow key={t.id} t={t} onNavigate={() => navigate(`/tokens/${t.id}`)} />
                  ))}
                </div>
              )}
            </section>
          ))}
        </div>
      ) : sorted.length === 0 ? (
        <div className="flex flex-col items-center justify-center flex-1 py-20 gap-3">
          <TrendingUp className="w-10 h-10" style={{ color: "#21262d" }} />
          <div className="text-[10px] uppercase tracking-widest text-[#484f58]">
            No tokens in this filter yet
          </div>
          <div className="text-[9px] text-[#30363d]">
            Event-driven intel → Pro Score v2 surfaces quality calls in seconds
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
      {(isSections ? sectionX5.length + sectionX10.length + sectionX10p.length : sorted.length) > 0 && (
        <div className="flex items-center justify-center gap-2 pt-1">
          <Zap className="w-2.5 h-2.5 text-[#30363d]" />
          <span className="text-[8px] text-[#30363d] tracking-widest uppercase">
            Pro Score v2 · hot snapshots 30s · ATH from called MC
          </span>
        </div>
      )}
    </div>
  );
}
