import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  Bell,
  BookOpen,
  Check,
  CheckCheck,
  ChevronRight,
  CircleHelp,
  ClipboardList,
  Clock3,
  Database,
  ExternalLink,
  Fingerprint,
  Globe2,
  KeyRound,
  Layers3,
  LockKeyhole,
  LogOut,
  Menu,
  Plus,
  Radar,
  RefreshCw,
  Search,
  Shield,
  ShieldCheck,
  SlidersHorizontal,
  Square,
  Target,
  Trash2,
  Wallet,
  X,
  Zap,
} from "lucide-react";
import "./style.css";

type Row = Record<string, any>;
type Page = "radar" | "room" | "decisions" | "memory" | "operations";
const navigation: {
  id: Page;
  label: string;
  icon: typeof Radar;
  index: string;
}[] = [
  { id: "radar", label: "Radar", icon: Radar, index: "01" },
  { id: "room", label: "Token room", icon: Layers3, index: "02" },
  { id: "decisions", label: "Decisions", icon: ClipboardList, index: "03" },
  { id: "memory", label: "Cabin / memory", icon: Database, index: "04" },
  {
    id: "operations",
    label: "Operations",
    icon: SlidersHorizontal,
    index: "05",
  },
];
const human = (s: unknown) =>
  String(s ?? "Unknown")
    .replaceAll("_", " ")
    .toLowerCase();
const short = (s: unknown, n = 7) => {
  const v = String(s ?? "");
  return v.length > n * 2 + 3
    ? `${v.slice(0, n)}…${v.slice(-n)}`
    : v || "Unknown";
};
const when = (s: unknown) => {
  if (!s) return "Not recorded";
  const d = new Date(String(s));
  return Number.isNaN(d.getTime())
    ? "Unknown"
    : d.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
};
const money = (v: unknown) =>
  v === null || v === undefined || v === ""
    ? "Unknown"
    : Number.isFinite(Number(v))
      ? new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: "USD",
          maximumFractionDigits: Number(v) < 1 ? 8 : 2,
        }).format(Number(v))
      : "Unknown";
const number = (v: unknown) =>
  v === null || v === undefined ? "—" : Number(v).toLocaleString();
const array = (v: any): Row[] => (Array.isArray(v) ? v : []);
const list = (v: any): any[] =>
  Array.isArray(v)
    ? v
    : v == null
      ? []
      : typeof v === "object"
        ? Object.entries(v).map(([name, value]) => ({
            name,
            ...(typeof value === "object" && value !== null
              ? value
              : { value }),
          }))
        : [];
