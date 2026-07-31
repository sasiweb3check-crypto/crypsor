import { useState, useCallback, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  Users, ExternalLink, Copy, CheckCheck,
  ChevronLeft, ChevronRight, Search, X, Download,
} from "lucide-react";
import { truncateAddress, cn } from "@/lib/utils";
import { getApiBase } from "@/lib/api-base";

// ── Types ─────────────────────────────────────────────────────────────────────

interface HolderRow {
  id: number;
  tokenId: number;
  walletAddress: string;
  twitterName: string | null;
  twitterUsername: string | null;
  labels: string[];
  amountPercentage: number | null;
  realizedProfit: string | null;
  buyCount: number;
  sellCount: number;
  tokenName: string | null;
  tokenSymbol: string | null;
  tokenChain: string | null;
  tokenLogoUri: string | null;
  /** How many distinct tracked tokens this wallet appears in (deduplicated) */
  tokenCount?: number;
}

interface HoldersPage {
  data: HolderRow[];
  total: number;
  page: number;
  pages: number;
}

// ── Only KOL and Smart label filters ─────────────────────────────────────────

const LABEL_FILTERS = [
  { value: "",     label: "ALL" },
  { value: "kol",  label: "KOL" },
  { value: "smart", label: "SMART" },
];

const PAGE_LIMIT = 50;

// ── Helpers ───────────────────────────────────────────────────────────────────

