/**
 * Dex Autopilot desk — fully automated paper agent.
 * No discretionary clicks. Pattern memory · 3× bank · moon bag trail.
 */
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Moon, Power, Radio } from "lucide-react";
import {
  DEX_EVENTS_KEY,
  DEX_PATTERNS_KEY,
  DEX_POSITIONS_KEY,
  DEX_STATUS_KEY,
  fetchDexEvents,
  fetchDexPatterns,
  fetchDexPositions,
  fetchDexStatus,
  setDexEnabled,
  type DexEvent,
  type DexPosition,
} from "@/lib/trader-api";
import { cn, formatCompactUsd, truncateAddress } from "@/lib/utils";

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

function PositionCard({ p, onOpen }: { p: DexPosition; onOpen: () => void }) {
  const open = p.status === "open" || p.status === "moon";
  return (
    <article
      className="desk-card p-4 cursor-pointer transition-transform duration-200 hover:-translate-y-0.5 fade-up"
      onClick={onOpen}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <h3 className="font-display text-[14px] font-bold">{p.symbol ?? "?"}</h3>
        <span
          className="text-[9px] font-bold tracking-wider uppercase px-1.5 py-0.5"
          style={{
            color: p.status === "moon" ? "var(--cryp-ink)" : open ? "var(--cryp-mint)" : "var(--cryp-mute)",
            background: p.status === "moon"
              ? "var(--cryp-warn)"
              : open ? "rgba(61,154,139,0.16)" : "rgba(122,143,153,0.14)",
          }}
        >
          {p.status === "moon" ? "🌙 Moon bag" : p.status}
        </span>
        {p.moonBagTaken && p.status !== "moon" && (
          <span className="text-[9px] font-bold text-[var(--cryp-gain)]">3× banked</span>
        )}
      </div>
      <div className="grid grid-cols-4 gap-2 mt-2.5">
        <div>
          <div className="text-[9px] uppercase tracking-wider text-[var(--cryp-mute)]">Mult</div>
          <div
            className="font-mono-num text-[12px] font-bold"
            style={{ color: p.multiple >= 3 ? "var(--cryp-gain)" : p.multiple < 1 ? "var(--cryp-loss)" : "var(--cryp-text)" }}
          >
            {p.multiple.toFixed(2)}×
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-wider text-[var(--cryp-mute)]">Entry</div>
          <div className="font-mono-num text-[12px]">{formatCompactUsd(p.entryMcUsd)}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-wider text-[var(--cryp-mute)]">Live</div>
          <div className="font-mono-num text-[12px]">{formatCompactUsd(p.liveMcUsd)}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-wider text-[var(--cryp-mute)]">Stake</div>
          <div className="font-mono-num text-[12px]">${Math.round(p.remainingStakeUsd || p.stakeUsd)}</div>
        </div>
      </div>
      <div className="mt-2 text-[11px] text-[var(--cryp-mute)] truncate">
        {p.entryPhase ?? "—"} · score {p.entryScore ?? "—"} · vel {p.entryVelocity?.toFixed(2) ?? "—"}× · snaps {p.entrySnapCount ?? "—"}/5
        {p.exitReason ? ` · exit ${p.exitReason}` : ""}
      </div>
      {p.patternKey && (
        <div className="mt-1 text-[10px] font-mono-num text-[var(--cryp-mute)] truncate" title={p.patternKey}>
          pattern {p.patternKey}
        </div>
      )}
    </article>
  );
}

function EventRow({ e }: { e: DexEvent }) {
  return (
    <li className="dex-news-row text-[12px] leading-snug">
      <span className="text-[10px] text-[var(--cryp-mute)] mr-2 font-mono-num">
        {e.at ? new Date(e.at).toLocaleTimeString() : ""}
      </span>
      <span style={{ color: e.level === "warn" ? "var(--cryp-warn)" : "var(--cryp-text)" }}>
        {e.msg}
      </span>
    </li>
  );
}

