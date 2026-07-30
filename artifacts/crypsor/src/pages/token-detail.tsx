import { useRoute, useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft, ExternalLink, Copy, CheckCheck, RefreshCw,
  Clock, TrendingUp, DollarSign, Star, Shield, ChevronLeft, ChevronRight,
  Brain, BarChart3, Users, Zap, Droplets, Lock, Unlock, AlertTriangle,
  CheckCircle, XCircle, HelpCircle, Flame, Bug, Activity, FileSearch,
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

// ── Types ─────────────────────────────────────────────────────────────────────

interface SecurityData {
  isHoneypot:          boolean | null;
  ownerRenounced:      boolean | null;
  mintRenounced:       boolean | null;
  freezeRenounced:     boolean | null;
  openSource:          boolean | null;
  top10HolderRate:     number | null;
  rugRatio:            number | null;
  sniperCount:         number | null;
  creatorAddress:      string | null;
  creatorClose:        boolean | null;
  creatorTokenStatus:  string | null;
  buyTax:              number | null;
  sellTax:             number | null;
  lpLocked:            boolean | null;
  lpLockPercent:       number | null;
  ctoFlag:             boolean | null;
  bluechipOwnerPct:    number | null;
  ratTraderAmtRate:    number | null;
  creatorCreatedCount: number | null;
  fetchedAt:           string | null;
}

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
  security: SecurityData | null;
}

interface HolderRow {
  id: number;
  walletAddress: string;
  twitterName: string | null;
  twitterUsername: string | null;
  labels: string[];
  amountPercentage: number | null;
  realizedProfit: string | null;
  buyCount: number;
  sellCount: number;
}

interface TraderRow {
  id: number;
  walletAddress: string;
  twitterName: string | null;
  twitterUsername: string | null;
  labels: string[];
  profit: number | null;
  profitUsd: number | null;
  realizedProfit: number | null;
  unrealizedProfit: number | null;
  buyVolumeUsd: number | null;
  sellVolumeUsd: number | null;
  netFlowUsd: number | null;
  buyCount: number;
  sellCount: number;
  holdingPct: number | null;
  fetchedAt: string;
}

interface HoldersPage { data: HolderRow[]; total: number; page: number; pages: number; }

interface KolSmartWallet {
  walletAddress: string;
  twitterName: string | null;
  twitterUsername: string | null;
  labels: string[];
  amountPercentage: number | null;
  costUsd: string | null;
  realizedProfit: string | null;
  unrealizedProfit: string | null;
  buyCount: number;
  sellCount: number;
  fetchedAt: string | null;
}

interface KolSmartFetchResult {
  kolCount: number;
  smartCount: number;
  totalCount: number;
  upserted: number;
  fetchedAt: string;
  wallets: KolSmartWallet[];
}
interface TradersResponse { source: string; traders: TraderRow[]; fetchedAt: string | null; }
interface SecurityResponse { source: string; security: SecurityData; secFetchedAt: string; creatorProfile: unknown | null; }

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
  athMultiple: number | null;
  proScore: number | null;
  qualityLabel: string | null;
  lastSnapshotAt: string | null;
  hit2x: boolean;  hit2xAt: string | null;
  hit3x: boolean;  hit3xAt: string | null;
  hit5x: boolean;  hit5xAt: string | null;
  hit10x: boolean; hit10xAt: string | null;
  hit100x: boolean;hit100xAt: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function gainColor(pct: number | null | undefined) {
  if (pct == null) return "text-[#8b949e]";
  if (pct > 0)  return "text-[#22c55e]";
  if (pct < 0)  return "text-[#ef4444]";
  return "text-[#8b949e]";
}

