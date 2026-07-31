/**
 * Pro token detail — conviction wallets, hold/sold, paper/diamond hands.
 */
import { useRoute, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft, ExternalLink, Copy, CheckCheck,
  Diamond, Hand, Twitter, Send, Globe, Shield,
} from "lucide-react";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid, ReferenceLine,
} from "recharts";
import { useState } from "react";
import {
  formatMarketCap, formatTimeAgo, truncateAddress, getGmgnUrl, safeSymbol, safeImageUrl,
} from "@/lib/utils";
import { getApiBase } from "@/lib/api-base";

interface VerifiedWallet {
  address: string;
  twitterName?: string | null;
  twitterUsername?: string | null;
  labels?: string[];
  makerTags?: string[];
  amountPercentage?: number | null;
  usdValue?: number | null;
  holding?: boolean;
  soldFully?: boolean;
  sellAmountPercentage?: number | null;
  paperHands?: boolean;
  diamondHands?: boolean;
  realizedProfit?: number | null;
  buyTxCount?: number;
  sellTxCount?: number;
}

interface Conviction {
  total: number;
  holding: number;
  sold: number;
  holdRate: number;
  soldRate: number;
  supplyPctHeld: number;
  usdHeld: number;
  paperHands: number;
  diamondHands: number;
}

interface TokenBase {
  id: number;
  address: string;
  chain: string;
  name: string | null;
  symbol: string | null;
  logoUri: string | null;
  marketCapUsd: string | null;
  liquidityUsd: string | null;
  holderCount: number;
  intelligenceScore?: number;
  status: string;
}

interface ProPack {
  proCall: {
    calledAt: string;
    calledMcUsd: number | null;
    calledIntelScore: number | null;
    calledKolCount: number;
    calledSmartCount: number;
    athMultiple: number | null;
    proScore: number | null;
    qualityLabel: string | null;
    survivalScore?: number | null;
    currentMcUsd?: number | null;
    runStatus?: string | null;
    verifiedWallets?: {
      conviction?: { kol: Conviction; smart: Conviction };
      holding?: { kol: number; smart: number };
      tokenStat?: {
        top10HolderRate?: number | null;
        bundlerPct?: number | null;
        botDegenRate?: number | null;
        ratPct?: number | null;
      } | null;
      kol?: VerifiedWallet[];
      smart?: VerifiedWallet[];
      socials?: { twitter?: string; telegram?: string; website?: string };
    } | null;
    socials?: { twitter?: string; telegram?: string; website?: string };
    kolSmartSource?: string | null;
  } | null;
  token?: TokenBase | null;
  postmortem: {
    headline: string;
    summary: string;
    notes: string[];
    entry: { mcUsd: number | null; intel: number | null; kol: number; smart: number; hv: number | null };
    now: {
      gainPct: number | null; athMultiple: number | null;
      survival: number | null; proScore: number | null; runStatus: string | null;
      liquidityUsd: number | null; holders: number | null;
    };
    milestones: Array<{ tier: number; hit: boolean }>;
    socials: { twitter?: string; telegram?: string; website?: string };
  } | null;
  snapshots: Array<{
    snapshotAt: string;
    gainPct: number | null;
    kolCount: number;
    smartCount: number;
  }>;
}

function CopyBtn({ text }: { text: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setOk(true);
        setTimeout(() => setOk(false), 1200);
      }}
      className="text-[var(--cryp-mute)] hover:text-[var(--cryp-text)]"
    >
      {ok ? <CheckCheck className="w-3.5 h-3.5 text-[var(--cryp-gain)]" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
}

