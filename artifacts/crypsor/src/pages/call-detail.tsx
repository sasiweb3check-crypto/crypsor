/**
 * FOMO-style call detail — opened from Best Calls cards.
 * Shows CALL/CURRENT/ATH, your tracked wallet buyers, Crypsor holder intel,
 * CTO/creator, snap tape.
 */
import { useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useLocation, useParams } from "wouter";
import {
  ArrowLeft, Copy, ExternalLink, Flame, Users, Shield, Brain,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  cn, truncateAddress, formatCompactUsd, formatTimeAgo,
  getGmgnUrl, safeSymbol, safeImageUrl,
} from "@/lib/utils";
import {
  CALLS_TOKEN_KEY, fetchCallDetail,
  type CallBuyer, type CallCard, type CrypsorWalletRow,
} from "@/lib/calls-api";

function crypsorLabelColor(label: string): string {
  switch (label) {
    case "diamond": return "text-[var(--cryp-mint)]";
    case "accumulator": return "text-[var(--cryp-teal)]";
    case "solid": return "text-[var(--cryp-text)]";
    case "whale": return "text-[var(--cryp-warn)]";
    case "flipper":
    case "dump": return "text-[var(--cryp-loss)]";
    default: return "text-[var(--cryp-mute)]";
  }
}

function CrypsorWalletRowView({ w }: { w: CrypsorWalletRow }) {
  const { toast } = useToast();
  return (
    <li
      className="py-2.5 space-y-1"
      style={{ borderBottom: "1px solid var(--cryp-line)" }}
    >
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          className="text-[12px] font-mono-num text-[var(--cryp-mute)] hover:text-[var(--cryp-mint)] truncate"
          onClick={() => {
            void navigator.clipboard.writeText(w.address);
            toast({ title: "Copied wallet", description: truncateAddress(w.address) });
          }}
        >
          {truncateAddress(w.address)}
        </button>
        <span className={cn("text-[11px] font-bold uppercase tracking-wider shrink-0", crypsorLabelColor(w.ourLabel))}>
          {w.ourLabel}
        </span>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] font-mono-num text-[var(--cryp-mute)]">
        <span>Score {Math.round(w.behaviourScore)}</span>
        <span>Wt {w.weightage.toFixed(1)}</span>
        {w.holdPct != null && <span>Hold {w.holdPct < 0.01 ? w.holdPct.toFixed(3) : w.holdPct.toFixed(2)}%</span>}
        {w.buyCount != null && <span>B{w.buyCount}</span>}
        {w.sellCount != null && <span>S{w.sellCount}</span>}
        {w.winRate != null ? (
          <span className="text-[var(--cryp-mint)]">
            WR {(w.winRate * 100).toFixed(0)}% ({w.wins}W/{w.losses}L)
          </span>
        ) : (
          <span>{w.wins}W/{w.losses}L</span>
        )}
        <span>{w.tokensSeen} tokens</span>
      </div>
      {w.reason && (
        <div className="text-[10px] text-[var(--cryp-mute)] leading-snug">{w.reason}</div>
      )}
    </li>
  );
}

function LiveBar({ now, peak }: { now: number; peak: number }) {
  const max = Math.max(peak, now, 1);
  const nowPct = Math.min(100, (now / max) * 100);
  const peakPct = Math.min(100, (peak / max) * 100);
  return (
    <div>
      <div className="relative h-2.5 rounded-full overflow-hidden" style={{ background: "rgba(125,180,170,0.12)" }}>
        <div
          className="absolute inset-y-0 left-0 rounded-full"
          style={{ width: `${peakPct}%`, background: "rgba(62,207,142,0.22)" }}
        />
        <div
          className="absolute inset-y-0 left-0 rounded-full"
          style={{
            width: `${nowPct}%`,
            background: "linear-gradient(90deg, #2f8f7e, #3ecf8e)",
          }}
        />
      </div>
      <div className="flex items-center justify-between mt-2 text-[12px]">
        <span className="font-mono-num text-[var(--cryp-warn)]">Now {now.toFixed(2)}×</span>
        <span className="font-mono-num text-[var(--cryp-gain)]">Peak {peak.toFixed(1)}× ✓</span>
      </div>
    </div>
  );
}

