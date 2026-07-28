import { useRoute, useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft, ExternalLink, Copy, CheckCheck, RefreshCw,
  Clock, TrendingUp, DollarSign, Star, Shield, ChevronLeft, ChevronRight,
  Brain, BarChart3, Users, Zap, Droplets, Lock, Unlock, AlertTriangle,
  CheckCircle, XCircle, HelpCircle, Flame, Bug, Activity,
} from "lucide-react";
import { useState, useCallback } from "react";
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
interface TradersResponse { source: string; traders: TraderRow[]; fetchedAt: string | null; }
interface SecurityResponse { source: string; security: SecurityData; secFetchedAt: string; creatorProfile: unknown | null; }

interface GmgnResponse {
  holderIntel?: { kolCount?: number; smartCount?: number; holderCount?: number };
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
  const [activeTab, setActiveTab] = useState<"holders" | "traders" | "security">("holders");

  const BASE = import.meta.env.BASE_URL;

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
              { label: "MC Growth",        score: token.mcGrowthScore,         weight: "35%", icon: TrendingUp,  color: "#22c55e" },
              { label: "Volume Intensity", score: token.volumeIntensityScore,   weight: "25%", icon: BarChart3,   color: "#60a5fa" },
              { label: "Holder Velocity",  score: token.holderVelocityScore,    weight: "20%", icon: Users,       color: "#a78bfa" },
              { label: "KOL / Smart",      score: token.kolSmartScore,          weight: "15%", icon: Zap,         color: "#f59e0b" },
              { label: "Liquidity Health", score: token.liquidityHealthScore,   weight: "5%",  icon: Droplets,    color: "#34d399" },
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

      {/* Tabs: Holders | Traders | Security */}
      <div>
        <div className="flex border-b border-[#30363d] mb-4">
          {(["holders", "traders", "security"] as const).map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={cn(
                "px-4 py-2 text-[10px] tracking-widest uppercase font-bold border-b-2 transition-colors -mb-px",
                activeTab === tab
                  ? "border-[#f59e0b] text-[#f59e0b]"
                  : "border-transparent text-[#484f58] hover:text-[#8b949e]",
              )}
            >
              {tab === "holders" && <span className="flex items-center gap-1.5"><Users className="w-3 h-3" />{tab}</span>}
              {tab === "traders" && <span className="flex items-center gap-1.5"><Activity className="w-3 h-3" />{tab}</span>}
              {tab === "security" && (
                <span className="flex items-center gap-1.5">
                  <Shield className="w-3 h-3" />
                  {tab}
                  {sec?.isHoneypot === true && <span className="ml-1 text-[#ef4444]">●</span>}
                  {sec?.isHoneypot === false && sec && (secRisk ?? 0) === 0 && <span className="ml-1 text-[#22c55e]">●</span>}
                </span>
              )}
            </button>
          ))}
        </div>

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
