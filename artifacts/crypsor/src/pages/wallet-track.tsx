/**
 * Wallet Track — free-resource holder board + Crypsor labels (GMGN = KOL/smart only).
 */
import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link } from "wouter";
import { ArrowLeft, Copy, Loader2, Radar, Search } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn, truncateAddress, formatUsd } from "@/lib/utils";
import {
  analyzeWalletTrack,
  type JudgedWallet,
  type RunStatus,
  type TrackLabel,
  type WalletTrackReport,
} from "@/lib/wallet-track-api";
import { ApiError } from "@/lib/api-fetch";

const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function labelTone(label: TrackLabel): string {
  switch (label) {
    case "kol":
    case "smart":
    case "diamond":
      return "text-[var(--cryp-mint)]";
    case "bundler":
    case "sniper":
    case "bot":
    case "insider":
    case "paper":
      return "text-[var(--cryp-loss)]";
    case "fresh":
    case "terminal":
    case "flipper":
    case "dev":
    case "cex_funded":
    case "whale":
      return "text-[var(--cryp-warn)]";
    default:
      return "text-[var(--cryp-mute)]";
  }
}

function gradeTone(g: string): string {
  if (g === "A" || g === "B") return "text-[var(--cryp-mint)]";
  if (g === "C") return "text-[var(--cryp-warn)]";
  return "text-[var(--cryp-loss)]";
}

function scoreTone(s: number): string {
  if (s >= 65) return "text-[var(--cryp-mint)]";
  if (s >= 45) return "text-[var(--cryp-text)]";
  if (s >= 30) return "text-[var(--cryp-warn)]";
  return "text-[var(--cryp-loss)]";
}

function statusTone(s: RunStatus): string {
  if (s === "running") return "text-[var(--cryp-mint)]";
  if (s === "fading") return "text-[var(--cryp-warn)]";
  if (s === "dead") return "text-[var(--cryp-loss)]";
  return "text-[var(--cryp-mute)]";
}