function BuyerRow({ b }: { b: CallBuyer }) {
  const { toast } = useToast();
  return (
    <li
      className="flex items-center justify-between gap-2 py-2.5"
      style={{ borderBottom: "1px solid var(--cryp-line)" }}
    >
      <div className="min-w-0">
        <div className="text-[13px] font-bold text-[var(--cryp-text)] truncate">{b.label}</div>
        <button
          type="button"
          className="text-[11px] font-mono-num text-[var(--cryp-mute)] hover:text-[var(--cryp-mint)]"
          onClick={() => {
            void navigator.clipboard.writeText(b.address);
            toast({ title: "Copied wallet", description: truncateAddress(b.address) });
          }}
        >
          {truncateAddress(b.address)}
        </button>
      </div>
      <div className="text-right shrink-0">
        <div className="text-[11px] text-[var(--cryp-mute)]">
          {b.boughtAt ? `${formatTimeAgo(b.boughtAt)} ago` : "—"}
        </div>
        {b.winRate != null && (
          <div className="text-[11px] font-mono-num text-[var(--cryp-mint)]">
            WR {(b.winRate * 100).toFixed(0)}%
          </div>
        )}
      </div>
    </li>
  );
}

function DetailHero({ c }: { c: CallCard }) {
  const { toast } = useToast();
  const [imgBroken, setImgBroken] = useState(false);
  const imgSrc = safeImageUrl(c.logoUri, c.address, c.symbol);
  const sym = safeSymbol(c.symbol, c.address) || "?";
  const athX = Number.isFinite(c.athMultiple) ? c.athMultiple : 1;
  const nowX = Number.isFinite(c.nowMultiple) ? c.nowMultiple : 1;

  return (
    <div className="call-card space-y-4">
      <div className="flex items-start gap-3">
        {!imgBroken ? (
          <img
            src={imgSrc}
            alt=""
            className="w-14 h-14 rounded-full object-cover shrink-0"
            style={{ background: "var(--cryp-elevated)", border: "1px solid var(--cryp-line)" }}
            onError={() => setImgBroken(true)}
          />
        ) : (
          <div
            className="w-14 h-14 rounded-full shrink-0 flex items-center justify-center text-[13px] font-bold"
            style={{ background: "rgba(61,154,139,0.18)", color: "var(--cryp-mint)" }}
          >
            {sym.slice(0, 2)}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <h1 className="font-display text-[22px] font-extrabold">${sym}</h1>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(c.address);
                toast({ title: "Copied", description: truncateAddress(c.address) });
              }}
              className="text-[var(--cryp-mute)] hover:text-[var(--cryp-mint)]"
            >
              <Copy className="w-3.5 h-3.5" />
            </button>
            {c.ctoFlag === true && (
              <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-md"
                style={{ color: "#04120c", background: "#7dd3c0" }}>CTO</span>
            )}
            {athX >= 2 && (
              <span className="ath-pill">{athX >= 10 ? Math.round(athX) : athX.toFixed(1)}x ATH</span>
            )}
          </div>
          <div className="text-[13px] text-[var(--cryp-mute)] mt-0.5 truncate">
            {c.name || truncateAddress(c.address)}
          </div>
          <div className="text-[12px] text-[var(--cryp-mute)] mt-1">
            Called {c.calledAt ? formatTimeAgo(c.calledAt) : "—"} ago
            {" · "}
            <span className="uppercase tracking-wider text-[var(--cryp-mint)]">
              {c.callLabel} {c.callScore}
            </span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2">
        {[
          { l: "Call MC", v: formatCompactUsd(c.calledMcUsd) },
          { l: "Current", v: formatCompactUsd(c.currentMcUsd) },
          { l: "ATH", v: formatCompactUsd(c.athMcUsd), accent: "var(--cryp-gain)" },
        ].map(x => (
          <div key={x.l} className="call-stat !py-3 !px-3">
            <div className="text-[9px] uppercase tracking-widest text-[var(--cryp-mute)]">{x.l}</div>
            <div
              className="font-mono-num text-[16px] font-bold mt-1"
              style={{ color: x.accent ?? "var(--cryp-text)" }}
            >
              {x.v}
            </div>
          </div>
        ))}
      </div>

      <LiveBar now={nowX} peak={Math.max(athX, nowX)} />

      <div className="flex flex-wrap gap-2">
        {c.walletBuys > 0 && (
          <span className="wallet-pill">
            <Flame className="w-3 h-3" />
            {c.walletBuys} tracked wallet{c.walletBuys === 1 ? "" : "s"} bought
          </span>
        )}
        {(c.calledSmart > 0 || c.calledKol > 0) && (
          <span className="text-[10px] font-bold px-2 py-1 rounded-full"
            style={{ background: "rgba(61,154,139,0.14)", color: "var(--cryp-mint)" }}>
            Smart {c.calledSmart} · KOL {c.calledKol}
          </span>
        )}
        {c.creatorClose === false && (
          <span className="text-[10px] font-bold px-2 py-1 rounded-full"
            style={{ background: "rgba(232,93,93,0.2)", color: "var(--cryp-loss)" }}>
            Dev still holding
          </span>
        )}
        {c.creatorClose === true && (
          <span className="text-[10px] font-bold px-2 py-1 rounded-full"
            style={{ background: "rgba(62,207,142,0.14)", color: "var(--cryp-gain)" }}>
            Creator closed
          </span>
        )}
      </div>

      {c.reasons.length > 0 && (
        <div className="text-[12px] text-[var(--cryp-mute)] leading-relaxed">
          {c.reasons.join(" · ")}
        </div>
      )}

      <div className="flex gap-2 pt-1">
        <a
          href={getGmgnUrl(c.chain, c.address)}
          target="_blank"
          rel="noreferrer"
          className="call-action flex-1 justify-center"
        >
          <ExternalLink className="w-3.5 h-3.5" />
          Buy on GMGN
        </a>
        <button
          type="button"
          className="call-action flex-1 justify-center"
          onClick={() => {
            const text = `$${sym} · ${athX.toFixed(1)}× ATH · Call ${formatCompactUsd(c.calledMcUsd)} → Now ${formatCompactUsd(c.currentMcUsd)}\n${c.address}`;
            void navigator.clipboard.writeText(text);
            toast({ title: "Copied call", description: `$${sym}` });
          }}
        >
          Share
        </button>
      </div>
    </div>
  );
}