function safeUrl(v: unknown) {
  try {
    const u = new URL(String(v));
    return ["https:", "http:"].includes(u.protocol) ? u.toString() : null;
  } catch {
    return null;
  }
}
function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
function Status({
  value,
  kind = "state",
}: {
  value: unknown;
  kind?: "state" | "confidence" | "priority" | "risk";
}) {
  const s = String(value ?? "UNKNOWN").toUpperCase();
  const tone =
    kind === "confidence"
      ? s === "HIGH"
        ? "green"
        : s === "MEDIUM"
          ? "amber"
          : "neutral"
      : kind === "priority"
        ? s === "HIGH"
          ? "amber"
          : "neutral"
        : [
              "HIGH",
              "STOP_ALL",
              "DEAD",
              "FAILED",
              "CONTRADICTION",
              "REJECTED",
            ].includes(s)
          ? "danger"
          : [
                "VERIFIED",
                "DONE",
                "SENT",
                "CONFIRMED",
                "FINALIZED",
                "FULL",
                "HEALTHY",
              ].includes(s)
            ? "green"
            : [
                  "MEDIUM",
                  "WATCH",
                  "WATCH_ONLY",
                  "RECHECK",
                  "QUEUED",
                  "UNVERIFIED",
                ].includes(s)
              ? "amber"
              : "neutral";
  return <Badge tone={tone}>{human(s)}</Badge>;
}
function Empty({
  icon: Icon = Radar,
  title,
  children,
}: {
  icon?: typeof Radar;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon size={25} />
      </span>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
function Section({
  title,
  kicker,
  action,
  children,
  className = "",
}: {
  title: string;
  kicker?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      <div className="panel-heading">
        <div>
          {kicker && <span className="eyebrow">{kicker}</span>}
          <h2>{title}</h2>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
function Json({ value }: { value: unknown }) {
  return <pre className="json">{JSON.stringify(value, null, 2)}</pre>;
}
function Source({ url, label }: { url: unknown; label?: string }) {
  const href = safeUrl(url);
  return href ? (
    <a
      className="source-link"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
    >
      {label ?? new URL(href).hostname}
      <ExternalLink size={12} />
    </a>
  ) : (
    <span className="muted">Source URL not recorded</span>
  );
}

function App() {
  const [token, setToken] = useState(
    () => sessionStorage.getItem("hunter.access") ?? "",
  );
  const requestGeneration = useRef(0);
  const [input, setInput] = useState("");
  const [page, setPage] = useState<Page>("radar");
  const [mint, setMint] = useState("");
  const [data, setData] = useState<Row | null>(null);
  const [overview, setOverview] = useState<Row | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [mobile, setMobile] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [verified, setVerified] = useState(false);
  const [modeDialog, setModeDialog] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [walletAddress, setWalletAddress] = useState("");
  const [walletLabel, setWalletLabel] = useState("");
  const logout = useCallback(() => {
    sessionStorage.removeItem("hunter.access");
    setToken("");
    setData(null);
    setOverview(null);
    setVerified(false);
    setInput("");
  }, []);
  const api = useCallback(
    async (path: string, options: RequestInit = {}) => {
      const response = await fetch(`/api${path}`, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          ...options.headers,
        },
      });
      const result = await response
        .json()
        .catch(() => ({ error: "The API returned an unreadable response." }));
      if (!response.ok) {
        if (response.status === 401) {
          logout();
          throw new Error("Access denied. Check your private API token.");
        }
        throw new Error(result.error ?? `Request failed (${response.status}).`);
      }
      return result;
    },
    [token, logout],
  );
  const refresh = useCallback(async () => {
    if (!token) return;
    const generation = ++requestGeneration.current;
    setLoading(true);
    setError("");
    try {
      const base = await api("/overview");
      if (generation !== requestGeneration.current) return;
      setOverview(base);
      setVerified(true);
      let result = base;
      if (page === "room" && mint)
        result = await api(`/tokens/${encodeURIComponent(mint)}`);
      if (page === "decisions") result = await api("/decisions");
      if (page === "memory")
        result = await api(`/memory?q=${encodeURIComponent(search)}`);
      if (page === "operations") result = await api("/operations");
      if (generation === requestGeneration.current) {
        setData(result);
        setLastRefresh(new Date());
      }
    } catch (e) {
      if (generation === requestGeneration.current)
        setError(e instanceof Error ? e.message : "Unable to reach Hunter.");
    } finally {
      if (generation === requestGeneration.current) setLoading(false);
    }
  }, [api, token, page, mint, search]);
  useEffect(() => {
    setData(null);
    void refresh();
    const interval = window.setInterval(() => void refresh(), 30000);
    return () => window.clearInterval(interval);
  }, [refresh]);
  useEffect(() => {
    if (!notice) return undefined;
    const t = window.setTimeout(() => setNotice(""), 7000);
    return () => window.clearTimeout(t);
  }, [notice]);
  useEffect(() => {
    if (!modeDialog) return undefined;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setModeDialog(null);
        return;
      }
      if (e.key === "Tab") {
        const controls = Array.from(
          document.querySelectorAll<HTMLElement>(
            ".modal button:not([disabled]), .modal textarea, .modal input",
          ),
        );
        const first = controls[0],
          last = controls.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [modeDialog]);
  const mutate = async (path: string, body?: Row, method = "POST") => {
    setBusy(true);
    setError("");
    try {
      await api(path, {
        method,
        body: body ? JSON.stringify(body) : undefined,
      });
      setNotice("Saved. The journal and current state have been refreshed.");
      await refresh();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to save.");
      return false;
    } finally {
      setBusy(false);
    }
  };
  const navigate = (p: Page) => {
    setPage(p);
    setMobile(false);
    setError("");
    setNotice("");
  };
  const openToken = (m: string) => {
    setMint(m);
    navigate("room");
  };
  const unlock = (e: FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;
    sessionStorage.setItem("hunter.access", input.trim());
    setToken(input.trim());
    setError("");
  };
  const walletSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (
      await mutate("/wallets", {
        address: walletAddress.trim(),
        label: walletLabel.trim(),
      })
    ) {
      setWalletAddress("");
      setWalletLabel("");
    }
  };
  const stat = overview?.stats ?? {};
  const tokens = array(overview?.tokens);
  const heading = {
    radar: [
      "Discovery surface",
      "Radar",
      "Every watched wallet. Every observed discovery.",
    ],
    room: [
      "Evidence workspace",
      "Token room",
      "Facts, hypotheses, and the gaps between them.",
    ],
    decisions: [
      "Read → think → gate → journal → revisit",
      "Decisions",
      "A versioned record of what was known, and when.",
    ],
    memory: [
      "Permanent research memory",
      "Cabin / memory",
      "Watch wallets. Revisit claims. Follow the evidence.",
    ],
    operations: [
      "Control plane",
      "Operations",
      "Keep the pipeline observable and the operator in control.",
    ],
  }[page];
  const mode = String(data?.mode ?? overview?.mode ?? "UNKNOWN");

  if (!token || !verified)
    return (
      <div className="unlock-shell">
        <div className="unlock-mast">
          <Brand />
          <Badge tone="amber">Private research system</Badge>
        </div>
        <main className="unlock-main">
          <div className="unlock-intro">
            <span className="eyebrow amber-text">
              SOLANA INTELLIGENCE / V0.2
            </span>
            <h1>
              Observe everything.
              <br />
              <em>Conclude carefully.</em>
            </h1>
            <p>
              Your private workspace for wallet discoveries, reproducible
              evidence, and decisions that remember their own uncertainty.
            </p>
            <div className="unlock-principles">
              <span>
                <ShieldCheck size={17} /> Read-only by design
              </span>
              <span>
                <Fingerprint size={17} /> Evidence before inference
              </span>
              <span>
                <BookOpen size={17} /> Memory that keeps its history
              </span>
            </div>
          </div>
          <form className="unlock-card" onSubmit={unlock}>
            <div className="unlock-lock">
              <LockKeyhole size={26} />
            </div>
            <span className="eyebrow">OPERATOR ACCESS</span>
            <h2>Enter your cabin.</h2>
            <p>
              Use the private API token configured for this Hunter instance.
            </p>
            <label htmlFor="access-token">API token</label>
            <div className="input-icon">
              <KeyRound size={16} />
              <input
                id="access-token"
                type="password"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                autoComplete="off"
                required
                placeholder="Private access token"
              />
            </div>
            {error && (
              <div className="inline-error" role="alert">
                {error}
              </div>
            )}
            <button className="button primary" type="submit" disabled={loading}>
              {loading ? (
                <RefreshCw size={16} className="spin" />
              ) : (
                <ArrowRight size={16} />
              )}
              Unlock workspace
            </button>
            <small>
              The token stays in this browser tab’s session storage. No wallet
              connection or signing key is needed.
            </small>
          </form>
        </main>
        <footer className="unlock-footer">
          <span>HUNTER / PERSONAL RESEARCH</span>
          <span>No trade execution. No guaranteed outcomes.</span>
        </footer>
      </div>
    );

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobile ? "open" : ""}`}>
        <div className="sidebar-brand">
          <Brand />
          <button
            className="icon-button mobile-only"
            aria-label="Close navigation"
            onClick={() => setMobile(false)}
          >
            <X size={18} />
          </button>
        </div>
        <div className="workspace-tag">
          <span className="signal-dot" />
          PRIVATE WORKSPACE
        </div>
        <nav aria-label="Main navigation">
          {navigation.map(({ id, label, icon: Icon, index }) => (
            <button
              key={id}
              className={`nav-item ${page === id ? "active" : ""}`}
              onClick={() => navigate(id)}
              aria-current={page === id ? "page" : undefined}
            >
              <Icon size={18} />
              <span>{label}</span>
              <span className="nav-index">{index}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="pilot-box">
            <div>
              <Target size={16} />
              <span>FREE-CAPPED PILOT</span>
            </div>
            <p>
              Observe, verify, revisit.
              <br />
              Spend only within configured caps.
            </p>
            <span
              className="text-link"
              onClick={() => navigate("operations")}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter") navigate("operations");
              }}
            >
              View operations <ArrowUpRight size={13} />
            </span>
          </div>
          <div className="sidebar-meta">
            <Shield size={13} />
            <span>Solana-first · Read-only</span>
          </div>
          <button className="logout" onClick={logout}>
            <LogOut size={14} />
            Lock workspace
          </button>
        </div>
      </aside>
      {mobile && (
        <button
          className="sidebar-overlay"
          aria-label="Close navigation"
          onClick={() => setMobile(false)}
        />
      )}
      <div className="content-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-only"
              onClick={() => setMobile(true)}
              aria-label="Open navigation"
            >
              <Menu size={20} />
            </button>
            <span>WORKSPACE</span>
            <ChevronRight size={13} />
            <b>{heading[1]}</b>
          </div>
          <div className="topbar-right">
            <span className="read-only">
              <ShieldCheck size={13} />
              READ ONLY
            </span>
            <span className="topbar-divider" />
            <span className="operator-avatar">OP</span>
          </div>
        </header>
        <main className="main">
          <div className="page-heading">
            <div>
              <span className="eyebrow">{heading[0]}</span>
              <h1>
                {heading[1]}
                <span className="heading-square" />
              </h1>
              <p>{heading[2]}</p>
            </div>
            <div className="heading-actions">
              <span className="refresh-time">
                {lastRefresh
                  ? `Updated ${lastRefresh.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`
                  : "Awaiting first response"}
              </span>
              <button
                className="button secondary"
                onClick={() => void refresh()}
                disabled={loading}
              >
                <RefreshCw size={14} className={loading ? "spin" : ""} />
                <span>Refresh</span>
              </button>
            </div>
          </div>
          {error && (
            <div className="notice error" role="alert">
              <CircleHelp size={16} />
              <span>{error}</span>
              <button
                className="icon-button"
                onClick={() => setError("")}
                aria-label="Dismiss error"
              >
                <X size={14} />
              </button>
            </div>
          )}
          {notice && (
            <div className="notice success" role="status">
              <Check size={16} />
              <span>{notice}</span>
            </div>
          )}
          {!data && loading ? (
            <div className="loading-state">
              <RefreshCw size={23} className="spin" />
              <span>Reading the evidence store…</span>
            </div>
          ) : (
            <>
              {page === "radar" && (
                <>
                  <div className="radar-banner">
                    <div className="radar-banner-icon">
                      <Radar size={25} />
                    </div>
                    <div>
                      <span className="eyebrow">WATCHED-WALLET DISCOVERY</span>
                      <p>Facts arrive first. Interpretation follows.</p>
                    </div>
                    <div className="radar-mode">
                      <span className="tiny-label">OPERATOR MODE</span>
                      <Status value={mode} />
                    </div>
                  </div>
                  <div className="stats-grid">
                    {[
                      {
                        label: "Watched wallets",
                        value: stat.wallets,
                        icon: Wallet,
                      },
                      {
                        label: "Discovered tokens",
                        value: stat.tokens,
                        icon: Radar,
                      },
                      {
                        label: "Observed events",
                        value: stat.events,
                        icon: Activity,
                      },
                      {
                        label: "Journal decisions",
                        value: stat.decisions,
                        icon: BookOpen,
                      },
                    ].map((s) => (
                      <div className="stat-card" key={s.label}>
                        <div>
                          <span>{s.label}</span>
                          <s.icon size={16} />
                        </div>
                        <strong>{number(s.value)}</strong>
                        <small>
                          {s.label === "Watched wallets"
                            ? "Unconditional discovery sensors"
                            : s.label === "Discovered tokens"
                              ? "Retained without quality thresholds"
                              : s.label === "Observed events"
                                ? "Persisted on-chain observations"
                                : "Append-only, known-at versions"}
                        </small>
                      </div>
                    ))}
                  </div>
                  <Section
                    title="Discovery radar"
                    kicker="LIVE CANDIDATES"
                    action={
                      <Badge>
                        <span className="signal-dot" />
                        {number(stat.pendingJobs)} pending jobs
                      </Badge>
                    }
                  >
                    <TokenTable tokens={tokens} openToken={openToken} />
                  </Section>
                  <div className="two-column">
                    <Section
                      title="The evidence contract"
                      kicker="HOW HUNTER THINKS"
                    >
                      <div className="contract-grid">
                        {[
                          [
                            "01",
                            "Read",
                            "Collect timestamped observations and reproducible source links.",
                          ],
                          [
                            "02",
                            "Think & gate",
                            "Separate provisional hypotheses from deterministic safety checks.",
                          ],
                          [
                            "03",
                            "Journal & revisit",
                            "Keep the original judgment. Append corrections and recheck triggers.",
                          ],
                        ].map(([n, t, d]) => (
                          <div className="contract-item" key={n}>
                            <span>{n}</span>
                            <div>
                              <h3>{t}</h3>
                              <p>{d}</p>
                            </div>
                          </div>
                        ))}
                      </div>
                    </Section>
                    <Section
                      title="Three independent signals"
                      kicker="NO SINGLE MAGIC SCORE"
                    >
                      <div className="signal-explainer">
                        <div>
                          <Target size={16} />
                          <span>Research priority</span>
                          <small>What deserves attention</small>
                        </div>
                        <div>
                          <Shield size={16} />
                          <span>Structural risk</span>
                          <small>What may cause harm</small>
                        </div>
                        <div>
                          <Fingerprint size={16} />
                          <span>Evidence confidence</span>
                          <small>What the sources support</small>
                        </div>
                      </div>
                    </Section>
                  </div>
                </>
              )}
              {page === "room" &&
                (!mint ? (
                  <Section
                    title="Choose a token to investigate"
                    kicker="TOKEN ROOM"
                  >
                    <TokenTable tokens={tokens} openToken={openToken} />
                  </Section>
                ) : (
                  <TokenRoom
                    data={data ?? {}}
                    mint={mint}
                    busy={busy}
                    requestResearch={() =>
                      void mutate(
                        `/tokens/${encodeURIComponent(mint)}/research`,
                      )
                    }
                    onBack={() => {
                      setMint("");
                      setData(null);
                    }}
                  />
                ))}
              {page === "decisions" && (
                <>
                  <div className="flow-strip">
                    {["READ", "THINK", "GATE", "JOURNAL", "REVISIT"].map(
                      (s, i) => (
                        <span key={s}>
                          <b>{String(i + 1).padStart(2, "0")}</b>
                          {s}
                          {i < 4 && <ArrowRight size={12} />}
                        </span>
                      ),
                    )}
                  </div>
                  <Section
                    title="Decision journal"
                    kicker="APPEND-ONLY MEMORY"
                    action={
                      <Badge>
                        {number(array(data?.decisions).length)} versions
                        returned
                      </Badge>
                    }
                  >
                    {array(data?.decisions).length ? (
                      <div className="decision-list">
                        {array(data?.decisions).map((d, i) => (
                          <Decision
                            key={d.id ?? i}
                            d={d}
                            openToken={openToken}
                          />
                        ))}
                      </div>
                    ) : (
                      <Empty
                        icon={BookOpen}
                        title="No judgments without evidence"
                      >
                        Decisions appear after a discovered token has completed
                        a research pass. Unknowns remain visible.
                      </Empty>
                    )}
                  </Section>
                </>
              )}
              {page === "memory" && (
                <>
                  <div className="memory-toolbar">
                    <form
                      className="search-form"
                      onSubmit={(e) => {
                        e.preventDefault();
                        setSearch(query);
                      }}
                    >
                      <Search size={17} />
                      <input
                        aria-label="Search permanent memory"
                        placeholder="Search wallets, tokens, and evidence claims…"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                      />
                      <button className="button secondary" type="submit">
                        Search
                      </button>
                    </form>
                  </div>
                  <div className="two-column memory-layout">
                    <Section
                      title="Watched wallets"
                      kicker="DISCOVERY SENSORS"
                      action={
                        <Badge>
                          {number(array(data?.wallets).length)} returned
                        </Badge>
                      }
                    >
                      <div className="wallet-list">
                        {array(data?.wallets).length ? (
                          array(data?.wallets).map((w) => (
                            <div className="wallet-row" key={w.address}>
                              <span className="wallet-icon">
                                <Wallet size={17} />
                              </span>
                              <div>
                                <strong>{w.label || "Unlabeled wallet"}</strong>
                                <code title={w.address}>
                                  {short(w.address, 10)}
                                </code>
                                <small>
                                  Last success: {when(w.last_success_at)}
                                  {w.cursor
                                    ? ` · Cursor ${short(w.cursor)}`
                                    : ""}
                                </small>
                              </div>
                              <Status
                                value={
                                  w.active === false ? "INACTIVE" : "WATCHING"
                                }
                              />
                              {w.active !== false && (
                                <button
                                  className="icon-button"
                                  disabled={busy}
                                  aria-label={`Stop watching ${w.label || w.address}`}
                                  onClick={() => {
                                    if (
                                      window.confirm(
                                        "Stop watching this wallet? Its historical discoveries will be retained.",
                                      )
                                    )
                                      void mutate(
                                        `/wallets/${encodeURIComponent(w.address)}`,
                                        undefined,
                                        "DELETE",
                                      );
                                  }}
                                >
                                  <Trash2 size={15} />
                                </button>
                              )}
                            </div>
                          ))
                        ) : (
                          <Empty icon={Wallet} title="No watched wallets">
                            Add a public Solana wallet address to start your
                            discovery surface.
                          </Empty>
                        )}
                      </div>
                      <form className="wallet-form" onSubmit={walletSubmit}>
                        <h3>
                          <Plus size={15} /> Watch a wallet
                        </h3>
                        <label htmlFor="wallet-address">
                          Public Solana address
                        </label>
                        <input
                          id="wallet-address"
                          className="mono"
                          value={walletAddress}
                          onChange={(e) => setWalletAddress(e.target.value)}
                          pattern="[1-9A-HJ-NP-Za-km-z]{32,44}"
                          required
                          placeholder="Public address only"
                          autoComplete="off"
                        />
                        <label htmlFor="wallet-label">
                          Label <span className="muted">(optional)</span>
                        </label>
                        <input
                          id="wallet-label"
                          value={walletLabel}
                          onChange={(e) => setWalletLabel(e.target.value)}
                          maxLength={100}
                          placeholder="A name you will recognize"
                        />
                        <button
                          className="button primary"
                          disabled={busy}
                          type="submit"
                        >
                          <Plus size={15} />
                          Watch wallet
                        </button>
                        <small>
                          No private key, connection, or signing permission is
                          requested.
                        </small>
                      </form>
                    </Section>
                    <div>
                      <Section title="Memory matches" kicker="TOKENS & CLAIMS">
                        <div className="memory-results">
                          {array(data?.tokens).map((t) => (
                            <button
                              className="memory-token"
                              key={t.mint}
                              onClick={() => openToken(t.mint)}
                            >
                              <span className="token-avatar">
                                {String(t.symbol ?? "?").slice(0, 2)}
                              </span>
                              <div>
                                <strong>{t.name || short(t.mint)}</strong>
                                <code>
                                  {t.symbol || "Unknown symbol"} ·{" "}
                                  {short(t.mint)}
                                </code>
                              </div>
                              <ArrowUpRight size={16} />
                            </button>
                          ))}
                          {array(data?.claims).map((c, i) => (
                            <div className="claim" key={c.id ?? i}>
                              <Status value={c.status} />
                              <p>
                                {typeof c.claim === "string"
                                  ? c.claim
                                  : JSON.stringify(c.claim ?? c.data)}
                              </p>
                              <small>
                                {when(c.known_at)} · confidence{" "}
                                {human(c.confidence)}
                              </small>
                              {c.mint && (
                                <button
                                  className="text-link"
                                  onClick={() => openToken(c.mint)}
                                >
                                  Open token <ArrowUpRight size={12} />
                                </button>
                              )}
                            </div>
                          ))}
                          {!array(data?.tokens).length &&
                            !array(data?.claims).length && (
                              <Empty icon={Search} title="No matching memory">
                                Search only returns retained records. Hunter
                                does not populate this space with sample
                                research.
                              </Empty>
                            )}
                        </div>
                      </Section>
                      {array(data?.relations).length > 0 && (
                        <Section
                          title="Observed relationships"
                          kicker="RELATION MEMORY"
                        >
                          <div className="record-list">
                            {array(data?.relations).map((r, i) => (
                              <div key={r.id ?? i}>
                                <Status
                                  value={
                                    r.relation_kind ?? r.kind ?? "OBSERVED"
                                  }
                                />
                                <Json value={r} />
                              </div>
                            ))}
                          </div>
                        </Section>
                      )}
                    </div>
                  </div>
                </>
              )}
              {page === "operations" && (
                <Operations
                  data={data ?? {}}
                  mode={mode}
                  busy={busy}
                  setModeDialog={setModeDialog}
                  retry={(id) => void mutate(`/jobs/${id}/retry`)}
                />
              )}
            </>
          )}
          <footer className="page-footer">
            <span>
              <ShieldCheck size={12} />
              PRIVATE · READ-ONLY · SOLANA
            </span>
            <span>Observations are facts. Interpretations are hypotheses.</span>
          </footer>
        </main>
      </div>
      {modeDialog && (
        <div className="modal-backdrop" role="presentation">
          <form
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mode-title"
            onSubmit={async (e) => {
              e.preventDefault();
              if (
                await mutate("/operator/mode", { mode: modeDialog, reason })
              ) {
                setModeDialog(null);
                setReason("");
              }
            }}
          >
            <div className="modal-title">
              <span className="eyebrow">OPERATOR CONTROL</span>
              <button
                className="icon-button"
                type="button"
                onClick={() => setModeDialog(null)}
                aria-label="Cancel"
              >
                <X size={18} />
              </button>
            </div>
            <h2 id="mode-title">Switch to {human(modeDialog)}?</h2>
            <p>
              {modeDialog === "STOP_ALL"
                ? "New event handling and jobs will stop where this application controls them. Vendor subscriptions and upstream providers are not automatically canceled."
                : modeDialog === "FULL"
                  ? "Enable research within configured free-tier caps. Optional AI remains subject to its separate opt-in and quota settings."
                  : "This change is recorded in the operator audit log. Existing evidence and historical decisions will be retained."}
            </p>
            <label htmlFor="mode-reason">Reason for this change</label>
            <textarea
              id="mode-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              required
              minLength={3}
              maxLength={500}
              placeholder="Record the reason for your future self."
              autoFocus
            />
            <div className="modal-actions">
              <button
                className="button secondary"
                type="button"
                onClick={() => setModeDialog(null)}
              >
                Cancel
              </button>
              <button
                className={`button ${modeDialog === "STOP_ALL" ? "danger-button" : "primary"}`}
                disabled={busy}
                type="submit"
              >
                Confirm mode change
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

function Brand() {
  return (
    <div className="brand">
      <span className="brand-symbol">
        <Target size={22} strokeWidth={1.7} />
      </span>
      <span>
        HUNTER<b>RESEARCH TERMINAL</b>
      </span>
    </div>
  );
}
function TokenTable({
  tokens,
  openToken,
}: {
  tokens: Row[];
  openToken: (mint: string) => void;
}) {
  return tokens.length ? (
    <div className="table-scroll">
      <table className="token-table">
        <thead>
          <tr>
            <th>Token / identity</th>
            <th>Discovery</th>
            <th>Market context</th>
            <th>Priority</th>
            <th>Risk</th>
            <th>Confidence</th>
            <th>Pipeline</th>
            <th>
              <span className="sr-only">Open</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {tokens.map((t) => (
            <tr key={t.mint}>
              <td>
                <button
                  className="token-button"
                  onClick={() => openToken(t.mint)}
                >
                  <span className="token-avatar">
                    {String(t.symbol ?? "?").slice(0, 2)}
                  </span>
                  <span>
                    <strong>{t.name || "Unresolved token"}</strong>
                    <small>
                      {t.symbol || "Unknown symbol"} <span>·</span>{" "}
                      <code title={t.mint}>{short(t.mint, 5)}</code>
                    </small>
                  </span>
                </button>
              </td>
              <td>
                <span>{when(t.discovered_at)}</span>
                <small>
                  {Array.isArray(t.wallets)
                    ? `${t.wallets.length} source wallet${t.wallets.length === 1 ? "" : "s"}`
                    : "Source not recorded"}
                </small>
              </td>
              <td>
                <span className="mono">{money(t.price_usd)}</span>
                <small>Liquidity {money(t.liquidity_usd)}</small>
              </td>
              <td>
                <Status value={t.priority} kind="priority" />
              </td>
              <td>
                <Status value={t.risk} kind="risk" />
              </td>
              <td>
                <Status value={t.confidence} kind="confidence" />
              </td>
              <td>
                <Status value={t.alert_status} />
                <small>{human(t.job_status ?? "Not scheduled")}</small>
              </td>
              <td>
                <button
                  className="icon-button"
                  aria-label={`Investigate ${t.name || t.mint}`}
                  onClick={() => openToken(t.mint)}
                >
                  <ArrowUpRight size={16} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <Empty title="Your radar is quiet" icon={Radar}>
      Watch a wallet in Cabin / memory. Authenticated intake will populate
      discoveries here; no sample tokens are added.
    </Empty>
  );
}

function Decision({
  d,
  openToken,
}: {
  d: Row;
  openToken?: (mint: string) => void;
}) {
  return (
    <article className="decision-card">
      <div className="decision-head">
        <div>
          <span className="version-label">
            VERSION {d.version ?? "?"} <span>·</span> {when(d.known_at)}
          </span>
          <h3>
            {d.symbol || short(d.mint, 8)}
            {openToken && (
              <button
                className="icon-button"
                aria-label="Open token room"
                onClick={() => openToken(d.mint)}
              >
                <ArrowUpRight size={15} />
              </button>
            )}
          </h3>
        </div>
        <Status value={d.action} />
      </div>
      <div className="thesis-grid">
        <div>
          <span className="tiny-label">
            <ArrowUpRight size={12} />
            PROVISIONAL THESIS
          </span>
          <p>
            {typeof d.thesis === "string"
              ? d.thesis
              : JSON.stringify(d.thesis ?? "Not recorded")}
          </p>
        </div>
        <div>
          <span className="tiny-label">
            <ArrowDownLeft size={12} />
            COMPETING HYPOTHESIS
          </span>
          <p>
            {typeof d.counter_thesis === "string"
              ? d.counter_thesis
              : JSON.stringify(d.counter_thesis ?? "Not recorded")}
          </p>
        </div>
      </div>
      {Array.isArray(d.unknowns) && d.unknowns.length > 0 && (
        <div className="unknown-list">
          <span className="tiny-label">UNRESOLVED QUESTIONS</span>
          <ul>
            {d.unknowns.map((u: any, i: number) => (
              <li key={i}>{typeof u === "string" ? u : JSON.stringify(u)}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="decision-foot">
        <span>
          <Clock3 size={12} />
          Next recheck: {when(d.next_recheck_at)}
        </span>
        <span>
          Rule {d.rule_version ?? "unrecorded"} · Model{" "}
          {d.model_version ?? "none"}
        </span>
      </div>
      <details>
        <summary>
          Gate result & provenance <ChevronRight size={12} />
        </summary>
        <Json
          value={{
            gate: d.gate,
            reviewer: d.reviewer_result,
            evidence_ids: d.evidence_ids,
            contradictions: d.contradictions,
            context: d.context,
            spend_usd: d.spend_usd,
          }}
        />
      </details>
    </article>
  );
}

function TokenRoom({
  data,
  mint,
  busy,
  requestResearch,
  onBack,
}: {
  data: Row;
  mint: string;
  busy: boolean;
  requestResearch: () => void;
  onBack: () => void;
}) {
  const t = data.token ?? {};
  return (
    <>
      <div className="token-room-top">
        <button className="text-link" onClick={onBack}>
          ← All discovered tokens
        </button>
        <button
          className="button secondary"
          onClick={requestResearch}
          disabled={busy}
        >
          <RefreshCw size={14} />
          Request research pass
        </button>
      </div>
      <div className="token-identity">
        <span className="token-avatar large">
          {String(t.symbol ?? "?").slice(0, 2)}
        </span>
        <div>
          <h2>
            {t.name || "Unresolved token"}
            <Badge>{t.symbol || "Symbol unknown"}</Badge>
          </h2>
          <span className="mint">
            <code>{mint}</code>
            <button
              className="icon-button"
              aria-label="Copy token mint"
              onClick={() => void navigator.clipboard.writeText(mint)}
            >
              <ClipboardList size={13} />
            </button>
            <Source url={`https://solscan.io/token/${mint}`} label="Explorer" />
          </span>
        </div>
        <div className="token-identity-time">
          <span className="tiny-label">FIRST OBSERVED</span>
          <span>{when(t.discovered_at)}</span>
        </div>
      </div>
      <div className="stats-grid room-stats">
        <div className="stat-card">
          <div>
            <span>Observed price</span>
            <Activity size={16} />
          </div>
          <strong>{money(t.price_usd)}</strong>
          <small>Market source: {when(t.market_updated_at)}</small>
        </div>
        <div className="stat-card">
          <div>
            <span>Liquidity</span>
            <Layers3 size={16} />
          </div>
          <strong>{money(t.liquidity_usd)}</strong>
          <small>Source-reported, not a guarantee</small>
        </div>
        <div className="stat-card">
          <div>
            <span>Research priority / risk</span>
            <Target size={16} />
          </div>
          <div className="signal-pair">
            <Status value={t.priority} kind="priority" />
            <Status value={t.risk} kind="risk" />
          </div>
          <small>Independent, never a composite score</small>
        </div>
        <div className="stat-card">
          <div>
            <span>Evidence confidence</span>
            <Fingerprint size={16} />
          </div>
          <div className="signal-pair">
            <Status value={t.confidence} kind="confidence" />
          </div>
          <small>Based on cited, timestamped observations</small>
        </div>
      </div>
      <div className="two-column token-room-layout">
        <div>
          <Section title="Research timeline" kicker="VERSIONED DECISIONS">
            {array(data.decisions).length ? (
              <div className="decision-list">
                {array(data.decisions).map((d, i) => (
                  <Decision key={d.id ?? i} d={d} />
                ))}
              </div>
            ) : (
              <Empty icon={BookOpen} title="The dossier is not ready yet">
                The discovery remains recorded while research is pending. No
                thesis is inferred from missing evidence.
              </Empty>
            )}
          </Section>
          <Section title="Evidence ledger" kicker="CITABLE OBSERVATIONS">
            {array(data.evidence).length ? (
              <div className="evidence-list">
                {array(data.evidence).map((e, i) => (
                  <div className="evidence-item" key={e.id ?? i}>
                    <div>
                      <Badge>EV-{e.id ?? i + 1}</Badge>
                      <Status value={e.status} />
                      <span>{when(e.known_at)}</span>
                    </div>
                    <h3>
                      {typeof e.claim === "string"
                        ? e.claim
                        : JSON.stringify(e.claim ?? e.data)}
                    </h3>
                    <div className="evidence-source">
                      <Source url={e.url ?? e.source_url} label={e.provider} />
                      <small>Confidence: {human(e.confidence)}</small>
                    </div>
                    <details>
                      <summary>
                        Recorded evidence <ChevronRight size={12} />
                      </summary>
                      <Json
                        value={{
                          claim_id: e.id,
                          known_at: e.known_at,
                          source_timestamp: e.source_timestamp,
                          source_provider: e.provider,
                          source_url: e.url,
                          data: e.data,
                        }}
                      />
                    </details>
                  </div>
                ))}
              </div>
            ) : (
              <Empty icon={Fingerprint} title="No evidence claims recorded">
                Unavailable information remains unknown.
              </Empty>
            )}
          </Section>
        </div>
        <div>
          <Section title="On-chain discoveries" kicker="SOURCE ATTRIBUTION">
            {array(data.events).length ? (
              <div className="event-list">
                {array(data.events).map((e, i) => (
                  <div className="event" key={e.id ?? i}>
                    <span className="event-dot" />
                    <div>
                      <div className="event-head">
                        <strong>{human(e.event_kind ?? "Observation")}</strong>
                        <Status value={e.commitment} />
                      </div>
                      <p>
                        Wallet{" "}
                        <code>{short(e.wallet_address ?? e.wallet)}</code>
                      </p>
                      <Source
                        url={`https://solscan.io/tx/${e.signature}`}
                        label={short(e.signature)}
                      />
                      <small>
                        {when(e.block_time ?? e.observed_at)} · path{" "}
                        {e.instruction_path ?? "unknown"}
                      </small>
                      <details>
                        <summary>Normalized observation</summary>
                        <Json value={e.observations} />
                      </details>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <Empty icon={Activity} title="No source events">
                No on-chain event is recorded for this token.
              </Empty>
            )}
          </Section>
          <Section
            title="Identity & holder memory"
            kicker="VERSIONED SOURCE RECORDS"
          >
            <div className="record-list">
              <details>
                <summary>
                  Metadata versions <Badge>{array(data.metadata).length}</Badge>
                </summary>
                {array(data.metadata).length ? (
                  <Json value={data.metadata} />
                ) : (
                  <p className="muted">
                    Identity metadata has not been resolved.
                  </p>
                )}
              </details>
              <details>
                <summary>
                  Holder snapshots <Badge>{array(data.holders).length}</Badge>
                </summary>
                {array(data.holders).length ? (
                  <Json value={data.holders} />
                ) : (
                  <p className="muted">
                    No holder snapshot is recorded. Concentration, common
                    funding, and churn remain unknown.
                  </p>
                )}
              </details>
              <details>
                <summary>
                  Relationship evidence{" "}
                  <Badge>{array(data.relations).length}</Badge>
                </summary>
                {array(data.relations).length ? (
                  <Json value={data.relations} />
                ) : (
                  <p className="muted">No relationship edges are recorded.</p>
                )}
              </details>
              <details>
                <summary>
                  Alerts & jobs{" "}
                  <Badge>
                    {array(data.alerts).length + array(data.jobs).length}
                  </Badge>
                </summary>
                <Json
                  value={{ alerts: data.alerts ?? [], jobs: data.jobs ?? [] }}
                />
              </details>
            </div>
          </Section>
          <div className="research-note">
            <CircleHelp size={17} />
            <p>
              “Earliest found” is scoped to covered datasets. It does not
              establish originality, affiliation, or future performance.
            </p>
          </div>
        </div>
      </div>
    </>
  );
}

function Operations({
  data,
  mode,
  busy,
  setModeDialog,
  retry,
}: {
  data: Row;
  mode: string;
  busy: boolean;
  setModeDialog: (s: string) => void;
  retry: (id: string) => void;
}) {
  const jobs = array(data.jobs);
  return (
    <>
      <div className="control-panel">
        <div className="control-heading">
          <div>
            <span className="eyebrow">OPERATOR STATE</span>
            <h2>You're in control.</h2>
            <p>Mode changes are audited. Historical evidence is retained.</p>
          </div>
          <Status value={mode} />
        </div>
        <div className="mode-grid">
          {[
            {
              id: "FULL",
              title: "Full research",
              desc: "Ingest, alert, and research within free caps.",
              icon: Zap,
            },
            {
              id: "WATCH_ONLY",
              title: "Watch only",
              desc: "Ingest discoveries and send factual alerts.",
              icon: Radar,
            },
            {
              id: "PAUSE_RESEARCH",
              title: "Pause research",
              desc: "Preserve intake; pause new reasoning work.",
              icon: Clock3,
            },
            {
              id: "STOP_ALL",
              title: "Stop all",
              desc: "Stop intake and jobs under app control.",
              icon: Square,
            },
          ].map((m) => (
            <button
              key={m.id}
              disabled={busy || mode === m.id}
              className={`mode-card ${mode === m.id ? "selected" : ""} ${m.id === "STOP_ALL" ? "stop" : ""}`}
              onClick={() => setModeDialog(m.id)}
            >
              <div>
                <m.icon size={18} />
                {mode === m.id && <Check size={14} />}
              </div>
              <h3>{m.title}</h3>
              <p>{m.desc}</p>
              <span>
                {mode === m.id ? "CURRENT MODE" : "SWITCH MODE"}
                <ArrowRight size={12} />
              </span>
            </button>
          ))}
        </div>
      </div>
      <div className="two-column operations-layout">
        <Section title="Provider readiness" kicker="CONFIGURATION STATUS">
          <div className="provider-list">
            {list(data.providers).length ? (
              list(data.providers).map((p, i) => (
                <div className="provider" key={p.name ?? p.provider ?? i}>
                  <span className="provider-icon">
                    <Globe2 size={17} />
                  </span>
                  <div>
                    <strong>
                      {p.name ?? p.provider ?? `Provider ${i + 1}`}
                    </strong>
                    <small>
                      {p.reason ??
                        p.note ??
                        p.message ??
                        (p.last_success_at
                          ? `Last success: ${when(p.last_success_at)}`
                          : "No live success recorded")}
                    </small>
                  </div>
                  <Status
                    value={
                      p.status ??
                      p.state ??
                      (p.configured === true
                        ? "CONFIGURED"
                        : p.configured === false
                          ? "MISSING"
                          : p.value)
                    }
                  />
                </div>
              ))
            ) : (
              <Empty icon={Globe2} title="No provider status returned">
                Check the API configuration before enabling live sources.
              </Empty>
            )}
          </div>
          {data.configuration && (
            <details className="configuration-details">
              <summary>
                Configuration requirements <ChevronRight size={12} />
              </summary>
              <Json value={data.configuration} />
            </details>
          )}
        </Section>
        <Section title="Usage ledger" kicker="MEASURE FIRST, UPGRADE LATER">
          <div className="budget-callout">
            <ShieldCheck size={19} />
            <p>
              The target is $0 incremental infrastructure. Local metering does
              not replace vendor billing safeguards.
            </p>
          </div>
          {list(data.usage).length ? (
            <div className="table-scroll">
              <table className="compact-table">
                <thead>
                  <tr>
                    <th>Provider / period</th>
                    <th>Requests</th>
                    <th>Recorded cost</th>
                  </tr>
                </thead>
                <tbody>
                  {list(data.usage).map((u, i) => (
                    <tr key={i}>
                      <td>
                        {u.provider ?? u.name ?? "Unspecified"}
                        <small>
                          {u.day ??
                            u.period ??
                            when(
                              u.recorded_at ??
                                u.created_at ??
                                u.last_request_at,
                            )}
                        </small>
                      </td>
                      <td>{number(u.requests ?? u.calls ?? u.units)}</td>
                      <td>
                        {money(
                          u.cost_usd ?? u.spend_usd ?? u.estimated_cost_usd,
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty icon={ClipboardList} title="No metered requests">
              No provider calls have been recorded in the returned ledger.
            </Empty>
          )}
        </Section>
      </div>
      <Section
        title="Job queue & recovery"
        kicker="DURABLE WORK"
        action={<Badge>{jobs.length} returned</Badge>}
      >
        {jobs.length ? (
          <div className="table-scroll">
            <table className="compact-table">
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Target</th>
                  <th>Status</th>
                  <th>Attempts</th>
                  <th>Next / last run</th>
                  <th>Recovery</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.id}>
                    <td>
                      <strong>{human(j.kind)}</strong>
                      <small>#{j.id}</small>
                    </td>
                    <td>
                      <code>
                        {short(
                          j.mint ??
                            j.payload?.wallet ??
                            j.payload?.address ??
                            "—",
                        )}
                      </code>
                    </td>
                    <td>
                      <Status value={j.status} />
                      {j.last_error && (
                        <small className="error-text">{j.last_error}</small>
                      )}
                    </td>
                    <td>
                      {j.attempts ?? 0} / {j.max_attempts ?? "—"}
                    </td>
                    <td>{when(j.run_after ?? j.created_at)}</td>
                    <td>
                      {["dead", "failed"].includes(
                        String(j.status).toLowerCase(),
                      ) ? (
                        <button
                          className="button tiny secondary"
                          disabled={busy}
                          onClick={() => retry(String(j.id))}
                        >
                          <RefreshCw size={12} />
                          Retry
                        </button>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon={CheckCheck} title="No queued work returned">
            Jobs appear after intake, reconciliation, or a requested research
            pass.
          </Empty>
        )}
      </Section>
      <div className="two-column">
        <Section title="Pipeline measurements" kicker="OBSERVED, NOT PROJECTED">
          {data.metrics ? (
            <div className="metrics-list">
              {Object.entries(data.metrics).map(([key, value]) => (
                <div key={key}>
                  <span>{human(key)}</span>
                  <b>
                    {value == null
                      ? "Not measured"
                      : typeof value === "object"
                        ? JSON.stringify(value)
                        : String(value)}
                  </b>
                </div>
              ))}
            </div>
          ) : (
            <Empty icon={Activity} title="No measurements returned">
              Latency and coverage need a live pilot before they can be claimed.
            </Empty>
          )}
        </Section>
        <Section title="Operator audit" kicker="CONTROL HISTORY">
          {array(data.audit).length ? (
            <div className="audit-list">
              {array(data.audit).map((a, i) => (
                <div key={a.id ?? i}>
                  <span className="audit-dot" />
                  <div>
                    <strong>
                      {human(
                        a.action ?? a.mode ?? a.to_mode ?? "Operator change",
                      )}
                    </strong>
                    <p>
                      {a.reason ?? a.details?.reason ?? "No reason recorded"}
                    </p>
                    <small>{when(a.created_at ?? a.changed_at)}</small>
                    <details>
                      <summary>Audit record</summary>
                      <Json value={a} />
                    </details>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <Empty icon={Shield} title="No operator changes returned">
              Mode changes and manual controls leave an audit record.
            </Empty>
          )}
        </Section>
      </div>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
