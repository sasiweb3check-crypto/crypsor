import { useState, useMemo, useEffect } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronLeft, ChevronRight, ExternalLink, TrendingUp, Coins, Users, Star,
} from "lucide-react";
import { useGetDashboard } from "@workspace/api-client-react";
import {
  formatTokenPrice, formatGain, formatCompactUsd,
  formatTimeAgo, truncateAddress, getGmgnUrl, cn,
  safeImageUrl, safeSymbol, safeName,
} from "@/lib/utils";
import { MonitorStatusBar } from "@/components/monitor-status-bar";
import { getApiBase } from "@/lib/api-base";

// ── Types ─────────────────────────────────────────────────────────────────────

interface RichToken {
  id: number;
  address: string;
  chain: string;
  name: string | null;
  symbol: string | null;
  logoUri: string | null;
  status?: string;
  migrated?: boolean;
  detectedPriceUsd?: string | null;
  currentPriceUsd?: string | null;
  marketCapUsd?: string | null;
  holderCount?: number;
  holderKolCount?: number;
  holderSmartCount?: number;
  firstDetectedAt: string;
  detectionGainPct?: number | null;
  athGainPct?: number | null;
  intelligenceScore?: number;
  qualityLabel?: string;
}

interface PaginatedTokenPage {
  data: RichToken[];
  total: number;
  page: number;
  pages: number;
}

type SortField = "name" | "detectionGainPct" | "athGainPct" | "marketCapUsd" | "systemAge" | "intelligenceScore";
type SortOrder = "asc" | "desc";

const PAGE_LIMIT = 50;

const LIFECYCLE_TABS = [
  { value: "smart",    label: "INTEL ≥80" },  // default: intel≥80, status new/active/watch, MC≥5K
  { value: "all",      label: "ALL" },
  { value: "new",      label: "NEW" },
  { value: "active",   label: "ACTIVE" },
  { value: "watch",    label: "WATCH" },
  { value: "revived",  label: "REVIVED" },
  { value: "archive",  label: "ARCHIVE" },
  { value: "migrated", label: "🔀" },
];

// ── Token logo with 3-step fallback chain ────────────────────────────────────