function fmtPct(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${Math.round(n * 100)}%`;
}

function fmtMc(v: number | null | undefined) {
  if (v == null) return "—";
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

function WalletRow({ w, kind }: { w: VerifiedWallet; kind: "kol" | "smart" }) {
  const supply = (w.amountPercentage ?? 0) * 100;
  return (
    <div
      className="flex items-center gap-3 px-3 py-2.5"
      style={{ borderBottom: "1px solid var(--cryp-line)" }}
    >
      <div
        className="w-1.5 h-8 shrink-0"
        style={{ background: w.holding ? "var(--cryp-teal)" : "var(--cryp-loss)" }}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono-num text-[12px] font-medium">
            {w.twitterUsername ? `@${w.twitterUsername}` : truncateAddress(w.address)}
          </span>
          <span className="text-[9px] uppercase tracking-wider text-[var(--cryp-mute)]">{kind}</span>
          {w.diamondHands && (
            <span className="inline-flex items-center gap-0.5 text-[9px] px-1" style={{ color: "var(--cryp-mint)", background: "rgba(61,154,139,0.12)" }}>
              <Diamond className="w-2.5 h-2.5" /> diamond
            </span>
          )}
          {w.paperHands && (
            <span className="inline-flex items-center gap-0.5 text-[9px] px-1" style={{ color: "var(--cryp-loss)", background: "rgba(232,93,93,0.1)" }}>
              <Hand className="w-2.5 h-2.5" /> paper
            </span>
          )}
          {!w.holding && (
            <span className="text-[9px] uppercase tracking-wider" style={{ color: "var(--cryp-loss)" }}>sold</span>
          )}
        </div>
        <div className="text-[10px] text-[var(--cryp-mute)] mt-0.5 font-mono-num">
          {w.holding ? `${supply.toFixed(2)}% supply` : "0%"}
          {w.usdValue != null && w.holding ? ` · $${w.usdValue.toFixed(0)}` : ""}
          {w.sellAmountPercentage != null && w.sellAmountPercentage > 0
            ? ` · sold ${(w.sellAmountPercentage * 100).toFixed(0)}% of bag`
            : ""}
          {w.realizedProfit != null ? ` · PnL $${w.realizedProfit.toFixed(0)}` : ""}
        </div>
      </div>
      <a
        href={`https://gmgn.ai/sol/address/${w.address}`}
        target="_blank"
        rel="noreferrer"
        className="text-[var(--cryp-mute)] hover:text-[var(--cryp-mint)]"
      >
        <ExternalLink className="w-3.5 h-3.5" />
      </a>
    </div>
  );
}

