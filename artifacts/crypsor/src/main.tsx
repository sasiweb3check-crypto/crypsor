import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowUpRight,
  ArrowDownRight,
  ArrowRight,
  Layers3,
  LayoutDashboard,
  Wallet,
  Activity,
  Plus,
  Search,
  RefreshCw,
  X,
  ExternalLink,
  Trash2,
  LockKeyhole,
  Radio,
  ChevronDown,
  Copy,
  Check,
  TrendingUp,
  Menu,
  CircleHelp,
} from "lucide-react";
import "./style.css";

type SourceWallet = {
  address: string;
  label: string;
  buys: number;
  tokens: number;
  synced_at: string | null;
  sync_error: string | null;
  catching_up?: boolean;
  avg_gain?: number | null;
  positive_rate?: number | null;
};
type Token = {
  mint: string;
  symbol: string | null;
  name: string | null;
  image: string | null;
  entry_price: number | null;
  entry_source: string | null;
  current_price: number | null;
  entry_at: string;
  detected_at: string;
  priced_at: string | null;
  gain: number | null;
  peak_gain: number | null;
  buys: number;
  wallet_count?: number;
  priceStale?: boolean;
  metadata_at?: string | null;
  wallets: { address: string; label: string }[];
  history: number[];
};
type Data = {
  wallets: SourceWallet[];
  tokens: Token[];
  summary: {
    wallets: number;
    tokens: number;
    priced: number;
    positive: number;
    averageGain: number | null;
  };
  leaders: Token[];
  page: { nextCursor: string | null; hasMore: boolean };
  tracking: {
    heliusConfigured: boolean;
    running: boolean;
    lastSync: string | null;
    error: string | null;
    intervalSeconds: number;
    backend: string;
    queued: number;
    failed: number;
    workers: number;
    workersHealthy: boolean;
    oldestJobSeconds: number;
  };
};
const short = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`;
const price = (n: number | null) =>
  n == null
    ? "—"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumSignificantDigits: 5,
      }).format(n);
const gain = (n: number | null) =>
  n == null ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
function since(s: string | null) {
  if (!s) return "Not synced yet";
  const mins = Math.max(
    0,
    Math.floor((Date.now() - new Date(s).getTime()) / 60000),
  );
  return mins < 1
    ? "Just now"
    : mins < 60
      ? `${mins}m ago`
      : `${Math.floor(mins / 60)}h ago`;
}
async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const r = await fetch(`/api/${path}`, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      "The service returned an unexpected response. Please try again.",
    );
  }
  if (!r.ok) throw new Error(data.error ?? "Request failed");
  return data;
}
function Sparkline({
  values,
  positive,
}: {
  values: number[];
  positive: boolean;
}) {
  if (values.length < 2)
    return <span className="spark-pending">Awaiting prices</span>;
  const min = Math.min(...values),
    max = Math.max(...values),
    range = max - min || 1;
  const points = values
    .map(
      (v, i) =>
        `${(i / (values.length - 1)) * 100},${31 - ((v - min) / range) * 26}`,
    )
    .join(" ");
  return (
    <svg
      className={`spark ${positive ? "positive" : "negative"}`}
      viewBox="0 0 100 36"
      aria-label="Recent observed price trend"
      role="img"
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
function Brand() {
  return (
    <span className="brand">
      <span className="brand-mark">
        <Layers3 size={22} />
      </span>
      crypsor<span className="brand-dot">.</span>
    </span>
  );
}
function App() {
  const [page, setPage] = useState<"overview" | "tokens" | "wallets">(
    "overview",
  );
  const [data, setData] = useState<Data | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  const [query, setQuery] = useState(""),
    [debounced, setDebounced] = useState(""),
    [filter, setFilter] = useState("all"),
    [cursors, setCursors] = useState<(string | undefined)[]>([undefined]),
    [detail, setDetail] = useState<any | null>(null),
    [detailBusy, setDetailBusy] = useState(false),
    [modal, setModal] = useState<"wallet" | null>(null);
  const [busy, setBusy] = useState(false),
    [formError, setFormError] = useState("");
  const [notice, setNotice] = useState(""),
    [removing, setRemoving] = useState<SourceWallet | null>(null),
    [copied, setCopied] = useState("");
  const [menu, setMenu] = useState(false),
    [refreshing, setRefreshing] = useState(false);
  const modalRef = useRef<HTMLDivElement>(null),
    returnFocus = useRef<HTMLElement | null>(null);
  const requestId = useRef(0);
  const cursor = cursors[cursors.length - 1];
  const load = useCallback(async () => {
    const id = ++requestId.current;
    try {
      const params = new URLSearchParams({
        q: debounced,
        sort:
          filter === "performers"
            ? "gain"
            : filter === "peak"
              ? "peak"
              : "recent",
        limit: "25",
      });
      if (cursor) params.set("cursor", cursor);
      const next = await api<Data>(`dashboard?${params}`);
      if (id === requestId.current) {
        setData(next);
        setError("");
      }
    } catch (e) {
      if (id === requestId.current) setError((e as Error).message);
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [debounced, filter, cursor]);
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(query);
      setCursors([undefined]);
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    setLoading(true);
    void load();
    const id = setInterval(() => {
      if (!document.hidden) void load();
    }, 15000);
    return () => {
      clearInterval(id);
      requestId.current++;
    };
  }, [load]);
  async function inspect(mint: string) {
    setDetailBusy(true);
    try {
      setDetail(await api(`tokens/${mint}`));
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setDetailBusy(false);
    }
  }
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 4000);
    return () => clearTimeout(t);
  }, [notice]);
  useEffect(() => {
    if (!modal && !removing && !detail) return;
    returnFocus.current = document.activeElement as HTMLElement;
    document.body.style.overflow = "hidden";
    const t = setTimeout(
      () =>
        modalRef.current?.querySelector<HTMLElement>("input,button")?.focus(),
      20,
    );
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        setModal(null);
        setRemoving(null);
        setDetail(null);
      }
      if (e.key === "Tab") {
        const elements = modalRef.current?.querySelectorAll<HTMLElement>(
          "button:not(:disabled),input,a[href]",
        );
        if (!elements?.length) return;
        const first = elements[0],
          last = elements[elements.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      clearTimeout(t);
      document.body.style.overflow = "";
      document.removeEventListener("keydown", key);
      returnFocus.current?.focus();
    };
  }, [modal, removing, busy, detail]);
  function openWallet() {
    setFormError("");
    setModal("wallet");
  }
  function navigate(next: typeof page) {
    setPage(next);
    setMenu(false);
    setQuery("");
    setFilter("all");
    setCursors([undefined]);
  }
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setFormError("");
    const fields = new FormData(e.currentTarget);
    try {
      await api("wallets", {
        method: "POST",
        body: JSON.stringify({
          address: fields.get("address"),
          label: fields.get("label"),
        }),
      });
      setModal(null);
      setNotice(
        "Wallet added. Its recent buys will appear after the next scan.",
      );
      await load();
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function sync() {
    setRefreshing(true);
    try {
      await api("sync", { method: "POST" });
      setNotice("Scan requested. New buys will appear as they’re detected.");
      await load();
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  }
  const wallets = data?.wallets ?? [],
    tokens = data?.tokens ?? [];
  const totals = data?.summary ?? {
    wallets: 0,
    tokens: 0,
    priced: 0,
    positive: 0,
    averageGain: null,
  };
  const avg = totals.averageGain,
    visible = tokens,
    best = data?.leaders ?? [];
  const connected = data?.tracking.heliusConfigured;
  const nav = [
    { id: "overview", title: "Overview", icon: LayoutDashboard },
    { id: "tokens", title: "Tokens", icon: Layers3 },
    { id: "wallets", title: "Wallets", icon: Wallet },
  ] as const;
  function tokenTable() {
    return (
      <section className="panel token-panel">
        <div className="panel-heading">
          <div>
            <h2>
              {page === "tokens" ? "Token feed" : "The watchlist"}{" "}
              <span className="count">{totals.tokens}</span>
            </h2>
            <p>Every detected buy. One fixed entry.</p>
          </div>
          <button
            className="icon-button"
            onClick={() => void sync()}
            aria-label="Refresh tracked buys"
            title="Request a scan"
          >
            <RefreshCw
              size={17}
              className={refreshing || data?.tracking.running ? "spin" : ""}
            />
          </button>
        </div>
        <div className="table-tools">
          <div className="tabs" aria-label="Token filters">
            {[
              ["all", "All tokens"],
              ["performers", "Performers"],
              ["peak", "Peak gain"],
            ].map(([id, label]) => (
              <button
                key={id}
                className={filter === id ? "active" : ""}
                onClick={() => {
                  setFilter(id);
                  setCursors([undefined]);
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <label className="search">
            <Search size={15} />
            <input
              aria-label="Search tokens"
              placeholder="Search token or address"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <span>/</span>
          </label>
        </div>
        {loading && !data ? (
          <div className="loading-state">
            <RefreshCw className="spin" size={20} /> Loading your watchlist…
          </div>
        ) : !visible.length ? (
          <div className="empty-state">
            <div className="empty-art">
              <Layers3 size={28} />
              <span className="empty-dot" />
            </div>
            <h3>
              {query
                ? "No matching tokens"
                : totals.tokens
                  ? "No performers yet"
                  : wallets.length
                    ? "Your first buy is on its way"
                    : "Good signals start with a wallet."}
            </h3>
            <p>
              {query
                ? "Try another symbol or mint address."
                : totals.tokens
                  ? "Tokens with positive current gains will appear here."
                  : wallets.length
                    ? "New tokens appear when a tracked wallet makes a confirmed swap. Transfers stay out of your feed."
                    : "Add a Solana wallet. We’ll follow its buys and track every token from entry to its next move."}
            </p>
            {!wallets.length && !query && (
              <button className="button primary" onClick={openWallet}>
                <Plus size={16} />
                Add your first wallet
              </button>
            )}
            {wallets.length > 0 && !totals.tokens && (
              <span className="empty-note">
                <Radio size={13} />{" "}
                {connected
                  ? "Scanning every 30 seconds"
                  : "Helius connection required"}
              </span>
            )}
          </div>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Token</th>
                  <th>Entry price</th>
                  <th>Current price</th>
                  <th>Gain</th>
                  <th>Peak gain</th>
                  <th>Price trend</th>
                  <th>Source</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {visible.map((t) => (
                  <tr key={t.mint}>
                    <td>
                      <button
                        className="token-name token-inspect"
                        onClick={() => void inspect(t.mint)}
                        disabled={detailBusy}
                      >
                        <span className="token-avatar">
                          {t.image ? (
                            <img
                              src={t.image}
                              loading="lazy"
                              alt=""
                              onError={(e) => {
                                e.currentTarget.style.display = "none";
                              }}
                            />
                          ) : null}
                          <span>{(t.symbol ?? "?").slice(0, 2)}</span>
                        </span>
                        <span>
                          <strong>{t.symbol ?? short(t.mint)}</strong>
                          <small>{t.name ?? short(t.mint)}</small>
                        </span>
                      </button>
                    </td>
                    <td>
                      <strong className="number">{price(t.entry_price)}</strong>
                      <small className="price-source">
                        {t.entry_source === "purchase"
                          ? "Wallet purchase"
                          : t.entry_source === "detection"
                            ? "At detection"
                            : "Awaiting price"}
                      </small>
                    </td>
                    <td className="number">
                      {price(t.current_price)}
                      <small className="price-source">
                        {t.priceStale
                          ? "Price stale"
                          : t.priced_at
                            ? since(t.priced_at)
                            : "Not priced yet"}
                      </small>
                    </td>
                    <td>
                      <span
                        className={`gain-pill ${t.gain == null ? "neutral" : t.gain >= 0 ? "positive" : "negative"}`}
                      >
                        {t.gain != null &&
                          (t.gain >= 0 ? (
                            <ArrowUpRight size={13} />
                          ) : (
                            <ArrowDownRight size={13} />
                          ))}
                        {gain(t.gain)}
                      </span>
                    </td>
                    <td
                      className={`number ${(t.peak_gain ?? 0) >= 0 ? "positive" : "negative"}`}
                    >
                      {gain(t.peak_gain)}
                    </td>
                    <td>
                      <Sparkline
                        values={t.history}
                        positive={(t.gain ?? 0) >= 0}
                      />
                    </td>
                    <td>
                      <span className="wallet-source">
                        {t.wallets[0]?.label ||
                          short(t.wallets[0]?.address ?? "")}
                      </span>
                      <small>
                        {t.wallet_count ?? t.wallets.length} wallet
                        {(t.wallet_count ?? t.wallets.length) === 1 ? "" : "s"}{" "}
                        · {t.buys} buy{t.buys === 1 ? "" : "s"}
                      </small>
                    </td>
                    <td>
                      <a
                        className="external"
                        aria-label={`View ${t.symbol ?? "token"} on Solscan`}
                        href={`https://solscan.io/token/${t.mint}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <ArrowUpRight size={16} />
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="pagination">
          <span>
            {visible.length} shown · Page {cursors.length}
          </span>
          <div>
            <button
              disabled={cursors.length === 1 || loading}
              onClick={() => setCursors((c) => c.slice(0, -1))}
            >
              Previous
            </button>
            <button
              disabled={!data?.page.hasMore || loading}
              onClick={() => setCursors((c) => [...c, data!.page.nextCursor!])}
            >
              Next <ArrowRight size={13} />
            </button>
          </div>
        </div>
        <div className="table-footer">
          <span>
            <span className="tiny-dot" /> {totals.tokens.toLocaleString()}{" "}
            tokens tracked
          </span>
          <span>
            Entry stays fixed. Peak tracks observed prices.{" "}
            <CircleHelp size={13} />
          </span>
        </div>
      </section>
    );
  }
  return (
    <div className="app-shell">
      {menu && (
        <button
          className="nav-backdrop"
          aria-label="Close navigation"
          onClick={() => setMenu(false)}
        />
      )}
      <aside className={`sidebar ${menu ? "open" : ""}`}>
        <a
          href="#"
          className="brand-link"
          onClick={(e) => {
            e.preventDefault();
            navigate("overview");
          }}
        >
          <Brand />
        </a>
        <div className="workspace">
          <span className="workspace-icon">C</span>
          <div>
            <strong>My workspace</strong>
            <small>Solana mainnet</small>
          </div>
          <ChevronDown size={14} />
        </div>
        <span className="nav-label">WORKSPACE</span>
        <nav>
          {nav.map((n) => (
            <button
              key={n.id}
              className={page === n.id ? "selected" : ""}
              onClick={() => navigate(n.id)}
            >
              <n.icon size={18} />
              {n.title}
              {n.id === "wallets" && (
                <span className="nav-count">{wallets.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="tracking-note">
            <span className="network-mark">
              <Radio size={18} />
            </span>
            <strong>Your wallets. Your edge.</strong>
            <p>
              Only buys enter the feed.
              <br />
              Every move starts at entry.
            </p>
            <button onClick={() => navigate("wallets")}>
              Manage sources <ArrowRight size={14} />
            </button>
          </div>
          <div className="profile">
            <span className="profile-avatar">
              <Wallet size={17} />
            </span>
            <div>
              <strong>Wallet intelligence</strong>
              <small>Built for conviction</small>
            </div>
          </div>
        </div>
      </aside>
      <div className="main-wrap">
        <header className="topbar">
          <div className="breadcrumbs">
            <button
              className="mobile-menu icon-button"
              aria-label="Open navigation"
              onClick={() => setMenu(true)}
            >
              <Menu size={20} />
            </button>
            <span className="breadcrumb-root">Workspace</span>
            <span className="divider">/</span>
            <strong>
              {page === "overview"
                ? "Overview"
                : page === "wallets"
                  ? "Wallets"
                  : "Tokens"}
            </strong>
          </div>
          <div className="topbar-right">
            <span className="network">
              <span className="solana-logo">≋</span>Solana{" "}
              <span className="tiny-dot" />
            </span>
            <span className="topbar-rule" />
            <span className="live-status">
              <span className={`status-dot ${connected ? "" : "muted"}`} />
              {connected ? "Tracking enabled" : "Not connected"}
            </span>
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                <span className="tiny-dot" /> WALLET INTELLIGENCE
              </div>
              <h1>
                {page === "wallets"
                  ? "Your source of signal."
                  : page === "tokens"
                    ? "Every buy. Every move."
                    : "Follow conviction."}
              </h1>
              <p>
                {page === "wallets"
                  ? "The wallets you follow shape the tokens you see."
                  : page === "tokens"
                    ? "A clear view of the tokens your wallets are buying."
                    : "Turn wallet buys into a clear view of what happens next."}
              </p>
            </div>
            <button className="button primary" onClick={openWallet}>
              <Plus size={17} />
              Add wallet
            </button>
          </div>
          {error && (
            <div className="alert error" role="alert">
              <Activity size={17} />
              <span>
                {error}
                {data ? " Showing the last loaded data." : ""}
              </span>
              <button onClick={() => void load()}>Retry</button>
            </div>
          )}
          {data && !connected && (
            <div className="alert">
              <Radio size={17} />
              <span>
                Connect Helius to start tracking wallet buys. Add{" "}
                <code>HELIUS_API_KEY</code> in your Render environment.
              </span>
            </div>
          )}
          {data && connected && !data.tracking.workersHealthy && (
            <div className="alert error">
              <Activity size={17} />
              <span>
                Background workers are not healthy. Your saved data is
                available; new tracking may be delayed.
              </span>
            </div>
          )}
          {data?.tracking.error && (
            <div className="alert error" role="alert">
              <Activity size={17} />
              <span>
                Tracking needs attention: {data.tracking.error}. Stored tokens
                remain visible.
              </span>
            </div>
          )}
          {page !== "wallets" && (
            <>
              <section className="metrics" aria-label="Tracking summary">
                {[
                  {
                    label: "Tracked wallets",
                    value: totals.wallets,
                    detail: "Your discovery sources",
                    icon: Wallet,
                  },
                  {
                    label: "Tokens discovered",
                    value: totals.tokens.toLocaleString(),
                    detail: "From confirmed wallet buys",
                    icon: Layers3,
                  },
                  {
                    label: "Average gain",
                    value: gain(avg),
                    detail: `Across ${totals.priced.toLocaleString()} priced tokens`,
                    icon: TrendingUp,
                  },
                  {
                    label: "Positive performers",
                    value: totals.positive.toLocaleString(),
                    detail: "Above their entry price",
                    icon: ArrowUpRight,
                  },
                ].map((m, i) => (
                  <div className="metric" key={m.label}>
                    <div className="metric-top">
                      <span>{m.label}</span>
                      <m.icon size={17} />
                    </div>
                    <strong
                      className={
                        i === 2 && avg != null
                          ? avg >= 0
                            ? "positive"
                            : "negative"
                          : ""
                      }
                    >
                      {loading && !data ? "—" : m.value}
                    </strong>
                    <small>{m.detail}</small>
                  </div>
                ))}
              </section>
              {page === "overview" && (
                <section className="highlights">
                  <div className="signal-card">
                    <div className="signal-tag">
                      <span className="status-dot" /> THE BUY SIGNAL
                    </div>
                    <h2>
                      Follow the wallet.
                      <br />
                      <span>Watch the token.</span>
                    </h2>
                    <p>
                      No scores. No guesses. Just confirmed buys
                      <br className="desktop-br" /> and performance from a fixed
                      entry.
                    </p>
                    <button onClick={() => navigate("wallets")}>
                      Explore your sources <ArrowRight size={15} />
                    </button>
                    <div className="signal-visual" aria-hidden="true">
                      <div className="orbit orbit-one" />
                      <div className="orbit orbit-two" />
                      <div className="signal-center">
                        <Wallet size={30} />
                      </div>
                      <span className="orbit-chip chip-one">
                        <ArrowUpRight size={15} />
                      </span>
                      <span className="orbit-chip chip-two">
                        <Layers3 size={18} />
                      </span>
                      <span className="orbit-chip chip-three">
                        <Activity size={16} />
                      </span>
                    </div>
                  </div>
                  <div className="performer-card">
                    <div className="performer-heading">
                      <h2>
                        <TrendingUp size={17} />
                        Leading the move
                      </h2>
                      <button
                        onClick={() => {
                          navigate("tokens");
                          setFilter("performers");
                          setCursors([undefined]);
                        }}
                        aria-label="View performers"
                      >
                        <ArrowUpRight size={18} />
                      </button>
                    </div>
                    {best.length ? (
                      best.map((t, i) => (
                        <a
                          className="leader"
                          key={t.mint}
                          href={`https://dexscreener.com/solana/${t.mint}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <span className="leader-rank">0{i + 1}</span>
                          <span className="leader-name">
                            <strong>{t.symbol ?? short(t.mint)}</strong>
                            <small>{t.name ?? "Solana token"}</small>
                          </span>
                          <strong className="positive">{gain(t.gain)}</strong>
                        </a>
                      ))
                    ) : (
                      <div className="leader-empty">
                        <span className="mini-bars">
                          <i />
                          <i />
                          <i />
                          <i />
                          <i />
                        </span>
                        <strong>The next move starts here.</strong>
                        <p>
                          Your top positive performers will rise to the surface
                          as prices update.
                        </p>
                      </div>
                    )}
                  </div>
                </section>
              )}
              {tokenTable()}
            </>
          )}
          {page === "wallets" && (
            <section className="panel wallets-panel">
              <div className="panel-heading">
                <div>
                  <h2>
                    Wallets <span className="count">{wallets.length}</span>
                  </h2>
                  <p>Solana addresses that power your token feed.</p>
                </div>
                <span className="soft-badge">
                  <span className="tiny-dot" /> Buys only
                </span>
              </div>
              {!wallets.length ? (
                <div className="empty-state">
                  <div className="empty-art">
                    <Wallet size={28} />
                  </div>
                  <h3>Your feed starts here.</h3>
                  <p>
                    Add the wallets you want to follow. We track swap purchases
                    and leave incoming transfers out.
                  </p>
                  <button className="button primary" onClick={openWallet}>
                    <Plus size={16} />
                    Add your first wallet
                  </button>
                </div>
              ) : (
                <div className="wallet-grid">
                  {wallets
                    .filter((w) =>
                      `${w.label} ${w.address}`
                        .toLowerCase()
                        .includes(query.toLowerCase()),
                    )
                    .map((w) => (
                      <article className="wallet-card" key={w.address}>
                        <div className="wallet-card-head">
                          <span className="wallet-icon">
                            <Wallet size={21} />
                          </span>
                          <span
                            className={`wallet-state ${w.sync_error ? "failed" : ""}`}
                          >
                            <span className="tiny-dot" />
                            {w.sync_error
                              ? "Needs attention"
                              : w.catching_up
                                ? "Catching up"
                                : w.synced_at
                                  ? "Synced"
                                  : "Waiting"}
                          </span>
                          <button
                            className="icon-button"
                            aria-label={`Remove ${w.label || short(w.address)}`}
                            onClick={() => {
                              setFormError("");
                              setRemoving(w);
                            }}
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                        <h3>{w.label || "Unnamed wallet"}</h3>
                        <div className="address-line">
                          <a
                            href={`https://solscan.io/account/${w.address}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {short(w.address)}
                            <ExternalLink size={12} />
                          </a>
                          <button
                            className="icon-button"
                            aria-label="Copy wallet address"
                            onClick={() =>
                              void navigator.clipboard
                                .writeText(w.address)
                                .then(() => {
                                  setCopied(w.address);
                                  setTimeout(() => setCopied(""), 2000);
                                })
                                .catch(() =>
                                  setNotice("Unable to copy address"),
                                )
                            }
                          >
                            {copied === w.address ? (
                              <Check size={13} />
                            ) : (
                              <Copy size={13} />
                            )}
                          </button>
                        </div>
                        <div className="wallet-stats">
                          <div>
                            <strong>{w.buys}</strong>
                            <span>Detected buys</span>
                          </div>
                          <div>
                            <strong>{w.tokens}</strong>
                            <span>Unique tokens</span>
                          </div>
                        </div>
                        <div className="source-performance">
                          <span>Tracked token performance</span>
                          <strong
                            className={
                              (w.avg_gain ?? 0) >= 0 ? "positive" : "negative"
                            }
                          >
                            {gain(w.avg_gain ?? null)} avg
                          </strong>
                        </div>
                        <div className="wallet-card-footer">
                          <Activity size={13} />
                          <span>{w.sync_error || since(w.synced_at)}</span>
                        </div>
                      </article>
                    ))}
                </div>
              )}
              <div className="wallet-info">
                <LockKeyhole size={16} />
                <p>
                  Watch-only. No wallet connection, signatures, or private keys.
                  <br />
                  <span>
                    First sync scans the latest 100 transactions. Removing a
                    wallet stops future tracking and keeps its detected tokens.
                  </span>
                </p>
              </div>
            </section>
          )}
          {data && (
            <div className="system-status">
              <span>
                <Activity size={13} /> {data.tracking.workers} worker
                {data.tracking.workers === 1 ? "" : "s"} ·{" "}
                {data.tracking.queued} queued · {data.tracking.failed} failed
              </span>
              {data.tracking.failed > 0 && (
                <button
                  onClick={() =>
                    void api("jobs/retry", { method: "POST" })
                      .then(() => {
                        setNotice("Failed jobs queued for retry.");
                        return load();
                      })
                      .catch((e) => setNotice(e.message))
                  }
                >
                  Retry failed jobs
                </button>
              )}
            </div>
          )}
          <footer className="footer">
            <span>
              <span className="tiny-dot" />{" "}
              {data?.tracking.lastSync
                ? `Last scan ${since(data.tracking.lastSync).toLowerCase()}`
                : "Waiting for the first scan"}
            </span>
            <span>
              Made for the moves that matter.{" "}
              <span className="footer-brand">crypsor.</span>
            </span>
          </footer>
        </main>
      </div>
      {notice && (
        <div className="toast" role="status">
          <Check size={17} />
          {notice}
          <button
            aria-label="Dismiss notification"
            onClick={() => setNotice("")}
          >
            <X size={14} />
          </button>
        </div>
      )}
      {(modal || removing || detail) && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !busy) {
              setModal(null);
              setRemoving(null);
              setDetail(null);
            }
          }}
        >
          <div
            className="modal"
            ref={modalRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-title"
          >
            <button
              className="modal-close icon-button"
              aria-label="Close dialog"
              disabled={busy}
              onClick={() => {
                setModal(null);
                setRemoving(null);
                setDetail(null);
              }}
            >
              <X size={19} />
            </button>
            <span className="modal-icon">
              <Wallet size={23} />
            </span>
            <h2 id="modal-title">
              {detail
                ? detail.name || detail.symbol || short(detail.mint)
                : removing
                  ? "Stop following this wallet?"
                  : "Follow a wallet"}
            </h2>
            <p>
              {detail
                ? "Token identity, source and observed performance."
                : removing
                  ? "Future scans will stop. Previously detected buys and tokens stay in your feed."
                  : "Add a Solana address. We’ll follow its buys from here."}
            </p>
            {formError && (
              <div className="form-error" role="alert">
                {formError}
              </div>
            )}
            {detail ? (
              <div className="token-details">
                <code className="mint-detail">{detail.mint}</code>
                <div className="detail-grid">
                  {[
                    ["Entry", price(detail.entry_price)],
                    ["Current", price(detail.current_price)],
                    ["Current gain", gain(detail.gain)],
                    ["Peak gain", gain(detail.peak_gain)],
                    [
                      "Decimals",
                      detail.metadata?.identity?.decimals ?? "Unknown",
                    ],
                    [
                      "Raw supply",
                      detail.metadata?.identity?.supply ?? "Unknown",
                    ],
                    [
                      "Token program",
                      detail.metadata?.identity?.tokenProgram ?? "Unknown",
                    ],
                    [
                      "Metadata source",
                      detail.metadata_source ?? "Awaiting metadata",
                    ],
                    [
                      "Observed",
                      detail.metadata_at
                        ? since(detail.metadata_at)
                        : "Not yet",
                    ],
                    [
                      "Mint authority",
                      detail.metadata?.identity?.mintAuthority ??
                        (detail.metadata?.identity?.mintAuthorityKnown
                          ? "None"
                          : "Unknown"),
                    ],
                    [
                      "Freeze authority",
                      detail.metadata?.identity?.freezeAuthority ??
                        (detail.metadata?.identity?.freezeAuthorityKnown
                          ? "None"
                          : "Unknown"),
                    ],
                  ].map(([label, value]) => (
                    <div key={String(label)}>
                      <span>{label}</span>
                      <strong>{String(value)}</strong>
                    </div>
                  ))}
                </div>
                {detail.metadata?.identity?.description && (
                  <p className="token-description">
                    {detail.metadata.identity.description}
                  </p>
                )}
                <h3>Observed intelligence</h3>
                <p className="detail-facts">
                  {detail.wallet_count} source wallets ·{" "}
                  {Number(detail.buy_count)} buys
                  <br />
                  Version: {detail.insight?.version ?? "Awaiting computation"}
                  <br />
                  Observed momentum:{" "}
                  {gain(
                    detail.insight?.facts?.observedMomentum ?? null,
                  )} across {detail.insight?.facts?.sampleCount ?? 0} samples
                </p>
                <div className="detail-links">
                  {[
                    ...(detail.metadata?.market?.websites ?? []),
                    ...(detail.metadata?.market?.socials ?? []),
                  ].map((link: any) => (
                    <a
                      href={link.url}
                      key={link.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {link.label ?? link.type}
                      <ExternalLink size={12} />
                    </a>
                  ))}
                </div>
                <a
                  className="button secondary"
                  href={`https://solscan.io/token/${detail.mint}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  View on Solscan <ArrowUpRight size={14} />
                </a>
              </div>
            ) : removing ? (
              <div className="modal-actions">
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => setRemoving(null)}
                >
                  Cancel
                </button>
                <button
                  className="button danger"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await api(`wallets/${removing.address}`, {
                        method: "DELETE",
                      });
                      setRemoving(null);
                      await load();
                      setNotice(
                        "Wallet removed. Its detected tokens are retained.",
                      );
                    } catch (e) {
                      setFormError((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {busy ? "Removing…" : "Remove wallet"}
                </button>
              </div>
            ) : (
              <form onSubmit={submit} key={modal}>
                <>
                  <label className="form-label">
                    Wallet address
                    <input
                      name="address"
                      placeholder="Paste a Solana wallet address"
                      required
                      autoComplete="off"
                      spellCheck={false}
                      maxLength={44}
                    />
                  </label>
                  <label className="form-label">
                    Label <span>optional</span>
                    <input
                      name="label"
                      placeholder="e.g. My conviction wallet"
                      maxLength={60}
                    />
                  </label>
                  <div className="form-note">
                    <Radio size={15} />
                    Only confirmed buys. No transfers. No spend minimum.
                  </div>
                </>
                <button className="button primary submit" disabled={busy}>
                  {busy ? "Please wait…" : "Start tracking"}
                  <ArrowRight size={16} />
                </button>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