export default function TraderPage() {
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const [tab, setTab] = useState<"live" | "closed" | "patterns" | "log">("live");

  const { data: status } = useQuery({
    queryKey: DEX_STATUS_KEY,
    queryFn: fetchDexStatus,
    refetchInterval: 8_000,
    placeholderData: keepPreviousData,
  });
  const { data: posData } = useQuery({
    queryKey: DEX_POSITIONS_KEY,
    queryFn: fetchDexPositions,
    refetchInterval: 8_000,
    placeholderData: keepPreviousData,
  });
  const { data: evData } = useQuery({
    queryKey: DEX_EVENTS_KEY,
    queryFn: () => fetchDexEvents(50),
    refetchInterval: 6_000,
    placeholderData: keepPreviousData,
  });
  const { data: patData } = useQuery({
    queryKey: DEX_PATTERNS_KEY,
    queryFn: fetchDexPatterns,
    refetchInterval: 20_000,
    placeholderData: keepPreviousData,
  });

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => setDexEnabled(enabled),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: DEX_STATUS_KEY });
      void qc.invalidateQueries({ queryKey: DEX_EVENTS_KEY });
    },
  });

  const positions = posData?.positions ?? [];
  const live = useMemo(() => positions.filter(p => p.status === "open" || p.status === "moon"), [positions]);
  const closed = useMemo(() => positions.filter(p => p.status === "closed"), [positions]);
  const events = evData?.events ?? [];
  const patterns = patData?.patterns ?? [];
  const enabled = status?.enabled ?? true;

  return (
    <div className="px-4 md:px-6 lg:px-8 py-5 md:py-8 space-y-5 md:space-y-6">
      <header className="fade-up">
        <div className="font-display text-[11px] font-bold tracking-[0.22em] uppercase text-[var(--cryp-teal)]">
          Dex Autopilot
        </div>
        <h1 className="font-display text-3xl md:text-4xl font-extrabold tracking-tight mt-1">
          No emotions. On-chain only.
        </h1>
        <p className="text-[var(--cryp-mute)] text-[13px] md:text-[14px] mt-2 max-w-2xl">
          Automated paper agent: observes ≥5 snaps, reverse-engineers patterns, enters on confirmed velocity,
          banks <span className="text-[var(--cryp-mint)]">70% at 3×</span>, trails a{" "}
          <span className="text-[var(--cryp-warn)]">30% moon bag</span>. You watch the machine.
        </p>
      </header>

      <div className="desk-card p-4 md:p-5 fade-up flex flex-wrap items-center gap-3 justify-between">
        <div className="flex items-center gap-3">
          <div
            className="w-12 h-12 flex items-center justify-center"
            style={{
              background: enabled ? "rgba(61,154,139,0.16)" : "rgba(122,143,153,0.12)",
              border: `1px solid ${enabled ? "var(--cryp-teal)" : "var(--cryp-line)"}`,
            }}
          >
            <Bot className="w-6 h-6" style={{ color: enabled ? "var(--cryp-mint)" : "var(--cryp-mute)" }} />
          </div>
          <div>
            <div className="font-display text-[13px] font-bold tracking-wide uppercase flex items-center gap-2">
              {enabled ? "Autopilot ON" : "Autopilot OFF"}
              <span className={cn("w-1.5 h-1.5 rounded-full", enabled ? "bg-[var(--cryp-gain)] pulse-dot" : "bg-[var(--cryp-mute)]")} />
            </div>
            <div className="text-[11px] text-[var(--cryp-mute)] mt-0.5">
              {status?.rules?.takeProfit ?? "70% @ 3×"} · {status?.rules?.moonBag ?? "30% trailed"} ·{" "}
              {status?.rules?.observationSnaps ?? 5} snaps · max {status?.rules?.maxOpen ?? 3} open
            </div>
          </div>
        </div>
        <button
          type="button"
          disabled={toggle.isPending}
          onClick={() => toggle.mutate(!enabled)}
          className="inline-flex items-center gap-2 text-[10px] font-bold tracking-widest uppercase px-3 py-2"
          style={{
            background: enabled ? "rgba(232,93,93,0.12)" : "var(--cryp-teal)",
            color: enabled ? "var(--cryp-loss)" : "var(--cryp-ink)",
          }}
        >
          <Power className="w-3.5 h-3.5" />
          {enabled ? "Pause agent" : "Start agent"}
        </button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatTile
          label="Equity"
          value={`$${Math.round(status?.equityUsd ?? 1000).toLocaleString()}`}
          hint="Cash + open marks"
          accent="var(--cryp-mint)"
        />
        <StatTile
          label="Bankroll"
          value={`$${Math.round(status?.bankrollUsd ?? 1000).toLocaleString()}`}
          hint={`Open mark $${Math.round(status?.openMarkUsd ?? 0)}`}
        />
        <StatTile
          label="Realized"
          value={`${(status?.realizedPnlUsd ?? 0) >= 0 ? "+" : ""}$${Math.round(status?.realizedPnlUsd ?? 0)}`}
          accent={(status?.realizedPnlUsd ?? 0) >= 0 ? "var(--cryp-gain)" : "var(--cryp-loss)"}
          hint={`${status?.tradesClosed ?? 0} closed`}
        />
        <StatTile
          label="3× Hits"
          value={String(status?.hits3x ?? 0)}
          hint={`${status?.openCount ?? 0} live · ${status?.tradesOpened ?? 0} opened`}
          accent="var(--cryp-gain)"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        <div className="lg:col-span-3 space-y-3">
          <div className="flex gap-2 flex-wrap">
            {([
              ["live", `Live (${live.length})`],
              ["closed", `Closed (${closed.length})`],
              ["patterns", `Patterns (${patterns.length})`],
              ["log", "Agent log"],
            ] as const).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className="text-[10px] font-bold tracking-[0.16em] uppercase px-3 py-2"
                style={{
                  background: tab === id ? "var(--cryp-teal)" : "transparent",
                  color: tab === id ? "var(--cryp-ink)" : "var(--cryp-mute)",
                  border: tab === id ? "1px solid var(--cryp-teal)" : "1px solid var(--cryp-line)",
                }}
              >
                {label}
              </button>
            ))}
          </div>

          {tab === "live" && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {live.length === 0 && (
                <div className="desk-card p-6 text-[var(--cryp-mute)] text-sm md:col-span-2">
                  <Radio className="w-4 h-4 inline mr-2" />
                  Agent scanning — waiting for observation-ready Heating/ENTRY with pattern edge.
                </div>
              )}
              {live.map(p => (
                <PositionCard key={p.id} p={p} onOpen={() => setLocation(`/tokens/${p.tokenId}`)} />
              ))}
            </div>
          )}

          {tab === "closed" && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {closed.length === 0 && (
                <div className="desk-card p-6 text-[var(--cryp-mute)] text-sm">No closed trades yet.</div>
              )}
              {closed.map(p => (
                <PositionCard key={p.id} p={p} onOpen={() => setLocation(`/tokens/${p.tokenId}`)} />
              ))}
            </div>
          )}

          {tab === "patterns" && (
            <div className="desk-card overflow-hidden">
              <div className="px-4 py-3 text-[10px] tracking-[0.18em] uppercase text-[var(--cryp-mute)]" style={{ borderBottom: "1px solid var(--cryp-line)" }}>
                Reverse-engineered fingerprints · win-rate gates future size
              </div>
              {patterns.length === 0 && (
                <div className="p-6 text-[var(--cryp-mute)] text-sm">Patterns fill as the agent closes trades.</div>
              )}
              <ul className="divide-y divide-[var(--cryp-line)]">
                {patterns.map(pat => (
                  <li key={pat.key} className="px-4 py-3 flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-mono-num text-[11px] text-[var(--cryp-text)] truncate">{pat.key}</div>
                      <div className="text-[10px] text-[var(--cryp-mute)] mt-0.5">
                        n={pat.samples} · best {pat.bestMultiple.toFixed(1)}×
                      </div>
                    </div>
                    <div className="text-right">
                      <div
                        className="font-mono-num text-[14px] font-bold"
                        style={{ color: pat.winRate >= 40 ? "var(--cryp-gain)" : pat.winRate < 25 ? "var(--cryp-loss)" : "var(--cryp-warn)" }}
                      >
                        {pat.winRate}% 3×
                      </div>
                      <div className="text-[10px] text-[var(--cryp-mute)]">avg exit {pat.avgExit.toFixed(2)}×</div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {tab === "log" && (
            <div className="desk-card p-4">
              <div className="font-display text-[10px] font-bold tracking-[0.2em] uppercase text-[var(--cryp-teal)] mb-2">
                🤖 Agent activity
              </div>
              <ul className="dex-news max-h-[420px] overflow-y-auto no-scrollbar space-y-1">
                {events.length === 0 && (
                  <li className="text-[var(--cryp-mute)] text-sm py-4">Waiting for first agent tick…</li>
                )}
                {events.map(e => <EventRow key={e.id} e={e} />)}
              </ul>
            </div>
          )}
        </div>

        <aside className="lg:col-span-2 space-y-3">
          <div className="desk-card p-4 fade-up">
            <div className="font-display text-[10px] font-bold tracking-[0.2em] uppercase text-[var(--cryp-teal)] mb-2 flex items-center gap-2">
              <Moon className="w-3.5 h-3.5" /> Playbook
            </div>
            <ul className="space-y-2 text-[12px] text-[var(--cryp-mute)] leading-relaxed">
              <li>📡 Watch tape until <span className="text-[var(--cryp-text)]">5 snaps</span></li>
              <li>🔥 Enter on ENTRY / strong heating + tagged + velocity</li>
              <li>🧬 Skip dead patterns (&lt;20% 3× after 6 samples)</li>
              <li>💰 Sell <span className="text-[var(--cryp-gain)]">70% at 3×</span></li>
              <li>🌙 Trail <span className="text-[var(--cryp-warn)]">30% moon bag</span> (−32% from peak or fade)</li>
              <li>🛑 Hard stop at 0.65× or dead phase</li>
              <li>⛓️ Marks = live on-chain MC · paper bankroll</li>
            </ul>
          </div>

          <div className="desk-card p-4 fade-up">
            <div className="font-display text-[10px] font-bold tracking-[0.2em] uppercase text-[var(--cryp-teal)] mb-2">
              📰 Latest ticks
            </div>
            <ul className="dex-news max-h-[280px] overflow-y-auto no-scrollbar space-y-1">
              {events.slice(0, 12).map(e => <EventRow key={`side-${e.id}`} e={e} />)}
              {events.length === 0 && (
                <li className="text-[12px] text-[var(--cryp-mute)]">Agent arms ~35s after API boot…</li>
              )}
            </ul>
          </div>

          {live[0] && (
            <div className="desk-card p-4 text-[11px] text-[var(--cryp-mute)]">
              Focus · <span className="text-[var(--cryp-text)] font-bold">{live[0].symbol}</span>{" "}
              {live[0].multiple.toFixed(2)}× · {truncateAddress(live[0].address)}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
