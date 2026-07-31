import { useRoute, useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft, ExternalLink, Copy, CheckCheck, RefreshCw,
  Clock, TrendingUp, Brain, Zap, Star, FileSearch,
} from "lucide-react";
import {
  AreaChart, Area, LineChart, Line, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid, ReferenceLine,
} from "recharts";
import { useState, useCallback, useEffect, useRef } from "react";
import {
  formatTokenPrice, formatGain, formatMarketCap, formatTimeAgo,
  truncateAddress, getGmgnUrl, cn,
} from "@/lib/utils";
import { getApiBase } from "@/lib/api-base";

// ── Types ─────────────────────────────────────────────────────────────────────

interface TokenDetail {
  id: number;
  address: string;
  chain: string;
  name: string | null;
  symbol: string | null;
  logoUri: string | null;
  detectedPriceUsd: string | null;
  currentPriceUsd: string | null;
  athMarketCapUsd: string | null;
  marketCapUsd: string | null;
  liquidityUsd: string | null;
  volume24hUsd: string | null;
  tokenCreatedAt: string | null;
  firstDetectedAt: string;
  lastBuyAt: string | null;
  priceUpdatedAt: string | null;
  status: string;
  detectionGainPct: number | null;
  athGainPct: number | null;
  holderCount: number;
  holderKolCount: number;
  holderSmartCount: number;
  lastHoldersUpdatedAt: string | null;
  intelligenceScore?: number;
  qualityLabel?: string;
  mcGrowthScore?: number;
  volumeIntensityScore?: number;
  holderVelocityScore?: number;
  kolSmartScore?: number;
  liquidityHealthScore?: number;
  intelligenceUpdatedAt?: string | null;
  consecutivePositiveChecks?: number;
  security?: { ctoFlag?: boolean } | null;
}

interface KolSmartFetchResult {
  kolCount: number;
  smartCount: number;
  totalCount: number;
  upserted: number;
  fetchedAt: string;
  wallets: unknown[];
}

interface GmgnResponse {
  holderIntel?: { kolCount?: number; smartCount?: number; holderCount?: number };
}

interface HistorySnapshot {
  snapshotAt: string;
  marketCapUsd: string | null;
  priceUsd: string | null;
  liquidityUsd: string | null;
}

interface IntelLogEntry {
  computedAt: string;
  intelligenceScore: number;
  prevIntelligenceScore: number | null;
  mcGrowthScore: number;
  volumeIntensityScore: number;
  holderVelocityScore: number;
  kolSmartScore: number;
  liquidityHealthScore: number;
  marketCapUsd: string | null;
  holderCount: number | null;
  statusBefore: string;
  statusAfter: string;
  statusChanged: boolean;
  trigger: string;
}

interface RugAnalysis {
  peakMcUsd: number | null;
  currentMcUsd: number | null;
  drawdownPct: number | null;
  peakToCurrentHours: number | null;
  rugSeverity: "rug" | "dump" | "decline" | "stable" | "recovering" | "correction" | "stabilizing";
  currentMultiple: number | null;
  athMultiple: number | null;
}

interface HistoryResponse {
  snapshots: HistorySnapshot[];
  intelLog: IntelLogEntry[];
  rugAnalysis: RugAnalysis;
  fetchedAt: string;
}

interface ProCallData {
  id: number;
  calledAt: string;
  calledMcUsd: number | null;
  calledIntelScore: number | null;
  calledKolCount: number;
  calledSmartCount: number;
  calledHolderVelocity?: number | null;
  athMultiple: number | null;
  proScore: number | null;
  qualityLabel: string | null;
  survivalScore?: number | null;
  entryTier?: string | null;
  liveKol?: number;
  liveSmart?: number;
  liveHv?: number | null;
  currentMcUsd?: number | null;
  runStatus?: string | null;
  socials?: { twitter?: string; telegram?: string; website?: string };
  hit2x?: boolean; hit5x?: boolean; hit10x?: boolean;
  hit2xAt?: string | null; hit5xAt?: string | null; hit10xAt?: string | null;
  kolSmartSource?: string | null;
  callAlertSentAt?: string | null;
}

interface ProSnapshotRow {
  snapshotAt: string;
  mcUsd: number | null;
  gainPct: number | null;
  athMultiple: number | null;
  kolCount: number;
  smartCount: number;
  kolDelta: number;
  smartDelta: number;
  holderVelocityScore: number | null;
  survivalScore: number | null;
  runStatus: string | null;
}

interface ProPostmortem {
  severity: string;
  headline: string;
  summary: string;
  notes: string[];
  entry: { mcUsd: number | null; intel: number | null; kol: number; smart: number; hv: number | null; tier: string | null; at: string };
  now: {
    mcUsd: number | null; gainPct: number | null; athMultiple: number | null;
    kol: number; smart: number; kolDelta: number; smartDelta: number;
    hv: number | null; survival: number | null; proScore: number | null; runStatus: string | null;
    liquidityUsd: number | null; holders: number | null;
  };
  milestones: Array<{ tier: number; hit: boolean; at: string | null }>;
  socials: { twitter?: string; telegram?: string; website?: string };
}

