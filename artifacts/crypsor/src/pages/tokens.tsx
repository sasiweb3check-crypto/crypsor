import { useState, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { Search, ExternalLink, X, ChevronLeft, ChevronRight } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import {
  formatTokenPrice, formatGain, formatMarketCap,
  formatTimeAgo, truncateAddress, getGmgnUrl, cn,
} from "@/lib/utils";

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
  holderKolCount?: number;
  holderSmartCount?: number;
  firstDetectedAt: string;
  detectionGainPct?: number | null;
  athGainPct?: number | null;
  intelligenceScore?: number;
  qualityLabel?: string;
  mcGrowthScore?: number;
  volumeIntensityScore?: number;
  holderVelocityScore?: number;
  kolSmartScore?: number;
  liquidityHealthScore?: number;
}

interface PaginatedTokenPage {
  data: RichToken[];
  total: number;
  page: number;
  pages: number;
}

type SortField = "name" | "detectionGainPct" | "athGainPct" | "marketCapUsd" | "systemAge" | "intelligenceScore";
type SortOrder = "asc" | "desc";

const PAGE_LIMIT   = 50;
const STATUS_OPTS  = ["all", "new", "active", "watch", "revived", "archive", "migrated"];
const CHAIN_OPTS   = ["all", "solana", "eth", "base", "bsc", "polygon", "arbitrum"];

// ── Helpers ───────────────────────────────────────────────────────────────────

function gainColor(pct: number | null | undefined) {
  if (pct == null) return "text-[#8b949e]";
  if (pct > 0)  return "text-[#22c55e]";
  if (pct < 0)  return "text-[#ef4444]";
  return "text-[#8b949e]";
}