function pctChange(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(1)}%`;
}

function WalletRow({ w }: { w: JudgedWallet }) {
  const { toast } = useToast();
  const tags = w.ourTags.length ? w.ourTags : w.gmgnTags;
  return (
    <li
      className="py-3 space-y-1.5"
      style={{ borderBottom: "1px solid var(--cryp-line)" }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-mono-num text-[var(--cryp-mute)]">#{w.rank}</span>
            <button
              type="button"
              className="font-mono text-[12px] text-[var(--cryp-text)] hover:text-[var(--cryp-mint)]"
              onClick={() => {
                void navigator.clipboard.writeText(w.address);
                toast({ title: "Address copied" });
              }}
            >
              {truncateAddress(w.address)}
              <Copy className="inline w-3 h-3 ml-1 opacity-50" />
            </button>
          </div>
          {(w.twitterUsername || w.twitterName) && (
            <div className="text-[10px] text-[var(--cryp-mute)] mt-0.5">
              @{w.twitterUsername || w.twitterName}
            </div>
          )}
        </div>
        <div className="text-right shrink-0">
          <div className={cn("text-[11px] font-bold uppercase tracking-wider", labelTone(w.ourLabel))}>
            {w.ourLabel.replace("_", " ")}
          </div>
          <div className={cn("font-mono-num text-[13px] font-bold", scoreTone(w.score))}>
            {w.score}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] font-mono-num text-[var(--cryp-mute)]">
        <span>Hold {w.holdPct.toFixed(2)}%</span>
        {w.ageDays != null && <span>Age {w.ageDays < 1 ? `${(w.ageDays * 24).toFixed(0)}h` : `${w.ageDays.toFixed(0)}d`}</span>}
        {w.solBalance != null && <span>◎ {w.solBalance.toFixed(2)}</span>}
        {w.isKol && <span className="text-[var(--cryp-mint)]">KOL</span>}
        {w.isSmart && <span className="text-[var(--cryp-mint)]">SMART</span>}
      </div>
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {tags.slice(0, 8).map((t) => (
            <span
              key={t}
              className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded"
              style={{ background: "rgba(125,180,170,0.08)", color: "var(--cryp-mute)" }}
            >
              {t}
            </span>
          ))}
        </div>
      )}
      <div className="text-[10px] text-[var(--cryp-mute)] leading-relaxed">
        {w.reasons.slice(0, 4).join(" · ")}
      </div>
    </li>
  );
}

function Report({ data }: { data: WalletTrackReport }) {
  const { toast } = useToast();
  const s = data.summary;
  const b = data.board;
  const [filter, setFilter] = useState<"all" | "quality" | "risk">("all");

  const shown = useMemo(() => {
    if (filter === "quality") {
      return data.wallets.filter(
        (w) => w.isKol || w.isSmart || w.ourLabel === "diamond" || w.score >= 65,
      );
    }
    if (filter === "risk") {
      return data.wallets.filter(
        (w) =>
          ["bundler", "sniper", "bot", "fresh", "insider", "paper"].includes(w.ourLabel)
          || w.score < 35,
      );
    }
    return data.wallets;
  }, [data.wallets, filter]);

  return (
    <div className="space-y-5 px-4 pb-10">
      {/* Token board — Deepnets-style status strip */}
      <section
        className="rounded-2xl p-4 space-y-4"
        style={{ background: "var(--cryp-elevated)", border: "1px solid var(--cryp-line)" }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex items-start gap-3">
            {data.token.imageUrl && (
              <img
                src={data.token.imageUrl}
                alt=""
                className="w-10 h-10 rounded-xl object-cover shrink-0"
              />
            )}
            <div className="min-w-0">
              <div className="font-display text-[18px] font-bold tracking-tight">
                ${data.token.symbol || "TOKEN"}
              </div>
              <div className="text-[12px] text-[var(--cryp-mute)] truncate">
                {data.token.name || "Unnamed"}
              </div>
              <button
                type="button"
                className="mt-1 font-mono text-[11px] text-[var(--cryp-mute)] hover:text-[var(--cryp-mint)]"
                onClick={() => {
                  void navigator.clipboard.writeText(data.token.address);
                  toast({ title: "Mint copied" });
                }}
              >
                {truncateAddress(data.token.address)}
              </button>
            </div>
          </div>
          <div className="text-right shrink-0 space-y-1">
            <div className={cn("text-[12px] font-bold uppercase tracking-widest", statusTone(b.runStatus))}>
              {b.runStatus}
            </div>
            <div className={cn("font-display text-[28px] font-extrabold leading-none", gradeTone(s.grade))}>
              {s.grade}
            </div>
            <div className="text-[9px] uppercase tracking-widest text-[var(--cryp-mute)]">
              Holder grade
            </div>
          </div>
        </div>

        <div className="grid grid-cols-4 gap-2 text-center">
          <div>
            <div className="font-mono-num text-[13px] font-bold">{formatUsd(data.token.marketCapUsd)}</div>
            <div className="text-[9px] uppercase tracking-widest text-[var(--cryp-mute)]">MC</div>
          </div>
          <div>
            <div className={cn(
              "font-mono-num text-[13px] font-bold",
              (b.priceChange24h ?? 0) >= 0 ? "text-[var(--cryp-gain)]" : "text-[var(--cryp-loss)]",
            )}>
              {pctChange(b.priceChange24h)}
            </div>
            <div className="text-[9px] uppercase tracking-widest text-[var(--cryp-mute)]">24h</div>
          </div>
          <div>
            <div className="font-mono-num text-[13px] font-bold">
              {b.athMultipleEst != null ? `${b.athMultipleEst.toFixed(1)}×` : "—"}
            </div>
            <div className="text-[9px] uppercase tracking-widest text-[var(--cryp-mute)]">ATH est</div>
          </div>
          <div>
            <div className="font-mono-num text-[13px] font-bold">{s.medianScore}</div>
            <div className="text-[9px] uppercase tracking-widest text-[var(--cryp-mute)]">Med score</div>
          </div>
        </div>

        <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 text-[11px]">
          <Stat label="Liq" value={formatUsd(b.liquidityUsd)} />
          <Stat label="Vol 24h" value={formatUsd(b.volume24h)} />
          <Stat label="1h" value={pctChange(b.priceChange1h)} bad={(b.priceChange1h ?? 0) < -20} />
          <Stat label="Top10" value={b.top10Pct != null ? `${b.top10Pct.toFixed(0)}%` : "—"} bad={(b.top10Pct ?? 0) >= 40} />
          <Stat label="Rug" value={b.rugScore != null ? String(b.rugScore) : "—"} bad={b.rugged || (b.rugScore ?? 0) >= 1000} />
          <Stat label="Pair age" value={b.pairAgeHours != null ? (b.pairAgeHours < 48 ? `${b.pairAgeHours.toFixed(0)}h` : `${(b.pairAgeHours / 24).toFixed(0)}d`) : "—"} />
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
          <Stat label="KOL" value={`${s.kolCount} · ${s.kolSupplyPct}%`} good />
          <Stat label="Smart" value={`${s.smartCount} · ${s.smartSupplyPct}%`} good />
          <Stat label="Bundler" value={`${s.bundlerCount} · ${s.bundlerSupplyPct}%`} bad={s.bundlerSupplyPct >= 10} />
          <Stat label="Sniper" value={`${s.sniperCount} · ${s.sniperSupplyPct}%`} bad={s.sniperSupplyPct >= 10} />
          <Stat label="Fresh" value={`${s.freshCount} · ${s.freshSupplyPct}%`} bad={s.freshSupplyPct >= 15} />
          <Stat label="Diamond" value={String(s.diamondCount)} good={s.diamondCount > 0} />
          <Stat label="CEX funded" value={String(s.cexFundedCount)} />
          <Stat label="Whales" value={String(s.whaleCount)} />
        </div>

        {(b.mintAuthorityLive || b.freezeAuthorityLive) && (
          <div className="flex flex-wrap gap-2 text-[10px]">
            {b.mintAuthorityLive && (
              <span className="text-[var(--cryp-loss)] uppercase tracking-wider">Mint auth live</span>
            )}
            {b.freezeAuthorityLive && (
              <span className="text-[var(--cryp-loss)] uppercase tracking-wider">Freeze auth live</span>
            )}
          </div>
        )}

        {s.riskFlags.length > 0 && (
          <div className="space-y-1">
            {s.riskFlags.map((f) => (
              <div key={f} className="text-[11px] text-[var(--cryp-loss)]">⚠ {f}</div>
            ))}
          </div>
        )}

        <div className="text-[10px] text-[var(--cryp-mute)] leading-relaxed">
          {data.note} · {new Date(data.fetchedAt).toLocaleString()} · free holders {data.fetch.holderRows} · enriched {data.fetch.enrichedWallets} · GMGN KOL/smart hits {data.fetch.gmgnOverlayRows}
        </div>
      </section>

      <div className="flex items-center gap-2">
        {(["all", "quality", "risk"] as const).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={cn(
              "text-[10px] uppercase tracking-widest px-3 py-1.5 rounded-full transition-colors",
              filter === f
                ? "bg-[rgba(61,154,139,0.2)] text-[var(--cryp-mint)]"
                : "text-[var(--cryp-mute)] hover:text-[var(--cryp-text)]",
            )}
          >
            {f} ({f === "all"
              ? data.wallets.length
              : f === "quality"
                ? data.wallets.filter((w) => w.isKol || w.isSmart || w.ourLabel === "diamond" || w.score >= 65).length
                : data.wallets.filter((w) => ["bundler", "sniper", "bot", "fresh", "insider", "paper"].includes(w.ourLabel) || w.score < 35).length})
          </button>
        ))}
      </div>

      <ul>
        {shown.map((w) => <WalletRow key={w.address} w={w} />)}
        {shown.length === 0 && (
          <li className="py-8 text-center text-[12px] text-[var(--cryp-mute)]">No wallets in this filter</li>
        )}
      </ul>
    </div>
  );
}

function Stat({ label, value, good, bad }: {
  label: string;
  value: string;
  good?: boolean;
  bad?: boolean;
}) {
  return (
    <div
      className="rounded-xl px-2 py-2"
      style={{ background: "rgba(5,10,15,0.45)", border: "1px solid var(--cryp-line)" }}
    >
      <div className="text-[9px] uppercase tracking-widest text-[var(--cryp-mute)]">{label}</div>
      <div className={cn(
        "font-mono-num text-[12px] font-bold mt-0.5",
        good && "text-[var(--cryp-mint)]",
        bad && "text-[var(--cryp-loss)]",
        !good && !bad && "text-[var(--cryp-text)]",
      )}>
        {value}
      </div>
    </div>
  );
}

export default function WalletTrackPage() {
  const [input, setInput] = useState("");
  const { toast } = useToast();

  const mutation = useMutation({
    mutationFn: (token: string) => analyzeWalletTrack(token),
    onError: (err) => {
      const msg = err instanceof ApiError ? err.message : "Analyze failed";
      toast({ title: "Wallet Track", description: msg, variant: "destructive" });
    },
  });

  const submit = () => {
    const token = input.trim();
    if (!token) {
      toast({ title: "Paste a mint or token id", variant: "destructive" });
      return;
    }
    if (!/^\d+$/.test(token) && !SOL_RE.test(token)) {
      toast({ title: "Invalid Solana mint", variant: "destructive" });
      return;
    }
    mutation.mutate(token);
  };

  return (
    <div className="flex flex-col min-h-full">
      <div className="px-4 pt-4 pb-3 flex items-center gap-3">
        <Link href="/">
          <button
            type="button"
            className="w-9 h-9 flex items-center justify-center rounded-xl text-[var(--cryp-mute)] hover:text-[var(--cryp-text)]"
            aria-label="Back"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
        </Link>
        <div>
          <div className="font-display text-[15px] font-bold tracking-[0.12em] uppercase text-[var(--cryp-mint)] flex items-center gap-2">
            <Radar className="w-4 h-4" />
            Wallet Track
          </div>
          <div className="text-[10px] text-[var(--cryp-mute)] tracking-wide">
            Free holders · Crypsor labels · GMGN KOL/smart only
          </div>
        </div>
      </div>

      <div className="px-4 pb-4">
        <div
          className="flex items-center gap-2 rounded-2xl px-3 py-2"
          style={{ background: "var(--cryp-elevated)", border: "1px solid var(--cryp-line)" }}
        >
          <Search className="w-4 h-4 text-[var(--cryp-mute)] shrink-0" />
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
            placeholder="Paste Solana mint or tracked token id"
            className="flex-1 bg-transparent outline-none text-[13px] font-mono text-[var(--cryp-text)] placeholder:text-[var(--cryp-mute)]"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
          />
          <button
            type="button"
            onClick={submit}
            disabled={mutation.isPending}
            className="shrink-0 h-9 px-3 rounded-xl text-[10px] font-bold uppercase tracking-widest text-[var(--cryp-ink)] bg-[var(--cryp-mint)] disabled:opacity-50"
          >
            {mutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "Fetch"}
          </button>
        </div>
        <p className="mt-2 text-[10px] text-[var(--cryp-mute)] leading-relaxed">
          Holders from Solana RPC. Age, funding clusters, sniper timing, concentration scored by Crypsor.
          GMGN overlays KOL/smart only. Status from DexScreener + RugCheck.
        </p>
      </div>

      {mutation.isPending && (
        <div className="px-4 py-12 text-center text-[12px] text-[var(--cryp-mute)] flex flex-col items-center gap-2">
          <Loader2 className="w-5 h-5 animate-spin text-[var(--cryp-mint)]" />
          Pulling free holders, enriching wallets, overlaying KOL/smart…
        </div>
      )}

      {mutation.data && !mutation.isPending && <Report data={mutation.data} />}

      {!mutation.data && !mutation.isPending && (
        <div className="px-4 py-10 text-center text-[12px] text-[var(--cryp-mute)] space-y-2">
          <p>Enter a token for a Crypsor holder board.</p>
          <p className="text-[10px]">Running / Fading / Dead · ATH est · own labels · KOL/smart from GMGN.</p>
        </div>
      )}
    </div>
  );
}
