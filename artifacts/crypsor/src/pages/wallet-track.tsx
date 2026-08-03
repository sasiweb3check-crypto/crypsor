/**
 * Wallet Track — paste a token mint, fetch GMGN holders, score & label from scratch.
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

function WalletRow({ w }: { w: JudgedWallet }) {
  const { toast } = useToast();
  return (
    <li
      className="py-3 space-y-1.5"
      style={{ borderBottom: "1px solid var(--cryp-line)" }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
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
          {(w.twitterUsername || w.twitterName) && (
            <div className="text-[10px] text-[var(--cryp-mute)] mt-0.5">
              @{w.twitterUsername || w.twitterName}
            </div>
          )}
        </div>
        <div className="text-right shrink-0">
          <div className={cn("text-[11px] font-bold uppercase tracking-wider", labelTone(w.ourLabel))}>
            {w.ourLabel}
          </div>
          <div className={cn("font-mono-num text-[13px] font-bold", scoreTone(w.score))}>
            {w.score}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] font-mono-num text-[var(--cryp-mute)]">
        <span>Hold {w.holdPct.toFixed(2)}%</span>
        <span>B{w.buyCount}</span>
        <span>S{w.sellCount}</span>
        {w.isKol && <span className="text-[var(--cryp-mint)]">KOL</span>}
        {w.isSmart && <span className="text-[var(--cryp-mint)]">SMART</span>}
        {w.realizedPnl != null && (
          <span className={w.realizedPnl >= 0 ? "text-[var(--cryp-gain)]" : "text-[var(--cryp-loss)]"}>
            PnL {w.realizedPnl >= 0 ? "+" : ""}{Math.round(w.realizedPnl)}
          </span>
        )}
      </div>
      {w.gmgnTags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {w.gmgnTags.slice(0, 8).map(t => (
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
  const [filter, setFilter] = useState<"all" | "quality" | "risk">("all");

  const shown = useMemo(() => {
    if (filter === "quality") {
      return data.wallets.filter(w => w.isKol || w.isSmart || w.ourLabel === "diamond" || w.score >= 65);
    }
    if (filter === "risk") {
      return data.wallets.filter(w =>
        ["bundler", "sniper", "bot", "fresh", "insider", "paper"].includes(w.ourLabel) || w.score < 35,
      );
    }
    return data.wallets;
  }, [data.wallets, filter]);

  return (
    <div className="space-y-5 px-4 pb-10">
      <section
        className="rounded-2xl p-4 space-y-3"
        style={{ background: "var(--cryp-elevated)", border: "1px solid var(--cryp-line)" }}
      >
        <div className="flex items-start justify-between gap-3">
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
          <div className="text-right shrink-0">
            <div className={cn("font-display text-[28px] font-extrabold leading-none", gradeTone(s.grade))}>
              {s.grade}
            </div>
            <div className="text-[9px] uppercase tracking-widest text-[var(--cryp-mute)] mt-1">
              Holder grade
            </div>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2 text-center">
          <div>
            <div className="font-mono-num text-[14px] font-bold">{s.analyzed}</div>
            <div className="text-[9px] uppercase tracking-widest text-[var(--cryp-mute)]">Wallets</div>
          </div>
          <div>
            <div className="font-mono-num text-[14px] font-bold">{s.medianScore}</div>
            <div className="text-[9px] uppercase tracking-widest text-[var(--cryp-mute)]">Med score</div>
          </div>
          <div>
            <div className="font-mono-num text-[14px] font-bold">{s.supplyPctCovered.toFixed(0)}%</div>
            <div className="text-[9px] uppercase tracking-widest text-[var(--cryp-mute)]">Supply seen</div>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
          <Stat label="KOL" value={`${s.kolCount} · ${s.kolSupplyPct}%`} good />
          <Stat label="Smart" value={`${s.smartCount} · ${s.smartSupplyPct}%`} good />
          <Stat label="Bundler" value={`${s.bundlerCount} · ${s.bundlerSupplyPct}%`} bad={s.bundlerSupplyPct >= 10} />
          <Stat label="Sniper" value={`${s.sniperCount} · ${s.sniperSupplyPct}%`} bad={s.sniperSupplyPct >= 10} />
          <Stat label="Fresh" value={`${s.freshCount} · ${s.freshSupplyPct}%`} bad={s.freshSupplyPct >= 15} />
          <Stat label="Bot" value={`${s.botCount} · ${s.botSupplyPct}%`} bad={s.botCount > 0} />
          <Stat label="Terminal" value={String(s.terminalCount)} />
          <Stat label="MC" value={formatUsd(data.token.marketCapUsd)} />
        </div>

        {s.riskFlags.length > 0 && (
          <div className="space-y-1">
            {s.riskFlags.map(f => (
              <div key={f} className="text-[11px] text-[var(--cryp-loss)]">⚠ {f}</div>
            ))}
          </div>
        )}

        <div className="text-[10px] text-[var(--cryp-mute)] leading-relaxed">
          {data.note} · fetched {new Date(data.fetchedAt).toLocaleString()} · GMGN pages {data.fetch.pages}
        </div>
      </section>

      <div className="flex items-center gap-2">
        {(["all", "quality", "risk"] as const).map(f => (
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
            {f} ({f === "all" ? data.wallets.length : f === "quality"
              ? data.wallets.filter(w => w.isKol || w.isSmart || w.ourLabel === "diamond" || w.score >= 65).length
              : data.wallets.filter(w => ["bundler", "sniper", "bot", "fresh", "insider", "paper"].includes(w.ourLabel) || w.score < 35).length})
          </button>
        ))}
      </div>

      <ul>
        {shown.map(w => <WalletRow key={w.address} w={w} />)}
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
            Token → holders → score & label (from scratch)
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
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") submit(); }}
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
          Pulls GMGN holders + free DexScreener meta. KOL/smart kept as GMGN tags. No cabal/balance-bracket logic.
        </p>
      </div>

      {mutation.isPending && (
        <div className="px-4 py-12 text-center text-[12px] text-[var(--cryp-mute)] flex flex-col items-center gap-2">
          <Loader2 className="w-5 h-5 animate-spin text-[var(--cryp-mint)]" />
          Fetching holders & scoring…
        </div>
      )}

      {mutation.data && !mutation.isPending && <Report data={mutation.data} />}

      {!mutation.data && !mutation.isPending && (
        <div className="px-4 py-10 text-center text-[12px] text-[var(--cryp-mute)] space-y-2">
          <p>Enter a token to judge its holders.</p>
          <p className="text-[10px]">Scores quality wallets up · flags bundlers, snipers, fresh, bots down.</p>
        </div>
      )}
    </div>
  );
}