export default function CallDetailPage() {
  const params = useParams<{ id: string }>();
  const [, setLocation] = useLocation();
  const id = Number(params.id);
  const [wantWinrate, setWantWinrate] = useState(false);

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: CALLS_TOKEN_KEY(id, wantWinrate),
    queryFn: () => fetchCallDetail(id, { winrate: wantWinrate }),
    enabled: Number.isFinite(id),
    refetchInterval: 15_000,
    placeholderData: keepPreviousData,
    retry: 3,
  });

  const card = data?.card ?? null;
  const buyers = data?.buyers ?? [];
  const snaps = data?.snaps ?? [];
  const crypsorWallets = data?.crypsorWallets ?? [];
  const winrateLoaded = Boolean(data?.winrateLoaded);
  const uniqueBuyers = useMemo(() => {
    const seen = new Set<number>();
    return buyers.filter(b => {
      if (seen.has(b.walletId)) return false;
      seen.add(b.walletId);
      return true;
    });
  }, [buyers]);

  return (
    <div className="px-4 pt-3 pb-10 space-y-4 max-w-lg mx-auto w-full">
      <button
        type="button"
        onClick={() => setLocation("/")}
        className="inline-flex items-center gap-1.5 text-[12px] font-bold uppercase tracking-widest text-[var(--cryp-mute)] hover:text-[var(--cryp-mint)]"
      >
        <ArrowLeft className="w-4 h-4" />
        Calls
      </button>

      {isLoading && !card && (
        <div className="call-card shimmer-card h-64" />
      )}

      {isError && !card && (
        <div className="call-card text-center py-10 space-y-3">
          <div className="text-[var(--cryp-loss)] text-[13px]">Couldn’t load call</div>
          <div className="text-[11px] text-[var(--cryp-mute)]">
            {error instanceof Error ? error.message : "Retry"}
          </div>
          <button type="button" className="call-action mx-auto" onClick={() => void refetch()}>
            Retry
          </button>
        </div>
      )}

      {card && <DetailHero c={card} />}

      {!winrateLoaded && card && (
        <button
          type="button"
          className="call-action w-full"
          disabled={isFetching && wantWinrate}
          onClick={() => setWantWinrate(true)}
        >
          {isFetching && wantWinrate ? "Loading win rates…" : "Load win rates"}
        </button>
      )}
      {winrateLoaded && card?.avgWalletWinRate != null && (
        <div className="text-[12px] font-mono-num text-[var(--cryp-mint)] text-center">
          Buyer WR avg {(card.avgWalletWinRate * 100).toFixed(0)}%
        </div>
      )}

      {/* Tracked wallet buyers */}
      <section className="call-card">
        <div className="flex items-center gap-2 mb-1">
          <Users className="w-4 h-4 text-[var(--cryp-teal)]" />
          <h2 className="font-display text-[13px] font-bold uppercase tracking-widest">
            Your wallet buys
          </h2>
          <span className="ml-auto text-[11px] font-mono-num text-[var(--cryp-mute)]">
            {uniqueBuyers.length}
          </span>
        </div>
        <p className="text-[11px] text-[var(--cryp-mute)] leading-relaxed mb-2">
          {data?.walletBuysNote
            ?? "Wallets from your tracked list (walletdatasource) that bought this token — scanned via Helius into token_buys. Not the full holder set."}
        </p>
        {uniqueBuyers.length === 0 ? (
          <div className="text-[12px] text-[var(--cryp-mute)] py-6 text-center">
            No tracked-wallet buys recorded yet for this token
          </div>
        ) : (
          <ul>
            {uniqueBuyers.map(b => <BuyerRow key={`${b.walletId}-${b.boughtAt}`} b={b} />)}
          </ul>
        )}
      </section>

      {/* Crypsor holder intel — OWN labels, not GMGN KOL/smart */}
      <section className="call-card">
        <div className="flex items-center gap-2 mb-1">
          <Brain className="w-4 h-4 text-[var(--cryp-mint)]" />
          <h2 className="font-display text-[13px] font-bold uppercase tracking-widest">
            Crypsor wallet intel
          </h2>
          <span className="ml-auto text-[11px] font-mono-num text-[var(--cryp-mute)]">
            {crypsorWallets.length}
          </span>
        </div>
        <p className="text-[11px] text-[var(--cryp-mute)] leading-relaxed mb-2">
          {data?.crypsorNote
            ?? "Our background labelling of this token’s holders (behaviour, weightage, Crypsor win-rate). Not GMGN KOL / smart tags."}
        </p>
        {crypsorWallets.length === 0 ? (
          <div className="text-[12px] text-[var(--cryp-mute)] py-6 text-center">
            Judging holders in the background — refresh shortly after holder snapshots land
          </div>
        ) : (
          <ul>
            {crypsorWallets.map(w => (
              <CrypsorWalletRowView key={w.address} w={w} />
            ))}
          </ul>
        )}
      </section>

      {/* Creator / security */}
      {card && (
        <section className="call-card space-y-2">
          <div className="flex items-center gap-2 mb-1">
            <Shield className="w-4 h-4 text-[var(--cryp-teal)]" />
            <h2 className="font-display text-[13px] font-bold uppercase tracking-widest">
              Creator · CTO
            </h2>
          </div>
          <div className="grid grid-cols-2 gap-2 text-[12px]">
            <div>
              <div className="text-[9px] uppercase tracking-widest text-[var(--cryp-mute)]">CTO</div>
              <div className={cn("font-bold mt-0.5", card.ctoFlag ? "text-[var(--cryp-mint)]" : "text-[var(--cryp-text)]")}>
                {card.ctoFlag === true ? "Yes (community)" : card.ctoFlag === false ? "No" : "Unknown"}
              </div>
            </div>
            <div>
              <div className="text-[9px] uppercase tracking-widest text-[var(--cryp-mute)]">Creator</div>
              <div className="font-bold mt-0.5">
                {card.creatorClose === true ? "Closed / exited"
                  : card.creatorClose === false ? "Still holding"
                    : "—"}
              </div>
            </div>
            <div>
              <div className="text-[9px] uppercase tracking-widest text-[var(--cryp-mute)]">Created tokens</div>
              <div className="font-mono-num font-bold mt-0.5">
                {card.creatorCreatedCount ?? "—"}
              </div>
            </div>
            <div>
              <div className="text-[9px] uppercase tracking-widest text-[var(--cryp-mute)]">Creator addr</div>
              <div className="font-mono-num text-[11px] mt-0.5 truncate">
                {card.creatorAddress ? truncateAddress(card.creatorAddress) : "—"}
              </div>
            </div>
          </div>
        </section>
      )}

      {/* Snap tape */}
      {snaps.length > 0 && (
        <section className="call-card">
          <h2 className="font-display text-[13px] font-bold uppercase tracking-widest mb-2">
            Observation tape
          </h2>
          <ul className="space-y-1.5 max-h-56 overflow-y-auto no-scrollbar">
            {[...snaps].reverse().map((s, i) => (
              <li
                key={`${s.at}-${i}`}
                className="flex items-center justify-between text-[11px] font-mono-num py-1"
                style={{ borderBottom: "1px solid rgba(125,180,170,0.08)" }}
              >
                <span className="text-[var(--cryp-mute)]">
                  {s.at ? formatTimeAgo(s.at) : "—"}
                </span>
                <span>{formatCompactUsd(s.mcUsd)}</span>
                <span className="text-[var(--cryp-gain)]">
                  {s.athMultiple != null ? `${s.athMultiple.toFixed(2)}×` : "—"}
                </span>
                <span className="text-[var(--cryp-mute)]">
                  S{s.smart ?? 0}/K{s.kol ?? 0}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
