/**
 * Crypsor Pro Caller Desk — conviction-first trader surface.
 * Stats: win rate, survival, edge — not a 2×/5× pill strip.
 */
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  Copy, ExternalLink, Twitter, Send, Globe,
  TrendingUp, Shield, Diamond, Hand,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { getApiBase } from "@/lib/api-base";
import {
  cn, truncateAddress, formatCompactUsd, formatTimeAgo, formatCalledAt,
  getGmgnUrl, safeSymbol, safeImageUrl, parseApiDate,
} from "@/lib/utils";

type RunStatus = "PUMPING" | "RAN" | "SLOW" | "FLAT" | "DEAD";
type QualityLabel = "very_good" | "good" | "below";
type AgeTab = "all" | "1h" | "6h" | "24h" | "7d";
type SortKey = "conviction" | "calledAt" | "ath" | "gain" | "proScore";

interface Conviction {
  smartHoldRate: number | null;
  kolHoldRate: number | null;
  smartHolding: number;
  kolHolding: number;
  paperHands: number;
  diamondHands: number;
  supplyPctHeld: number;
}

interface ProToken {
  id: number;
  address: string;
  chain: string;
  name: string | null;
  symbol: string | null;
  logoUri: string | null;
  calledAt: string | null;
  calledMcUsd: number | null;
  calledIntel: number | null;
  calledKol: number;
  calledSmart: number;
  currentMcUsd: number | null;
  gainSinceCall: number | null;
  athMultiple: number | null;
  runStatus: RunStatus;
  proScore: number;
  qualityLabel: QualityLabel;
  survivalScore?: number | null;
  currentKol: number;
  currentSmart: number;
  surfacedAt: string | null;
  conviction: Conviction | null;
  kolSmartSource?: string | null;
  secMintRenounced: boolean | null;
  secFreezeRenounced: boolean | null;
  secIsHoneypot: boolean | null;
  socials: { twitter?: string; telegram?: string; website?: string };
}

interface ProStats {
  total: number;
  winRate: number;
  x2Count: number;
  x5Count: number;
  x10Count: number;
  x10PlusCount?: number;
  bestAth: number | null;
  veryGoodCount: number;
  goodCount: number;
  qualityCount: number;
  recent1hCount?: number;
  recent6hCount?: number;
  recent7dCount?: number;
  latestCalledAt?: string | null;
  avgSurvival?: number | null;
}

const RUN: Record<RunStatus, { label: string; color: string }> = {
  PUMPING: { label: "Running", color: "var(--cryp-gain)" },
  RAN:     { label: "Printed", color: "#5b9fd4" },
  SLOW:    { label: "Building", color: "var(--cryp-warn)" },
  FLAT:    { label: "Flat", color: "var(--cryp-mute)" },
  DEAD:    { label: "Dead", color: "var(--cryp-loss)" },
};