// ── Quality score badge (7-tier) ──────────────────────────────────────────────

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
      {s === "migrated" ? "🔀" : (status ?? "?").toUpperCase()}
    </span>
  );
}

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

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
      <span className={cn("flex items-center gap-1", right && "justify-end")}>
        {children}
        <span className="opacity-60">{active ? (order === "asc" ? "↑" : "↓") : "↕"}</span>
      </span>
    </th>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function Tokens() {
  const [, setLocation] = useLocation();
  const [search,       setSearch]       = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [chainFilter,  setChainFilter]  = useState("all");
  const [sortField,    setSortField]    = useState<SortField>("systemAge");
  const [sortOrder,    setSortOrder]    = useState<SortOrder>("desc");
  const [page,         setPage]         = useState(1);

  const debouncedSearch = useDebounce(search, 300);

  useEffect(() => { setPage(1); }, [statusFilter, chainFilter, debouncedSearch, sortField, sortOrder]);

  const { data: tokenPage, isLoading, isFetching } = useQuery<PaginatedTokenPage>({
    queryKey: ["tokens-list", page, statusFilter, chainFilter, debouncedSearch, sortField, sortOrder],
    queryFn: async () => {
      const p = new URLSearchParams({ page: String(page), limit: String(PAGE_LIMIT), sort: sortField, order: sortOrder });
      if (statusFilter !== "all") p.set("status", statusFilter);
      if (chainFilter  !== "all") p.set("chain",  chainFilter);
      if (debouncedSearch)        p.set("q",      debouncedSearch);
      const r = await fetch(`${import.meta.env.BASE_URL}api/tokens?${p}`);
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    refetchInterval: 20_000,
    placeholderData: prev => prev,
    staleTime: 10_000,
  });

  const tokens = tokenPage?.data  ?? [];
  const total  = tokenPage?.total ?? 0;
  const pages  = tokenPage?.pages ?? 1;
  const from   = total === 0 ? 0 : Math.min((page - 1) * PAGE_LIMIT + 1, total);
  const to     = Math.min(page * PAGE_LIMIT, total);

  const handleSort = useCallback((f: SortField) => {
    if (sortField === f) setSortOrder(o => o === "asc" ? "desc" : "asc");
    else { setSortField(f); setSortOrder("desc"); }
  }, [sortField]);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div>
        <h1 className="text-lg font-bold text-[#f59e0b] tracking-widest uppercase">Token Stream</h1>
        <p className="text-[#484f58] text-[10px] mt-0.5 tracking-widest uppercase">Live view of token growth and holder conviction</p>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Search */}
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-[#484f58]" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search name, symbol, address…"
            className="h-8 pl-7 pr-7 text-[11px] w-52 bg-[#161b22] border border-[#30363d] text-[#c9d1d9] placeholder-[#484f58] focus:outline-none focus:border-[#f59e0b]/50 font-mono"
          />
          {search && (
            <button onClick={() => setSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-[#484f58] hover:text-[#c9d1d9]">
              <X className="w-3 h-3" />
            </button>
          )}
        </div>

        {/* Status */}
        <div className="flex items-center gap-px">
          {STATUS_OPTS.map(s => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={cn(
                "h-8 px-2.5 text-[9px] font-bold uppercase tracking-widest border-y border-r first:border-l transition-colors",
                statusFilter === s
                  ? "bg-[#f59e0b]/10 border-[#f59e0b]/40 text-[#f59e0b]"
                  : "bg-[#161b22] border-[#30363d] text-[#484f58] hover:text-[#8b949e]",
              )}
            >
              {s === "migrated" ? "🔀" : s}
            </button>
          ))}
        </div>

        {/* Chain */}
        <div className="flex items-center gap-px">
          {CHAIN_OPTS.map(c => (
            <button
              key={c}
              onClick={() => setChainFilter(c)}
              className={cn(
                "h-8 px-2.5 text-[9px] font-bold uppercase tracking-widest border-y border-r first:border-l transition-colors",
                chainFilter === c
                  ? "bg-[#60a5fa]/10 border-[#60a5fa]/40 text-[#60a5fa]"
                  : "bg-[#161b22] border-[#30363d] text-[#484f58] hover:text-[#8b949e]",
              )}
            >
              {c}
            </button>
          ))}
        </div>

        {/* Count */}
        <span className="ml-auto text-[10px] text-[#484f58] tabular-nums tracking-widest flex items-center gap-1.5">
          {isFetching && !isLoading && <span className="w-1.5 h-1.5 rounded-full bg-[#f59e0b] animate-pulse" />}
          {total > 0 ? `${from}–${to} of ${total}` : "0 tokens"}
        </span>
      </div>

      {/* Table */}
      <div className="border border-[#30363d] bg-[#0d1117] overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-[11px] text-left whitespace-nowrap">
            <thead>
              <tr>
                <th className="px-4 py-2.5 text-[9px] font-bold uppercase tracking-widest text-[#484f58] border-b border-[#30363d] bg-[#161b22] w-[200px]">Token</th>
                <th className="px-3 py-2.5 text-[9px] font-bold uppercase tracking-widest text-[#484f58] border-b border-[#30363d] bg-[#161b22]">Status</th>
                <SortHead field="intelligenceScore" current={sortField} order={sortOrder} onSort={handleSort}>Intel</SortHead>
                <SortHead field="detectionGainPct" current={sortField} order={sortOrder} onSort={handleSort}>Gain %</SortHead>
                <SortHead field="athGainPct"       current={sortField} order={sortOrder} onSort={handleSort}>ATH %</SortHead>
                <SortHead field="marketCapUsd"     current={sortField} order={sortOrder} onSort={handleSort}>MCap</SortHead>
                <th className="px-3 py-2.5 text-[9px] font-bold uppercase tracking-widest text-[#484f58] border-b border-[#30363d] bg-[#161b22]">Entry → Live</th>
                <th className="px-3 py-2.5 text-[9px] font-bold uppercase tracking-widest text-[#484f58] border-b border-[#30363d] bg-[#161b22]">KOL / Smart</th>
                <SortHead field="systemAge" current={sortField} order={sortOrder} onSort={handleSort} right>Age</SortHead>
              </tr>
            </thead>
            <tbody>
              {isLoading && !tokenPage ? (
                Array(12).fill(0).map((_, i) => (
                  <tr key={i} className={i % 2 === 0 ? "bg-[#0d1117]" : "bg-[#161b22]/20"}>
                    {Array(8).fill(0).map((__, j) => (
                      <td key={j} className="px-3 py-3 border-b border-[#30363d]/40">
                        <div className="h-3 bg-[#161b22] animate-pulse w-16" />
                      </td>
                    ))}
                  </tr>
                ))
              ) : tokens.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-16 text-center text-[#484f58] text-xs tracking-widest uppercase">
                    {debouncedSearch ? `No tokens matching "${debouncedSearch}"` : `No "${statusFilter}" tokens`}
                  </td>
                </tr>
              ) : tokens.map((token, i) => (
                <tr
                  key={token.id}
                  className={cn(
                    "group cursor-pointer border-b border-[#30363d]/40 hover:bg-[#1c2128] transition-colors",
                    i % 2 === 0 ? "bg-[#0d1117]" : "bg-[#161b22]/20",
                  )}
                  onClick={() => setLocation(`/tokens/${token.id}`)}
                >
                  {/* Token */}
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      {token.logoUri ? (
                        <img src={token.logoUri} alt="" className="w-6 h-6 border border-[#30363d] shrink-0" />
                      ) : (
                        <div className="w-6 h-6 border border-[#30363d] bg-[#161b22] flex items-center justify-center text-[#f59e0b] text-[8px] font-bold shrink-0">
                          {token.symbol?.slice(0, 2) ?? "??"}
                        </div>
                      )}
                      <div className="min-w-0">
                        <div className="text-[#f59e0b] font-bold truncate">{token.symbol || truncateAddress(token.address)}</div>
                        <div className="text-[#484f58] text-[9px] truncate">{token.name || token.chain}</div>
                      </div>
                      <a
                        href={getGmgnUrl(token.chain, token.address)}
                        target="_blank" rel="noopener noreferrer"
                        onClick={e => e.stopPropagation()}
                        className="opacity-0 group-hover:opacity-100 text-[#484f58] hover:text-[#f59e0b] shrink-0 transition-opacity"
                      >
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    </div>
                  </td>
                  {/* Status */}
                  <td className="px-3 py-2.5"><StatusBadge status={token.status} /></td>
                  {/* Intelligence */}
                  <td className="px-3 py-2.5"><IntelBadge score={token.intelligenceScore} label={token.qualityLabel} /></td>
                  {/* Gain % */}
                  <td className="px-3 py-2.5">
                    <span className={cn("font-bold tabular-nums", gainColor(token.detectionGainPct))}>
                      {formatGain(token.detectionGainPct)}
                    </span>
                  </td>
                  {/* ATH % */}
                  <td className="px-3 py-2.5">
                    <span className={cn("font-bold tabular-nums", gainColor(token.athGainPct))}>
                      {formatGain(token.athGainPct)}
                    </span>
                  </td>
                  {/* MCap */}
                  <td className="px-3 py-2.5 text-[#c9d1d9] tabular-nums">{formatMarketCap(token.marketCapUsd)}</td>
                  {/* Entry → Live */}
                  <td className="px-3 py-2.5 text-[#8b949e] tabular-nums font-mono text-[10px]">
                    <span>{formatTokenPrice(token.detectedPriceUsd)}</span>
                    {token.currentPriceUsd && (
                      <>
                        <span className="text-[#30363d] mx-1">→</span>
                        <span className="text-[#c9d1d9]">{formatTokenPrice(token.currentPriceUsd)}</span>
                      </>
                    )}
                  </td>
                  {/* KOL / Smart */}
                  <td className="px-3 py-2.5">
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
                  <td className="px-4 py-2.5 text-right text-[#484f58]">
                    {formatTimeAgo(token.firstDetectedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {!isLoading && total > 0 && (
          <div className="flex items-center justify-between px-4 py-2.5 border-t border-[#30363d] bg-[#161b22]">
            <span className="text-[10px] text-[#484f58] tabular-nums tracking-widest">{from}–{to} OF {total} TOKENS</span>
            <div className="flex items-center gap-2">
              <button
                className="w-6 h-6 flex items-center justify-center border border-[#30363d] text-[#8b949e] hover:border-[#f59e0b] hover:text-[#f59e0b] disabled:opacity-30 transition-colors"
                disabled={page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}
              >
                <ChevronLeft className="w-3.5 h-3.5" />
              </button>
              <span className="text-[10px] text-[#8b949e] tabular-nums tracking-widest px-1">{page} / {pages}</span>
              <button
                className="w-6 h-6 flex items-center justify-center border border-[#30363d] text-[#8b949e] hover:border-[#f59e0b] hover:text-[#f59e0b] disabled:opacity-30 transition-colors"
                disabled={page >= pages} onClick={() => setPage(p => Math.min(pages, p + 1))}
              >
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