export default function TokenDetailPage() {
  const [, params] = useRoute("/tokens/:id");
  const [, setLocation] = useLocation();
  const id = params?.id ? parseInt(params.id, 10) : null;
  const BASE = getApiBase();
  const [imgBroken, setImgBroken] = useState(false);

  const {
    data: token,
    isLoading: tokenLoading,
    isError: tokenError,
  } = useQuery<TokenBase>({
    queryKey: ["token", id],
    queryFn: async () => {
      const r = await fetch(`${BASE}api/tokens/${id}`);
      if (!r.ok) throw new Error(`${r.status}`);
      return r.json();
    },
    enabled: id != null && Number.isFinite(id),
    retry: 1,
  });

  const {
    data: pack,
    isLoading: packLoading,
    isError: packError,
  } = useQuery<ProPack>({
    queryKey: ["pro-token", id],
    queryFn: async () => {
      const r = await fetch(`${BASE}api/pro/token/${id}`);
      if (!r.ok) throw new Error(`${r.status}`);
      return r.json();
    },
    enabled: id != null && Number.isFinite(id),
    refetchInterval: 20_000,
    retry: 1,
  });

  const pc = pack?.proCall ?? null;
  const pm = pack?.postmortem ?? null;
  const vw = pc?.verifiedWallets ?? null;
  const kolW = (vw?.kol ?? []) as VerifiedWallet[];
  const smartW = (vw?.smart ?? []) as VerifiedWallet[];
  const kolC = vw?.conviction?.kol;
  const smartC = vw?.conviction?.smart;
  const socials = {
    ...(vw?.socials ?? {}),
    ...(pc?.socials ?? {}),
    ...(pm?.socials ?? {}),
  };
  const snaps = (pack?.snapshots ?? [])
    .filter(s => s.gainPct != null)
    .map(s => ({
      ts: new Date(s.snapshotAt).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" }),
      gain: Math.round(s.gainPct!),
    }));

  const ath = pc?.athMultiple ?? pm?.now.athMultiple ?? 1;
  const gain = pm?.now.gainPct ?? null;

  // Prefer /tokens/:id; fall back to any token stub on the pro pack
  const display: TokenBase | null = token ?? (pack?.token as TokenBase | null) ?? (
    pc
      ? {
          id: id!,
          address: "",
          chain: "solana",
          name: null,
          symbol: null,
          logoUri: null,
          marketCapUsd: pc.currentMcUsd != null ? String(pc.currentMcUsd) : null,
          liquidityUsd: null,
          holderCount: 0,
          status: "active",
        }
      : null
  );

  if (id == null || !Number.isFinite(id)) {
    return (
      <div className="px-4 md:px-8 pt-8 text-sm text-[var(--cryp-mute)]">
        Invalid token id.{" "}
        <button type="button" className="underline" onClick={() => setLocation("/")}>Back to desk</button>
      </div>
    );
  }

  if ((tokenLoading || packLoading) && !display && !pc) {
    return (
      <div className="px-4 md:px-8 pt-8 text-[var(--cryp-mute)] text-sm">
        Loading…
      </div>
    );
  }

  if ((tokenError && packError) || (!display && !pc && !tokenLoading && !packLoading)) {
    return (
      <div className="px-4 md:px-8 pt-8 space-y-3">
        <button
          type="button"
          onClick={() => setLocation("/")}
          className="inline-flex items-center gap-1.5 text-[12px] text-[var(--cryp-mute)] hover:text-[var(--cryp-text)]"
        >
          <ArrowLeft className="w-3.5 h-3.5" /> Back to desk
        </button>
        <div className="desk-card p-6 text-sm text-[var(--cryp-mute)]">
          Couldn’t load this token. It may have been removed, or the API is unreachable.
        </div>
      </div>
    );
  }

  const symbol = safeSymbol(display?.symbol ?? null, display?.address ?? "");
  const address = display?.address || "";
  const chain = display?.chain || "solana";
  const imgSrc = safeImageUrl(display?.logoUri ?? null, address, display?.symbol ?? null);
  const smartTotal = smartC?.total ?? pc?.calledSmartCount ?? 0;
  const kolTotal = kolC?.total ?? pc?.calledKolCount ?? 0;
  const smartHolding = smartC?.holding ?? vw?.holding?.smart ?? pc?.calledSmartCount ?? 0;
  const kolHolding = kolC?.holding ?? vw?.holding?.kol ?? pc?.calledKolCount ?? 0;

  return (
    <div className="px-4 md:px-8 pt-4 md:pt-6 pb-8 space-y-5 max-w-5xl">
      <button
        type="button"
        onClick={() => setLocation("/")}
        className="inline-flex items-center gap-1.5 text-[12px] text-[var(--cryp-mute)] hover:text-[var(--cryp-text)]"
      >
        <ArrowLeft className="w-3.5 h-3.5" /> Back to desk
      </button>

      <header className="desk-card p-5 fade-up">
        <div className="flex items-start gap-4">
          {!imgBroken && address ? (
            <img
              src={imgSrc}
              alt=""
              className="w-14 h-14 object-cover"
              style={{ borderRadius: 4 }}
              onError={() => setImgBroken(true)}
            />
          ) : (
            <div
              className="w-14 h-14 flex items-center justify-center font-display font-bold"
              style={{ background: "rgba(61,154,139,0.15)", color: "var(--cryp-mint)", borderRadius: 4 }}
            >
              {(symbol || "?").slice(0, 2)}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="font-display text-2xl font-extrabold">{symbol || "—"}</h1>
              {pc?.qualityLabel === "very_good" && (
                <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5"
                  style={{ color: "var(--cryp-mint)", background: "rgba(61,154,139,0.15)" }}>Elite</span>
              )}
              {pc?.runStatus && (
                <span className="text-[11px] text-[var(--cryp-mute)]">{pc.runStatus}</span>
              )}
            </div>
            {address && (
              <div className="flex items-center gap-2 mt-1.5 text-[12px] text-[var(--cryp-mute)]">
                <span className="font-mono-num">{truncateAddress(address)}</span>
                <CopyBtn text={address} />
                <a href={getGmgnUrl(chain, address)} target="_blank" rel="noreferrer"
                  className="hover:text-[var(--cryp-mint)]"><ExternalLink className="w-3.5 h-3.5" /></a>
                {socials.twitter && <a href={socials.twitter} target="_blank" rel="noreferrer"><Twitter className="w-3.5 h-3.5" /></a>}
                {socials.telegram && <a href={socials.telegram} target="_blank" rel="noreferrer"><Send className="w-3.5 h-3.5" /></a>}
                {socials.website && <a href={socials.website} target="_blank" rel="noreferrer"><Globe className="w-3.5 h-3.5" /></a>}
              </div>
            )}
            {pc?.calledAt && (
              <div className="text-[11px] text-[var(--cryp-mute)] mt-2">
                Called {formatTimeAgo(pc.calledAt)} · entry {fmtMc(pc.calledMcUsd)} · now {formatMarketCap(display?.marketCapUsd ?? null)}
                <span className="ml-2 opacity-80">· conviction as of verify</span>
              </div>
            )}
          </div>
          <div className="text-right shrink-0">
            <div className="font-mono-num text-3xl font-bold" style={{ color: ath >= 2 ? "var(--cryp-gain)" : "var(--cryp-text)" }}>
              {ath >= 1.05 ? `${Number(ath).toFixed(1)}×` : "—"}
            </div>
            <div className="font-mono-num text-sm mt-1" style={{ color: (gain ?? 0) >= 0 ? "var(--cryp-gain)" : "var(--cryp-loss)" }}>
              {gain != null ? `${gain >= 0 ? "+" : ""}${gain.toFixed(0)}%` : "—"}
            </div>
          </div>
        </div>
      </header>

      {!pc && (
        <div className="desk-card p-6 text-sm text-[var(--cryp-mute)]">
          Not a Pro call yet — waiting for live GMGN smart conviction.
        </div>
      )}

      {pc && (
        <>
          <section className="grid grid-cols-2 md:grid-cols-4 gap-3 fade-up fade-up-delay-1">
            {[
              { l: "Pro score", v: pc.proScore != null ? Math.round(pc.proScore) : "—", c: "var(--cryp-mint)" },
              { l: "Survival", v: pc.survivalScore != null ? Math.round(pc.survivalScore) : "—", c: undefined },
              {
                l: "Smart holding",
                v: `${smartHolding}/${smartTotal || "—"}`,
                c: "var(--cryp-teal)",
              },
              {
                l: "KOL holding",
                v: `${kolHolding}/${kolTotal || "—"}`,
                c: undefined,
              },
            ].map(s => (
              <div key={s.l} className="desk-card px-4 py-3">
                <div className="text-[9px] tracking-[0.16em] uppercase text-[var(--cryp-mute)]">{s.l}</div>
                <div className="font-mono-num text-xl font-bold mt-1" style={{ color: s.c }}>{s.v}</div>
              </div>
            ))}
          </section>

          <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="desk-card px-4 py-3">
              <div className="text-[9px] tracking-wider uppercase text-[var(--cryp-mute)] flex items-center gap-1">
                <Diamond className="w-3 h-3" /> Diamond
              </div>
              <div className="font-mono-num text-lg font-bold mt-1" style={{ color: "var(--cryp-mint)" }}>
                {(smartC?.diamondHands ?? 0) + (kolC?.diamondHands ?? 0)}
              </div>
            </div>
            <div className="desk-card px-4 py-3">
              <div className="text-[9px] tracking-wider uppercase text-[var(--cryp-mute)] flex items-center gap-1">
                <Hand className="w-3 h-3" /> Paper
              </div>
              <div className="font-mono-num text-lg font-bold mt-1" style={{ color: "var(--cryp-loss)" }}>
                {(smartC?.paperHands ?? 0) + (kolC?.paperHands ?? 0)}
              </div>
            </div>
            <div className="desk-card px-4 py-3">
              <div className="text-[9px] tracking-wider uppercase text-[var(--cryp-mute)]">Smart hold rate</div>
              <div className="font-mono-num text-lg font-bold mt-1">{fmtPct(smartC?.holdRate)}</div>
            </div>
            <div className="desk-card px-4 py-3">
              <div className="text-[9px] tracking-wider uppercase text-[var(--cryp-mute)]">Supply still held</div>
              <div className="font-mono-num text-lg font-bold mt-1">
                {((smartC?.supplyPctHeld ?? 0) + (kolC?.supplyPctHeld ?? 0)).toFixed(2)}%
              </div>
            </div>
          </section>

          {vw?.tokenStat && (
            <section className="desk-card p-4 grid grid-cols-2 md:grid-cols-4 gap-3 text-[12px]">
              <div>
                <div className="text-[9px] uppercase tracking-wider text-[var(--cryp-mute)]">Top 10</div>
                <div className="font-mono-num font-semibold mt-0.5 flex items-center gap-1">
                  <Shield className="w-3 h-3" />
                  {vw.tokenStat.top10HolderRate != null
                    ? `${(Number(vw.tokenStat.top10HolderRate) * 100).toFixed(0)}%`
                    : "—"}
                </div>
              </div>
              <div>
                <div className="text-[9px] uppercase tracking-wider text-[var(--cryp-mute)]">Bundler</div>
                <div className="font-mono-num font-semibold mt-0.5">
                  {vw.tokenStat.bundlerPct != null
                    ? `${(Number(vw.tokenStat.bundlerPct) * 100).toFixed(0)}%`
                    : "—"}
                </div>
              </div>
              <div>
                <div className="text-[9px] uppercase tracking-wider text-[var(--cryp-mute)]">Bot degen</div>
                <div className="font-mono-num font-semibold mt-0.5">
                  {vw.tokenStat.botDegenRate != null
                    ? `${(Number(vw.tokenStat.botDegenRate) * 100).toFixed(0)}%`
                    : "—"}
                </div>
              </div>
              <div>
                <div className="text-[9px] uppercase tracking-wider text-[var(--cryp-mute)]">Rat</div>
                <div className="font-mono-num font-semibold mt-0.5">
                  {vw.tokenStat.ratPct != null
                    ? `${(Number(vw.tokenStat.ratPct) * 100).toFixed(1)}%`
                    : "—"}
                </div>
              </div>
            </section>
          )}

          {pm && (
            <section className="desk-card p-4 space-y-2">
              <div className="font-display font-bold text-[15px]">{pm.headline}</div>
              <div className="text-sm text-[var(--cryp-mute)] leading-relaxed">{pm.summary}</div>
              {pm.notes.length > 0 && (
                <ul className="text-[12px] text-[var(--cryp-mute)] space-y-1 list-disc pl-4 pt-1">
                  {pm.notes.slice(0, 4).map((n, i) => <li key={i}>{n}</li>)}
                </ul>
              )}
            </section>
          )}

          {snaps.length > 1 && (
            <section className="desk-card p-4">
              <div className="text-[10px] tracking-[0.16em] uppercase text-[var(--cryp-mute)] mb-3">Gain from entry</div>
              <div className="h-40">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={snaps}>
                    <CartesianGrid stroke="rgba(125,180,170,0.08)" strokeDasharray="3 3" />
                    <XAxis dataKey="ts" tick={{ fill: "#7a8f99", fontSize: 9 }} />
                    <YAxis tick={{ fill: "#7a8f99", fontSize: 9 }} />
                    <Tooltip
                      contentStyle={{ background: "#0b141c", border: "1px solid rgba(125,180,170,0.2)", fontSize: 11 }}
                    />
                    <ReferenceLine y={0} stroke="rgba(125,180,170,0.2)" />
                    <Area type="monotone" dataKey="gain" stroke="#3d9a8b" fill="rgba(61,154,139,0.15)" name="Gain %" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </section>
          )}

          <section className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <div className="desk-card overflow-hidden">
              <div className="px-4 py-3 flex items-center justify-between" style={{ borderBottom: "1px solid var(--cryp-line)" }}>
                <div>
                  <div className="font-display font-bold text-sm">Smart money</div>
                  <div className="text-[10px] text-[var(--cryp-mute)] mt-0.5">
                    {smartC
                      ? `${smartC.holding}/${smartC.total} holding · ${smartC.sold} sold · ${fmtPct(smartC.holdRate)} · as of verify`
                      : `${smartW.length} wallets`}
                  </div>
                </div>
              </div>
              <div className="max-h-80 overflow-y-auto">
                {smartW.length === 0 && (
                  <div className="p-4 text-sm text-[var(--cryp-mute)]">No smart wallets frozen yet</div>
                )}
                {smartW.map(w => <WalletRow key={w.address} w={w} kind="smart" />)}
              </div>
            </div>

            <div className="desk-card overflow-hidden">
              <div className="px-4 py-3 flex items-center justify-between" style={{ borderBottom: "1px solid var(--cryp-line)" }}>
                <div>
                  <div className="font-display font-bold text-sm">KOL</div>
                  <div className="text-[10px] text-[var(--cryp-mute)] mt-0.5">
                    {kolC
                      ? `${kolC.holding}/${kolC.total} holding · ${kolC.sold} sold · ${fmtPct(kolC.holdRate)} · as of verify`
                      : `${kolW.length} wallets`}
                  </div>
                </div>
              </div>
              <div className="max-h-80 overflow-y-auto">
                {kolW.length === 0 && (
                  <div className="p-4 text-sm text-[var(--cryp-mute)]">No KOL wallets frozen yet</div>
                )}
                {kolW.map(w => <WalletRow key={w.address} w={w} kind="kol" />)}
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