function pct(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${Math.round(n * 100)}%`;
}

function StatTile({
  label, value, hint, accent,
}: { label: string; value: string; hint?: string; accent?: string }) {
  return (
    <div className="desk-card px-4 py-3.5 fade-up">
      <div className="text-[10px] tracking-[0.18em] uppercase text-[var(--cryp-mute)]">{label}</div>
      <div
        className="font-display font-mono-num text-2xl font-bold mt-1.5 tracking-tight"
        style={{ color: accent ?? "var(--cryp-text)" }}
      >
        {value}
      </div>
      {hint && <div className="text-[11px] text-[var(--cryp-mute)] mt-1">{hint}</div>}
    </div>
  );
}

function TokenCard({ t, onOpen }: { t: ProToken; onOpen: () => void }) {
  const { toast } = useToast();
  const run = RUN[t.runStatus] ?? RUN.FLAT;
  const c = t.conviction;
  const holdSmart = c?.smartHolding ?? 0;
  const holdKol = c?.kolHolding ?? 0;
  const ath = t.athMultiple ?? 1;
  const gain = t.gainSinceCall ?? 0;
  const [imgBroken, setImgBroken] = useState(false);
  const imgSrc = safeImageUrl(t.logoUri, t.address, t.symbol);

  return (
    <article
      className="desk-card group cursor-pointer overflow-hidden transition-transform duration-200 hover:-translate-y-0.5 fade-up"
      onClick={onOpen}
    >
      <div className="p-4 md:p-5">
        <div className="flex items-start gap-3">
          {!imgBroken ? (
            <img
              src={imgSrc}
              alt=""
              className="w-11 h-11 object-cover shrink-0"
              style={{ borderRadius: 4 }}
              onError={() => setImgBroken(true)}
            />
          ) : (
            <div
              className="w-11 h-11 flex items-center justify-center font-display font-bold text-sm shrink-0"
              style={{ background: "rgba(61,154,139,0.15)", color: "var(--cryp-mint)", borderRadius: 4 }}
            >
              {(safeSymbol(t.symbol, t.address) || "?").slice(0, 2)}
            </div>
          )}

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-display text-[15px] font-bold truncate">{safeSymbol(t.symbol, t.address) || "—"}</h3>
              {t.qualityLabel === "very_good" && (
                <span className="text-[9px] font-bold tracking-wider uppercase px-1.5 py-0.5"
                  style={{ color: "var(--cryp-mint)", background: "rgba(61,154,139,0.15)" }}>
                  Elite
                </span>
              )}
              <span className="text-[10px] font-medium" style={{ color: run.color }}>{run.label}</span>
            </div>
            <div className="flex items-center gap-2 mt-1 text-[11px] text-[var(--cryp-mute)]">
              <span className="font-mono-num">{formatCalledAt(t.calledAt)}</span>
              <span>·</span>
              <span>Entry {formatCompactUsd(t.calledMcUsd)}</span>
              {t.calledIntel != null && (
                <>
                  <span>·</span>
                  <span>Intel {Math.round(t.calledIntel)}</span>
                </>
              )}
            </div>
          </div>

          <div className="text-right shrink-0">
            <div className="font-mono-num text-lg font-semibold" style={{ color: ath >= 2 ? "var(--cryp-gain)" : "var(--cryp-text)" }}>
              {ath >= 1.05 ? `${ath.toFixed(1)}×` : "—"}
            </div>
            <div
              className="font-mono-num text-[11px] mt-0.5"
              style={{ color: gain >= 0 ? "var(--cryp-gain)" : "var(--cryp-loss)" }}
            >
              {gain >= 0 ? "+" : ""}{gain.toFixed(0)}%
            </div>
          </div>
        </div>

        {/* Conviction strip */}
        <div
          className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-2 pt-3"
          style={{ borderTop: "1px solid var(--cryp-line)" }}
        >
          <div>
            <div className="text-[9px] tracking-wider uppercase text-[var(--cryp-mute)]">
              {c ? "Smart hold" : "Smart at call"}
            </div>
            <div className="font-mono-num text-sm font-semibold mt-0.5">
              {c
                ? <>{holdSmart}<span className="text-[var(--cryp-mute)] font-normal">/{t.calledSmart || "—"}</span></>
                : (t.calledSmart || "—")}
              {c?.smartHoldRate != null && (
                <span className="text-[10px] text-[var(--cryp-mute)] ml-1">{pct(c.smartHoldRate)}</span>
              )}
            </div>
          </div>
          <div>
            <div className="text-[9px] tracking-wider uppercase text-[var(--cryp-mute)]">
              {c ? "KOL hold" : "KOL at call"}
            </div>
            <div className="font-mono-num text-sm font-semibold mt-0.5">
              {c
                ? <>{holdKol}<span className="text-[var(--cryp-mute)] font-normal">/{t.calledKol || "—"}</span></>
                : (t.calledKol || "—")}
            </div>
          </div>
          <div>
            <div className="text-[9px] tracking-wider uppercase text-[var(--cryp-mute)] flex items-center gap-1">
              <Diamond className="w-2.5 h-2.5" /> Diamond
            </div>
            <div className="font-mono-num text-sm font-semibold mt-0.5" style={{ color: (c?.diamondHands ?? 0) > 0 ? "var(--cryp-mint)" : undefined }}>
              {c?.diamondHands ?? "—"}
            </div>
          </div>
          <div>
            <div className="text-[9px] tracking-wider uppercase text-[var(--cryp-mute)] flex items-center gap-1">
              <Hand className="w-2.5 h-2.5" /> Paper
            </div>
            <div className="font-mono-num text-sm font-semibold mt-0.5" style={{ color: (c?.paperHands ?? 0) >= 2 ? "var(--cryp-loss)" : undefined }}>
              {c?.paperHands ?? "—"}
            </div>
          </div>
        </div>

        <div className="mt-3 flex items-center justify-between gap-2">
          <div className="flex items-center gap-3 text-[11px] text-[var(--cryp-mute)]">
            <span className="font-mono-num">Score <strong className="text-[var(--cryp-text)]">{t.proScore.toFixed(0)}</strong></span>
            {t.survivalScore != null && (
              <span className="font-mono-num">Survive <strong className="text-[var(--cryp-text)]">{Math.round(t.survivalScore)}</strong></span>
            )}
            {t.secMintRenounced && (
              <span className="flex items-center gap-0.5" style={{ color: "var(--cryp-gain)" }}>
                <Shield className="w-3 h-3" /> Mint
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5" onClick={e => e.stopPropagation()}>
            <button
              type="button"
              className="p-1.5 text-[var(--cryp-mute)] hover:text-[var(--cryp-text)]"
              onClick={() => {
                void navigator.clipboard.writeText(t.address);
                toast({ title: "CA copied" });
              }}
              aria-label="Copy CA"
            >
              <Copy className="w-3.5 h-3.5" />
            </button>
            <a href={getGmgnUrl(t.chain, t.address)} target="_blank" rel="noreferrer" className="p-1.5 text-[var(--cryp-mute)] hover:text-[var(--cryp-mint)]">
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
            {t.socials?.twitter && (
              <a href={t.socials.twitter} target="_blank" rel="noreferrer" className="p-1.5 text-[var(--cryp-mute)] hover:text-[var(--cryp-text)]">
                <Twitter className="w-3.5 h-3.5" />
              </a>
            )}
            {t.socials?.telegram && (
              <a href={t.socials.telegram} target="_blank" rel="noreferrer" className="p-1.5 text-[var(--cryp-mute)] hover:text-[var(--cryp-text)]">
                <Send className="w-3.5 h-3.5" />
              </a>
            )}
            {t.socials?.website && (
              <a href={t.socials.website} target="_blank" rel="noreferrer" className="p-1.5 text-[var(--cryp-mute)] hover:text-[var(--cryp-text)]">
                <Globe className="w-3.5 h-3.5" />
              </a>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

export default function Caller() {
  const [, setLocation] = useLocation();
  const [age, setAge] = useState<AgeTab>("7d");
  const [sort, setSort] = useState<SortKey>("calledAt");
  const [q, setQ] = useState("");

  const { data: stats } = useQuery<ProStats>({
    queryKey: ["pro-stats"],
    queryFn: () => fetch(`${getApiBase()}api/pro/stats`).then(r => r.json()),
    refetchInterval: 20_000,
  });

  const { data: hist, isLoading } = useQuery<{ tokens: ProToken[] }>({
    queryKey: ["pro-history"],
    queryFn: () => fetch(`${getApiBase()}api/pro/history?limit=200&sort=calledAt&order=desc`).then(r => r.json()),
    refetchInterval: 12_000,
  });

  const ageCounts = useMemo(() => {
    const list = hist?.tokens ?? [];
    const now = Date.now();
    const count = (ms: number | null) =>
      list.filter(t => {
        if (ms == null) return true;
        const d = parseApiDate(t.calledAt);
        return d != null && now - d.getTime() <= ms;
      }).length;
    return {
      "1h": count(3_600_000),
      "6h": count(6 * 3_600_000),
      "24h": count(24 * 3_600_000),
      "7d": count(7 * 24 * 3_600_000),
      all: list.length,
    } as Record<AgeTab, number>;
  }, [hist]);

  const tokens = useMemo(() => {
    let list = hist?.tokens ?? [];
    const now = Date.now();
    const ageMs: Record<AgeTab, number | null> = {
      all: null, "1h": 3_600_000, "6h": 6 * 3_600_000, "24h": 24 * 3_600_000, "7d": 7 * 24 * 3_600_000,
    };
    const cut = ageMs[age];
    if (cut != null) {
      list = list.filter(t => {
        const d = parseApiDate(t.calledAt);
        return d != null && now - d.getTime() <= cut;
      });
    }
    if (q.trim()) {
      const s = q.trim().toLowerCase();
      list = list.filter(t =>
        (t.symbol ?? "").toLowerCase().includes(s)
        || (t.name ?? "").toLowerCase().includes(s)
        || t.address.toLowerCase().includes(s),
      );
    }
    const scored = [...list];
    scored.sort((a, b) => {
      if (sort === "calledAt") {
        const ta = parseApiDate(a.calledAt)?.getTime() ?? 0;
        const tb = parseApiDate(b.calledAt)?.getTime() ?? 0;
        return tb - ta;
      }
      if (sort === "ath") return (b.athMultiple ?? 0) - (a.athMultiple ?? 0);
      if (sort === "gain") return (b.gainSinceCall ?? 0) - (a.gainSinceCall ?? 0);
      if (sort === "proScore") return (b.proScore ?? 0) - (a.proScore ?? 0);
      const ac = a.conviction?.smartHoldRate ?? 0;
      const bc = b.conviction?.smartHoldRate ?? 0;
      if (bc !== ac) return bc - ac;
      return (b.proScore ?? 0) - (a.proScore ?? 0);
    });
    return scored;
  }, [hist, age, sort, q]);

  const latest = hist?.tokens?.[0];
  const latestAge = latest?.calledAt ? formatTimeAgo(latest.calledAt) : null;

  return (
    <div className="px-4 md:px-8 pt-5 md:pt-8 space-y-6">
      {/* Hero */}
      <header className="fade-up">
        <div className="font-display text-[11px] tracking-[0.28em] uppercase text-[var(--cryp-teal)]">
          Crypsor Pro
        </div>
        <h1 className="font-display text-3xl md:text-4xl font-extrabold tracking-tight mt-1.5">
          Caller desk
        </h1>
        <p className="text-[var(--cryp-mute)] text-sm mt-2 max-w-xl leading-relaxed">
          High-conviction Solana memes verified live on GMGN — smart still holding beats tag counts.
          {latest?.symbol && (
            <span className="text-[var(--cryp-text)]">
              {" "}Latest · {safeSymbol(latest.symbol, latest.address)}
              {latestAge ? ` · ${latestAge} ago` : ""}
            </span>
          )}
        </p>
      </header>

      {/* KPI row — trader metrics, not milestone chrome */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-3 fade-up fade-up-delay-1">
        <StatTile
          label="Win rate ≥2×"
          value={stats ? `${Math.round(stats.winRate)}%` : "—"}
          hint={stats ? `${stats.x2Count}/${stats.total} quality calls` : "loading"}
          accent="var(--cryp-gain)"
        />
        <StatTile
          label="Avg survival"
          value={stats?.avgSurvival != null ? `${Math.round(stats.avgSurvival)}` : "—"}
          hint="Structure held since call"
        />
        <StatTile
          label="On desk"
          value={String(stats?.qualityCount ?? "—")}
          hint={`${stats?.veryGoodCount ?? 0} elite · ${stats?.goodCount ?? 0} strong`}
          accent="var(--cryp-mint)"
        />
        <StatTile
          label="Best run"
          value={stats?.bestAth != null ? `${Number(stats.bestAth).toFixed(1)}×` : "—"}
          hint={stats?.x10PlusCount ? `${stats.x10PlusCount} above 20×` : "ATH from entry"}
        />
      </section>

      {/* Controls */}
      <section className="flex flex-col sm:flex-row sm:items-center gap-3 fade-up fade-up-delay-2">
        <div className="flex flex-wrap gap-1">
          {([
            ["1h", "1H"], ["6h", "6H"], ["24h", "24H"], ["7d", "7D"], ["all", "All"],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setAge(key)}
              className={cn(
                "px-3 py-1.5 text-[11px] font-bold tracking-wider uppercase transition-colors",
                age === key ? "text-[var(--cryp-ink)]" : "text-[var(--cryp-mute)] hover:text-[var(--cryp-text)]",
              )}
              style={{
                background: age === key ? "var(--cryp-teal)" : "transparent",
                border: `1px solid ${age === key ? "var(--cryp-teal)" : "var(--cryp-line)"}`,
              }}
            >
              {label}
              <span className="ml-1 opacity-70 font-mono-num">{ageCounts[key]}</span>
            </button>
          ))}
        </div>
        <div className="flex flex-1 items-center gap-2">
          <select
            value={sort}
            onChange={e => setSort(e.target.value as SortKey)}
            className="bg-transparent text-[12px] px-2 py-1.5 text-[var(--cryp-text)]"
            style={{ border: "1px solid var(--cryp-line)" }}
          >
            <option value="calledAt">Newest</option>
            <option value="conviction">Conviction</option>
            <option value="proScore">Pro score</option>
            <option value="ath">ATH ×</option>
            <option value="gain">Gain</option>
          </select>
          <input
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Search symbol or CA"
            className="flex-1 bg-transparent text-[12px] px-3 py-1.5 outline-none placeholder:text-[var(--cryp-mute)]"
            style={{ border: "1px solid var(--cryp-line)" }}
          />
        </div>
      </section>

      {/* Feed */}
      <section className="space-y-3 fade-up fade-up-delay-3">
        <div className="flex items-center justify-between">
          <div className="text-[11px] tracking-[0.2em] uppercase text-[var(--cryp-mute)]">
            {tokens.length} call{tokens.length === 1 ? "" : "s"}
          </div>
          <div className="flex items-center gap-1.5 text-[11px] text-[var(--cryp-mute)]">
            <TrendingUp className="w-3 h-3" />
            Live GMGN verify
          </div>
        </div>

        {isLoading && (
          <div className="desk-card p-8 text-center text-[var(--cryp-mute)] text-sm">Loading desk…</div>
        )}
        {!isLoading && tokens.length === 0 && (
          <div className="desk-card p-10 text-center">
            <div className="font-display text-lg font-bold">No calls in this window</div>
            <div className="text-sm text-[var(--cryp-mute)] mt-2 max-w-md mx-auto">
              {age !== "all" && ageCounts.all > 0
                ? `${ageCounts.all} Pro calls exist, but none in ${age.toUpperCase()}. Try 7D or All.`
                : "Strict gates: smart still holding · MC $5–40K · live GMGN"}
              {latestAge && (
                <div className="mt-2 text-[12px]">Latest call was {latestAge} ago</div>
              )}
            </div>
            {age !== "7d" && age !== "all" && (
              <button
                type="button"
                className="mt-4 px-4 py-2 text-[11px] font-bold uppercase tracking-wider"
                style={{ background: "var(--cryp-teal)", color: "var(--cryp-ink)" }}
                onClick={() => setAge("7d")}
              >
                Show 7D ({ageCounts["7d"]})
              </button>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
          {tokens.map(t => (
            <TokenCard
              key={t.id}
              t={t}
              onOpen={() => setLocation(`/tokens/${t.id}`)}
            />
          ))}
        </div>
      </section>
    </div>
  );
}