function TokenLogo({
  logoUri, address, symbol, size = 6,
}: { logoUri?: string | null; address: string; symbol?: string | null; size?: number }) {
  const initial = safeImageUrl(logoUri, address, symbol);
  const fallbacks = [
    `https://static.jup.ag/images/tokens/${address}.png`,
    `https://ui-avatars.com/api/?name=${encodeURIComponent((symbol?.slice(0, 2) || '?').replace(/[^\x00-\x7F]/g, '').trim() || '?')}&background=1a2030&color=f59e0b&size=64`,
  ];
  const [src, setSrc] = useState(initial);
  const [idx, setIdx] = useState(0);

  const onError = () => {
    const next = fallbacks[idx];
    if (next && src !== next) { setSrc(next); setIdx(i => i + 1); }
  };

  const cls = `w-${size} h-${size} shrink-0 border border-[#30363d]`;
  return (
    <img src={src} alt="" className={cls} onError={onError}
      style={{ borderRadius: 0 }} />
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function gainColor(pct: number | null | undefined) {
  if (pct == null) return "text-[#8b949e]";
  if (pct > 0)  return "text-[#22c55e]";
  if (pct < 0)  return "text-[#ef4444]";
  return "text-[#8b949e]";
}

function LiveAge({ dateStr }: { dateStr: string | null | undefined }) {
  const [text, setText] = useState(() => formatTimeAgo(dateStr));
  useEffect(() => {
    setText(formatTimeAgo(dateStr));
    const id = setInterval(() => setText(formatTimeAgo(dateStr)), 10_000);
    return () => clearInterval(id);
  }, [dateStr]);
  return <span>{text || "—"}</span>;
}

function qualityTier(score: number, label?: string) {
  const lbl = label ?? (
    score >= 82 ? "Elite" : score >= 72 ? "Excellent" : score >= 62 ? "Strong" :
    score >= 52 ? "Good"  : score >= 40 ? "Average"   : score >= 25 ? "Speculative" : "Weak"
  );
  const color =
    lbl === "Elite"       ? "text-[#a78bfa] bg-[#a78bfa]/10 border-[#a78bfa]/20" :
    lbl === "Excellent"   ? "text-[#22c55e] bg-[#22c55e]/10 border-[#22c55e]/20" :
    lbl === "Strong"      ? "text-[#10b981] bg-[#10b981]/10 border-[#10b981]/20" :
    lbl === "Good"        ? "text-[#3b82f6] bg-[#3b82f6]/10 border-[#3b82f6]/20" :
    lbl === "Average"     ? "text-[#f59e0b] bg-[#f59e0b]/10 border-[#f59e0b]/20" :
    lbl === "Speculative" ? "text-[#f97316] bg-[#f97316]/10 border-[#f97316]/20" :
                            "text-[#ef4444] bg-[#ef4444]/10 border-[#ef4444]/20";
  return { lbl, color };
}

function IntelBadge({ score, label }: { score?: number; label?: string }) {
  if (score == null || score === 0) return <span className="text-[#30363d]">—</span>;
  const { lbl, color } = qualityTier(score, label);
  return (
    <div className="flex items-center gap-1.5">
      <span className={cn("text-[9px] font-bold px-1.5 py-0.5 border tracking-widest", color)}>
        {lbl.toUpperCase()}
      </span>
      <span className="tabular-nums font-bold text-[#c9d1d9]">{Math.round(score)}</span>
    </div>
  );
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

// ── Stat Card ─────────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, icon: Icon, accentColor }: {
  label: string; value: React.ReactNode; sub?: string;
  icon: React.ElementType; accentColor: string;
}) {
  return (
    <div className="bg-[#161b22] border border-[#30363d] p-3 relative overflow-hidden">
      <div className="absolute right-0 top-0 w-10 h-10 opacity-10" style={{ background: `radial-gradient(circle at top right, ${accentColor}, transparent 70%)` }} />
      <span className="text-[#8b949e] text-[9px] uppercase tracking-widest flex items-center gap-1.5">
        <Icon className="w-3 h-3" style={{ color: accentColor }} />
        {label}
      </span>
      <div className="text-[#c9d1d9] text-2xl font-bold leading-none mt-2 tabular-nums">{value}</div>
      {sub && <div className="text-[#8b949e] text-[10px] mt-1 truncate">{sub}</div>}
    </div>
  );
}

// ── Mobile Token Card ─────────────────────────────────────────────────────────

function MobileTokenCard({ token, onClick }: { token: RichToken; onClick: () => void }) {
  const gain = token.detectionGainPct;
  const ath  = token.athGainPct;
  return (
    <div
      className="bg-[#161b22] border-b border-[#30363d] px-4 py-3 cursor-pointer hover:bg-[#1c2128] transition-colors active:bg-[#1c2128]"
      onClick={onClick}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <TokenLogo logoUri={token.logoUri} address={token.address} symbol={token.symbol} size={7} />
          <div className="min-w-0">
            <div className="text-[#f59e0b] text-sm font-bold truncate">{safeSymbol(token.symbol, token.address)}</div>
            <div className="text-[#8b949e] text-[10px] truncate">{safeName(token.name, token.symbol, token.address)}</div>
          </div>
        </div>
        <StatusBadge status={token.status} />
      </div>

      <div className="grid grid-cols-3 gap-2 text-[10px]">
        <div>
          <div className="text-[#484f58] uppercase tracking-widest">Gain</div>
          <div className={cn("font-bold tabular-nums", gainColor(gain))}>{formatGain(gain)}</div>
        </div>
        <div>
          <div className="text-[#484f58] uppercase tracking-widest">ATH</div>
          <div className={cn("font-bold tabular-nums", gainColor(ath))}>{formatGain(ath)}</div>
        </div>
        <div>
          <div className="text-[#484f58] uppercase tracking-widest">Detected @</div>
          <div className="text-[#c9d1d9] font-bold tabular-nums">{formatTokenPrice(token.detectedPriceUsd)}</div>
        </div>
      </div>

      <div className="flex items-center gap-3 mt-2">
        {(token.holderKolCount ?? 0) > 0 && (
          <span className="text-[#f59e0b] text-[10px] font-bold">KOL {token.holderKolCount}</span>
        )}
        {(token.holderSmartCount ?? 0) > 0 && (
          <span className="text-[#60a5fa] text-[10px] font-bold">SMART {token.holderSmartCount}</span>
        )}
        <span className="ml-auto text-[#484f58] text-[10px]">
          <LiveAge dateStr={token.firstDetectedAt} />
        </span>
      </div>
    </div>
  );
}

// ── Sort Head ─────────────────────────────────────────────────────────────────

function SortHead({ field, current, order, onSort, children, right }: {
  field: SortField; current: SortField; order: SortOrder;
  onSort: (f: SortField) => void; children: React.ReactNode; right?: boolean;
}) {
  const active = field === current;
  return (
    <th
      className={cn(
        "px-3 py-2.5 text-[9px] font-bold uppercase tracking-widest cursor-pointer select-none whitespace-nowrap border-b border-[#30363d] bg-[#161b22]",
        active ? "text-[#f59e0b]" : "text-[#484f58] hover:text-[#8b949e]",
        right && "text-right",
      )}
      onClick={() => onSort(field)}
    >
      <span className="flex items-center gap-1" style={right ? { justifyContent: "flex-end" } : {}}>
        {children}
        <span className="opacity-60">{active ? (order === "asc" ? "↑" : "↓") : "↕"}</span>
      </span>
    </th>
  );
}

// ── Pagination ────────────────────────────────────────────────────────────────

function PaginationBar({ page, pages, total, limit, onPrev, onNext }: {
  page: number; pages: number; total: number; limit: number;
  onPrev: () => void; onNext: () => void;
}) {
  const from = Math.min((page - 1) * limit + 1, total);
  const to   = Math.min(page * limit, total);
  return (
    <div className="flex items-center justify-between px-4 py-2.5 border-t border-[#30363d] bg-[#161b22]">
      <span className="text-[10px] text-[#484f58] tabular-nums tracking-widest">
        {total === 0 ? "0 TOKENS" : `${from}–${to} OF ${total}`}
      </span>
      <div className="flex items-center gap-2">
        <button
          className="w-6 h-6 flex items-center justify-center border border-[#30363d] text-[#8b949e] hover:border-[#f59e0b] hover:text-[#f59e0b] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          disabled={page <= 1} onClick={onPrev}
        >
          <ChevronLeft className="w-3.5 h-3.5" />
        </button>
        <span className="text-[10px] text-[#8b949e] tabular-nums tracking-widest px-1">{page} / {pages}</span>
        <button
          className="w-6 h-6 flex items-center justify-center border border-[#30363d] text-[#8b949e] hover:border-[#f59e0b] hover:text-[#f59e0b] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          disabled={page >= pages} onClick={onNext}
        >
          <ChevronRight className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const [, setLocation] = useLocation();
  const [sortField, setSortField] = useState<SortField>("systemAge");
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc");
  const [activeTab, setActiveTab] = useState("smart");
  const [page, setPage] = useState(1);

  useEffect(() => { setPage(1); }, [activeTab, sortField, sortOrder]);

  const { data: summary, isLoading: summaryLoading } = useGetDashboard({
    query: { refetchInterval: 20_000, queryKey: ["dashboard"] },
  });

  const { data: tokenPage, isLoading: tokensLoading, isFetching } = useQuery<PaginatedTokenPage>({
    queryKey: ["tokens", page, activeTab, sortField, sortOrder],
    queryFn: async () => {
      const params = new URLSearchParams({
        page: String(page), limit: String(PAGE_LIMIT),
        sort: sortField, order: sortOrder,
      });
      if (activeTab !== "all") params.set("status", activeTab);
      // "smart" tab: enforce intel ≥ 80 and MC ≥ 5 000 at the API level
      if (activeTab === "smart") {
        params.set("minIntelScore", "80");
        params.set("minMc", "5000");
      }
      const r = await fetch(`${getApiBase()}api/tokens?${params}`);
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    refetchInterval: 20_000,
    placeholderData: prev => prev,
    staleTime: 10_000,
  });

  const { data: topPerfPage } = useQuery<PaginatedTokenPage>({
    queryKey: ["tokens", "top-performers"],
    queryFn: async () => {
      const r = await fetch(`${getApiBase()}api/tokens?sort=detectionGainPct&order=desc&limit=1&page=1`);
      return r.json();
    },
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  const pageTokens    = tokenPage?.data   ?? [];
  const total         = tokenPage?.total  ?? 0;
  const pages         = tokenPage?.pages  ?? 1;
  const topGainer     = (topPerfPage?.data ?? [])[0];
  const dashSummary   = summary as Record<string, unknown> | undefined;
  const lifecycle     = (dashSummary?.lifecycle as Record<string, number>) ?? {};

  const handleSort = (f: SortField) => {
    if (sortField === f) setSortOrder(o => o === "asc" ? "desc" : "asc");
    else { setSortField(f); setSortOrder("desc"); }
  };

  const tabCounts = useMemo<Record<string, number>>(() => ({
    all: (dashSummary?.totalTokens as number) ?? 0,
    ...lifecycle,
  }), [dashSummary, lifecycle]);

  return (
    <div className="space-y-4">
      {/* Status bar */}
      <MonitorStatusBar />

      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        {summaryLoading ? (
          Array(4).fill(0).map((_, i) => (
            <div key={i} className="bg-[#161b22] border border-[#30363d] p-3 h-20 animate-pulse" />
          ))
        ) : (
          <>
            <StatCard
              label="Tokens Detected"
              value={(dashSummary?.totalTokens as number) ?? 0}
              icon={Coins}
              accentColor="#f59e0b"
              sub={`${lifecycle["active"] ?? 0} active`}
            />
            <StatCard
              label="Top Gainer"
              value={
                topGainer
                  ? <span className="text-[#22c55e]">{topGainer.symbol || truncateAddress(topGainer.address)}</span>
                  : <span className="text-[#8b949e]">—</span>
              }
              icon={TrendingUp}
              accentColor="#22c55e"
              sub={topGainer ? formatGain(topGainer.detectionGainPct) : "No data yet"}
            />
            <StatCard
              label="KOL Wallets"
              value={(dashSummary?.totalKolWallets as number) ?? 0}
              icon={Star}
              accentColor="#f59e0b"
              sub="unique across all tokens"
            />
            <StatCard
              label="Smart Wallets"
              value={(dashSummary?.totalSmartWallets as number) ?? 0}
              icon={Users}
              accentColor="#60a5fa"
              sub="unique across all tokens"
            />
          </>
        )}
      </div>

      {/* Lifecycle tabs */}
      <div className="flex items-center gap-px flex-wrap border-b border-[#30363d]">
        {LIFECYCLE_TABS.map(tab => (
          <button
            key={tab.value}
            onClick={() => setActiveTab(tab.value)}
            className={cn(
              "px-3 py-2 text-[10px] font-bold tracking-widest uppercase border-b-2 transition-colors whitespace-nowrap",
              activeTab === tab.value
                ? "border-[#f59e0b] text-[#f59e0b]"
                : "border-transparent text-[#484f58] hover:text-[#8b949e]",
            )}
          >
            {tab.label}
            {tabCounts[tab.value] !== undefined && tabCounts[tab.value] > 0 && (
              <span className="ml-1.5 opacity-50 tabular-nums">{tabCounts[tab.value]}</span>
            )}
          </button>
        ))}
        {isFetching && !tokensLoading && (
          <span className="ml-auto text-[9px] text-[#484f58] tracking-widest animate-pulse pr-2">REFRESHING…</span>
        )}
      </div>

      {/* Mobile: card list */}
      <div className="md:hidden border border-[#30363d] bg-[#0d1117]">
        {tokensLoading && !tokenPage ? (
          Array(6).fill(0).map((_, i) => (
            <div key={i} className="px-4 py-3 border-b border-[#30363d] animate-pulse">
              <div className="flex justify-between mb-2">
                <div className="h-4 w-24 bg-[#161b22]" />
                <div className="h-4 w-14 bg-[#161b22]" />
              </div>
              <div className="h-3 w-32 bg-[#161b22]" />
            </div>
          ))
        ) : pageTokens.length === 0 ? (
          <div className="py-16 text-center">
            <Coins className="w-8 h-8 mx-auto mb-3 text-[#30363d]" />
            <p className="text-[#8b949e] text-sm tracking-widest uppercase">No Tokens</p>
            <p className="text-[#484f58] text-xs mt-1">{activeTab !== "all" ? "Try another filter" : "Configure Helius to start"}</p>
          </div>
        ) : (
          pageTokens.map(token => (
            <MobileTokenCard key={token.id} token={token} onClick={() => setLocation(`/tokens/${token.id}`)} />
          ))
        )}
        {pageTokens.length > 0 && (
          <PaginationBar page={page} pages={pages} total={total} limit={PAGE_LIMIT}
            onPrev={() => setPage(p => p - 1)} onNext={() => setPage(p => p + 1)} />
        )}
      </div>

      {/* Desktop: table */}
      <div className="hidden md:block border border-[#30363d] bg-[#0d1117] overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-[11px] text-left whitespace-nowrap">
            <thead>
              <tr>
                <th className="px-4 py-2.5 text-[9px] font-bold uppercase tracking-widest text-[#484f58] border-b border-[#30363d] bg-[#161b22] w-[200px]">
                  Token
                </th>
                <th className="px-3 py-2.5 text-[9px] font-bold uppercase tracking-widest text-[#484f58] border-b border-[#30363d] bg-[#161b22]">
                  Status
                </th>
                <SortHead field="intelligenceScore" current={sortField} order={sortOrder} onSort={handleSort}>Intel</SortHead>
                <SortHead field="detectionGainPct" current={sortField} order={sortOrder} onSort={handleSort}>Gain</SortHead>
                <SortHead field="athGainPct"       current={sortField} order={sortOrder} onSort={handleSort}>ATH</SortHead>
                <SortHead field="marketCapUsd"     current={sortField} order={sortOrder} onSort={handleSort}>MCap</SortHead>
                <th className="px-3 py-2.5 text-[9px] font-bold uppercase tracking-widest text-[#484f58] border-b border-[#30363d] bg-[#161b22]">
                  Detected @
                </th>
                <th className="px-3 py-2.5 text-[9px] font-bold uppercase tracking-widest text-[#484f58] border-b border-[#30363d] bg-[#161b22]">
                  KOL / Smart
                </th>
                <SortHead field="systemAge" current={sortField} order={sortOrder} onSort={handleSort} right>Age</SortHead>
              </tr>
            </thead>
            <tbody>
              {tokensLoading && !tokenPage ? (
                Array(10).fill(0).map((_, i) => (
                  <tr key={i} className={i % 2 === 0 ? "bg-[#0d1117]" : "bg-[#161b22]/30"}>
                    {Array(8).fill(0).map((__, j) => (
                      <td key={j} className="px-3 py-3 border-b border-[#30363d]/50">
                        <div className="h-3 bg-[#161b22] animate-pulse w-16" />
                      </td>
                    ))}
                  </tr>
                ))
              ) : pageTokens.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-20 text-center">
                    <Coins className="w-8 h-8 mx-auto mb-3 text-[#30363d]" />
                    <p className="text-[#8b949e] text-xs tracking-widest uppercase">
              {activeTab === "smart" ? "No tokens passing Intel ≥80 · MC ≥5K" : activeTab !== "all" ? `No tokens in "${activeTab}"` : "No tokens"}
            </p>
                  </td>
                </tr>
              ) : pageTokens.map((token, i) => (
                <tr
                  key={token.id}
                  className={cn(
                    "group cursor-pointer border-b border-[#30363d]/50 hover:bg-[#1c2128] transition-colors",
                    i % 2 === 0 ? "bg-[#0d1117]" : "bg-[#161b22]/20",
                  )}
                  onClick={() => setLocation(`/tokens/${token.id}`)}
                >
                  {/* Token */}
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <TokenLogo logoUri={token.logoUri} address={token.address} symbol={token.symbol} size={6} />
                      <div className="min-w-0">
                        <div className="text-[#f59e0b] font-bold text-xs truncate">{safeSymbol(token.symbol, token.address)}</div>
                        <div className="text-[#484f58] text-[9px] truncate">{safeName(token.name, token.symbol, token.address)}</div>
                      </div>
                      <a
                        href={getGmgnUrl(token.chain, token.address)}
                        target="_blank" rel="noopener noreferrer"
                        onClick={e => e.stopPropagation()}
                        className="opacity-0 group-hover:opacity-100 transition-opacity text-[#484f58] hover:text-[#f59e0b] shrink-0"
                      >
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    </div>
                  </td>
                  {/* Status */}
                  <td className="px-3 py-3"><StatusBadge status={token.status} /></td>
                  {/* Intelligence */}
                  <td className="px-3 py-3"><IntelBadge score={token.intelligenceScore} label={token.qualityLabel} /></td>
                  {/* Gain % */}
                  <td className="px-3 py-3">
                    <span className={cn("font-bold tabular-nums", gainColor(token.detectionGainPct))}>
                      {formatGain(token.detectionGainPct)}
                    </span>
                  </td>
                  {/* ATH % */}
                  <td className="px-3 py-3">
                    <span className={cn("font-bold tabular-nums", gainColor(token.athGainPct))}>
                      {formatGain(token.athGainPct)}
                    </span>
                  </td>
                  {/* MCap */}
                  <td className="px-3 py-3 text-[#c9d1d9] tabular-nums">{formatCompactUsd(token.marketCapUsd)}</td>
                  {/* Detected @ */}
                  <td className="px-3 py-3 text-[#8b949e] tabular-nums">{formatTokenPrice(token.detectedPriceUsd)}</td>
                  {/* KOL / Smart */}
                  <td className="px-3 py-3">
                    <div className="flex items-center gap-2">
                      {(token.holderKolCount ?? 0) > 0 && (
                        <span className="text-[#f59e0b] font-bold text-[10px]">KOL {token.holderKolCount}</span>
                      )}
                      {(token.holderSmartCount ?? 0) > 0 && (
                        <span className="text-[#60a5fa] font-bold text-[10px]">SMART {token.holderSmartCount}</span>
                      )}
                      {(token.holderKolCount ?? 0) === 0 && (token.holderSmartCount ?? 0) === 0 && (
                        <span className="text-[#30363d]">—</span>
                      )}
                    </div>
                  </td>
                  {/* Age */}
                  <td className="px-4 py-3 text-right text-[#484f58]">
                    <LiveAge dateStr={token.firstDetectedAt} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {pageTokens.length > 0 && (
          <PaginationBar page={page} pages={pages} total={total} limit={PAGE_LIMIT}
            onPrev={() => setPage(p => p - 1)} onNext={() => setPage(p => p + 1)} />
        )}
      </div>
    </div>
  );
}