interface ProTokenResponse {
  proCall: ProCallData | null;
  postmortem: ProPostmortem | null;
  snapshots: ProSnapshotRow[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function gainColor(pct: number | null | undefined) {
  if (pct == null) return "text-[#8b949e]";
  if (pct > 0) return "text-[#22c55e]";
  if (pct < 0) return "text-[#ef4444]";
  return "text-[#8b949e]";
}

function fmtMc(v: number) {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000)     return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

function StatusBadge({ status }: { status?: string }) {
  const s = (status ?? "").toLowerCase();
  const cfg: Record<string, string> = {
    new:      "text-[#60a5fa] bg-[#60a5fa]/10 border-[#60a5fa]/20",
    active:   "text-[#22c55e] bg-[#22c55e]/10 border-[#22c55e]/20",
    watch:    "text-[#f59e0b] bg-[#f59e0b]/10 border-[#f59e0b]/20",
    revived:  "text-[#a78bfa] bg-[#a78bfa]/10 border-[#a78bfa]/20",
    archive:  "text-[#8b949e] bg-[#8b949e]/10 border-[#30363d]",
    dumped:   "text-[#ef4444] bg-[#ef4444]/10 border-[#ef4444]/20",
    migrated: "text-[#a78bfa] bg-[#a78bfa]/10 border-[#a78bfa]/20",
  };
  return (
    <span className={cn("text-[9px] font-bold px-1.5 py-0.5 border tracking-widest uppercase", cfg[s] ?? "text-[#8b949e] border-[#30363d]")}>
      {s === "migrated" ? "🔀 MIG" : (status ?? "?").toUpperCase()}
    </span>
  );
}

function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      className="text-[#484f58] hover:text-[#c9d1d9] transition-colors"
    >
      {copied ? <CheckCheck className="w-3.5 h-3.5 text-[#22c55e]" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
}

function TokenDetailLogo({ logoUri, address, symbol }: { logoUri?: string | null; address: string; symbol?: string | null }) {
  const [err, setErr] = useState(false);
  if (logoUri && !err) {
    return <img src={logoUri} alt={symbol ?? ""} onError={() => setErr(true)} className="w-12 h-12 object-cover border border-[#30363d] shrink-0" />;
  }
  return (
    <div className="w-12 h-12 bg-[#161b22] border border-[#30363d] flex items-center justify-center text-lg font-bold text-[#f59e0b] shrink-0">
      {(symbol ?? address.slice(0, 2)).slice(0, 2).toUpperCase()}
    </div>
  );
}

// Compact intel score pill
function IntelScorePill({ score, label }: { score: number; label: string }) {
  const scoreColor =
    label === "Elite"       ? "#a78bfa" :
    label === "Excellent"   ? "#22c55e" :
    label === "Strong"      ? "#10b981" :
    label === "Good"        ? "#3b82f6" :
    label === "Average"     ? "#f59e0b" :
    label === "Speculative" ? "#f97316" : "#ef4444";
  return (
    <span
      className="inline-flex items-center gap-1 text-[9px] font-black px-2 py-0.5 border tracking-wider uppercase"
      style={{ color: scoreColor, borderColor: scoreColor + "40", background: scoreColor + "15" }}
    >
      <Brain className="w-2.5 h-2.5" />
      {Math.round(score)} · {label}
    </span>
  );
}

// Price/stat card
function StatCard({ label, value, sub, accent }: {
  label: string; value: React.ReactNode; sub?: React.ReactNode; accent?: boolean;
}) {
  return (
    <div className={cn(
      "p-3 border flex flex-col gap-0.5",
      accent ? "border-[#f59e0b]/30 bg-[#f59e0b]/5" : "border-[#30363d] bg-[#161b22]",
    )}>
      <div className="text-[9px] text-[#484f58] uppercase tracking-widest">{label}</div>
      <div className={cn("text-base font-bold leading-tight tabular-nums", accent ? "text-[#f59e0b]" : "text-[#c9d1d9]")}>
        {value}
      </div>
      {sub && <div className="text-[10px] text-[#8b949e]">{sub}</div>}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function TokenDetailPage() {
  const [, params]      = useRoute("/tokens/:id");
  const [, setLocation] = useLocation();
  const id = params?.id ? parseInt(params.id, 10) : null;
  const qc = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);

  const BASE = getApiBase();

  // KOL/Smart auto-fetch
  const [kolSmartResult, setKolSmartResult] = useState<KolSmartFetchResult | null>(null);
  const [kolSmartLoading, setKolSmartLoading] = useState(false);
  const fetchedForId = useRef<number | null>(null);

  const fetchKolSmart = useCallback(async (tokenId: number) => {
    if (fetchedForId.current === tokenId) return;
    fetchedForId.current = tokenId;
    setKolSmartLoading(true);
    try {
      const r = await fetch(`${BASE}api/holders/token/${tokenId}/fetch`, { method: "POST" });
      if (!r.ok) throw new Error(`${r.status}`);
      const data: KolSmartFetchResult = await r.json();
      setKolSmartResult(data);
    } catch {
      fetchedForId.current = null;
    } finally {
      setKolSmartLoading(false);
    }
  }, [BASE]);

  useEffect(() => {
    if (id != null) fetchKolSmart(id);
  }, [id, fetchKolSmart]);

  const { data: token, isLoading } = useQuery<TokenDetail>({
    queryKey: ["token", id],
    queryFn: async () => {
      const r = await fetch(`${BASE}api/tokens/${id}`);
      if (!r.ok) throw new Error(`${r.status}`);
      return r.json();
    },
    enabled: id != null,
    refetchInterval: 15_000,
  });

  const { data: gmgn } = useQuery<GmgnResponse>({
    queryKey: ["token-gmgn-intelligence", id],
    queryFn: async () => {
      const r = await fetch(`${BASE}api/tokens/${id}/gmgn`);
      if (!r.ok) throw new Error(`${r.status}`);
      return r.json();
    },
    enabled: id != null,
    refetchInterval: 30_000,
    staleTime: 10_000,
  });

  const { data: historyData, isLoading: historyLoading } = useQuery<HistoryResponse>({
    queryKey: ["token-history", id],
    queryFn: async () => {
      const r = await fetch(`${BASE}api/tokens/${id}/history`);
      if (!r.ok) throw new Error(`${r.status}`);
      return r.json();
    },
    enabled: id != null,
    staleTime: 2 * 60_000,
  });

  const { data: proPack } = useQuery<ProTokenResponse>({
    queryKey: ["token-pro-call", id],
    queryFn: async () => {
      const r = await fetch(`${BASE}api/pro/token/${id}`);
      if (!r.ok) throw new Error(`${r.status}`);
      return r.json();
    },
    enabled: id != null,
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
  const proCallData = proPack;

  const handleRefresh = useCallback(async () => {
    if (!id || refreshing) return;
    setRefreshing(true);
    try {
      await fetch(`${BASE}api/tokens/${id}/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ holders: true }),
      });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["token", id] }),
        qc.invalidateQueries({ queryKey: ["token-gmgn-intelligence", id] }),
        qc.invalidateQueries({ queryKey: ["token-history", id] }),
      ]);
    } finally {
      setRefreshing(false);
    }
  }, [id, refreshing, qc, BASE]);

  if (isLoading) {
    return (
      <div className="space-y-4 animate-pulse px-4 py-6">
        <div className="h-4 w-20 bg-[#161b22]" />
        <div className="h-16 bg-[#161b22] border border-[#30363d]" />
        <div className="grid grid-cols-2 gap-2">
          {Array(4).fill(0).map((_, i) => <div key={i} className="h-14 bg-[#161b22] border border-[#30363d]" />)}
        </div>
      </div>
    );
  }

  if (!token) {
    return (
      <div className="text-center py-24 text-[#8b949e]">
        <p className="text-sm tracking-widest uppercase">Token not found</p>
        <button className="mt-4 text-[#f59e0b] text-xs tracking-widest uppercase hover:underline" onClick={() => setLocation("/")}>
          ← Back
        </button>
      </div>
    );
  }

  const gmgnUrl  = getGmgnUrl(token.chain, token.address);
  const kolCount = kolSmartResult?.kolCount   ?? gmgn?.holderIntel?.kolCount   ?? token.holderKolCount   ?? 0;
  const smtCount = kolSmartResult?.smartCount ?? gmgn?.holderIntel?.smartCount ?? token.holderSmartCount ?? 0;

  // Intelligence score label
  const score = token.intelligenceScore ?? 0;
  const scoreLabel = token.qualityLabel ?? (
    score >= 82 ? "Elite" : score >= 72 ? "Excellent" : score >= 62 ? "Strong" :
    score >= 52 ? "Good"  : score >= 40 ? "Average"   : score >= 25 ? "Speculative" : "Weak"
  );

  // Pro call MC reference
  const calledMc = proCallData?.proCall?.calledMcUsd ?? null;
  const pm = proCallData?.postmortem ?? null;
  const proSnaps = proCallData?.snapshots ?? [];
  const proSocials = pm?.socials ?? proCallData?.proCall?.socials ?? {};

  return (
    <div className="space-y-4">
      {/* Back */}
      <button
        className="flex items-center gap-1.5 text-[#484f58] hover:text-[#f59e0b] transition-colors text-[10px] tracking-widest uppercase"
        onClick={() => setLocation("/")}
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        Dashboard
      </button>

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="border border-[#30363d] bg-[#0d1117] p-4 space-y-3">
        {/* Top row: logo + name/ticker */}
        <div className="flex items-start gap-3">
          <TokenDetailLogo logoUri={token.logoUri} address={token.address} symbol={token.symbol} />
          <div className="flex-1 min-w-0">
            {/* Name + status + KOL/Smart */}
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl font-bold text-[#f59e0b] tracking-tight leading-none">
                {token.name || "Unknown Token"}
              </h1>
              <StatusBadge status={token.status} />
              {/* KOL/Smart counts next to name */}
              {(kolCount > 0 || kolSmartLoading) && (
                <span className={cn(
                  "inline-flex items-center gap-1 text-[9px] font-black px-1.5 py-0.5 border tracking-wider uppercase",
                  kolCount > 0
                    ? "text-[#f59e0b] bg-[#f59e0b]/10 border-[#f59e0b]/30"
                    : "text-[#484f58] border-[#30363d]"
                )}>
                  <Star className="w-2.5 h-2.5" />
                  {kolSmartLoading && kolCount === 0 ? "…" : kolCount} KOL
                </span>
              )}
              {(smtCount > 0 || kolSmartLoading) && (
                <span className={cn(
                  "inline-flex items-center gap-1 text-[9px] font-black px-1.5 py-0.5 border tracking-wider uppercase",
                  smtCount > 0
                    ? "text-[#60a5fa] bg-[#60a5fa]/10 border-[#60a5fa]/30"
                    : "text-[#484f58] border-[#30363d]"
                )}>
                  <Brain className="w-2.5 h-2.5" />
                  {kolSmartLoading && smtCount === 0 ? "…" : smtCount} Smart
                </span>
              )}
            </div>

            {/* Symbol + chain + address */}
            <div className="flex items-center gap-2 mt-1.5 text-[10px] text-[#8b949e] flex-wrap">
              <span className="text-[#c9d1d9] font-bold">{token.symbol ?? "—"}</span>
              <span className="text-[#30363d]">·</span>
              <span className="uppercase tracking-widest text-[#484f58]">{token.chain}</span>
              <span className="text-[#30363d]">·</span>
              <span className="font-mono text-[#484f58]">{truncateAddress(token.address)}</span>
              <CopyBtn text={token.address} />
              <a href={gmgnUrl} target="_blank" rel="noopener noreferrer" className="text-[#484f58] hover:text-[#f59e0b]">
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </div>

            {/* Intel score + refresh */}
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              {score > 0 && <IntelScorePill score={score} label={scoreLabel} />}
              {token.intelligenceUpdatedAt && (
                <span className="text-[9px] text-[#30363d] tracking-widest">
                  updated {formatTimeAgo(token.intelligenceUpdatedAt)} ago
                </span>
              )}
              <button
                className="ml-auto flex items-center gap-1 text-[9px] text-[#484f58] hover:text-[#f59e0b] tracking-widest uppercase transition-colors disabled:opacity-40"
                onClick={handleRefresh}
                disabled={refreshing}
              >
                <RefreshCw className={cn("w-3 h-3", refreshing && "animate-spin")} />
                {refreshing ? "…" : "Refresh"}
              </button>
            </div>
          </div>
        </div>

        {/* Graduation bar if new status */}
        {token.status === "new" && (token.consecutivePositiveChecks ?? 0) > 0 && (
          <div>
            <div className="text-[9px] text-[#484f58] uppercase tracking-widest mb-1.5">
              Graduation {token.consecutivePositiveChecks}/3 checks
            </div>
            <div className="flex gap-1">
              {[1, 2, 3].map(n => (
                <div key={n} className={cn("h-1 flex-1", n <= (token.consecutivePositiveChecks ?? 0) ? "bg-[#22c55e]" : "bg-[#30363d]")} />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Price / MC Stats ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-2">
        <StatCard
          label="Current Price"
          value={formatTokenPrice(token.currentPriceUsd)}
          sub={token.priceUpdatedAt ? `${formatTimeAgo(token.priceUpdatedAt)} ago` : undefined}
        />
        <StatCard
          label="ATH Market Cap"
          value={formatMarketCap(token.athMarketCapUsd)}
          sub={token.athGainPct != null ? (
            <span className={gainColor(token.athGainPct)}>{formatGain(token.athGainPct)} ATH</span>
          ) : undefined}
          accent
        />
        <StatCard
          label="Gain from Entry"
          value={<span className={gainColor(token.detectionGainPct)}>{formatGain(token.detectionGainPct)}</span>}
          sub="entry → live"
        />
        <StatCard
          label="Current MC"
          value={formatMarketCap(token.marketCapUsd)}
          sub={calledMc != null ? (
            <span className="flex items-center gap-1 text-[#484f58]">
              <Zap className="w-2.5 h-2.5 text-[#f59e0b]" />
              Called @ {fmtMc(calledMc)}
            </span>
          ) : undefined}
        />
      </div>

      {/* Called at MC (if proCall exists — shown as a full-width strip) */}
      {calledMc != null && (
        <div className="flex items-center gap-3 px-4 py-2.5 border border-[#f59e0b]/20 bg-[#f59e0b]/5 text-[10px] tracking-widest">
          <Zap className="w-3 h-3 text-[#f59e0b] shrink-0" />
          <span className="text-[#484f58]">CALLED @</span>
          <span className="text-[#f59e0b] font-bold">{fmtMc(calledMc)}</span>
          <span className="text-[#30363d]">→</span>
          <span className="text-[#484f58]">NOW</span>
          <span className="text-[#c9d1d9] font-bold">{formatMarketCap(token.marketCapUsd)}</span>
          {token.marketCapUsd && calledMc > 0 && (() => {
            const mult = parseFloat(token.marketCapUsd) / calledMc;
            const color = mult >= 2 ? "#22c55e" : mult >= 1 ? "#f59e0b" : "#ef4444";
            return (
              <span className="ml-auto font-bold tabular-nums" style={{ color }}>
                {mult >= 1 ? `${mult.toFixed(1)}×` : `-${((1 - mult) * 100).toFixed(0)}%`}
              </span>
            );
          })()}
        </div>
      )}

      {/* ── Pro Desk (trader view) ───────────────────────────────────────────── */}
      {pm && proCallData?.proCall && (
        <div className="border border-[#30363d] bg-[#0d1117] p-4 space-y-3">
          <div className="flex items-start justify-between gap-2 flex-wrap">
            <div>
              <div className="text-[9px] text-[#484f58] uppercase tracking-widest">Pro Desk</div>
              <div className="text-sm font-bold text-[#c9d1d9]">{pm.headline}</div>
              <div className="text-[10px] text-[#8b949e] mt-0.5">{pm.summary}</div>
            </div>
            <div className="text-right text-[10px] space-y-0.5">
              <div className="text-[#a78bfa] font-bold">Pro {Math.round(pm.now.proScore ?? 0)}</div>
              <div className="text-[#06b6d4]">Survive {Math.round(pm.now.survival ?? 0)}</div>
              <div className="text-[#484f58] uppercase tracking-widest">{pm.now.runStatus ?? "—"}</div>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <StatCard label="Entry MC" value={pm.entry.mcUsd != null ? fmtMc(pm.entry.mcUsd) : "—"} sub={pm.entry.tier ?? undefined} accent />
            <StatCard
              label="Gain from Call"
              value={<span className={gainColor(pm.now.gainPct)}>{pm.now.gainPct != null ? `${pm.now.gainPct >= 0 ? "+" : ""}${pm.now.gainPct.toFixed(0)}%` : "—"}</span>}
              sub={pm.now.athMultiple != null ? `ATH ${pm.now.athMultiple.toFixed(1)}×` : undefined}
            />
            <StatCard
              label="KOL @ call → now"
              value={`K${pm.entry.kol} → ${pm.now.kol}`}
              sub={pm.now.kolDelta !== 0 ? `${pm.now.kolDelta > 0 ? "+" : ""}${pm.now.kolDelta} since call` : "flat"}
            />
            <StatCard
              label="Smart @ call → now"
              value={`S${pm.entry.smart} → ${pm.now.smart}`}
              sub={pm.now.smartDelta !== 0 ? `${pm.now.smartDelta > 0 ? "+" : ""}${pm.now.smartDelta} since call` : "flat"}
            />
          </div>

          <div className="grid grid-cols-3 gap-2 text-[10px]">
            <div className="border border-[#30363d] p-2">
              <div className="text-[#484f58] uppercase tracking-widest text-[8px]">Intel / HV</div>
              <div className="text-[#c9d1d9] font-bold tabular-nums">
                {Math.round(pm.entry.intel ?? 0)} · HV {Math.round(pm.entry.hv ?? pm.now.hv ?? 0)}
              </div>
            </div>
            <div className="border border-[#30363d] p-2">
              <div className="text-[#484f58] uppercase tracking-widest text-[8px]">Milestones</div>
              <div className="flex gap-1.5 mt-0.5 font-bold">
                {pm.milestones.map(m => (
                  <span key={m.tier} style={{ color: m.hit ? "#22c55e" : "#30363d" }}>{m.tier}×</span>
                ))}
              </div>
            </div>
            <div className="border border-[#30363d] p-2">
              <div className="text-[#484f58] uppercase tracking-widest text-[8px]">Liq / Holders</div>
              <div className="text-[#c9d1d9] font-bold tabular-nums">
                {pm.now.liquidityUsd != null ? fmtMc(pm.now.liquidityUsd) : "—"} · {pm.now.holders ?? "—"}
              </div>
            </div>
          </div>

          {(proSocials.twitter || proSocials.telegram || proSocials.website) && (
            <div className="flex flex-wrap gap-3 text-[10px]">
              {proSocials.twitter && (
                <a href={proSocials.twitter} target="_blank" rel="noopener noreferrer" className="text-[#60a5fa] hover:underline">Twitter</a>
              )}
              {proSocials.telegram && (
                <a href={proSocials.telegram} target="_blank" rel="noopener noreferrer" className="text-[#22c55e] hover:underline">Telegram</a>
              )}
              {proSocials.website && (
                <a href={proSocials.website} target="_blank" rel="noopener noreferrer" className="text-[#f59e0b] hover:underline">Website</a>
              )}
            </div>
          )}

          {pm.notes.length > 0 && (
            <ul className="text-[10px] text-[#8b949e] space-y-1 list-disc pl-4">
              {pm.notes.map((n, i) => <li key={i}>{n}</li>)}
            </ul>
          )}

          {proSnaps.length > 1 && (
            <div>
              <div className="text-[9px] text-[#484f58] uppercase tracking-widest mb-2">Gain from call (Pro snapshots)</div>
              <div className="h-36">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={proSnaps.filter(s => s.gainPct != null).map(s => ({
                    ts: new Date(s.snapshotAt).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" }),
                    gain: Math.round(s.gainPct!),
                    kol: s.kolCount,
                    smart: s.smartCount,
                  }))}>
                    <CartesianGrid stroke="#21262d" strokeDasharray="3 3" />
                    <XAxis dataKey="ts" tick={{ fill: "#484f58", fontSize: 9 }} />
                    <YAxis tick={{ fill: "#484f58", fontSize: 9 }} />
                    <Tooltip contentStyle={{ background: "#0d1117", border: "1px solid #30363d", fontSize: 11 }} />
                    <ReferenceLine y={0} stroke="#30363d" />
                    <Area type="monotone" dataKey="gain" stroke="#f59e0b" fill="#f59e0b22" name="Gain %" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
              <div className="h-28 mt-2">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={proSnaps.map(s => ({
                    ts: new Date(s.snapshotAt).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" }),
                    kol: s.kolCount,
                    smart: s.smartCount,
                  }))}>
                    <CartesianGrid stroke="#21262d" strokeDasharray="3 3" />
                    <XAxis dataKey="ts" tick={{ fill: "#484f58", fontSize: 9 }} />
                    <YAxis tick={{ fill: "#484f58", fontSize: 9 }} allowDecimals={false} />
                    <Tooltip contentStyle={{ background: "#0d1117", border: "1px solid #30363d", fontSize: 11 }} />
                    <Line type="monotone" dataKey="smart" stroke="#06b6d4" dot={false} name="Smart" />
                    <Line type="monotone" dataKey="kol" stroke="#a855f7" dot={false} name="KOL" />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Postmortem ───────────────────────────────────────────────────────── */}
      <div>
        <div className="text-[9px] text-[#484f58] uppercase tracking-widest flex items-center gap-2 mb-3">
          <FileSearch className="w-3 h-3" />
          <span>Price &amp; Intel History</span>
          {token.tokenCreatedAt && (
            <span className="ml-auto flex items-center gap-1">
              <Clock className="w-2.5 h-2.5" />
              {formatTimeAgo(token.tokenCreatedAt)} old
            </span>
          )}
        </div>

        {historyLoading && (
          <div className="animate-pulse space-y-2">
            {Array(3).fill(0).map((_, i) => <div key={i} className="h-20 bg-[#161b22] border border-[#30363d]" />)}
          </div>
        )}

        {!historyLoading && historyData && (() => {
          const { snapshots, intelLog, rugAnalysis } = historyData;

          const rugCfg: Record<string, { color: string; label: string }> = {
            rug:         { color: "#ef4444", label: "🚨 RUG DETECTED" },
            dump:        { color: "#f97316", label: "⚠ MAJOR DUMP" },
            decline:     { color: "#f59e0b", label: "📉 DECLINING" },
            stable:      { color: "#22c55e", label: "✓ STABLE" },
            recovering:  { color: "#a78bfa", label: "↑ MAKING NEW HIGHS" },
            correction:  { color: "#60a5fa", label: "📊 HEALTHY CORRECTION" },
            stabilizing: { color: "#34d399", label: "🏔 POST-PUMP STABILIZING" },
          };
          const sev = rugCfg[rugAnalysis.rugSeverity] ?? rugCfg.stable;

          const mcChartData = snapshots
            .filter(s => s.marketCapUsd)
            .map(s => ({
              t: new Date(s.snapshotAt).getTime(),
              ts: new Date(s.snapshotAt).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" }),
              mc: parseFloat(s.marketCapUsd!),
            }));

          const scoreChartData = intelLog.map(e => ({
            t: new Date(e.computedAt).getTime(),
            ts: new Date(e.computedAt).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" }),
            score: Math.round(e.intelligenceScore),
            status: e.statusAfter,
          }));

          return (
            <div className="space-y-3">
              {/* Rug summary */}
              <div
                className="border p-3 grid grid-cols-2 gap-3"
                style={{ borderColor: sev.color + "40", backgroundColor: sev.color + "08" }}
              >
                <div className="col-span-2 flex items-center gap-2 flex-wrap">
                  <span className="text-[11px] font-bold tracking-widest" style={{ color: sev.color }}>
                    {sev.label}
                  </span>
                  {rugAnalysis.currentMultiple != null && rugAnalysis.currentMultiple > 1 && (
                    <span className="text-[10px] text-[#22c55e] font-bold">
                      still +{rugAnalysis.currentMultiple.toFixed(1)}× from entry
                    </span>
                  )}
                </div>

                <div>
                  <div className="text-[9px] text-[#484f58] uppercase tracking-widest mb-0.5">Peak MC</div>
                  <div className="text-base font-bold text-[#c9d1d9]">
                    {rugAnalysis.peakMcUsd ? fmtMc(rugAnalysis.peakMcUsd) : "—"}
                  </div>
                  {rugAnalysis.athMultiple != null && (
                    <div className="text-[9px] text-[#484f58]">{rugAnalysis.athMultiple.toFixed(1)}× ATH</div>
                  )}
                </div>

                <div>
                  <div className="text-[9px] text-[#484f58] uppercase tracking-widest mb-0.5">Drawdown</div>
                  <div
                    className="text-base font-bold"
                    style={{ color: (rugAnalysis.drawdownPct ?? 0) > 50 ? "#ef4444" : (rugAnalysis.drawdownPct ?? 0) > 20 ? "#f59e0b" : "#22c55e" }}
                  >
                    {rugAnalysis.drawdownPct != null ? `-${rugAnalysis.drawdownPct.toFixed(0)}%` : "—"}
                  </div>
                  {rugAnalysis.peakToCurrentHours != null && (
                    <div className="text-[9px] text-[#484f58]">over {rugAnalysis.peakToCurrentHours.toFixed(0)}h</div>
                  )}
                </div>

                <div>
                  <div className="text-[9px] text-[#484f58] uppercase tracking-widest mb-0.5">Current MC</div>
                  <div className="text-base font-bold text-[#c9d1d9]">
                    {rugAnalysis.currentMcUsd ? fmtMc(rugAnalysis.currentMcUsd) : "—"}
                  </div>
                  {rugAnalysis.currentMultiple != null && (
                    <div
                      className="text-[9px]"
                      style={{ color: rugAnalysis.currentMultiple >= 1 ? "#22c55e" : "#ef4444" }}
                    >
                      {rugAnalysis.currentMultiple >= 1 ? "+" : ""}{rugAnalysis.currentMultiple.toFixed(1)}× from entry
                    </div>
                  )}
                </div>

                <div>
                  <div className="text-[9px] text-[#484f58] uppercase tracking-widest mb-0.5">Token Age</div>
                  <div className="text-base font-bold text-[#c9d1d9] flex items-center gap-1">
                    <Clock className="w-3 h-3 text-[#484f58]" />
                    {token.tokenCreatedAt ? formatTimeAgo(token.tokenCreatedAt) : formatTimeAgo(token.firstDetectedAt)}
                  </div>
                  <div className="text-[9px] text-[#484f58]">
                    {token.tokenCreatedAt ? "since creation" : "since detection"}
                  </div>
                </div>
              </div>

              {/* MC chart */}
              {mcChartData.length > 1 && (
                <div className="border border-[#30363d] bg-[#0d1117]">
                  <div className="text-[9px] text-[#484f58] uppercase tracking-widest px-3 py-2 border-b border-[#30363d] bg-[#161b22] flex items-center gap-2">
                    <TrendingUp className="w-3 h-3" />
                    Market Cap History
                    <span className="text-[#30363d]">· {mcChartData.length} pts</span>
                  </div>
                  <div className="p-2">
                    <ResponsiveContainer width="100%" height={140}>
                      <AreaChart data={mcChartData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                        <defs>
                          <linearGradient id="mcGrad" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%"  stopColor="#f59e0b" stopOpacity={0.25} />
                            <stop offset="95%" stopColor="#f59e0b" stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="#1c2128" />
                        <XAxis dataKey="ts" tick={{ fontSize: 8, fill: "#484f58" }} interval="preserveStartEnd" />
                        <YAxis tickFormatter={fmtMc} tick={{ fontSize: 8, fill: "#484f58" }} width={46} />
                        <Tooltip
                          contentStyle={{ backgroundColor: "#161b22", border: "1px solid #30363d", borderRadius: 0, fontSize: 11 }}
                          formatter={(v: number) => [fmtMc(v), "Market Cap"]}
                          labelStyle={{ color: "#8b949e" }}
                        />
                        <Area type="monotone" dataKey="mc" stroke="#f59e0b" strokeWidth={1.5} fill="url(#mcGrad)" dot={false} />
                        {rugAnalysis.peakMcUsd && (
                          <ReferenceLine y={rugAnalysis.peakMcUsd} stroke="#ef4444" strokeDasharray="4 2"
                            label={{ value: "Peak", position: "insideTopRight", fontSize: 8, fill: "#ef4444" }} />
                        )}
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}

              {/* Intel score chart */}
              {scoreChartData.length > 1 && (
                <div className="border border-[#30363d] bg-[#0d1117]">
                  <div className="text-[9px] text-[#484f58] uppercase tracking-widest px-3 py-2 border-b border-[#30363d] bg-[#161b22] flex items-center gap-2">
                    <Brain className="w-3 h-3" />
                    Intel Score History
                    <span className="text-[#30363d]">· {scoreChartData.length} entries</span>
                  </div>
                  <div className="p-2">
                    <ResponsiveContainer width="100%" height={120}>
                      <LineChart data={scoreChartData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#1c2128" />
                        <XAxis dataKey="ts" tick={{ fontSize: 8, fill: "#484f58" }} interval="preserveStartEnd" />
                        <YAxis domain={[0, 100]} tick={{ fontSize: 8, fill: "#484f58" }} width={24} />
                        <Tooltip
                          contentStyle={{ backgroundColor: "#161b22", border: "1px solid #30363d", borderRadius: 0, fontSize: 11 }}
                          formatter={(v: number, _: string, props: { payload?: { status?: string } }) => [
                            `${v} (${props.payload?.status ?? ""})`, "Intel Score",
                          ]}
                          labelStyle={{ color: "#8b949e" }}
                        />
                        <ReferenceLine y={55} stroke="#484f58" strokeDasharray="3 3"
                          label={{ value: "55", fontSize: 8, fill: "#484f58" }} />
                        <Line type="monotone" dataKey="score" stroke="#a78bfa" strokeWidth={2} dot={{ r: 2, fill: "#a78bfa" }} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}

              {/* Score log */}
              {intelLog.length > 0 && (
                <div className="border border-[#30363d] bg-[#0d1117]">
                  <div className="text-[9px] text-[#484f58] uppercase tracking-widest px-3 py-2 border-b border-[#30363d] bg-[#161b22]">
                    Score Log — {intelLog.length} entries
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-[10px] whitespace-nowrap">
                      <thead>
                        <tr className="border-b border-[#30363d] bg-[#161b22]">
                          <th className="px-3 py-2 text-[9px] text-[#484f58] uppercase tracking-widest text-left">Time</th>
                          <th className="px-3 py-2 text-[9px] text-[#484f58] uppercase tracking-widest text-right">Score</th>
                          <th className="px-3 py-2 text-[9px] text-[#484f58] uppercase tracking-widest text-right">Δ</th>
                          <th className="px-3 py-2 text-[9px] text-[#484f58] uppercase tracking-widest text-right">MC</th>
                          <th className="px-3 py-2 text-[9px] text-[#484f58] uppercase tracking-widest text-left">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...intelLog].reverse().map((e, i) => {
                          const delta = e.prevIntelligenceScore != null
                            ? Math.round((e.intelligenceScore - e.prevIntelligenceScore) * 10) / 10
                            : null;
                          const deltaColor = delta == null ? "#484f58" : delta > 0 ? "#22c55e" : delta < 0 ? "#ef4444" : "#484f58";
                          const scoreColor = e.intelligenceScore >= 62 ? "#22c55e" : e.intelligenceScore >= 40 ? "#f59e0b" : "#ef4444";
                          return (
                            <tr
                              key={i}
                              className={cn(
                                "border-b border-[#30363d]/50 hover:bg-[#1c2128] transition-colors",
                                e.statusChanged ? "bg-[#f59e0b]/5" : i % 2 === 0 ? "bg-[#0d1117]" : "bg-[#161b22]/20",
                              )}
                            >
                              <td className="px-3 py-2 text-[#484f58] font-mono text-[9px]">
                                {new Date(e.computedAt).toLocaleString("en", {
                                  month: "short", day: "numeric",
                                  hour: "2-digit", minute: "2-digit",
                                })}
                              </td>
                              <td className="px-3 py-2 text-right font-bold tabular-nums" style={{ color: scoreColor }}>
                                {Math.round(e.intelligenceScore)}
                              </td>
                              <td className="px-3 py-2 text-right font-bold tabular-nums" style={{ color: deltaColor }}>
                                {delta == null ? "—" : delta > 0 ? `+${delta}` : String(delta)}
                              </td>
                              <td className="px-3 py-2 text-right text-[#8b949e] tabular-nums">
                                {e.marketCapUsd ? fmtMc(parseFloat(e.marketCapUsd)) : "—"}
                              </td>
                              <td className="px-3 py-2">
                                {e.statusChanged
                                  ? <span className="text-[#f59e0b] font-bold text-[9px] tracking-widest">{e.statusBefore} → {e.statusAfter}</span>
                                  : <span className="text-[#484f58]">{e.statusAfter}</span>
                                }
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {mcChartData.length === 0 && intelLog.length === 0 && (
                <div className="text-center py-10 text-[#484f58] text-[11px] border border-[#30363d] bg-[#0d1117]">
                  <FileSearch className="w-6 h-6 mx-auto mb-2 opacity-30" />
                  <p>No history yet.</p>
                  <p className="mt-1 text-[10px]">Price snapshots build up over time.</p>
                </div>
              )}
            </div>
          );
        })()}
      </div>
    </div>
  );
}
