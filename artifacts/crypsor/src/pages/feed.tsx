/**
 * Feed page — Social Buzz
 *
 * Token-centric view: for each tracked token, shows what news sites
 * and social platforms are saying about it right now.
 * Data comes from RSS feeds (CryptoPanic, CoinTelegraph, Decrypt, CoinDesk)
 * matched to your tokens by symbol / name — refreshed every 30 min server-side.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Radio, RefreshCw, Newspaper, ExternalLink, Search,
  TrendingUp, Flame, ChevronDown, ChevronUp,
} from "lucide-react";
import { cn, formatTimeAgo } from "@/lib/utils";

const BASE = import.meta.env.BASE_URL;

// ── Types ─────────────────────────────────────────────────────────────────────

interface NewsItem {
  title:       string;
  link:        string;
  source:      string;
  publishedAt: string;
}

interface SocialToken {
  id:               number;
  address:          string;
  name:             string | null;
  symbol:           string | null;
  status:           string;
  gainPct:          number | null;
  athGainPct:       number | null;
  marketCapUsd:     string | null;
  intelligenceScore: number | null;
  imageStatus:      string | null;
  firstDetectedAt:  string;
  buzzScore:        number;
  newsCount:        number;
  news:             NewsItem[];
  xSearchUrl:       string;
  redditSearchUrl:  string;
}

interface SocialResponse {
  totalTokens:     number;
  totalArticles:   number;
  cacheAgeMinutes: number;
  cachedAt:        string | null;
  tokens:          SocialToken[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtMcap(v: string | null | undefined): string {
  if (!v) return "—";
  const n = parseFloat(v);
  if (!isFinite(n)) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function fmtGain(v: number | null): { text: string; pos: boolean } | null {
  if (v == null) return null;
  return { text: v >= 0 ? `+${v.toFixed(0)}X` : `${v.toFixed(0)}X`, pos: v >= 0 };
}

function statusStyle(s: string): string {
  return ({
    active:  "text-[#22c55e] border-[#22c55e]/40 bg-[#22c55e]/8",
    new:     "text-[#60a5fa] border-[#60a5fa]/40 bg-[#60a5fa]/8",
    watch:   "text-[#f59e0b] border-[#f59e0b]/40 bg-[#f59e0b]/8",
    revived: "text-[#a78bfa] border-[#a78bfa]/40 bg-[#a78bfa]/8",
    archive: "text-[#484f58] border-[#30363d]    bg-transparent",
  }[s] ?? "text-[#8b949e] border-[#30363d] bg-transparent");
}

function buzzLabel(score: number): { emoji: string; label: string; color: string } {
  if (score >= 20) return { emoji: "🔥", label: "HOT",     color: "text-[#ef4444]" };
  if (score >= 10) return { emoji: "📈", label: "TRENDING", color: "text-[#f59e0b]" };
  if (score >= 3)  return { emoji: "💬", label: "BUZZ",    color: "text-[#60a5fa]" };
  return              { emoji: "🔇", label: "QUIET",   color: "text-[#484f58]" };
}

function avatarBg(address: string): string {
  const palettes = [
    "bg-[#1a2740] text-[#60a5fa]", "bg-[#1a2a1a] text-[#22c55e]",
    "bg-[#2a1f1a] text-[#fb923c]", "bg-[#251a2a] text-[#a78bfa]",
    "bg-[#2a2a1a] text-[#f59e0b]", "bg-[#1a2a2a] text-[#2dd4bf]",
    "bg-[#2a1a1a] text-[#ef4444]",
  ];
  return palettes[address.charCodeAt(0) % palettes.length];
}

function initials(sym: string | null, name: string | null): string {
  return ((sym ?? name ?? "??").replace(/[^a-zA-Z0-9]/g, "").slice(0, 2).toUpperCase()) || "??";
}

// ── Token Avatar ──────────────────────────────────────────────────────────────

function TokenAvatar({ token }: { token: SocialToken }) {
  const [imgOk, setImgOk] = useState(token.imageStatus === "ok");
  return (
    <div className={cn(
      "w-11 h-11 rounded-full border border-[#30363d] flex items-center justify-center shrink-0 overflow-hidden text-xs font-bold",
      imgOk ? "bg-[#161b22]" : avatarBg(token.address),
    )}>
      {imgOk ? (
        <img
          src={`${BASE}api/assets/token/${token.id}`}
          alt={token.symbol ?? ""}
          className="w-full h-full object-cover"
          onError={() => setImgOk(false)}
        />
      ) : initials(token.symbol, token.name)}
    </div>
  );
}

// ── News Article Row ──────────────────────────────────────────────────────────

function ArticleRow({ article }: { article: NewsItem }) {
  return (
    <a
      href={article.link}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-start gap-2 py-2 px-3 hover:bg-[#1c2128] transition-colors group border-b border-[#21262d] last:border-0"
    >
      <Newspaper className="w-3 h-3 text-[#484f58] shrink-0 mt-0.5 group-hover:text-[#8b949e]" />
      <div className="flex-1 min-w-0">
        <div className="text-xs text-[#c9d1d9] leading-snug group-hover:text-white line-clamp-2">
          {article.title}
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-[9px] text-[#f59e0b] font-semibold tracking-wide">{article.source}</span>
          <span className="text-[9px] text-[#484f58]">{formatTimeAgo(article.publishedAt)}</span>
        </div>
      </div>
      <ExternalLink className="w-3 h-3 text-[#30363d] group-hover:text-[#8b949e] shrink-0 mt-0.5" />
    </a>
  );
}

// ── Token Social Card ─────────────────────────────────────────────────────────

function TokenCard({ token }: { token: SocialToken }) {
  const [expanded, setExpanded] = useState(token.newsCount > 0);
  const buzz  = buzzLabel(token.buzzScore);
  const gain  = fmtGain(token.gainPct);
  const hasNews = token.newsCount > 0;

  return (
    <div className={cn(
      "border-b border-[#30363d] last:border-0 transition-colors",
      hasNews ? "border-l-2 border-l-[#f59e0b]" : "border-l-2 border-l-[#21262d]",
    )}>
      {/* Card header — always visible */}
      <div className="flex items-start gap-3 px-4 py-4">
        <TokenAvatar token={token} />

        <div className="flex-1 min-w-0">
          {/* Name row */}
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className="font-bold text-sm text-[#c9d1d9] leading-tight">
              {token.name ?? token.symbol ?? token.address.slice(0, 8)}
            </span>
            {token.symbol && (
              <span className="text-[#8b949e] text-xs">${token.symbol}</span>
            )}
            <span className={cn(
              "text-[8px] font-bold px-1.5 py-0.5 border tracking-widest uppercase",
              statusStyle(token.status),
            )}>
              {token.status.toUpperCase()}
            </span>
            {/* Buzz badge */}
            <span className={cn("text-[10px] font-bold ml-auto shrink-0", buzz.color)}>
              {buzz.emoji} {token.buzzScore > 0 ? token.buzzScore : "—"}
            </span>
          </div>

          {/* Metrics strip */}
          <div className="flex items-center gap-3 text-[11px] text-[#484f58] flex-wrap">
            <span>MC <span className="text-[#8b949e] font-mono">{fmtMcap(token.marketCapUsd)}</span></span>
            {token.intelligenceScore != null && (
              <>
                <span className="text-[#30363d]">·</span>
                <span>Score <span className="font-mono font-bold text-[#f59e0b]">
                  {Math.round(token.intelligenceScore)}
                </span></span>
              </>
            )}
            {gain && (
              <>
                <span className="text-[#30363d]">·</span>
                <span className={cn("font-mono font-bold", gain.pos ? "text-[#22c55e]" : "text-[#ef4444]")}>
                  {gain.text}
                </span>
              </>
            )}
          </div>

          {/* Social search links */}
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            <a
              href={token.xSearchUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-[9px] font-bold px-2 py-1 border border-[#30363d] text-[#8b949e] hover:text-[#c9d1d9] hover:border-[#484f58] transition-colors tracking-widest uppercase"
              onClick={e => e.stopPropagation()}
            >
              𝕏 Search X
            </a>
            <a
              href={token.redditSearchUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-[9px] font-bold px-2 py-1 border border-[#30363d] text-[#8b949e] hover:text-[#c9d1d9] hover:border-[#484f58] transition-colors tracking-widest uppercase"
              onClick={e => e.stopPropagation()}
            >
              <Search className="w-2.5 h-2.5" />
              Reddit
            </a>

            {/* News toggle */}
            {hasNews && (
              <button
                onClick={() => setExpanded(e => !e)}
                className="flex items-center gap-1 text-[9px] font-bold px-2 py-1 border border-[#f59e0b]/30 text-[#f59e0b] hover:bg-[#f59e0b]/10 transition-colors tracking-widest uppercase ml-auto"
              >
                <Newspaper className="w-2.5 h-2.5" />
                {token.newsCount} news
                {expanded
                  ? <ChevronUp   className="w-2.5 h-2.5" />
                  : <ChevronDown className="w-2.5 h-2.5" />}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* News articles — expandable */}
      {hasNews && expanded && (
        <div className="mx-4 mb-4 border border-[#30363d] bg-[#0d1117]">
          {token.news.map((a) => <ArticleRow key={a.link} article={a} />)}
        </div>
      )}
    </div>
  );
}

// ── Filter tabs ───────────────────────────────────────────────────────────────

const STATUS_FILTERS = [
  { value: "new,active,watch,revived,archive", label: "All" },
  { value: "active,revived",                   label: "Active" },
  { value: "new",                              label: "New" },
  { value: "watch",                            label: "Watch" },
  { value: "archive",                          label: "Archive" },
] as const;

// ── Page ──────────────────────────────────────────────────────────────────────

export default function Feed() {
  const [statusFilter, setStatusFilter] = useState(STATUS_FILTERS[0].value);
  const [showNoNews, setShowNoNews]     = useState(true);

  const { data, isLoading, isFetching, refetch, dataUpdatedAt } = useQuery<SocialResponse>({
    queryKey:        ["social", statusFilter],
    queryFn:         async () => {
      const r = await fetch(`${BASE}api/social?status=${statusFilter}`);
      if (!r.ok) throw new Error(`Social API error ${r.status}`);
      return r.json();
    },
    refetchInterval: 5 * 60_000,   // re-ask server every 5 min (server caches 30 min)
    staleTime:       2 * 60_000,
  });

  const tokens = data?.tokens ?? [];
  const visible = showNoNews ? tokens : tokens.filter(t => t.newsCount > 0);
  const withNews    = tokens.filter(t => t.newsCount > 0).length;
  const withoutNews = tokens.length - withNews;

  return (
    <div className="space-y-0 max-w-2xl mx-auto">
      {/* Page header */}
      <div className="flex items-start justify-between gap-4 mb-4 flex-wrap">
        <div className="flex items-center gap-2">
          <Radio className="w-4 h-4 text-[#f59e0b]" />
          <div>
            <h1 className="text-sm font-bold tracking-widest text-[#c9d1d9] uppercase">
              Social Buzz
            </h1>
            <p className="text-[10px] text-[#484f58]">
              News & mentions for your tokens — from CryptoPanic, CoinTelegraph, Decrypt & more
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {data?.cacheAgeMinutes != null && (
            <span className="text-[9px] text-[#484f58]">
              News refreshed {data.cacheAgeMinutes}m ago · {data.totalArticles} articles scanned
            </span>
          )}
          <button
            onClick={() => refetch()}
            className="text-[#484f58] hover:text-[#8b949e] transition-colors"
            title="Refresh"
          >
            <RefreshCw className={cn("w-3.5 h-3.5", isFetching && "animate-spin")} />
          </button>
        </div>
      </div>

      {/* Status filter tabs */}
      <div className="flex items-center gap-1 mb-3 flex-wrap">
        {STATUS_FILTERS.map(f => (
          <button
            key={f.value}
            onClick={() => setStatusFilter(f.value)}
            className={cn(
              "text-[9px] font-bold px-3 py-1.5 border tracking-widest uppercase transition-colors",
              statusFilter === f.value
                ? "border-[#f59e0b] text-[#f59e0b] bg-[#f59e0b]/10"
                : "border-[#30363d] text-[#484f58] hover:text-[#8b949e] hover:border-[#484f58]",
            )}
          >
            {f.label}
          </button>
        ))}

        {/* No-news toggle */}
        {withoutNews > 0 && (
          <button
            onClick={() => setShowNoNews(v => !v)}
            className={cn(
              "text-[9px] font-bold px-3 py-1.5 border tracking-widest uppercase transition-colors ml-auto",
              !showNoNews
                ? "border-[#f59e0b] text-[#f59e0b] bg-[#f59e0b]/10"
                : "border-[#30363d] text-[#484f58] hover:text-[#8b949e]",
            )}
          >
            {showNoNews ? `Hide quiet (${withoutNews})` : `Show all (${tokens.length})`}
          </button>
        )}
      </div>

      {/* Summary bar */}
      {!isLoading && tokens.length > 0 && (
        <div className="flex items-center gap-4 px-3 py-2 bg-[#161b22] border border-[#30363d] mb-3 text-[10px]">
          <span className="flex items-center gap-1.5 text-[#22c55e]">
            <Flame className="w-3 h-3" />
            <span className="font-bold">{withNews}</span>
            <span className="text-[#484f58]">tokens with news</span>
          </span>
          <span className="text-[#30363d]">·</span>
          <span className="flex items-center gap-1.5 text-[#8b949e]">
            <TrendingUp className="w-3 h-3" />
            <span className="font-bold">{tokens.reduce((s, t) => s + t.newsCount, 0)}</span>
            <span className="text-[#484f58]">total articles matched</span>
          </span>
        </div>
      )}

      {/* Token list */}
      <div className="border border-[#30363d] bg-[#0d1117]">
        {isLoading ? (
          <div className="py-16 text-center">
            <div className="w-8 h-8 border border-[#30363d] rounded-full border-t-[#f59e0b] animate-spin mx-auto mb-3" />
            <div className="text-[#484f58] text-xs">Scanning RSS feeds…</div>
            <div className="text-[#30363d] text-[10px] mt-1">First load fetches live news — takes a few seconds</div>
          </div>
        ) : visible.length === 0 ? (
          <div className="py-16 text-center px-6">
            <Newspaper className="w-8 h-8 text-[#30363d] mx-auto mb-3" />
            <div className="text-[#8b949e] text-sm font-semibold mb-1">
              No tokens in this category
            </div>
            <div className="text-[#484f58] text-xs leading-relaxed">
              Add wallets in Settings to start tracking tokens.
            </div>
          </div>
        ) : (
          visible.map(token => <TokenCard key={token.id} token={token} />)
        )}

        {/* Footer */}
        {visible.length > 0 && (
          <div className="px-4 py-2.5 border-t border-[#30363d] flex items-center justify-between">
            <span className="text-[9px] text-[#484f58]">
              {visible.length} token{visible.length !== 1 ? "s" : ""}
              {!showNoNews ? " with news" : ""}
            </span>
            <span className="text-[9px] text-[#484f58]">
              Sources: CryptoPanic · CoinTelegraph · Decrypt · CoinDesk · BeInCrypto
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