function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={e => {
        e.stopPropagation();
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="text-[#484f58] hover:text-[#c9d1d9] transition-colors shrink-0"
    >
      {copied ? <CheckCheck className="w-3 h-3 text-[#22c55e]" /> : <Copy className="w-3 h-3" />}
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

// Map raw labels to canonical KOL/Smart only — other labels are ignored in display
function holderType(labels: string[]): { isKol: boolean; isSmart: boolean } {
  const lower = (labels ?? []).map(l => l.toLowerCase());
  const isKol   = lower.some(l => ["kol","renowned"].includes(l));
  const isSmart = lower.some(l => ["smart","smart_money","smart_degen"].includes(l));
  return { isKol, isSmart };
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function HoldersPage() {
  const [, setLocation] = useLocation();
  const [labelFilter, setLabelFilter] = useState("");
  const [search, setSearch]           = useState("");
  const [debouncedQ, setDebouncedQ]   = useState("");
  const [page, setPage]               = useState(1);

  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleSearch = useCallback((v: string) => {
    setSearch(v);
    setPage(1);
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => setDebouncedQ(v), 350);
  }, []);

  const handleLabelChange = (v: string) => { setLabelFilter(v); setPage(1); };

  const { data, isLoading, isFetching } = useQuery<HoldersPage>({
    queryKey: ["holders-list", page, labelFilter, debouncedQ],
    queryFn: async () => {
      const base = getApiBase();
      const params = new URLSearchParams({ page: String(page), limit: String(PAGE_LIMIT) });
      if (labelFilter) params.set("label", labelFilter);
      if (debouncedQ)  params.set("q", debouncedQ);
      const r = await fetch(`${base}api/holders/list?${params}`);
      if (!r.ok) throw new Error(`Holders API error ${r.status}`);
      return r.json();
    },
    placeholderData: prev => prev,
    staleTime: 30_000,
  });

  const rows  = data?.data   ?? [];
  const total = data?.total  ?? 0;
  const pages = data?.pages  ?? 1;
  const from  = total === 0 ? 0 : Math.min((page - 1) * PAGE_LIMIT + 1, total);
  const to    = Math.min(page * PAGE_LIMIT, total);

  const downloadUrl = `${getApiBase()}api/holders/download`;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-lg font-bold text-[#f59e0b] tracking-widest uppercase flex items-center gap-2">
            <Users className="w-4 h-4" />
            Holders Database
          </h1>
          <p className="text-[#484f58] text-[10px] mt-0.5 tracking-widest uppercase">
            KOL and Smart wallet holders across tracked tokens
          </p>
        </div>
        <a href={downloadUrl} download>
          <button className="flex items-center gap-1.5 h-8 px-3 text-[9px] font-bold uppercase tracking-widest border border-[#30363d] text-[#8b949e] hover:border-[#f59e0b]/40 hover:text-[#f59e0b] transition-colors">
            <Download className="w-3 h-3" />
            Export CSV
          </button>
        </a>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Label pills */}
        <div className="flex items-center gap-px">
          {LABEL_FILTERS.map(f => (
            <button
              key={f.value}
              onClick={() => handleLabelChange(f.value)}
              className={cn(
                "h-8 px-3 text-[9px] font-bold uppercase tracking-widest border-y border-r first:border-l transition-colors",
                labelFilter === f.value
                  ? f.value === "kol"
                    ? "bg-[#f59e0b]/10 border-[#f59e0b]/40 text-[#f59e0b]"
                    : f.value === "smart"
                    ? "bg-[#60a5fa]/10 border-[#60a5fa]/40 text-[#60a5fa]"
                    : "bg-[#c9d1d9]/10 border-[#c9d1d9]/30 text-[#c9d1d9]"
                  : "bg-[#161b22] border-[#30363d] text-[#484f58] hover:text-[#8b949e]",
              )}
            >
              {f.label}
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="w-3 h-3 absolute left-2.5 top-1/2 -translate-y-1/2 text-[#484f58]" />
          <input
            value={search}
            onChange={e => handleSearch(e.target.value)}
            placeholder="Search wallet or @twitter…"
            className="h-8 pl-7 pr-7 text-[11px] w-52 bg-[#161b22] border border-[#30363d] text-[#c9d1d9] placeholder-[#484f58] focus:outline-none focus:border-[#f59e0b]/50 font-mono"
          />
          {search && (
            <button onClick={() => { setSearch(""); setDebouncedQ(""); setPage(1); }} className="absolute right-2 top-1/2 -translate-y-1/2 text-[#484f58] hover:text-[#c9d1d9]">
              <X className="w-3 h-3" />
            </button>
          )}
        </div>

        {/* Count */}
        <span className="ml-auto text-[10px] text-[#484f58] tabular-nums tracking-widest flex items-center gap-1.5">
          {isFetching && !isLoading && <span className="w-1.5 h-1.5 rounded-full bg-[#f59e0b] animate-pulse" />}
          <span className="text-[#c9d1d9] font-bold">{total.toLocaleString()}</span> holders
          {(labelFilter || debouncedQ) && <span className="text-[#f59e0b]">filtered</span>}
        </span>
      </div>

      {/* Desktop table */}
      <div className="border border-[#30363d] bg-[#0d1117] overflow-hidden">
        <div className="hidden sm:block overflow-x-auto">
          <table className="w-full text-[11px] whitespace-nowrap">
            <thead>
              <tr className="border-b border-[#30363d]">
                <th className="px-4 py-2.5 text-[9px] font-bold uppercase tracking-widest text-[#484f58] bg-[#161b22] text-left w-[180px]">Wallet</th>
                <th className="px-3 py-2.5 text-[9px] font-bold uppercase tracking-widest text-[#484f58] bg-[#161b22] text-left w-[120px]">Identity</th>
                <th className="px-3 py-2.5 text-[9px] font-bold uppercase tracking-widest text-[#484f58] bg-[#161b22] text-left">Type</th>
                <th className="px-3 py-2.5 text-[9px] font-bold uppercase tracking-widest text-[#484f58] bg-[#161b22] text-left w-[120px]">Token</th>
                <th className="px-3 py-2.5 text-[9px] font-bold uppercase tracking-widest text-[#484f58] bg-[#161b22] text-right">% Supply</th>
                <th className="px-3 py-2.5 text-[9px] font-bold uppercase tracking-widest text-[#484f58] bg-[#161b22] text-right">Realized P&L</th>
                <th className="px-3 py-2.5 text-[9px] font-bold uppercase tracking-widest text-[#484f58] bg-[#161b22] text-right pr-4">Buys / Sells</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                Array(12).fill(0).map((_, i) => (
                  <tr key={i} className={i % 2 === 0 ? "bg-[#0d1117]" : "bg-[#161b22]/20"}>
                    {Array(7).fill(0).map((__, j) => (
                      <td key={j} className="px-3 py-3 border-b border-[#30363d]/40">
                        <div className="h-3 bg-[#161b22] animate-pulse w-20" />
                      </td>
                    ))}
                  </tr>
                ))
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-20 text-center">
                    <Users className="w-8 h-8 mx-auto mb-3 text-[#30363d]" />
                    <p className="text-[#484f58] text-xs tracking-widest uppercase">No Holders Found</p>
                    <p className="text-[#30363d] text-[10px] mt-1">
                      {labelFilter || debouncedQ ? "Try removing filters" : "Holders fetched every 3 minutes"}
                    </p>
                  </td>
                </tr>
              ) : rows.map((row, i) => {
                const { isKol, isSmart } = holderType(row.labels ?? []);
                return (
                  <tr
                    key={row.id}
                    className={cn(
                      "group border-b border-[#30363d]/40 hover:bg-[#1c2128] transition-colors",
                      i % 2 === 0 ? "bg-[#0d1117]" : "bg-[#161b22]/20",
                    )}
                  >
                    {/* Wallet */}
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-[#c9d1d9] text-[10px]">{truncateAddress(row.walletAddress)}</span>
                        <CopyBtn text={row.walletAddress} />
                        <a
                          href={`https://gmgn.ai/sol/address/${row.walletAddress}`}
                          target="_blank" rel="noopener noreferrer"
                          onClick={e => e.stopPropagation()}
                          className="text-[#484f58] hover:text-[#f59e0b] transition-colors opacity-0 group-hover:opacity-100"
                        >
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      </div>
                    </td>
                    {/* Identity */}
                    <td className="px-3 py-2.5">
                      {(row.twitterName || row.twitterUsername) ? (
                        <div className="text-[10px]">
                          {row.twitterName && <p className="text-[#f59e0b] truncate max-w-[110px]">{row.twitterName}</p>}
                          {row.twitterUsername && <p className="text-[#484f58] font-mono">@{row.twitterUsername}</p>}
                        </div>
                      ) : (
                        <span className="text-[#30363d] text-[10px]">—</span>
                      )}
                    </td>
                    {/* Type — KOL / Smart + token-count badge */}
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {isKol   && <span className="text-[9px] font-bold text-[#f59e0b] bg-[#f59e0b]/10 border border-[#f59e0b]/20 px-1.5 py-0.5 tracking-widest">KOL</span>}
                        {isSmart && <span className="text-[9px] font-bold text-[#60a5fa] bg-[#60a5fa]/10 border border-[#60a5fa]/20 px-1.5 py-0.5 tracking-widest">SMART</span>}
                        {!isKol && !isSmart && <span className="text-[#30363d] text-[10px]">—</span>}
                        {(row.tokenCount ?? 1) > 1 && (
                          <button
                            onClick={e => { e.stopPropagation(); handleSearch(row.walletAddress); setLabelFilter(""); }}
                            title={`Wallet in ${row.tokenCount} tokens — click to filter`}
                            className="text-[9px] font-bold text-[#a78bfa] bg-[#a78bfa]/10 border border-[#a78bfa]/30 px-1.5 py-0.5 tracking-widest hover:bg-[#a78bfa]/20 transition-colors"
                          >
                            {row.tokenCount} tokens
                          </button>
                        )}
                      </div>
                    </td>
                    {/* Token */}
                    <td className="px-3 py-2.5">
                      {(row.tokenName || row.tokenSymbol) ? (
                        <button
                          onClick={() => setLocation(`/tokens/${row.tokenId}`)}
                          className="flex items-center gap-1.5 hover:text-[#f59e0b] text-[#8b949e] transition-colors text-[10px]"
                        >
                          {row.tokenLogoUri && (
                            <img src={row.tokenLogoUri} alt="" className="w-4 h-4 border border-[#30363d] shrink-0" />
                          )}
                          <span className="font-bold">{row.tokenSymbol ?? row.tokenName}</span>
                          {row.tokenChain && <span className="text-[#484f58] capitalize">{row.tokenChain}</span>}
                        </button>
                      ) : <span className="text-[#30363d] text-[10px]">—</span>}
                    </td>
                    {/* % Supply */}
                    <td className="px-3 py-2.5 text-right font-mono text-[10px] text-[#8b949e] tabular-nums">
                      {row.amountPercentage != null ? `${row.amountPercentage.toFixed(3)}%` : "—"}
                    </td>
                    {/* P&L */}
                    <td className={cn(
                      "px-3 py-2.5 text-right font-mono text-[10px] tabular-nums font-bold",
                      row.realizedProfit
                        ? parseFloat(row.realizedProfit) >= 0 ? "text-[#22c55e]" : "text-[#ef4444]"
                        : "text-[#30363d]",
                    )}>
                      {usd(row.realizedProfit)}
                    </td>
                    {/* Buys / Sells */}
                    <td className="px-4 py-2.5 text-right text-[10px] tabular-nums">
                      <span className="text-[#22c55e]/70">{row.buyCount ?? 0}B</span>
                      {" / "}
                      <span className="text-[#ef4444]/70">{row.sellCount ?? 0}S</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Mobile card list */}
        <div className="sm:hidden">
          {isLoading ? (
            <div className="divide-y divide-[#30363d]">
              {Array(8).fill(0).map((_, i) => (
                <div key={i} className="px-4 py-3 space-y-2 animate-pulse">
                  <div className="h-3 w-36 bg-[#161b22]" />
                  <div className="h-2.5 w-24 bg-[#161b22]" />
                </div>
              ))}
            </div>
          ) : rows.length === 0 ? (
            <div className="py-16 flex flex-col items-center gap-3 text-[#484f58]">
              <Users className="w-8 h-8 opacity-20" />
              <p className="text-xs tracking-widest uppercase">No Holders Found</p>
            </div>
          ) : (
            <div className="divide-y divide-[#30363d]">
              {rows.map(row => {
                const { isKol, isSmart } = holderType(row.labels ?? []);
                return (
                  <div key={row.id} className="px-4 py-3 space-y-2 hover:bg-[#161b22] transition-colors">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="font-mono text-[10px] text-[#c9d1d9]">{truncateAddress(row.walletAddress)}</span>
                        <CopyBtn text={row.walletAddress} />
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {isKol   && <span className="text-[9px] font-bold text-[#f59e0b] bg-[#f59e0b]/10 border border-[#f59e0b]/20 px-1.5 py-0.5 tracking-widest">KOL</span>}
                        {isSmart && <span className="text-[9px] font-bold text-[#60a5fa] bg-[#60a5fa]/10 border border-[#60a5fa]/20 px-1.5 py-0.5 tracking-widest">SMART</span>}
                      </div>
                    </div>
                    <div className="flex items-center justify-between gap-2 text-[10px]">
                      {(row.twitterName || row.twitterUsername) ? (
                        <span className="text-[#f59e0b] truncate">{row.twitterName ?? `@${row.twitterUsername}`}</span>
                      ) : <span />}
                      {(row.tokenName || row.tokenSymbol) && (
                        <button onClick={() => setLocation(`/tokens/${row.tokenId}`)} className="text-[#8b949e] hover:text-[#f59e0b] font-bold shrink-0">
                          {row.tokenSymbol ?? row.tokenName}
                        </button>
                      )}
                    </div>
                    <div className="flex items-center justify-between gap-2 text-[10px]">
                      <span className="text-[#484f58]">
                        {row.amountPercentage != null ? `${row.amountPercentage.toFixed(2)}% supply` : ""}
                      </span>
                      <div className="flex items-center gap-2 shrink-0">
                        {row.realizedProfit && (
                          <span className={cn("font-mono font-bold", parseFloat(row.realizedProfit) >= 0 ? "text-[#22c55e]" : "text-[#ef4444]")}>
                            {usd(row.realizedProfit)}
                          </span>
                        )}
                        <span className="text-[#484f58]">
                          <span className="text-[#22c55e]/70">{row.buyCount ?? 0}B</span>
                          {" / "}
                          <span className="text-[#ef4444]/70">{row.sellCount ?? 0}S</span>
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Pagination */}
        {!isLoading && total > 0 && (
          <div className="flex items-center justify-between px-4 py-2.5 border-t border-[#30363d] bg-[#161b22]">
            <span className="text-[10px] text-[#484f58] tabular-nums tracking-widest">
              {total === 0 ? "NO HOLDERS" : `${from}–${to} OF ${total.toLocaleString()}`}
            </span>
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
