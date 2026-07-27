import { useRoute, useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft, ExternalLink, Copy, CheckCheck, RefreshCw,
  Clock, TrendingUp, DollarSign, Star, Shield, ChevronLeft, ChevronRight,
  Brain, BarChart3, Users, Zap, Droplets,
} from "lucide-react";
import { useState, useCallback, useEffect } from "react";
import {
  formatTokenPrice, formatGain, formatMarketCap, formatTimeAgo,
  truncateAddress, getGmgnUrl, cn,
} from "@/lib/utils";

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
  mcGrowthScore?: number;
  volumeIntensityScore?: number;
  holderVelocityScore?: number;
  kolSmartScore?: number;
  liquidityHealthScore?: number;
  intelligenceUpdatedAt?: string | null;
  consecutivePositiveChecks?: number;
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

interface HoldersPage { data: HolderRow[]; total: number; page: number; pages: number; }

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

function usd(val: string | null | undefined): string {
  if (!val) return "—";
  const n = parseFloat(val);
  if (!isFinite(n)) return "—";
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000)     return `$${(n / 1_000).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

// ── Token logo with 3-step onerror fallback chain ────────────────────────────
function TokenDetailLogo({
  logoUri, address, symbol,
}: { logoUri?: string | null; address: string; symbol?: string | null }) {
  const jup = `https://static.jup.ag/images/tokens/${address}.png`;
  const avtr = `https://ui-avatars.com/api/?name=${encodeURIComponent(symbol?.slice(0, 2) || '?')}&background=1a2030&color=f59e0b&size=128`;
  const [src, setSrc] = useState(logoUri || jup);
  const [idx, setIdx] = useState(0);
  const fallbacks = [jup, avtr];

  useEffect(() => { setSrc(logoUri || jup); setIdx(0); }, [logoUri, address]);

  const onError = () => {
    const next = fallbacks[idx];
    if (next && src !== next) { setSrc(next); setIdx(i => i + 1); }
  };

  if (!src) return (
    <div className="w-14 h-14 border border-[#30363d] bg-[#161b22] flex items-center justify-center text-[#f59e0b] text-xl font-bold shrink-0">
      {symbol?.slice(0, 2) ?? "??"}
    </div>
  );
  return (
    <img src={src} alt="" className="w-14 h-14 border border-[#30363d] shrink-0" onError={onError} />
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function TokenDetail() {
  const [, params]      = useRoute("/tokens/:id");
  const [, setLocation] = useLocation();
  const id = params?.id ? parseInt(params.id, 10) : null;
  const qc = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const [holderPage, setHolderPage] = useState(1);

  const BASE = import.meta.env.BASE_URL;

  const { data: token, isLoading } = useQuery<TokenDetail>({
    queryKey: ["token", id],
    queryFn:  () => fetch(`${BASE}api/tokens/${id}`).then(r => r.json()),
    enabled:  id != null,
    refetchInterval: 15_000,
  });

  const { data: gmgn } = useQuery<GmgnResponse>({
    queryKey: ["token-gmgn-intelligence", id],
    queryFn:  () => fetch(`${BASE}api/tokens/${id}/gmgn`).then(r => r.json()),
    enabled:  id != null,
    refetchInterval: 30_000,
    staleTime: 10_000,
  });

  const { data: holdersData } = useQuery<HoldersPage>({
    queryKey: ["token-holders-kol-smart", id, holderPage],
    queryFn: async () => {
      const params = new URLSearchParams({ tokenId: String(id), limit: "20", page: String(holderPage) });
      return fetch(`${BASE}api/holders/list?${params}`).then(r => r.json());
    },
    enabled: id != null,
    staleTime: 60_000,
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

  // Filter holders to only KOL and Smart
  const holders     = (holdersData?.data ?? []).filter(h => {
    const labels = (h.labels ?? []).map(l => l.toLowerCase());
    return labels.some(l => ["kol","renowned","smart","smart_money","smart_degen"].includes(l));
  });
  const holderTotal = holdersData?.total ?? 0;
  const holderPages = holdersData?.pages ?? 1;

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

          {/* Master score */}
          <div className="bg-[#161b22] border border-[#30363d] p-4 mb-2">
            <div className="flex items-center justify-between mb-3">
              <div>
                <div className="text-[9px] text-[#484f58] uppercase tracking-widest mb-1">Master Intelligence Score</div>
                <div className="flex items-center gap-3">
                  <span className={cn(
                    "text-4xl font-bold tabular-nums",
                    (token.intelligenceScore ?? 0) >= 70 ? "text-[#22c55e]" :
                    (token.intelligenceScore ?? 0) >= 45 ? "text-[#f59e0b]" :
                    "text-[#ef4444]"
                  )}>
                    {Math.round(token.intelligenceScore ?? 0)}
                  </span>
                  <span className={cn(
                    "text-[10px] font-bold px-2 py-1 border tracking-widest",
                    (token.intelligenceScore ?? 0) >= 70 ? "text-[#22c55e] bg-[#22c55e]/10 border-[#22c55e]/20" :
                    (token.intelligenceScore ?? 0) >= 45 ? "text-[#f59e0b] bg-[#f59e0b]/10 border-[#f59e0b]/20" :
                    "text-[#ef4444] bg-[#ef4444]/10 border-[#ef4444]/20"
                  )}>
                    {(token.intelligenceScore ?? 0) >= 70 ? "HIGH CONVICTION" :
                     (token.intelligenceScore ?? 0) >= 45 ? "MODERATE" : "WEAK SIGNAL"}
                  </span>
                </div>
              </div>
              {/* Progress arc */}
              <div className="relative w-16 h-16 shrink-0">
                <svg viewBox="0 0 56 56" className="w-full h-full -rotate-90">
                  <circle cx="28" cy="28" r="22" fill="none" stroke="#1c2128" strokeWidth="6" />
                  <circle
                    cx="28" cy="28" r="22" fill="none"
                    stroke={(token.intelligenceScore ?? 0) >= 70 ? "#22c55e" : (token.intelligenceScore ?? 0) >= 45 ? "#f59e0b" : "#ef4444"}
                    strokeWidth="6"
                    strokeDasharray={`${((token.intelligenceScore ?? 0) / 100) * 138.2} 138.2`}
                    strokeLinecap="round"
                  />
                </svg>
                <div className="absolute inset-0 flex items-center justify-center text-[11px] font-bold text-[#c9d1d9] tabular-nums rotate-0">
                  {Math.round(token.intelligenceScore ?? 0)}
                </div>
              </div>
            </div>

            {/* Graduation progress (only for new tokens) */}
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

          {/* Sub-score breakdown */}
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

      {/* Holder Intel — KOL + Smart only */}
      <div>
        <div className="text-[9px] text-[#484f58] uppercase tracking-widest mb-2 flex items-center gap-2">
          <span>Holder Intelligence</span>
          {token.lastHoldersUpdatedAt && (
            <span>· Updated {formatTimeAgo(token.lastHoldersUpdatedAt)} ago</span>
          )}
        </div>
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

        {/* Holder snapshot table — KOL + Smart filtered */}
        {holders.length > 0 && (
          <div className="border border-[#30363d] bg-[#0d1117]">
            <div className="text-[9px] text-[#484f58] uppercase tracking-widest px-4 py-2 border-b border-[#30363d] bg-[#161b22]">
              KOL + Smart Wallets
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
                        <td className={cn("px-3 py-2.5 text-right tabular-nums font-bold", h.realizedProfit ? (parseFloat(h.realizedProfit) >= 0 ? "text-[#22c55e]" : "text-[#ef4444]") : "text-[#484f58]")}>
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
