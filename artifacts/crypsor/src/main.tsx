import {requestJson} from './request-json.ts';
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
  const pageCache = useRef(new Map<string,{data:Row,at:number}>());
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
    pageCache.current.clear();
    sessionStorage.removeItem("hunter.access");
    setToken("");
    setData(null);
    setOverview(null);
    setVerified(false);
    setInput("");
  }, []);
  const api = useCallback(
    async (path: string, options: RequestInit = {}) => {
      try {
        return await requestJson(`/api${path}`,{...options,headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`,...options.headers}});
      } catch(error) {
        if(error instanceof Error&&error.message.includes('session expired'))logout();
        throw error;
      }
    },
    [token, logout],
  );
  const pagePath=page==='room'&&mint?`/tokens/${encodeURIComponent(mint)}`:page==='decisions'?'/decisions':page==='memory'?`/memory?q=${encodeURIComponent(search)}`:page==='operations'?'/operations':'/overview';
  const refresh = useCallback(async (force=false) => {
    if (!token) return;
    const generation=++requestGeneration.current;
    const cached=pageCache.current.get(pagePath);
    if(cached){setData(cached.data);setLastRefresh(new Date(cached.at));if(!force&&Date.now()-cached.at<15000){setLoading(false);return;}}
    setLoading(true);setError('');
    try{
      const result=await api(pagePath);
      if(generation!==requestGeneration.current)return;
      pageCache.current.set(pagePath,{data:result,at:Date.now()});
      if(pageCache.current.size>20)pageCache.current.delete(pageCache.current.keys().next().value!);
      setData(result);setVerified(true);setLastRefresh(new Date());
      if(pagePath==='/overview')setOverview(result);
      else if(result.mode)setOverview(previous=>({...previous,mode:result.mode}));
    }catch(e){if(generation===requestGeneration.current)setError(e instanceof Error?e.message:'Unable to reach Hunter.');}
    finally{if(generation===requestGeneration.current)setLoading(false);}
  },[api,token,pagePath]);
  useEffect(()=>{
    setData(pageCache.current.get(pagePath)?.data??null);
    void refresh();
    const interval=window.setInterval(()=>{if(document.visibilityState==='visible')void refresh(true);},60000);
    const visible=()=>{if(document.visibilityState==='visible')void refresh();};
    document.addEventListener('visibilitychange',visible);
    return ()=>{clearInterval(interval);document.removeEventListener('visibilitychange',visible);};
  },[refresh,pagePath]);
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
      pageCache.current.clear();
      await refresh(true);
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
      "Every watched wallet. Add addresses in Cabin / memory.",
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
              <button className="button secondary" onClick={()=>void mutate("/wallets/scan")} disabled={busy}>Scan wallets</button>
              <button className="button primary" onClick={()=>navigate("memory")}><Plus size={16}/>Add wallet</button>
              <span className="refresh-time">
                {lastRefresh
                  ? `View checked ${lastRefresh.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`
                  : "Awaiting first response"}
              </span>
              <button
                className="button secondary"
                onClick={() => void refresh(true)}
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
                        label: "Recorded buys",
                        value: stat.buys,
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
                              : s.label === "Recorded buys"
                                ? "Actual entries with decoded amounts"
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
              {page === "memory" && <ExperimentMemory experiments={array(data?.experiments)}/>}
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
                                  Last scan: {when(w.last_scan_at??w.last_success_at)} · {w.last_scan_count??"—"} transactions checked
                                  {w.cursor
                                    ? ` · Cursor ${short(w.cursor)}`
                                    : ""}
                                </small>
                                {w.pending_cursor&&<small>Older transactions are catching up.</small>}
                                {w.last_error&&<small className="error-text">Scan issue: {human(w.last_error)}</small>}
                              </div>
                              <Status value={w.active===false?"INACTIVE":w.last_error?"NEEDS_ATTENTION":w.last_scan_at?"TRACKING":"AWAITING_SCAN"}/>

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
                          placeholder="Solana address only — no EVM / 0x addresses"
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
  const [search,setSearch]=useState('');
  const [risk,setRisk]=useState('ALL');
  const filtered=tokens.filter(t=>(risk==='ALL'||t.risk===risk)&&[t.name,t.symbol,t.mint,...(t.wallets??[])].join(' ').toLowerCase().includes(search.toLowerCase()));
  return tokens.length ? (
    <div className="table-scroll">
      <div className="token-filters"><label>Search tokens<input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Name, ticker, mint or wallet" /></label><label>Structural risk<select value={risk} onChange={e=>setRisk(e.target.value)}><option value="ALL">All risks</option><option>UNKNOWN</option><option>UNASSESSED</option><option>ELEVATED</option></select></label><small>{filtered.length} results · latest 100 discoveries</small></div>
      <div className="mobile-token-cards">{filtered.map(t=><button key={t.mint} className="mobile-token-card" onClick={()=>openToken(t.mint)}><div><TokenAvatar token={t}/><strong>{t.name||'Unresolved token'} <small>{t.symbol||'Symbol unknown'}</small></strong><ArrowUpRight size={18}/></div><code>{short(t.mint,10)}</code><p>{t.description||'Metadata description unavailable. Open the report for source evidence and research gaps.'}</p><div><span>Price {money(t.price_usd)}</span><span>Liquidity {money(t.liquidity_usd)}</span></div><div><Status value={t.risk} kind="risk"/><Status value={t.confidence} kind="confidence"/><span>{t.wallets?.length??0} wallets</span></div><div><span>Since covered buy: {gainText(t.gain_summary?.gain_percent)}</span><span>All-time observed peak: {gainText(t.gain_summary?.peak_observed_gain_percent)}</span></div><small>{t.gain_summary?`${t.buy_count} recorded buys · ${t.gain_summary.quote_symbol} · first covered entry`:'No eligible actual purchase entry yet'}</small><small>Gain quote {when(t.gain_summary?.current_observed_at)}{t.gain_summary?.current_observed_at&&!t.gain_summary.quote_fresh?" (stale)":""} · market {when(t.market_updated_at)}</small></button>)}</div>
      <table className="token-table">
        <thead>
          <tr>
            <th>Token / identity</th>
            <th>Discovery</th>
            <th>Market context</th>
            <th>Gains from actual buy</th>
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
          {filtered.map((t) => (
            <tr key={t.mint}>
              <td>
                <button
                  className="token-button"
                  onClick={() => openToken(t.mint)}
                >
                  <TokenAvatar token={t}/>
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
              <td><strong>{gainText(t.gain_summary?.gain_percent)}</strong><small>From first covered buy</small><small>All-time observed peak {gainText(t.gain_summary?.peak_observed_gain_percent)}</small><small>{t.buy_count??0} buys · {t.gain_summary?.quote_symbol??"Entry unavailable"}{t.gain_summary?.current_observed_at?` · ${when(t.gain_summary.current_observed_at)}${t.gain_summary.quote_fresh?"":" (stale)"}`:""}</small></td>
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

function Decision({d,openToken}:{d:Row;openToken?:(mint:string)=>void}){
 const modern=d.rule_version==='hunter-facts-v2';
 const gaps=array(d.unknowns) as any[];
 return <article className="decision-card compact-decision">
  <div className="decision-head"><div><span className="version-label">VERSION {d.version} · {when(d.known_at)}</span><h3>{modern?'Rule-based observations':'Earlier rule-based record'}{openToken&&<button className="icon-button" aria-label="Open token room" onClick={()=>openToken(d.mint)}><ArrowUpRight size={15}/></button>}</h3></div><Status value={d.action}/></div>
  {modern?<div className="report-copy"><ul>{list(d.context?.evidenceSummary).map((line:any,i:number)=><li key={i}>{typeof line==='string'?line:line.value}</li>)}</ul><p>{d.counter_thesis}</p></div>:<details className="report-copy"><summary>Read earlier generated text</summary><p>{d.thesis}</p><p>{d.counter_thesis}</p></details>}
  {gaps.length>0&&<details className="report-copy"><summary>{gaps.length} evidence limitations</summary><ul>{gaps.map((gap:any,i:number)=><li key={i}>{String(gap)}</li>)}</ul></details>}
  {d.context?.modelHypotheses&&<details className="report-copy"><summary>Unverified AI hypotheses · {d.context.modelHypotheses.model}</summary><p>{d.context.modelHypotheses.thesis}</p><p>{d.context.modelHypotheses.counter_thesis}</p><p>Citations: {(d.context.modelHypotheses.cited_evidence_ids??[]).join(', ')}</p></details>}
  <div className="decision-foot"><span>Recorded {when(d.known_at)}</span><span>{d.rule_version} · {d.model_version==='none'?'No AI used':d.model_version}</span></div>
  <LazyRecord label="Gate checks and provenance" value={{gate:d.gate,evidence_ids:d.evidence_ids,contradictions:d.contradictions,reviewer:d.reviewer_result}}/>
 </article>;
}
function LazyRecord({label,value}:{label:string;value:unknown}){const [open,setOpen]=useState(false);return <details className="lazy-record" onToggle={e=>setOpen(e.currentTarget.open)}><summary>{label}</summary>{open&&<Json value={value}/>}</details>;}
function quantityText(raw:unknown,decimals:unknown){
 const text=String(raw??'');const places=Number(decimals);
 if(!/^\d+$/.test(text)||!Number.isInteger(places)||places<0||places>30)return 'Not returned';
 const padded=text.padStart(places+1,'0'),whole=places?padded.slice(0,-places):padded,fraction=places?padded.slice(-places).replace(/0+$/,''):'';
 return BigInt(whole).toLocaleString()+(fraction?'.'+fraction.slice(0,6)+(fraction.length>6?'…':''):'');
}
function coverageMessage(code:string){
 if(code.includes('REQUEST_CAP'))return 'Request allowance reached; the next attempt is deferred.';
 if(code.includes('NOT_CONFIGURED'))return code.startsWith('jupiter')?'Optional Jupiter cross-check is not enabled.':'Helius is not connected.';
 if(code.includes('429')||code.includes('RATE_LIMIT'))return 'Provider rate limit; retry is deferred.';
 if(code.includes('401')||code.includes('403'))return 'Provider access was denied. Check the saved credentials.';
 if(code.startsWith('offchain'))return 'Publisher metadata could not be retrieved from an approved public gateway.';
 return 'A source request did not complete: '+human(code)+'.';
}
function TokenRoom({data,mint,busy,requestResearch,onBack}:{data:Row;mint:string;busy:boolean;requestResearch:()=>void;onBack:()=>void}){
 const [history,setHistory]=useState<Row|null>(null),[auditLoading,setAuditLoading]=useState(false),[auditError,setAuditError]=useState('');
 useEffect(()=>{setHistory(null);setAuditError('');},[mint]);
 const t=data.token??{},metadata=array(data.metadata),verified=metadata.find(row=>row.data?.authoritySourceVerified===true),holders=array(data.holders)[0];
 const missing=(t.coverage?.missing_fields??[]) as string[],errors=(t.coverage?.source_errors??[]).filter((code:string)=>code!=='jupiter:NOT_CONFIGURED');
 const names:Record<string,string>={name:'name',symbol:'ticker',image_uri:'image',price_usd:'market price',description:'description'};
 const evidence=array(data.evidence).filter(row=>row.claim!=='Research coverage gaps');
 async function loadHistory(){setAuditLoading(true);setAuditError('');try{setHistory(await requestJson(`/api/tokens/${encodeURIComponent(mint)}?history=1`,{headers:{Authorization:`Bearer ${sessionStorage.getItem('hunter.access')??''}`}}));}catch(error){setAuditError(error instanceof Error?error.message:'History unavailable');}finally{setAuditLoading(false);}}
 return <>
  <div className="token-room-top"><button className="text-link" onClick={onBack}>← All discovered tokens</button><button className="button secondary" onClick={requestResearch} disabled={busy}><RefreshCw size={14}/>Refresh report</button></div>
  <div className="token-identity"><TokenAvatar token={t}/><div><h2>{t.name||'Unresolved token'} <Badge>{t.symbol||'Ticker unavailable'}</Badge></h2><div className="mint"><code>{mint}</code><button className="icon-button" aria-label="Copy token mint" onClick={()=>void navigator.clipboard.writeText(mint)}><ClipboardList size={14}/></button><Source url={`https://solscan.io/token/${mint}`} label="Explorer"/></div></div></div>
  <div className="readiness-strip"><Status value={t.enrichment_state??'pending'}/><span>{missing.length?'Not returned: '+missing.map(field=>names[field]??field).join(', '):'Identity and market fields available'}</span><small>Checked {when(t.enrichment_checked_at)}</small></div>
  {errors.length>0&&<div className="source-notices" role="status">{[...new Set(errors.map(coverageMessage))].map((message:any,i)=><p key={i}>{message}</p>)}</div>}
  <div className="stats-grid room-stats">
   <div className="stat-card"><span>Observed price</span><strong>{money(t.price_usd)}</strong><small>Retrieved {when(t.market_updated_at)}</small></div>
   <div className="stat-card"><span>Venue liquidity</span><strong>{money(t.liquidity_usd)}</strong><small>{t.market_data?.venue||'Venue not returned'}</small></div>
   <div className="stat-card"><span>Provider market-cap estimate</span><strong>{money(t.market_data?.marketCap)}</strong><small>FDV {money(t.market_data?.fdv)}</small></div>
   <div className="stat-card"><span>24h reported volume</span><strong>{money(t.market_data?.volume?.h24)}</strong><small>Source: {t.market_data?.source||'Not retrieved'}</small></div>
  </div>
  <PurchasePanel mint={mint} purchases={array(data.purchases)} total={data.purchase_count??0} priceError={t.price_error}/>
  <Section title="Token brief" kicker="OBSERVATIONS & PUBLISHER METADATA">
   <div className="report-copy"><p>{t.description||`${t.name||'This mint'} is a Solana token with ${array(data.events).length} swap output(s) shown in this report. No publisher description was retrieved.`}</p>{t.description&&<small>Publisher-provided description; creator affiliation is not verified.</small>}<div className="report-signals"><span>Priority <Status value={t.priority} kind="priority"/></span><span>Structural risk <Status value={t.risk} kind="risk"/></span><span>Evidence <Status value={t.confidence} kind="confidence"/></span></div><div className="source-links">{array(t.market_data?.websites).map((link,i)=><Source key={i} url={link.url} label={link.label||'Website'}/>)}{array(t.market_data?.socials).map((link,i)=><Source key={i} url={link.url} label={link.type||'Social'}/>)}{t.market_data?.pairUrl&&<Source url={t.market_data.pairUrl} label="Market pair"/>}</div><details><summary>Coverage and source limitations</summary><p>Prices are retrieved observations, not guaranteed live quotes. Market APIs can share underlying venues. Creator affiliation, originality, social authenticity, MEV attribution and calibrated predictions are not established by this report.</p>{t.coverage?.optional_sources?.jupiter==='not_enabled'&&<p>Optional Jupiter market cross-check is not enabled. The Helius/DEX flow does not require it.</p>}</details></div>
  </Section>
  <div className="two-column token-room-layout"><div>
   <Section title="Current assessment" kicker="LATEST JOURNAL RECORD">{array(data.decisions).length?<Decision d={array(data.decisions)[0]}/>:<div className="report-copy"><p>No assessment recorded yet. Basic observations remain available in Watch Only; Full research enables the rule journal.</p></div>}</Section>
   <Section title="On-chain checks" kicker="SCOPE: MINT ACCOUNT & LARGEST TOKEN ACCOUNTS"><div className="report-copy"><dl className="fact-grid"><div><dt>Mint authority</dt><dd>{verified?verified.mint_authority===null?'Revoked':short(verified.mint_authority,10):'Not verified'}</dd></div><div><dt>Freeze authority</dt><dd>{verified?verified.freeze_authority===null?'Revoked':short(verified.freeze_authority,10):'Not verified'}</dd></div><div><dt>Supply</dt><dd>{verified?quantityText(verified.supply,verified.decimals):'Not returned'}</dd></div><div><dt>Decimals</dt><dd>{verified?.decimals??'Not returned'}</dd></div></dl><p>Revoked authorities do not make a token safe. Extensions and market risks require separate review.</p>{holders?<><p>Largest-account sample captured {when(holders.captured_at)}. These are token accounts, not a count of independent holders.</p>{holders.features?.top_accounts_supply_share!=null&&<p>Sample share of supply: {(Number(holders.features.top_accounts_supply_share)*100).toFixed(2)}% · liquidity-pool ownership not classified.</p>}<details><summary>Largest-account ownership sample</summary><div className="holder-list">{array(holders.holders).slice(0,20).map((holder,i)=><div key={i}><code>{holder.owner?short(holder.owner,8):'Owner not resolved'}</code><span>{quantityText(holder.amount_raw,holder.decimals)}</span></div>)}</div></details></>:<p>Holder snapshot not available. Full research requests this sample within the provider allowance.</p>}</div></Section>
   <Section title="Source evidence" kicker="LATEST DISTINCT OBSERVATIONS">{evidence.length?<div className="evidence-list">{evidence.map((entry,i)=><div className="evidence-item compact-evidence" key={entry.id??i}><div><Badge>EV-{entry.id}</Badge><small>{when(entry.known_at)}</small></div><h3>{entry.claim}</h3><div className="evidence-source">{entry.url?<Source url={entry.url} label={entry.provider?.includes('helius')?'Helius RPC endpoint':entry.provider||'Source response'}/>:<small>Derived from stored observations · no external document</small>}<small>Claim confidence: {human(entry.confidence)}</small></div><LazyRecord label="Exact recorded observation" value={{claim_id:entry.id,source_record_id:entry.source_document_id,known_at:entry.known_at,retrieved_at:entry.fetched_at,provider_update_at:entry.source_timestamp,data:entry.data}}/></div>)}</div>:<div className="report-copy">No source-backed claims have been recorded.</div>}</Section>
  </div><div>
   <Section title="Wallet discovery" kicker="RECORDED TRANSACTIONS"><div className="record-list">{array(data.events).slice(0,5).map((event,i)=><div className="discovery-row" key={event.id??i}><Status value={event.commitment}/><p>Wallet <code>{short(event.wallet_address,8)}</code></p><Source url={`https://solscan.io/tx/${event.signature}`} label="Transaction"/><small>{when(event.block_time??event.observed_at)}</small></div>)}</div></Section>
   <Section title="Audit history" kicker="OLDER RECORDS LOAD ON REQUEST"><div className="report-copy"><p>Historical decisions and raw source records are retained. They are not downloaded on initial load.</p><button className="button secondary" disabled={auditLoading} onClick={()=>void loadHistory()}>{auditLoading?'Loading history…':'Load audit history'}</button>{auditError&&<p role="alert">{auditError}</p>}{history&&<><p>{array(history.decisions).length} decisions · {array(history.evidence).length} claims returned (bounded history).</p>{array(history.decisions).map((decision,i)=><LazyRecord key={decision.id??i} label={`Decision version ${decision.version} · ${when(decision.known_at)}`} value={decision}/>)}<LazyRecord label="Raw metadata, holders and diagnostics" value={{metadata:history.metadata,holders:history.holders,evidence:history.evidence,jobs:history.jobs}}/></>}</div></Section>
  </div></div>
 </>;
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
      <ProviderSettings />
      {array(data.parseGaps).length>0&&<Section title="Transactions needing verification" kicker="RECENT UNRESOLVED SWAPS"><p>These transactions could not establish an unambiguous supported payment and receipt. They are excluded from actual entries and gains.</p><div className="record-list">{array(data.parseGaps).map((gap,i)=><div key={i}><Source url={gap.url} label={short(gap.payload?.signature??'Transaction',12)}/><small>{when(gap.fetched_at)}</small></div>)}</div></Section>}
      {data.tracking&&<Section title="Buy and gain tracking" kicker="BACKGROUND STATUS"><p>{data.tracking.backgroundEnabled?(data.tracking.workerHealthy?'Background worker is reporting.':'No recent worker heartbeat. Check Render logs; scans cannot run while the service sleeps.'):'Background processing is disabled. Enable it on the backend to collect buys and prices.'}</p><p>Price batches check up to {data.tracking.priceBatchSize} purchased tokens about every {Math.ceil(data.tracking.priceBatchIntervalSeconds/60)} minutes, within public API caps. Larger collections rotate across batches. The initial wallet scan covers the latest {data.tracking.initialSignatureLimit} signatures; subsequent scans catch up from their saved cursor.</p></Section>}
      {data.polling&&<Section title="Free-budget polling" kicker="HELIUS REQUEST ALLOWANCE"><p>Automatic scan interval: approximately {Math.ceil(data.polling.intervalSeconds/60)} minutes per wallet. Today: {data.polling.usedToday} / {data.polling.dailyRequestCap} requests. Month: {data.polling.usedMonth} / {data.polling.monthlyRequestCap}.</p><p>This local allowance reserves requests for metadata. Scan wallets requests an earlier scan within the same hard caps. Helius credit usage and entitlement must be checked in your provider dashboard.</p></Section>}
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

function TokenAvatar({token}:{token:Row}) {
 const candidates=[...new Set([token.image_uri,...(Array.isArray(token.image_candidates)?token.image_candidates:[])].map(safeUrl).filter((url):url is string=>Boolean(url)))];
 const key=candidates.join('|');const [index,setIndex]=useState(0);useEffect(()=>setIndex(0),[key]);
 return <span className="token-avatar" title={candidates[index]?'Publisher-supplied token image':'Image unavailable'}>{candidates[index]?<img src={candidates[index]} alt="" loading="lazy" referrerPolicy="no-referrer" onError={()=>setIndex(value=>value+1)}/>:String(token.symbol??'?').slice(0,2)}</span>;
}
function ProviderSettings(){
 const [key,setKey]=useState(''),[status,setStatus]=useState<Row|null>(null),[message,setMessage]=useState(''),[saving,setSaving]=useState(false),[daily,setDaily]=useState('500'),[monthly,setMonthly]=useState('10000');
 const headers=()=>({Authorization:`Bearer ${sessionStorage.getItem('hunter.access')??''}`,'Content-Type':'application/json'});
 useEffect(()=>{requestJson('/api/settings',{headers:headers()}).then(data=>{setStatus(data);setDaily(String(data.heliusDailyRequestCap));setMonthly(String(data.heliusMonthlyRequestCap));}).catch(e=>setMessage(e instanceof Error?e.message:'Settings unavailable.'));},[]);
 async function save(e:FormEvent){e.preventDefault();setSaving(true);setMessage('Checking Helius connection…');try{await requestJson('/api/settings/helius',{method:'POST',headers:headers(),body:JSON.stringify({apiKey:key.trim()})});setKey('');setStatus({...status,heliusConfigured:true});setMessage('Helius connected. Add a wallet, then tap Scan wallets. Basic metadata works in Watch only; Full research adds holder snapshots and the decision journal.');}catch(e){setMessage(e instanceof Error?e.message:'Could not save key');}finally{setSaving(false);}}
 async function saveTracking(e:FormEvent){e.preventDefault();setSaving(true);try{await requestJson('/api/settings/tracking',{method:'POST',headers:headers(),body:JSON.stringify({dailyRequestCap:Number(daily),monthlyRequestCap:Number(monthly)})});setMessage('Local request limits saved. The scheduler will apply them within a minute. Refresh Operations to see the recalculated interval.');}catch(e){setMessage(e instanceof Error?e.message:'Could not save request limits');}finally{setSaving(false);}}
 return <Section title="Helius connection" kicker="MOBILE SETTINGS · SOLANA MAINNET"><p>{status?.heliusConfigured?'Helius key configured. Replace it below at any time.':'Add your own Helius API key to begin wallet polling.'}</p><form className="wallet-form" onSubmit={save}><label htmlFor="helius-key">Helius API key</label><input id="helius-key" type="password" autoComplete="new-password" value={key} onChange={e=>setKey(e.target.value)} required maxLength={256} placeholder="Paste your Helius key"/><button className="button primary" disabled={saving||!key.trim()}>Verify and save key</button><p role="status">{message}</p><small>Your key is encrypted in the database and is never returned to the browser. Polling runs while the Render service is awake. Free Render sleep still interrupts background work.</small></form><details><summary>Adjust wallet polling request allowance</summary><p>The default local limits can make scans several minutes apart, and longer with more wallets. These are request counts, while Helius bills by credits. Set limits that fit the free allowance shown in your Helius dashboard; Hunter does not verify your plan or enable a paid upgrade.</p><form className="wallet-form" onSubmit={saveTracking}><label>Daily Helius request limit<input type="number" min="0" max="20000" required value={daily} onChange={e=>setDaily(e.target.value)}/></label><label>Monthly Helius request limit<input type="number" min="0" max="500000" required value={monthly} onChange={e=>setMonthly(e.target.value)}/></label><button className="button secondary" disabled={saving}>Save tracking limits</button></form></details></Section>;
}

function gainText(value:unknown){if(value===null||value===undefined||!Number.isFinite(Number(value)))return 'Unavailable';return (Number(value)>0?'+':'')+Number(value).toLocaleString(undefined,{maximumFractionDigits:2})+'%';}
function PurchasePanel({mint,purchases,total,priceError}:{mint:string;purchases:Row[];total:number;priceError?:string}){
 const [extra,setExtra]=useState<Row[]>([]),[replay,setReplay]=useState<Row|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[take,setTake]=useState('20'),[stop,setStop]=useState('10'),[selected,setSelected]=useState('');
 useEffect(()=>{setExtra([]);setReplay(null);setMessage('');setSelected(purchases[0]?.id??'');},[mint,purchases]);
 const buys=[...new Map([...purchases,...extra].map(b=>[b.id,b])).values()];
 const headers=()=>({Authorization:`Bearer ${sessionStorage.getItem('hunter.access')??''}`,'Content-Type':'application/json'});
 async function more(){setBusy(true);try{const result=await requestJson(`/api/buys?mint=${encodeURIComponent(mint)}&offset=${buys.length}`,{headers:headers()});setExtra([...extra,...result.buys]);}catch(error){setMessage(error instanceof Error?error.message:'Could not load buys');}finally{setBusy(false);}}
 async function run(){setBusy(true);setMessage('');try{setReplay(await requestJson(`/api/tokens/${encodeURIComponent(mint)}/replay?purchase_id=${encodeURIComponent(selected)}&take_profit=${encodeURIComponent(take)}&stop_loss=${encodeURIComponent(stop)}`,{headers:headers()}));}catch(error){setMessage(error instanceof Error?error.message:'Replay unavailable');}finally{setBusy(false);}}
 async function save(){if(!replay?.available)return;setBusy(true);try{const result=await requestJson(`/api/tokens/${encodeURIComponent(mint)}/experiments`,{method:'POST',headers:headers(),body:JSON.stringify({purchaseId:replay.purchase.id,takeProfit:replay.parameters.takeProfit,stopLoss:replay.parameters.stopLoss,datasetFingerprint:replay.dataset_fingerprint})});setMessage(`Paper replay ${result.experiment.id} saved to memory. This is retrospective, not a forward prediction.`);}catch(error){setMessage(error instanceof Error?error.message:'Save failed');}finally{setBusy(false);}}
 async function recheck(){setBusy(true);try{await requestJson('/api/wallets/scan',{method:'POST',headers:headers(),body:JSON.stringify({replayRecent:true})});setMessage('Recent-transaction recheck queued within provider caps. At most 100 finalized signatures per wallet; normal catch-up cursor is preserved.');}catch(error){setMessage(error instanceof Error?error.message:'Could not queue');}finally{setBusy(false);}}
 return <Section title="Actual wallet buys & gains" kicker="EVERY RECORDED BUY · MATCHING QUOTE CURRENCY"><div className="report-copy">
  <p>{total} recorded buys. Gains use each actual swap entry. The all-time observed peak retains the highest collected gain since that buy; unobserved candles may contain a higher peak. These are price returns, including after a wallet sells, rather than realized profit.</p>
  {priceError&&<p role="status">Price collection: {human(priceError)}. Previous samples are retained.</p>}
  {buys.length?buys.map(buy=><div key={buy.id} className="purchase-row">
   <p><strong>Buy #{buy.id} · wallet {short(buy.wallet_address)}</strong></p>
   <p>{quantityText(buy.token_raw,buy.token_decimals)} tokens bought for {quantityText(buy.quote_raw,buy.quote_decimals)} {buy.quote_symbol} · {when(buy.block_time??buy.known_at)}</p>
   <p>Actual entry: {Number(buy.entry_quote_price).toPrecision(7)} {buy.quote_symbol} per token</p>
   <div className="report-signals"><span>Last observed gain <strong>{gainText(buy.gain_percent)}</strong></span><span>All-time observed peak <strong>{gainText(buy.peak_observed_gain_percent)}</strong></span></div>
   <small>{buy.samples} matching-currency samples · last quote {when(buy.current_observed_at)}{buy.current_observed_at&&!buy.quote_fresh?' (stale)':''}{buy.detection_lag_seconds!=null?` · event first recorded ${Math.max(0,Math.round(Number(buy.detection_lag_seconds)/60))} minutes after block time`:''}</small>
   <p className="muted">{buy.data?.fee_scope??'Swap input only; network fees excluded.'} This may not be the first lifetime buy.</p><Source url={`https://solscan.io/tx/${buy.signature}`} label="Purchase transaction"/>
  </div>):<p>No eligible actual entry is recorded yet. Unsupported or ambiguous transactions stay unavailable until decoded. Displayed market prices are never substituted as entry.</p>}
  {buys.length<total&&<button className="button secondary" disabled={busy} onClick={()=>void more()}>Load older buys ({buys.length} of {total})</button>}
  <button className="button secondary" disabled={busy} onClick={()=>void recheck()}>Recheck recent wallet buys</button>
  <details><summary>Replay collected quotes and save a paper experiment</summary><p>Collected samples do not form a complete candle backtest. Unrecorded intervals, exit fees, slippage and liquidity constraints are not modeled.</p>
   <label>Replay purchase<select aria-label="Replay purchase" value={selected} onChange={e=>{setSelected(e.target.value);setReplay(null);}}>{buys.map(b=><option key={b.id} value={b.id}>Buy #{b.id} · {short(b.wallet_address)} · {when(b.block_time??b.known_at)}</option>)}</select></label>
   <div className="replay-inputs"><label>Take-profit %<input type="number" min="0.1" max="10000" value={take} onChange={e=>setTake(e.target.value)}/></label><label>Stop-loss %<input type="number" min="0.1" max="100" value={stop} onChange={e=>setStop(e.target.value)}/></label></div>
   <button className="button secondary" disabled={busy||!selected} onClick={()=>void run()}>Replay collected quotes</button>
   {replay&&(replay.available?<div><p>{replay.samples.length} observed quotes · last change {gainText(replay.result.mark_to_market_gain_percent)} · largest unobserved interval {Math.round(replay.result.max_unobserved_gap_seconds/60)} minutes.{replay.truncated?' Limited to the first 5,000 samples; later observations are excluded.':''}</p><p>{replay.result.exit_observed?`First observed threshold crossing: ${gainText(replay.result.exit_observed.gain_percent)} at ${when(replay.result.exit_observed.observed_at)}`:'No threshold crossing was observed in the collected samples.'}</p><button className="button primary" disabled={busy} onClick={()=>void save()}>Save paper replay</button><LazyRecord label="Replay samples and limitations" value={replay}/></div>:<p>{replay.reason}</p>)}
  </details><p role="status">{message}</p></div></Section>;
}
function ExperimentMemory({experiments}:{experiments:Row[]}){return experiments.length?<Section title="Saved paper replays" kicker="RETROSPECTIVE RESEARCH MEMORY"><div className="record-list">{experiments.map(experiment=><div key={experiment.id}><p>Replay {experiment.id} · {short(experiment.mint)} · {when(experiment.created_at)}</p><p>{experiment.classification} · {experiment.result?.sample_count} quotes · last observed change {gainText(experiment.result?.mark_to_market_gain_percent)}</p><LazyRecord label="Parameters, result and dataset fingerprint" value={experiment}/></div>)}</div></Section>:null;}