function usd(v: string | number | null | undefined): string {
  if (v == null || v === "") return "—";
  const n = typeof v === "number" ? v : parseFloat(String(v));
  if (isNaN(n)) return "—";
  if (Math.abs(n) >= 1000) return `$${(n / 1000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function pct(v: number | null | undefined, decimals = 1): string {
  if (v == null) return "—";
  return `${(v * 100).toFixed(decimals)}%`;
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

function MetricBox({ label, value, accent, subValue }: {
  label: string; value: React.ReactNode; accent?: boolean; subValue?: React.ReactNode;
}) {
  return (
    <div className={cn(
      "p-3 border",
      accent ? "border-[#f59e0b]/30 bg-[#f59e0b]/5" : "border-[#30363d] bg-[#161b22]",
    )}>
      <div className="text-[9px] text-[#484f58] uppercase tracking-widest mb-1">{label}</div>
      <div className={cn("text-xl font-bold leading-none tabular-nums", accent ? "text-[#f59e0b]" : "text-[#c9d1d9]")}>{value}</div>
      {subValue && <div className="text-[10px] text-[#8b949e] mt-1">{subValue}</div>}
    </div>
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
    return <img src={logoUri} alt={symbol ?? ""} onError={() => setErr(true)} className="w-14 h-14 object-cover border border-[#30363d]" />;
  }
  return (
    <div className="w-14 h-14 bg-[#161b22] border border-[#30363d] flex items-center justify-center text-xl font-bold text-[#f59e0b]">
      {(symbol ?? address.slice(0, 2)).slice(0, 2).toUpperCase()}
    </div>
  );
}

// ── Security helpers ──────────────────────────────────────────────────────────

type SecurityStatus = "safe" | "warn" | "danger" | "unknown";

function secStatus(val: boolean | null | undefined, safeIs: boolean): SecurityStatus {
  if (val == null) return "unknown";
  return val === safeIs ? "safe" : "danger";
}

function SecIcon({ status }: { status: SecurityStatus }) {
  if (status === "safe")    return <CheckCircle className="w-3.5 h-3.5 text-[#22c55e]" />;
  if (status === "danger")  return <XCircle     className="w-3.5 h-3.5 text-[#ef4444]" />;
  if (status === "warn")    return <AlertTriangle className="w-3.5 h-3.5 text-[#f59e0b]" />;
  return <HelpCircle className="w-3.5 h-3.5 text-[#484f58]" />;
}

function SecRow({ label, status, value }: { label: string; status: SecurityStatus; value: React.ReactNode }) {
  const color = status === "safe" ? "text-[#22c55e]" : status === "danger" ? "text-[#ef4444]" : status === "warn" ? "text-[#f59e0b]" : "text-[#484f58]";
  return (
    <div className="flex items-center justify-between py-2 border-b border-[#30363d]/50 last:border-0">
      <div className="flex items-center gap-2">
        <SecIcon status={status} />
        <span className="text-[11px] text-[#8b949e]">{label}</span>
      </div>
      <span className={cn("text-[11px] font-bold tabular-nums", color)}>{value}</span>
    </div>
  );
}

function labelBadge(label: string): React.ReactNode {
  const l = label.toLowerCase();
  const cfg: Record<string, string> = {
    kol:          "text-[#f59e0b] bg-[#f59e0b]/10 border-[#f59e0b]/20",
    renowned:     "text-[#f59e0b] bg-[#f59e0b]/10 border-[#f59e0b]/20",
    smart_degen:  "text-[#60a5fa] bg-[#60a5fa]/10 border-[#60a5fa]/20",
    smart_money:  "text-[#60a5fa] bg-[#60a5fa]/10 border-[#60a5fa]/20",
    insider:      "text-[#a78bfa] bg-[#a78bfa]/10 border-[#a78bfa]/20",
    fomo:         "text-[#fb923c] bg-[#fb923c]/10 border-[#fb923c]/20",
    sniper:       "text-[#ef4444] bg-[#ef4444]/10 border-[#ef4444]/20",
    snipe_bot:    "text-[#ef4444] bg-[#ef4444]/10 border-[#ef4444]/20",
    bundler:      "text-[#ef4444] bg-[#ef4444]/10 border-[#ef4444]/20",
    dev:          "text-[#34d399] bg-[#34d399]/10 border-[#34d399]/20",
    fresh_wallet: "text-[#8b949e] bg-[#8b949e]/10 border-[#30363d]",
    bot_degen:    "text-[#ef4444] bg-[#ef4444]/10 border-[#ef4444]/20",
    rat_trader:   "text-[#ef4444] bg-[#ef4444]/10 border-[#ef4444]/20",
  };
  const cls = cfg[l] ?? "text-[#8b949e] bg-[#8b949e]/10 border-[#30363d]";
  return (
    <span key={label} className={cn("text-[9px] font-bold px-1.5 py-0.5 border tracking-wider uppercase", cls)}>
      {label.replace(/_/g, " ")}
    </span>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function TokenDetailPage() {
  const [, params]      = useRoute("/tokens/:id");
  const [, setLocation] = useLocation();
  const id = params?.id ? parseInt(params.id, 10) : null;
  const qc = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const [holderPage, setHolderPage] = useState(1);
  const [activeTab, setActiveTab] = useState<"kol-smart" | "holders" | "traders" | "security" | "postmortem">("kol-smart");

  const BASE = import.meta.env.BASE_URL;

  // ── KOL / Smart auto-fetch on token entry ────────────────────────────────
  const [kolSmartResult, setKolSmartResult] = useState<KolSmartFetchResult | null>(null);
  const [kolSmartLoading, setKolSmartLoading] = useState(false);
  const [kolSmartError, setKolSmartError]   = useState<string | null>(null);
  const fetchedForId = useRef<number | null>(null);

  const fetchKolSmart = useCallback(async (tokenId: number) => {
    if (fetchedForId.current === tokenId) return; // already fetched for this token
    fetchedForId.current = tokenId;
    setKolSmartLoading(true);
    setKolSmartError(null);
    try {
      const r = await fetch(`${BASE}api/holders/token/${tokenId}/fetch`, { method: "POST" });
      if (!r.ok) throw new Error(`Fetch error ${r.status}`);
      const data: KolSmartFetchResult = await r.json();
      setKolSmartResult(data);
    } catch (e) {
      setKolSmartError(e instanceof Error ? e.message : String(e));
      fetchedForId.current = null; // allow retry
    } finally {
      setKolSmartLoading(false);
    }
  }, [BASE]);

  useEffect(() => {
    if (id != null) fetchKolSmart(id);
  }, [id, fetchKolSmart]);

  const { data: token, isLoading } = useQuery<TokenDetail>({
    queryKey: ["token", id],
    queryFn:  async () => {
      const r = await fetch(`${BASE}api/tokens/${id}`);
      if (!r.ok) throw new Error(`Token API error ${r.status}`);
      return r.json();
    },
    enabled:  id != null,
    refetchInterval: 15_000,
  });

  const { data: gmgn } = useQuery<GmgnResponse>({
    queryKey: ["token-gmgn-intelligence", id],
    queryFn:  async () => {
      const r = await fetch(`${BASE}api/tokens/${id}/gmgn`);
      if (!r.ok) throw new Error(`GMGN API error ${r.status}`);
      return r.json();
    },
    enabled:  id != null,
    refetchInterval: 30_000,
    staleTime: 10_000,
  });

  const { data: holdersData } = useQuery<HoldersPage>({
    queryKey: ["token-holders", id, holderPage],
    queryFn: async () => {
      const params = new URLSearchParams({ tokenId: String(id), limit: "20", page: String(holderPage) });
      const r = await fetch(`${BASE}api/holders/list?${params}`);
      if (!r.ok) throw new Error(`Holders API error ${r.status}`);
      return r.json();
    },
    enabled: id != null,
    staleTime: 60_000,
  });

  const { data: tradersData, isLoading: tradersLoading } = useQuery<TradersResponse>({
    queryKey: ["token-traders", id],
    queryFn:  async () => {
      const r = await fetch(`${BASE}api/tokens/${id}/traders`);
      if (!r.ok) throw new Error(`Traders API error ${r.status}`);
      return r.json();
    },
    enabled:  id != null && activeTab === "traders",
    staleTime: 5 * 60_000,
  });

  const { data: securityData, isLoading: secLoading, refetch: refetchSec } = useQuery<SecurityResponse>({
    queryKey: ["token-security", id],
    queryFn:  async () => {
      const r = await fetch(`${BASE}api/tokens/${id}/security`);
      if (!r.ok) throw new Error(`Security API error ${r.status}`);
      return r.json();
    },
    enabled:  id != null && activeTab === "security",
    staleTime: 10 * 60_000,
  });

  const { data: historyData, isLoading: historyLoading } = useQuery<HistoryResponse>({
    queryKey: ["token-history", id],
    queryFn:  async () => {
      const r = await fetch(`${BASE}api/tokens/${id}/history`);
      if (!r.ok) throw new Error(`History API error ${r.status}`);
      return r.json();
    },
    enabled:  id != null && activeTab === "postmortem",
    staleTime: 2 * 60_000,
  });

  const { data: proCallData } = useQuery<{ proCall: ProCallData | null }>({
    queryKey: ["token-pro-call", id],
    queryFn:  async () => {
      const r = await fetch(`${BASE}api/pro/token/${id}`);
      if (!r.ok) throw new Error(`Pro call API error ${r.status}`);
      return r.json();
    },
    enabled:  id != null,
    staleTime: 5 * 60_000,
  });

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
        qc.invalidateQueries({ queryKey: ["token-holders-kol-smart", id] }),
        qc.invalidateQueries({ queryKey: ["token-traders", id] }),
        qc.invalidateQueries({ queryKey: ["token-security", id] }),
      ]);
    } finally {
      setRefreshing(false);
    }
  }, [id, refreshing, qc, BASE]);

  if (isLoading) {
    return (
      <div className="space-y-4 animate-pulse">
        <div className="h-4 w-24 bg-[#161b22]" />
        <div className="h-8 w-48 bg-[#161b22]" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          {Array(4).fill(0).map((_, i) => <div key={i} className="h-20 bg-[#161b22] border border-[#30363d]" />)}
        </div>
      </div>
    );
  }

  if (!token) {
    return (
      <div className="text-center py-24 text-[#8b949e]">
        <p className="text-sm tracking-widest uppercase">Token not found</p>
        <button
          className="mt-4 text-[#f59e0b] text-xs tracking-widest uppercase hover:underline"
          onClick={() => setLocation("/")}
        >← Back</button>
      </div>
    );
  }

  const gmgnUrl = getGmgnUrl(token.chain, token.address);
  const kol     = gmgn?.holderIntel?.kolCount   ?? token.holderKolCount   ?? 0;
  const smart   = gmgn?.holderIntel?.smartCount  ?? token.holderSmartCount ?? 0;

  // Show all holders for this token — filtering client-side on a single page
  // would hide KOL/Smart holders that happen to fall outside the current 20-row window.
  const holders     = holdersData?.data ?? [];
  const holderTotal = holdersData?.total ?? 0;
  const holderPages = holdersData?.pages ?? 1;

  // Security from token or from dedicated endpoint
  const sec = securityData?.security ?? token.security;

  // Security risk score
  const secRisk = sec ? (() => {
    let flags = 0;
    if (sec.isHoneypot === true) flags += 5;
    if (sec.ownerRenounced === false) flags += 2;
    if (sec.lpLocked === false) flags += 2;
    if ((sec.rugRatio ?? 0) > 0.3) flags += 2;
    if ((sec.top10HolderRate ?? 0) > 0.5) flags += 1;
    if (sec.creatorClose === false) flags += 1;
    return flags;
  })() : null;

  const secRiskLabel = secRisk == null ? null
    : secRisk === 0 ? "CLEAN"
    : secRisk <= 2  ? "LOW RISK"
    : secRisk <= 4  ? "MEDIUM"
    : "HIGH RISK";

  const secRiskColor = secRisk == null ? "#484f58"
    : secRisk === 0 ? "#22c55e"
    : secRisk <= 2  ? "#22c55e"
    : secRisk <= 4  ? "#f59e0b"
    : "#ef4444";

  return (
    <div className="space-y-5">
      {/* Back */}
      <button
        className="flex items-center gap-1.5 text-[#484f58] hover:text-[#f59e0b] transition-colors text-[10px] tracking-widest uppercase"
        onClick={() => setLocation("/")}
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        Dashboard
      </button>

      {/* Header */}
      <div className="flex items-start gap-4 flex-wrap">
        <TokenDetailLogo logoUri={token.logoUri} address={token.address} symbol={token.symbol} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-bold text-[#f59e0b] tracking-tight">{token.name || "Unknown Token"}</h1>
            <StatusBadge status={token.status} />
            {/* Security badge if available */}
            {sec && secRiskLabel && (
              <span className="text-[9px] font-bold px-1.5 py-0.5 border tracking-widest uppercase"
                style={{ color: secRiskColor, borderColor: secRiskColor + "33", backgroundColor: secRiskColor + "11" }}>
                {sec.isHoneypot ? "🚫 HONEYPOT" : secRiskLabel}
              </span>
            )}
            {sec?.ctoFlag && (
              <span className="text-[9px] font-bold px-1.5 py-0.5 border border-[#a78bfa]/20 bg-[#a78bfa]/10 text-[#a78bfa] tracking-widest uppercase">CTO</span>
            )}
            <a href={gmgnUrl} target="_blank" rel="noopener noreferrer" className="text-[#484f58] hover:text-[#f59e0b]">
              <ExternalLink className="w-4 h-4" />
            </a>
          </div>
          <div className="flex items-center gap-3 mt-1.5 text-[11px] text-[#8b949e] flex-wrap">
            <span className="text-[#c9d1d9]">{token.symbol ?? "—"}</span>
            <span className="text-[#30363d]">·</span>
            <span className="uppercase tracking-widest">{token.chain}</span>
            <span className="text-[#30363d]">·</span>
            <span className="text-[#484f58]">{truncateAddress(token.address)}</span>
            <CopyBtn text={token.address} />
          </div>
          {/* Creator address if known */}
          {sec?.creatorAddress && (
            <div className="flex items-center gap-2 mt-1 text-[10px] text-[#484f58]">
              <Bug className="w-3 h-3 shrink-0" />
              <span>Dev:</span>
              <span className="font-mono text-[#8b949e]">{truncateAddress(sec.creatorAddress)}</span>
              <CopyBtn text={sec.creatorAddress} />
              {sec.creatorClose && (
                <span className="text-[#22c55e] text-[9px] font-bold tracking-widest">SOLD ✓</span>
              )}
              {sec.creatorClose === false && (
                <span className="text-[#f59e0b] text-[9px] font-bold tracking-widest">HOLDING ⚠</span>
              )}
              {sec.creatorCreatedCount != null && sec.creatorCreatedCount > 0 && (
                <span className="text-[#ef4444] text-[9px]">{sec.creatorCreatedCount} prev tokens</span>
              )}
            </div>
          )}
          <div className="flex items-center gap-3 mt-1.5">
            {token.priceUpdatedAt && (
              <span className="text-[9px] text-[#484f58] tracking-widest">
                Price updated {formatTimeAgo(token.priceUpdatedAt)} ago
              </span>
            )}
            <button
              className="flex items-center gap-1 text-[9px] text-[#484f58] hover:text-[#f59e0b] tracking-widest uppercase transition-colors disabled:opacity-40"
              onClick={handleRefresh}
              disabled={refreshing}
            >
              <RefreshCw className={cn("w-3 h-3", refreshing && "animate-spin")} />
              {refreshing ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </div>
      </div>

      {/* Key metrics: 4 boxes */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <MetricBox
          label="Token Age"
          value={token.tokenCreatedAt ? formatTimeAgo(token.tokenCreatedAt) : formatTimeAgo(token.firstDetectedAt)}
          accent
          subValue={
            <span className="flex items-center gap-1">
              <Clock className="w-2.5 h-2.5" />
              {token.tokenCreatedAt ? "since creation" : "since detection"}
            </span>
          }
        />
        <MetricBox
          label="Detected @"
          value={formatTokenPrice(token.detectedPriceUsd)}
          subValue={
            <span className="flex items-center gap-1">
              <DollarSign className="w-2.5 h-2.5" />
              Entry price USD
            </span>
          }
        />
        <MetricBox
          label="Current Gain"
          value={
            <span className={gainColor(token.detectionGainPct)}>{formatGain(token.detectionGainPct)}</span>
          }
          subValue={
            <span className="flex items-center gap-1">
              <TrendingUp className="w-2.5 h-2.5" />
              Entry → live
            </span>
          }
        />
        <MetricBox
          label="ATH Gain"
          value={
            <span className={gainColor(token.athGainPct)}>{formatGain(token.athGainPct)}</span>
          }
          subValue="Entry → peak"
        />
      </div>

      {/* Additional price metrics row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <MetricBox label="Live Price"   value={formatTokenPrice(token.currentPriceUsd)} />
        <MetricBox label="Market Cap"   value={formatMarketCap(token.marketCapUsd)} subValue={token.athMarketCapUsd ? `ATH: ${formatMarketCap(token.athMarketCapUsd)}` : undefined} />
        <MetricBox label="Liquidity"    value={formatMarketCap(token.liquidityUsd)} />
        <MetricBox label="Volume 24h"   value={formatMarketCap(token.volume24hUsd)} />
      </div>

      {/* Intelligence Score Panel */}
      {(token.intelligenceScore != null && token.intelligenceScore > 0) && (
        <div>
          <div className="text-[9px] text-[#484f58] uppercase tracking-widest mb-2 flex items-center gap-2">
            <Brain className="w-3 h-3" />
            <span>Intelligence Score</span>
            {token.intelligenceUpdatedAt && (
              <span>· Updated {formatTimeAgo(token.intelligenceUpdatedAt)} ago</span>
            )}
          </div>

          <div className="bg-[#161b22] border border-[#30363d] p-4 mb-2">
            <div className="flex items-center justify-between mb-3">
              <div>
                <div className="text-[9px] text-[#484f58] uppercase tracking-widest mb-1">Master Intelligence Score</div>
                <div className="flex items-center gap-3">
                  {(() => {
                    const s = token.intelligenceScore ?? 0;
                    const lbl = token.qualityLabel ?? (
                      s >= 82 ? "Elite" : s >= 72 ? "Excellent" : s >= 62 ? "Strong" :
                      s >= 52 ? "Good"  : s >= 40 ? "Average"   : s >= 25 ? "Speculative" : "Weak"
                    );
                    const scoreColor =
                      lbl === "Elite"       ? "text-[#a78bfa]" :
                      lbl === "Excellent"   ? "text-[#22c55e]" :
                      lbl === "Strong"      ? "text-[#10b981]" :
                      lbl === "Good"        ? "text-[#3b82f6]" :
                      lbl === "Average"     ? "text-[#f59e0b]" :
                      lbl === "Speculative" ? "text-[#f97316]" : "text-[#ef4444]";
                    const badgeColor =
                      lbl === "Elite"       ? "text-[#a78bfa] bg-[#a78bfa]/10 border-[#a78bfa]/20" :
                      lbl === "Excellent"   ? "text-[#22c55e] bg-[#22c55e]/10 border-[#22c55e]/20" :
                      lbl === "Strong"      ? "text-[#10b981] bg-[#10b981]/10 border-[#10b981]/20" :
                      lbl === "Good"        ? "text-[#3b82f6] bg-[#3b82f6]/10 border-[#3b82f6]/20" :
                      lbl === "Average"     ? "text-[#f59e0b] bg-[#f59e0b]/10 border-[#f59e0b]/20" :
                      lbl === "Speculative" ? "text-[#f97316] bg-[#f97316]/10 border-[#f97316]/20" :
                                              "text-[#ef4444] bg-[#ef4444]/10 border-[#ef4444]/20";
                    const gaugeColor =
                      lbl === "Elite" ? "#a78bfa" : lbl === "Excellent" ? "#22c55e" :
                      lbl === "Strong" ? "#10b981" : lbl === "Good" ? "#3b82f6" :
                      lbl === "Average" ? "#f59e0b" : lbl === "Speculative" ? "#f97316" : "#ef4444";
                    return (
                      <>
                        <span className={cn("text-4xl font-bold tabular-nums", scoreColor)}>
                          {Math.round(s)}
                        </span>
                        <span className={cn("text-[10px] font-bold px-2 py-1 border tracking-widest", badgeColor)}>
                          {lbl.toUpperCase()}
                        </span>
                        {/* store gauge color for SVG below */}
                        <span style={{ display: "none" }} data-gauge-color={gaugeColor} />
                      </>
                    );
                  })()}
                </div>
              </div>
              <div className="relative w-16 h-16 shrink-0">
                {(() => {
                  const s = token.intelligenceScore ?? 0;
                  const lbl = token.qualityLabel ?? (s >= 82 ? "Elite" : s >= 72 ? "Excellent" : s >= 62 ? "Strong" : s >= 52 ? "Good" : s >= 40 ? "Average" : s >= 25 ? "Speculative" : "Weak");
                  const gc = lbl === "Elite" ? "#a78bfa" : lbl === "Excellent" ? "#22c55e" : lbl === "Strong" ? "#10b981" : lbl === "Good" ? "#3b82f6" : lbl === "Average" ? "#f59e0b" : lbl === "Speculative" ? "#f97316" : "#ef4444";
                  return (<>
                    <svg viewBox="0 0 56 56" className="w-full h-full -rotate-90">
                      <circle cx="28" cy="28" r="22" fill="none" stroke="#1c2128" strokeWidth="6" />
                      <circle cx="28" cy="28" r="22" fill="none" stroke={gc} strokeWidth="6"
                        strokeDasharray={`${(s / 100) * 138.2} 138.2`} strokeLinecap="round" />
                    </svg>
                    <div className="absolute inset-0 flex items-center justify-center text-[11px] font-bold text-[#c9d1d9] tabular-nums">
                      {Math.round(s)}
                    </div>
                  </>);
                })()}
              </div>
            </div>

            {token.status === "new" && (token.consecutivePositiveChecks ?? 0) > 0 && (
              <div className="mt-2 pt-2 border-t border-[#30363d]">
                <div className="text-[9px] text-[#484f58] uppercase tracking-widest mb-1.5">
                  Graduation Progress ({token.consecutivePositiveChecks}/3 consecutive checks)
                </div>
                <div className="flex gap-1">
                  {[1, 2, 3].map(n => (
                    <div key={n} className={cn(
                      "h-1.5 flex-1",
                      n <= (token.consecutivePositiveChecks ?? 0) ? "bg-[#22c55e]" : "bg-[#30363d]"
                    )} />
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="border border-[#30363d] bg-[#0d1117]">
            <div className="text-[9px] text-[#484f58] uppercase tracking-widest px-4 py-2 border-b border-[#30363d] bg-[#161b22]">
              Signal Breakdown
            </div>
            {[
              { label: "MC Growth",        score: token.mcGrowthScore,         weight: "27%", icon: TrendingUp,  color: "#22c55e" },
              { label: "Volume Intensity", score: token.volumeIntensityScore,   weight: "25%", icon: BarChart3,   color: "#60a5fa" },
              { label: "Holder Velocity",  score: token.holderVelocityScore,    weight: "22%", icon: Users,       color: "#a78bfa" },
              { label: "KOL / Smart",      score: token.kolSmartScore,          weight: "18%", icon: Zap,         color: "#f59e0b" },
              { label: "Liquidity Health", score: token.liquidityHealthScore,   weight: "8%",  icon: Droplets,    color: "#34d399" },
            ].map(({ label, score, weight, icon: Icon, color }) => {
              const s = score ?? 0;
              const barColor = s >= 60 ? "#22c55e" : s >= 40 ? "#f59e0b" : "#ef4444";
              return (
                <div key={label} className="flex items-center gap-3 px-4 py-3 border-b border-[#30363d]/50 last:border-0 hover:bg-[#161b22]/60 transition-colors">
                  <Icon className="w-3.5 h-3.5 shrink-0" style={{ color }} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[10px] text-[#c9d1d9] font-bold">{label}</span>
                      <div className="flex items-center gap-2">
                        <span className="text-[9px] text-[#484f58] tabular-nums">{weight}</span>
                        <span className="text-[11px] font-bold tabular-nums" style={{ color: barColor }}>
                          {Math.round(s)}
                        </span>
                      </div>
                    </div>
                    <div className="h-1 bg-[#1c2128] w-full">
                      <div
                        className="h-full transition-all duration-500"
                        style={{ width: `${Math.min(100, s)}%`, backgroundColor: barColor }}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Pro Caller Milestone Tracker ───────────────────────────────────── */}
      {proCallData?.proCall && (() => {
        const pc = proCallData.proCall;
        const milestones = [
          { label: "2×",   hit: pc.hit2x,   at: pc.hit2xAt,   color: "#22c55e" },
          { label: "3×",   hit: pc.hit3x,   at: pc.hit3xAt,   color: "#22c55e" },
          { label: "5×",   hit: pc.hit5x,   at: pc.hit5xAt,   color: "#f59e0b" },
          { label: "10×",  hit: pc.hit10x,  at: pc.hit10xAt,  color: "#f59e0b" },
          { label: "100×", hit: pc.hit100x, at: pc.hit100xAt, color: "#ef4444" },
        ];
        const qualityColor = pc.qualityLabel === "very_good" ? "#f59e0b"
          : pc.qualityLabel === "good" ? "#3b82f6" : "#484f58";
        return (
          <div className="border border-[#21262d] bg-[#0d1117] p-4 space-y-3">
            {/* Header */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Zap className="w-3.5 h-3.5" style={{ color: "#f59e0b" }} />
                <span className="text-[10px] font-black uppercase tracking-widest text-white">Pro Call</span>
                {pc.qualityLabel && (
                  <span
                    className="px-1.5 py-0.5 text-[8px] font-black uppercase tracking-wider"
                    style={{ color: qualityColor, background: `${qualityColor}15`, border: `1px solid ${qualityColor}30` }}
                  >
                    {pc.qualityLabel === "very_good" ? "⭐ Very Good" : pc.qualityLabel === "good" ? "✅ Good" : pc.qualityLabel}
                  </span>
                )}
                {pc.proScore != null && (
                  <span className="text-[9px] font-bold" style={{ color: qualityColor }}>
                    {pc.proScore.toFixed(0)} score
                  </span>
                )}
              </div>
              <div className="text-right">
                <div className="text-[9px] text-[#484f58]">Called {formatTimeAgo(pc.calledAt)} ago</div>
                {pc.calledMcUsd != null && (
                  <div className="text-[9px] font-bold text-[#8b949e]">@ {formatMarketCap(String(pc.calledMcUsd))}</div>
                )}
              </div>
            </div>

            {/* Milestone timeline */}
            <div className="flex items-center gap-1 flex-wrap">
              <span className="text-[8px] text-[#484f58] uppercase tracking-widest mr-1">Milestones</span>
              {milestones.map(m => (
                <div
                  key={m.label}
                  className="flex flex-col items-center px-2 py-1.5 rounded-lg"
                  style={{
                    background: m.hit ? `${m.color}12` : "#161b22",
                    border: `1px solid ${m.hit ? m.color + "40" : "#30363d"}`,
                    minWidth: 44,
                  }}
                >
                  <span
                    className="text-[10px] font-black tabular-nums"
                    style={{ color: m.hit ? m.color : "#30363d" }}
                  >
                    {m.label}
                  </span>
                  <span className="text-[7px] text-[#484f58] mt-0.5">
                    {m.hit && m.at ? formatTimeAgo(m.at) : m.hit ? "✓" : "—"}
                  </span>
                </div>
              ))}
              {pc.athMultiple != null && (
                <>
                  <div className="w-px h-6 mx-1" style={{ background: "#21262d" }} />
                  <div
                    className="flex flex-col items-center px-2 py-1.5 rounded-lg"
                    style={{ background: "#f59e0b12", border: "1px solid #f59e0b30", minWidth: 52 }}
                  >
                    <span className="text-[10px] font-black text-[#f59e0b]">
                      {pc.athMultiple >= 2 ? `${pc.athMultiple.toFixed(1)}×` : `+${((pc.athMultiple - 1) * 100).toFixed(0)}%`}
                    </span>
                    <span className="text-[7px] text-[#484f58] mt-0.5">ATH</span>
                  </div>
                </>
              )}
            </div>
          </div>
        );
      })()}

      {/* Tabs: Holders | Traders | Security */}
      <div>
        <div className="flex border-b border-[#30363d] mb-4 overflow-x-auto">
          <button
            onClick={() => setActiveTab("kol-smart")}
            className={cn("px-4 py-2 text-[10px] tracking-widest uppercase font-bold border-b-2 transition-colors -mb-px shrink-0",
              activeTab === "kol-smart" ? "border-[#f59e0b] text-[#f59e0b]" : "border-transparent text-[#484f58] hover:text-[#8b949e]")}
          >
            <span className="flex items-center gap-1.5">
              <Zap className="w-3 h-3" />
              KOL / Smart
              {kolSmartResult && (
                <span className="ml-1 px-1.5 py-0.5 text-[8px] font-bold bg-[#f59e0b]/10 text-[#f59e0b] border border-[#f59e0b]/20">
                  {kolSmartResult.kolCount + kolSmartResult.smartCount}
                </span>
              )}
            </span>
          </button>
          <button
            onClick={() => setActiveTab("holders")}
            className={cn("px-4 py-2 text-[10px] tracking-widest uppercase font-bold border-b-2 transition-colors -mb-px shrink-0",
              activeTab === "holders" ? "border-[#f59e0b] text-[#f59e0b]" : "border-transparent text-[#484f58] hover:text-[#8b949e]")}
          >
            <span className="flex items-center gap-1.5"><Users className="w-3 h-3" />Holders</span>
          </button>
          <button
            onClick={() => setActiveTab("traders")}
            className={cn("px-4 py-2 text-[10px] tracking-widest uppercase font-bold border-b-2 transition-colors -mb-px shrink-0",
              activeTab === "traders" ? "border-[#f59e0b] text-[#f59e0b]" : "border-transparent text-[#484f58] hover:text-[#8b949e]")}
          >
            <span className="flex items-center gap-1.5"><Activity className="w-3 h-3" />Traders</span>
          </button>
          <button
            onClick={() => setActiveTab("security")}
            className={cn("px-4 py-2 text-[10px] tracking-widest uppercase font-bold border-b-2 transition-colors -mb-px shrink-0",
              activeTab === "security" ? "border-[#f59e0b] text-[#f59e0b]" : "border-transparent text-[#484f58] hover:text-[#8b949e]")}
          >
            <span className="flex items-center gap-1.5">
              <Shield className="w-3 h-3" />
              Security
              {sec?.isHoneypot === true && <span className="ml-1 text-[#ef4444]">●</span>}
              {sec?.isHoneypot === false && sec && (secRisk ?? 0) === 0 && <span className="ml-1 text-[#22c55e]">●</span>}
            </span>
          </button>
          <button
            onClick={() => setActiveTab("postmortem")}
            className={cn("px-4 py-2 text-[10px] tracking-widest uppercase font-bold border-b-2 transition-colors -mb-px shrink-0",
              activeTab === "postmortem" ? "border-[#f59e0b] text-[#f59e0b]" : "border-transparent text-[#484f58] hover:text-[#8b949e]")}
          >
            <span className="flex items-center gap-1.5"><FileSearch className="w-3 h-3" />Postmortem</span>
          </button>
        </div>

        {/* ── KOL / Smart Tab ── */}
        {activeTab === "kol-smart" && (
          <div>
            {/* Header row */}
            <div className="flex items-center justify-between mb-3">
              <div className="text-[9px] text-[#484f58] uppercase tracking-widest flex items-center gap-2">
                <Zap className="w-3 h-3 text-[#f59e0b]" />
                <span>KOL &amp; Smart Wallet Intelligence</span>
                {kolSmartResult?.fetchedAt && (
                  <span className="text-[#30363d]">· fetched {formatTimeAgo(kolSmartResult.fetchedAt)} ago</span>
                )}
              </div>
              <button
                onClick={() => { fetchedForId.current = null; if (id != null) fetchKolSmart(id); }}
                disabled={kolSmartLoading}
                className="text-[9px] text-[#484f58] hover:text-[#f59e0b] tracking-widest uppercase flex items-center gap-1 transition-colors disabled:opacity-40"
              >
                <RefreshCw className={cn("w-3 h-3", kolSmartLoading && "animate-spin")} />
                {kolSmartLoading ? "Fetching…" : "Refresh"}
              </button>
            </div>

            {/* Loading skeleton */}
            {kolSmartLoading && !kolSmartResult && (
              <div className="animate-pulse space-y-3">
                <div className="grid grid-cols-2 gap-2">
                  <div className="h-24 bg-[#161b22] border border-[#30363d]" />
                  <div className="h-24 bg-[#161b22] border border-[#30363d]" />
                </div>
                {Array(4).fill(0).map((_, i) => <div key={i} className="h-10 bg-[#161b22] border border-[#30363d]" />)}
              </div>
            )}

            {/* Error state */}
            {kolSmartError && !kolSmartLoading && (
              <div className="border border-[#ef4444]/30 bg-[#ef4444]/5 p-4 text-[10px] text-[#ef4444] tracking-widest">
                FETCH FAILED — {kolSmartError}
              </div>
            )}

            {/* Results */}
            {kolSmartResult && (
              <>
                {/* Stat cards */}
                <div className="grid grid-cols-2 gap-2 mb-4">
                  <div className="bg-[#0d1117] border border-[#f59e0b]/30 p-5">
                    <div className="flex items-center gap-2 mb-3">
                      <Star className="w-4 h-4 text-[#f59e0b]" />
                      <span className="text-[9px] text-[#8b949e] uppercase tracking-widest">KOL / Renowned</span>
                    </div>
                    <div className="text-5xl font-bold text-[#f59e0b] tabular-nums leading-none mb-2">
                      {kolSmartResult.kolCount}
                    </div>
                    <div className="text-[9px] text-[#484f58] tracking-widest uppercase">
                      wallets stored in DB
                    </div>
                  </div>
                  <div className="bg-[#0d1117] border border-[#60a5fa]/30 p-5">
                    <div className="flex items-center gap-2 mb-3">
                      <Brain className="w-4 h-4 text-[#60a5fa]" />
                      <span className="text-[9px] text-[#8b949e] uppercase tracking-widest">Smart Money</span>
                    </div>
                    <div className="text-5xl font-bold text-[#60a5fa] tabular-nums leading-none mb-2">
                      {kolSmartResult.smartCount}
                    </div>
                    <div className="text-[9px] text-[#484f58] tracking-widest uppercase">
                      wallets stored in DB
                    </div>
                  </div>
                </div>

                {/* Summary strip */}
                <div className="flex gap-4 px-4 py-2.5 bg-[#161b22] border border-[#30363d] mb-4 text-[10px] tracking-widest">
                  <span className="text-[#484f58]">TOTAL TRACKED <span className="text-[#c9d1d9] font-bold">{kolSmartResult.totalCount}</span></span>
                  <span className="text-[#30363d]">|</span>
                  <span className="text-[#484f58]">NEW UPSERTED <span className="text-[#22c55e] font-bold">{kolSmartResult.upserted}</span></span>
                  <span className="text-[#30363d]">|</span>
                  <span className="text-[#484f58]">SOURCE <span className="text-[#8b949e]">GMGN → HOLDERS DB</span></span>
                </div>

                {/* Wallet list */}
                {kolSmartResult.wallets.length > 0 ? (
                  <div className="border border-[#30363d] bg-[#0d1117]">
                    <div className="text-[9px] text-[#484f58] uppercase tracking-widest px-4 py-2 border-b border-[#30363d] bg-[#161b22] flex items-center justify-between">
                      <span>KOL + Smart Wallets — Holders Database</span>
                      <span className="text-[#30363d]">{kolSmartResult.wallets.length} wallets</span>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-[10px]">
                        <thead>
                          <tr className="border-b border-[#30363d] bg-[#161b22]/50">
                            <th className="text-left px-4 py-2 text-[#484f58] tracking-widest font-normal">WALLET</th>
                            <th className="text-left px-3 py-2 text-[#484f58] tracking-widest font-normal">TYPE</th>
                            <th className="text-right px-3 py-2 text-[#484f58] tracking-widest font-normal">SUPPLY %</th>
                            <th className="text-right px-3 py-2 text-[#484f58] tracking-widest font-normal">REALIZED PNL</th>
                            <th className="text-right px-3 py-2 text-[#484f58] tracking-widest font-normal">TRADES</th>
                          </tr>
                        </thead>
                        <tbody>
                          {kolSmartResult.wallets.map((w, i) => {
                            const isKol   = (w.labels ?? []).some(l => ["kol","renowned"].includes(l.toLowerCase()));
                            const isSmart = (w.labels ?? []).some(l => ["smart_money","smart_degen"].includes(l.toLowerCase()));
                            const pnl = w.realizedProfit ? parseFloat(w.realizedProfit) : null;
                            return (
                              <tr key={w.walletAddress} className={cn("border-b border-[#30363d]/50 hover:bg-[#161b22]/60 transition-colors", i % 2 === 0 ? "" : "bg-[#161b22]/20")}>
                                <td className="px-4 py-2.5">
                                  <div className="flex items-center gap-2">
                                    <span className="font-mono text-[#8b949e]">{truncateAddress(w.walletAddress)}</span>
                                    {w.twitterName && (
                                      <span className="text-[#f59e0b] font-bold truncate max-w-[100px]">@{w.twitterName}</span>
                                    )}
                                  </div>
                                </td>
                                <td className="px-3 py-2.5">
                                  <div className="flex gap-1 flex-wrap">
                                    {isKol   && <span className="text-[8px] font-bold px-1.5 py-0.5 border text-[#f59e0b] bg-[#f59e0b]/10 border-[#f59e0b]/30 uppercase tracking-wider">KOL</span>}
                                    {isSmart && <span className="text-[8px] font-bold px-1.5 py-0.5 border text-[#60a5fa] bg-[#60a5fa]/10 border-[#60a5fa]/30 uppercase tracking-wider">SMART</span>}
                                  </div>
                                </td>
                                <td className="px-3 py-2.5 text-right text-[#8b949e] tabular-nums">
                                  {w.amountPercentage != null ? `${Number(w.amountPercentage).toFixed(2)}%` : "—"}
                                </td>
                                <td className="px-3 py-2.5 text-right tabular-nums font-mono font-bold">
                                  {pnl == null ? <span className="text-[#484f58]">—</span>
                                    : <span className={pnl >= 0 ? "text-[#22c55e]" : "text-[#ef4444]"}>
                                        {pnl >= 0 ? "+" : ""}
                                        {Math.abs(pnl) >= 1000 ? `$${(pnl/1000).toFixed(1)}K` : `$${pnl.toFixed(0)}`}
                                      </span>
                                  }
                                </td>
                                <td className="px-3 py-2.5 text-right text-[#8b949e] tabular-nums">
                                  <span className="text-[#22c55e]/70">{w.buyCount ?? 0}B</span>
                                  {" / "}
                                  <span className="text-[#ef4444]/70">{w.sellCount ?? 0}S</span>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : (
                  <div className="border border-[#30363d] bg-[#0d1117] py-12 text-center">
                    <Zap className="w-8 h-8 text-[#30363d] mx-auto mb-3" />
                    <div className="text-[10px] text-[#484f58] tracking-widest uppercase">No KOL or Smart wallets found</div>
                    <div className="text-[9px] text-[#30363d] mt-1">GMGN returned no KOL / Smart labels for this token</div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ── Holders Tab ── */}
        {activeTab === "holders" && (
          <div>
            <div className="grid grid-cols-2 gap-2 mb-3">
              <div className="bg-[#161b22] border border-[#f59e0b]/20 p-4">
                <div className="flex items-center gap-2 mb-2">
                  <Star className="w-4 h-4 text-[#f59e0b]" />
                  <span className="text-[9px] text-[#8b949e] uppercase tracking-widest">KOL / Renowned</span>
                </div>
                <div className="text-3xl font-bold text-[#f59e0b] tabular-nums">{kol}</div>
                <div className="text-[10px] text-[#484f58] mt-1">GMGN aggregate</div>
              </div>
              <div className="bg-[#161b22] border border-[#60a5fa]/20 p-4">
                <div className="flex items-center gap-2 mb-2">
                  <Shield className="w-4 h-4 text-[#60a5fa]" />
                  <span className="text-[9px] text-[#8b949e] uppercase tracking-widest">Smart Wallets</span>
                </div>
                <div className="text-3xl font-bold text-[#60a5fa] tabular-nums">{smart}</div>
                <div className="text-[10px] text-[#484f58] mt-1">GMGN aggregate</div>
              </div>
            </div>

            {holders.length > 0 && (
              <div className="border border-[#30363d] bg-[#0d1117]">
                <div className="text-[9px] text-[#484f58] uppercase tracking-widest px-4 py-2 border-b border-[#30363d] bg-[#161b22]">
                  KOL + Smart Wallets
                  {token.lastHoldersUpdatedAt && (
                    <span className="ml-2 text-[#30363d] normal-case">· {formatTimeAgo(token.lastHoldersUpdatedAt)} ago</span>
                  )}
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-[11px] whitespace-nowrap">
                    <thead>
                      <tr className="border-b border-[#30363d]">
                        <th className="px-4 py-2 text-[9px] text-[#484f58] uppercase tracking-widest text-left bg-[#161b22]">Wallet</th>
                        <th className="px-3 py-2 text-[9px] text-[#484f58] uppercase tracking-widest text-left bg-[#161b22]">Type</th>
                        <th className="px-3 py-2 text-[9px] text-[#484f58] uppercase tracking-widest text-right bg-[#161b22]">% Supply</th>
                        <th className="px-3 py-2 text-[9px] text-[#484f58] uppercase tracking-widest text-right bg-[#161b22]">P&L</th>
                        <th className="px-3 py-2 text-[9px] text-[#484f58] uppercase tracking-widest text-right bg-[#161b22]">Buys/Sells</th>
                      </tr>
                    </thead>
                    <tbody>
                      {holders.map((h, i) => {
                        const labels = (h.labels ?? []).map(l => l.toLowerCase());
                        const isKol   = labels.some(l => ["kol","renowned"].includes(l));
                        const isSmart = labels.some(l => ["smart","smart_money","smart_degen"].includes(l));
                        return (
                          <tr key={h.id} className={cn("border-b border-[#30363d]/50 hover:bg-[#1c2128]", i % 2 === 0 ? "bg-[#0d1117]" : "bg-[#161b22]/20")}>
                            <td className="px-4 py-2.5">
                              <div className="flex items-center gap-1.5">
                                <span className="font-mono text-[#c9d1d9]">{truncateAddress(h.walletAddress)}</span>
                                {h.twitterUsername && (
                                  <span className="text-[#f59e0b] text-[9px]">@{h.twitterUsername}</span>
                                )}
                              </div>
                            </td>
                            <td className="px-3 py-2.5">
                              <div className="flex gap-1.5">
                                {isKol   && <span className="text-[9px] font-bold text-[#f59e0b] bg-[#f59e0b]/10 border border-[#f59e0b]/20 px-1.5 py-0.5 tracking-widest">KOL</span>}
                                {isSmart && <span className="text-[9px] font-bold text-[#60a5fa] bg-[#60a5fa]/10 border border-[#60a5fa]/20 px-1.5 py-0.5 tracking-widest">SMART</span>}
                              </div>
                            </td>
                            <td className="px-3 py-2.5 text-right text-[#8b949e] tabular-nums">
                              {h.amountPercentage != null ? `${h.amountPercentage.toFixed(3)}%` : "—"}
                            </td>
                            <td className={cn("px-3 py-2.5 text-right tabular-nums font-bold",
                              h.realizedProfit ? (parseFloat(h.realizedProfit) >= 0 ? "text-[#22c55e]" : "text-[#ef4444]") : "text-[#484f58]")}>
                              {usd(h.realizedProfit)}
                            </td>
                            <td className="px-3 py-2.5 text-right text-[#8b949e] tabular-nums">
                              <span className="text-[#22c55e]/70">{h.buyCount ?? 0}B</span>
                              {" / "}
                              <span className="text-[#ef4444]/70">{h.sellCount ?? 0}S</span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {holderPages > 1 && (
                  <div className="flex items-center justify-between px-4 py-2 border-t border-[#30363d] bg-[#161b22]">
                    <span className="text-[10px] text-[#484f58] tracking-widest">
                      {holderTotal} holders total
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        className="w-6 h-6 flex items-center justify-center border border-[#30363d] text-[#8b949e] hover:border-[#f59e0b] hover:text-[#f59e0b] disabled:opacity-30 transition-colors"
                        disabled={holderPage <= 1} onClick={() => setHolderPage(p => p - 1)}
                      >
                        <ChevronLeft className="w-3.5 h-3.5" />
                      </button>
                      <span className="text-[10px] text-[#484f58] tabular-nums">{holderPage} / {holderPages}</span>
                      <button
                        className="w-6 h-6 flex items-center justify-center border border-[#30363d] text-[#8b949e] hover:border-[#f59e0b] hover:text-[#f59e0b] disabled:opacity-30 transition-colors"
                        disabled={holderPage >= holderPages} onClick={() => setHolderPage(p => p + 1)}
                      >
                        <ChevronRight className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── Traders Tab ── */}
        {activeTab === "traders" && (
          <div>
            <div className="text-[9px] text-[#484f58] uppercase tracking-widest mb-2 flex items-center gap-2">
              <Activity className="w-3 h-3" />
              <span>Top Traders by Profit</span>
              {tradersData?.fetchedAt && <span>· {formatTimeAgo(tradersData.fetchedAt)} ago</span>}
              {tradersData?.source === "cache" && <span className="text-[#30363d]">(cached)</span>}
            </div>

            {tradersLoading && (
              <div className="animate-pulse space-y-2">
                {Array(5).fill(0).map((_, i) => <div key={i} className="h-10 bg-[#161b22] border border-[#30363d]" />)}
              </div>
            )}

            {!tradersLoading && (tradersData?.traders ?? []).length === 0 && (
              <div className="text-center py-12 text-[#484f58] text-[11px] border border-[#30363d] bg-[#0d1117]">
                <Activity className="w-6 h-6 mx-auto mb-2 opacity-30" />
                <p>No trader data yet.</p>
                <p className="mt-1 text-[10px]">Traders are fetched on token detection and refreshed periodically.</p>
              </div>
            )}

            {!tradersLoading && (tradersData?.traders ?? []).length > 0 && (
              <div className="border border-[#30363d] bg-[#0d1117]">
                <div className="overflow-x-auto">
                  <table className="w-full text-[11px] whitespace-nowrap">
                    <thead>
                      <tr className="border-b border-[#30363d] bg-[#161b22]">
                        <th className="px-4 py-2 text-[9px] text-[#484f58] uppercase tracking-widest text-left">#</th>
                        <th className="px-3 py-2 text-[9px] text-[#484f58] uppercase tracking-widest text-left">Wallet</th>
                        <th className="px-3 py-2 text-[9px] text-[#484f58] uppercase tracking-widest text-left">Labels</th>
                        <th className="px-3 py-2 text-[9px] text-[#484f58] uppercase tracking-widest text-right">Profit $</th>
                        <th className="px-3 py-2 text-[9px] text-[#484f58] uppercase tracking-widest text-right">Buy Vol</th>
                        <th className="px-3 py-2 text-[9px] text-[#484f58] uppercase tracking-widest text-right">Sell Vol</th>
                        <th className="px-3 py-2 text-[9px] text-[#484f58] uppercase tracking-widest text-right">Holding</th>
                        <th className="px-3 py-2 text-[9px] text-[#484f58] uppercase tracking-widest text-right">B/S</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(tradersData?.traders ?? []).map((t, i) => {
                        const profitPos = (t.profitUsd ?? 0) >= 0;
                        const netPos    = (t.netFlowUsd ?? 0) >= 0;
                        return (
                          <tr key={t.id} className={cn(
                            "border-b border-[#30363d]/50 hover:bg-[#1c2128] transition-colors",
                            i % 2 === 0 ? "bg-[#0d1117]" : "bg-[#161b22]/20",
                          )}>
                            <td className="px-4 py-2.5 text-[#484f58] tabular-nums">{i + 1}</td>
                            <td className="px-3 py-2.5">
                              <div className="flex items-center gap-1.5">
                                <span className="font-mono text-[#c9d1d9]">{truncateAddress(t.walletAddress)}</span>
                                {t.twitterUsername && (
                                  <a href={`https://x.com/${t.twitterUsername}`} target="_blank" rel="noopener noreferrer"
                                    className="text-[#f59e0b] text-[9px] hover:underline">
                                    @{t.twitterUsername}
                                  </a>
                                )}
                              </div>
                            </td>
                            <td className="px-3 py-2.5">
                              <div className="flex flex-wrap gap-1">
                                {(t.labels ?? []).slice(0, 3).map(l => labelBadge(l))}
                              </div>
                            </td>
                            <td className={cn("px-3 py-2.5 text-right tabular-nums font-bold",
                              profitPos ? "text-[#22c55e]" : "text-[#ef4444]")}>
                              {usd(t.profitUsd)}
                            </td>
                            <td className="px-3 py-2.5 text-right text-[#8b949e] tabular-nums">{usd(t.buyVolumeUsd)}</td>
                            <td className="px-3 py-2.5 text-right text-[#8b949e] tabular-nums">{usd(t.sellVolumeUsd)}</td>
                            <td className="px-3 py-2.5 text-right tabular-nums">
                              {t.holdingPct != null
                                ? <span className={t.holdingPct > 0 ? "text-[#22c55e]" : "text-[#484f58]"}>{t.holdingPct.toFixed(2)}%</span>
                                : <span className="text-[#484f58]">—</span>
                              }
                            </td>
                            <td className="px-3 py-2.5 text-right text-[#8b949e] tabular-nums">
                              <span className="text-[#22c55e]/70">{t.buyCount}B</span>
                              {" / "}
                              <span className="text-[#ef4444]/70">{t.sellCount}S</span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Postmortem Tab ── */}
        {activeTab === "postmortem" && (
          <div className="space-y-4">
            <div className="text-[9px] text-[#484f58] uppercase tracking-widest flex items-center gap-2">
              <FileSearch className="w-3 h-3" />
              <span>Token Postmortem · Price &amp; Intelligence History</span>
            </div>

            {historyLoading && (
              <div className="animate-pulse space-y-2">
                {Array(4).fill(0).map((_, i) => <div key={i} className="h-24 bg-[#161b22] border border-[#30363d]" />)}
              </div>
            )}

            {!historyLoading && historyData && (() => {
              const { snapshots, intelLog, rugAnalysis } = historyData;

              // Rug severity config
              const rugCfg: Record<string, { color: string; label: string; bg: string }> = {
                rug:         { color: "#ef4444", label: "🚨 RUG DETECTED",          bg: "#ef4444/10" },
                dump:        { color: "#f97316", label: "⚠ MAJOR DUMP",             bg: "#f97316/10" },
                decline:     { color: "#f59e0b", label: "📉 DECLINING",              bg: "#f59e0b/10" },
                stable:      { color: "#22c55e", label: "✓ STABLE",                  bg: "#22c55e/10" },
                recovering:  { color: "#a78bfa", label: "↑ MAKING NEW HIGHS",        bg: "#a78bfa/10" },
                correction:  { color: "#60a5fa", label: "📊 HEALTHY CORRECTION",     bg: "#60a5fa/10" },
                stabilizing: { color: "#34d399", label: "🏔 POST-PUMP STABILIZING",  bg: "#34d399/10" },
              };
              const sev = rugCfg[rugAnalysis.rugSeverity] ?? rugCfg.stable;

              // Prepare chart data for MC chart
              const mcChartData = snapshots
                .filter(s => s.marketCapUsd)
                .map(s => ({
                  t: new Date(s.snapshotAt).getTime(),
                  ts: new Date(s.snapshotAt).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" }),
                  mc: parseFloat(s.marketCapUsd!),
                }));

              // Prepare chart data for intel score
              const scoreChartData = intelLog.map(e => ({
                t: new Date(e.computedAt).getTime(),
                ts: new Date(e.computedAt).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" }),
                score: Math.round(e.intelligenceScore),
                mc: e.marketCapUsd ? Math.round(parseFloat(e.marketCapUsd)) : null,
                trigger: e.trigger,
                status: e.statusAfter,
              }));

              const fmtMc = (v: number) =>
                v >= 1_000_000 ? `$${(v/1_000_000).toFixed(1)}M`
                : v >= 1_000 ? `$${(v/1_000).toFixed(1)}K`
                : `$${v.toFixed(0)}`;

              return (
                <>
                  {/* Rug analysis summary */}
                  <div className={`border p-4 grid grid-cols-2 md:grid-cols-3 gap-4`}
                    style={{ borderColor: sev.color + "40", backgroundColor: sev.color + "08" }}>
                    <div className="col-span-2 md:col-span-3 flex items-center gap-3 mb-1">
                      <span className="text-[11px] font-bold tracking-widest" style={{ color: sev.color }}>
                        {sev.label}
                      </span>
                      {rugAnalysis.currentMultiple != null && rugAnalysis.currentMultiple > 1 && (
                        <span className="text-[10px] text-[#22c55e] font-bold">
                          still +{rugAnalysis.currentMultiple.toFixed(1)}X from entry
                        </span>
                      )}
                    </div>
                    <div>
                      <div className="text-[9px] text-[#484f58] uppercase tracking-widest mb-1">Peak MC</div>
                      <div className="text-lg font-bold text-[#c9d1d9]">
                        {rugAnalysis.peakMcUsd ? fmtMc(rugAnalysis.peakMcUsd) : "—"}
                      </div>
                      {rugAnalysis.athMultiple != null && (
                        <div className="text-[9px] text-[#484f58] mt-0.5">{rugAnalysis.athMultiple.toFixed(1)}X ATH</div>
                      )}
                    </div>
                    <div>
                      <div className="text-[9px] text-[#484f58] uppercase tracking-widest mb-1">Current MC</div>
                      <div className="text-lg font-bold text-[#c9d1d9]">
                        {rugAnalysis.currentMcUsd ? fmtMc(rugAnalysis.currentMcUsd) : "—"}
                      </div>
                      {rugAnalysis.currentMultiple != null && (
                        <div className="text-[9px] mt-0.5" style={{ color: rugAnalysis.currentMultiple >= 1 ? "#22c55e" : "#ef4444" }}>
                          {rugAnalysis.currentMultiple >= 1 ? "+" : ""}{rugAnalysis.currentMultiple.toFixed(1)}X from entry
                        </div>
                      )}
                    </div>
                    <div>
                      <div className="text-[9px] text-[#484f58] uppercase tracking-widest mb-1">Drawdown from Peak</div>
                      <div className="text-lg font-bold" style={{ color: (rugAnalysis.drawdownPct ?? 0) > 50 ? "#ef4444" : (rugAnalysis.drawdownPct ?? 0) > 20 ? "#f59e0b" : "#22c55e" }}>
                        {rugAnalysis.drawdownPct != null ? `-${rugAnalysis.drawdownPct.toFixed(1)}%` : "—"}
                      </div>
                      {rugAnalysis.peakToCurrentHours != null && (
                        <div className="text-[9px] text-[#484f58] mt-0.5">{rugAnalysis.peakToCurrentHours.toFixed(1)}h ago</div>
                      )}
                    </div>
                  </div>

                  {/* MC chart */}
                  {mcChartData.length > 2 && (
                    <div className="border border-[#30363d] bg-[#0d1117]">
                      <div className="text-[9px] text-[#484f58] uppercase tracking-widest px-4 py-2 border-b border-[#30363d] bg-[#161b22] flex items-center gap-2">
                        <TrendingUp className="w-3 h-3" />
                        Market Cap Timeline (48h)
                        <span className="text-[#30363d]">· {mcChartData.length} snapshots</span>
                      </div>
                      <div className="p-3">
                        <ResponsiveContainer width="100%" height={160}>
                          <AreaChart data={mcChartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                            <defs>
                              <linearGradient id="mcGrad" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%"  stopColor="#f59e0b" stopOpacity={0.25} />
                                <stop offset="95%" stopColor="#f59e0b" stopOpacity={0} />
                              </linearGradient>
                            </defs>
                            <CartesianGrid strokeDasharray="3 3" stroke="#1c2128" />
                            <XAxis dataKey="ts" tick={{ fontSize: 8, fill: "#484f58" }} interval="preserveStartEnd" />
                            <YAxis tickFormatter={fmtMc} tick={{ fontSize: 8, fill: "#484f58" }} width={52} />
                            <Tooltip
                              contentStyle={{ backgroundColor: "#161b22", border: "1px solid #30363d", borderRadius: 0, fontSize: 11 }}
                              formatter={(v: number) => [fmtMc(v), "Market Cap"]}
                              labelStyle={{ color: "#8b949e" }}
                            />
                            <Area type="monotone" dataKey="mc" stroke="#f59e0b" strokeWidth={1.5}
                              fill="url(#mcGrad)" dot={false} />
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
                      <div className="text-[9px] text-[#484f58] uppercase tracking-widest px-4 py-2 border-b border-[#30363d] bg-[#161b22] flex items-center gap-2">
                        <Brain className="w-3 h-3" />
                        Intelligence Score History
                        <span className="text-[#30363d]">· {scoreChartData.length} entries</span>
                      </div>
                      <div className="p-3">
                        <ResponsiveContainer width="100%" height={130}>
                          <LineChart data={scoreChartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#1c2128" />
                            <XAxis dataKey="ts" tick={{ fontSize: 8, fill: "#484f58" }} interval="preserveStartEnd" />
                            <YAxis domain={[0, 100]} tick={{ fontSize: 8, fill: "#484f58" }} width={28} />
                            <Tooltip
                              contentStyle={{ backgroundColor: "#161b22", border: "1px solid #30363d", borderRadius: 0, fontSize: 11 }}
                              formatter={(v: number, _: string, props: { payload?: { status?: string; trigger?: string } }) => [
                                `${v} (${props.payload?.status ?? ""})`,
                                "Intel Score",
                              ]}
                              labelStyle={{ color: "#8b949e" }}
                            />
                            <ReferenceLine y={55} stroke="#484f58" strokeDasharray="3 3" label={{ value: "55", fontSize: 8, fill: "#484f58" }} />
                            <Line type="monotone" dataKey="score" stroke="#a78bfa" strokeWidth={2} dot={{ r: 2, fill: "#a78bfa" }} />
                          </LineChart>
                        </ResponsiveContainer>
                      </div>
                    </div>
                  )}

                  {/* Intel log table */}
                  {intelLog.length > 0 && (
                    <div className="border border-[#30363d] bg-[#0d1117]">
                      <div className="text-[9px] text-[#484f58] uppercase tracking-widest px-4 py-2 border-b border-[#30363d] bg-[#161b22]">
                        Score Log — {intelLog.length} entries (most recent first)
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
                              <th className="px-3 py-2 text-[9px] text-[#484f58] uppercase tracking-widest text-left">Trigger</th>
                            </tr>
                          </thead>
                          <tbody>
                            {[...intelLog].reverse().map((e, i) => {
                              const delta = e.prevIntelligenceScore != null
                                ? Math.round((e.intelligenceScore - e.prevIntelligenceScore) * 10) / 10
                                : null;
                              const deltaColor = delta == null ? "#484f58" : delta > 0 ? "#22c55e" : delta < 0 ? "#ef4444" : "#484f58";
                              const scoreColor =
                                e.intelligenceScore >= 62 ? "#22c55e" :
                                e.intelligenceScore >= 40 ? "#f59e0b" : "#ef4444";
                              return (
                                <tr key={i} className={cn(
                                  "border-b border-[#30363d]/50 hover:bg-[#1c2128] transition-colors",
                                  e.statusChanged ? "bg-[#f59e0b]/5" : i % 2 === 0 ? "bg-[#0d1117]" : "bg-[#161b22]/20",
                                )}>
                                  <td className="px-3 py-2 text-[#484f58] font-mono">
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
                                  <td className="px-3 py-2 text-[#484f58] capitalize">{e.trigger.replace("_", " ")}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {mcChartData.length === 0 && intelLog.length === 0 && (
                    <div className="text-center py-12 text-[#484f58] text-[11px] border border-[#30363d] bg-[#0d1117]">
                      <FileSearch className="w-6 h-6 mx-auto mb-2 opacity-30" />
                      <p>No history data yet.</p>
                      <p className="mt-1 text-[10px]">Price snapshots build up over time. Check back after the next scan cycle.</p>
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        )}

        {/* ── Security Tab ── */}
        {activeTab === "security" && (
          <div>
            <div className="flex items-center justify-between mb-3">
              <div className="text-[9px] text-[#484f58] uppercase tracking-widest flex items-center gap-2">
                <Shield className="w-3 h-3" />
                <span>CA Security Analysis</span>
                {(securityData?.secFetchedAt ?? sec?.fetchedAt) && (
                  <span>· {formatTimeAgo(securityData?.secFetchedAt ?? sec!.fetchedAt!)} ago</span>
                )}
              </div>
              <button
                onClick={() => { refetchSec(); }}
                className="text-[9px] text-[#484f58] hover:text-[#f59e0b] tracking-widest uppercase flex items-center gap-1 transition-colors"
              >
                <RefreshCw className={cn("w-3 h-3", secLoading && "animate-spin")} />
                Refresh
              </button>
            </div>

            {secLoading && !sec && (
              <div className="animate-pulse space-y-2">
                {Array(6).fill(0).map((_, i) => <div key={i} className="h-8 bg-[#161b22] border border-[#30363d]" />)}
              </div>
            )}

            {!secLoading && !sec && (
              <div className="text-center py-12 text-[#484f58] text-[11px] border border-[#30363d] bg-[#0d1117]">
                <Shield className="w-6 h-6 mx-auto mb-2 opacity-30" />
                <p>Security data not yet fetched.</p>
                <p className="mt-1 text-[10px]">Auto-fetched 15s after detection. Click Refresh to fetch now.</p>
              </div>
            )}

            {sec && (
              <div className="space-y-3">
                {/* Honeypot alert */}
                {sec.isHoneypot === true && (
                  <div className="border border-[#ef4444]/40 bg-[#ef4444]/10 px-4 py-3 flex items-center gap-3">
                    <XCircle className="w-5 h-5 text-[#ef4444] shrink-0" />
                    <div>
                      <div className="text-[11px] font-bold text-[#ef4444] tracking-widest uppercase">HONEYPOT DETECTED</div>
                      <div className="text-[10px] text-[#ef4444]/70 mt-0.5">This token cannot be sold. Do not buy.</div>
                    </div>
                  </div>
                )}

                {/* Risk summary */}
                <div className="grid grid-cols-2 gap-2">
                  <div className="border border-[#30363d] bg-[#161b22] p-3">
                    <div className="text-[9px] text-[#484f58] uppercase tracking-widest mb-1">Risk Score</div>
                    <div className="text-2xl font-bold tabular-nums" style={{ color: secRiskColor }}>
                      {secRiskLabel ?? "—"}
                    </div>
                    {sec.rugRatio != null && (
                      <div className="text-[10px] text-[#8b949e] mt-1">Rug ratio: {(sec.rugRatio * 100).toFixed(1)}%</div>
                    )}
                  </div>
                  <div className="border border-[#30363d] bg-[#161b22] p-3">
                    <div className="text-[9px] text-[#484f58] uppercase tracking-widest mb-1">LP Lock</div>
                    <div className="flex items-center gap-2 mt-1">
                      {sec.lpLocked === true
                        ? <Lock className="w-4 h-4 text-[#22c55e]" />
                        : sec.lpLocked === false
                        ? <Unlock className="w-4 h-4 text-[#ef4444]" />
                        : <HelpCircle className="w-4 h-4 text-[#484f58]" />
                      }
                      <span className={cn("text-lg font-bold",
                        sec.lpLocked === true ? "text-[#22c55e]" : sec.lpLocked === false ? "text-[#ef4444]" : "text-[#484f58]")}>
                        {sec.lpLocked === true ? "LOCKED" : sec.lpLocked === false ? "UNLOCKED" : "UNKNOWN"}
                      </span>
                    </div>
                    {sec.lpLockPercent != null && (
                      <div className="text-[10px] text-[#8b949e] mt-1">{(sec.lpLockPercent * 100).toFixed(1)}% locked</div>
                    )}
                  </div>
                </div>

                {/* Contract checks */}
                <div className="border border-[#30363d] bg-[#0d1117]">
                  <div className="text-[9px] text-[#484f58] uppercase tracking-widest px-4 py-2 border-b border-[#30363d] bg-[#161b22]">
                    Contract Checks
                  </div>
                  <div className="px-4">
                    <SecRow label="Honeypot"       status={sec.isHoneypot == null ? "unknown" : sec.isHoneypot ? "danger" : "safe"}
                      value={sec.isHoneypot == null ? "Unknown" : sec.isHoneypot ? "YES — do not buy" : "No"} />
                    <SecRow label="Owner Renounced" status={secStatus(sec.ownerRenounced, true)}
                      value={sec.ownerRenounced == null ? "Unknown" : sec.ownerRenounced ? "Yes" : "No"} />
                    {sec.mintRenounced != null && (
                      <SecRow label="Mint Renounced (SOL)" status={secStatus(sec.mintRenounced, true)}
                        value={sec.mintRenounced ? "Yes" : "No"} />
                    )}
                    {sec.freezeRenounced != null && (
                      <SecRow label="Freeze Renounced (SOL)" status={secStatus(sec.freezeRenounced, true)}
                        value={sec.freezeRenounced ? "Yes" : "No"} />
                    )}
                    <SecRow label="Open Source"   status={sec.openSource == null ? "unknown" : sec.openSource ? "safe" : "warn"}
                      value={sec.openSource == null ? "Unknown" : sec.openSource ? "Yes" : "No"} />
                    <SecRow label="CTO (Community Takeover)" status={sec.ctoFlag ? "warn" : "unknown"}
                      value={sec.ctoFlag ? "Yes" : sec.ctoFlag === false ? "No" : "Unknown"} />
                  </div>
                </div>

                {/* Holder distribution */}
                <div className="border border-[#30363d] bg-[#0d1117]">
                  <div className="text-[9px] text-[#484f58] uppercase tracking-widest px-4 py-2 border-b border-[#30363d] bg-[#161b22]">
                    Holder Distribution
                  </div>
                  <div className="px-4">
                    <SecRow label="Top 10 Holder Rate"
                      status={
                        sec.top10HolderRate == null ? "unknown"
                        : sec.top10HolderRate < 0.2 ? "safe"
                        : sec.top10HolderRate < 0.5 ? "warn" : "danger"
                      }
                      value={sec.top10HolderRate != null ? pct(sec.top10HolderRate) : "Unknown"} />
                    <SecRow label="Sniper Count"
                      status={
                        sec.sniperCount == null ? "unknown"
                        : sec.sniperCount < 5 ? "safe"
                        : sec.sniperCount < 20 ? "warn" : "danger"
                      }
                      value={sec.sniperCount != null ? String(sec.sniperCount) : "Unknown"} />
                    {sec.bluechipOwnerPct != null && (
                      <SecRow label="Bluechip Owner %" status="safe"
                        value={pct(sec.bluechipOwnerPct)} />
                    )}
                    {sec.ratTraderAmtRate != null && (
                      <SecRow label="Rat Trader Rate"
                        status={sec.ratTraderAmtRate > 0.3 ? "danger" : sec.ratTraderAmtRate > 0.1 ? "warn" : "safe"}
                        value={pct(sec.ratTraderAmtRate)} />
                    )}
                  </div>
                </div>

                {/* Creator / Dev info */}
                {(sec.creatorAddress || sec.buyTax != null || sec.sellTax != null) && (
                  <div className="border border-[#30363d] bg-[#0d1117]">
                    <div className="text-[9px] text-[#484f58] uppercase tracking-widest px-4 py-2 border-b border-[#30363d] bg-[#161b22]">
                      Creator &amp; Tax
                    </div>
                    <div className="px-4">
                      {sec.creatorAddress && (
                        <div className="flex items-center justify-between py-2 border-b border-[#30363d]/50">
                          <div className="flex items-center gap-2">
                            <Bug className="w-3.5 h-3.5 text-[#484f58]" />
                            <span className="text-[11px] text-[#8b949e]">Creator Address</span>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <span className="font-mono text-[11px] text-[#c9d1d9]">{truncateAddress(sec.creatorAddress)}</span>
                            <CopyBtn text={sec.creatorAddress} />
                            <a href={`https://gmgn.ai/sol/address/${sec.creatorAddress}`} target="_blank" rel="noopener noreferrer"
                              className="text-[#484f58] hover:text-[#f59e0b]">
                              <ExternalLink className="w-3 h-3" />
                            </a>
                          </div>
                        </div>
                      )}
                      {sec.creatorTokenStatus != null && (
                        <SecRow label="Creator Holding"
                          status={sec.creatorClose ? "safe" : sec.creatorClose === false ? "warn" : "unknown"}
                          value={sec.creatorClose ? "Sold ✓" : sec.creatorClose === false ? "Still Holding ⚠" : "Unknown"} />
                      )}
                      {sec.creatorCreatedCount != null && (
                        <SecRow label="Tokens by Creator"
                          status={sec.creatorCreatedCount > 5 ? "danger" : sec.creatorCreatedCount > 2 ? "warn" : "safe"}
                          value={String(sec.creatorCreatedCount)} />
                      )}
                      {sec.buyTax != null && (
                        <SecRow label="Buy Tax"
                          status={sec.buyTax === 0 ? "safe" : sec.buyTax < 0.05 ? "warn" : "danger"}
                          value={sec.buyTax === 0 ? "0%" : `${(sec.buyTax * 100).toFixed(2)}%`} />
                      )}
                      {sec.sellTax != null && (
                        <SecRow label="Sell Tax"
                          status={sec.sellTax === 0 ? "safe" : sec.sellTax < 0.05 ? "warn" : "danger"}
                          value={sec.sellTax === 0 ? "0%" : `${(sec.sellTax * 100).toFixed(2)}%`} />
                      )}
                    </div>
                  </div>
                )}

                {/* Flame meter */}
                <div className="flex items-center gap-3 border border-[#30363d] bg-[#0d1117] px-4 py-3">
                  <Flame className="w-4 h-4 text-[#f59e0b] shrink-0" />
                  <div className="flex-1">
                    <div className="flex justify-between text-[9px] tracking-widest uppercase mb-1.5">
                      <span className="text-[#484f58]">Overall Risk</span>
                      <span style={{ color: secRiskColor }} className="font-bold">{secRiskLabel ?? "—"}</span>
                    </div>
                    <div className="h-1.5 bg-[#1c2128] w-full">
                      <div className="h-full transition-all duration-500"
                        style={{
                          width: `${Math.min(100, ((secRisk ?? 0) / 10) * 100)}%`,
                          backgroundColor: secRiskColor,
                        }}
                      />
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Footer metadata row */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[10px] text-[#484f58] tracking-widest border-t border-[#30363d] pt-4">
        {token.tokenCreatedAt && (
          <span className="flex items-center gap-1.5">
            <Clock className="w-3 h-3" />
            Born {formatTimeAgo(token.tokenCreatedAt)} ago
          </span>
        )}
        <span className="flex items-center gap-1.5">
          <TrendingUp className="w-3 h-3" />
          Detected {formatTimeAgo(token.firstDetectedAt)} ago
        </span>
        {token.lastBuyAt && (
          <span className="flex items-center gap-1.5">
            Last wallet activity {formatTimeAgo(token.lastBuyAt)} ago
          </span>
        )}
      </div>
    </div>
  );
}
