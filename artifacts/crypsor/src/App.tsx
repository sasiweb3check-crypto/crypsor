import { Route, Switch, Link, Router as WouterRouter, useLocation } from "wouter";
import WardPage from "./pages/ward";
import PatientPage from "./pages/patient";
import StatsPage from "./pages/stats";
import AgentsPage from "./pages/agents";
import SettingsPage from "./pages/settings";

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}

function Nav() {
  const [loc] = useLocation();
  const item = (href: string, label: string, d: string) => (
    <Link href={href} className={loc === href || (href === "/" && loc.startsWith("/p/")) || (href === "/stats" && loc.startsWith("/alerts")) || (href !== "/" && loc.startsWith(href)) ? "on" : ""}>
      <Icon d={d} />
      {label}
    </Link>
  );
  return (
    <nav className="nav">
      {item("/", "Desk", "M3 10.5 12 4l9 6.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z")}
      {item("/stats", "Stats", "M4 19V9h3v10H4zm6.5 0V5h3v14h-3zM17 19v-7h3v7h-3z")}
      {item("/agents", "Logs", "M6 5h12v2H6zm0 6h12v2H6zm0 6h8v2H6z")}
      {item("/settings", "Settings", "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM4 12l1.2-2.2L4 8.2 6.2 7l.6-2.2L9.2 5 12 3.8 14.8 5l2.4-.2.6 2.2L20 8.2l-1.2 1.6L20 12l-1.2 2.2 1.2 1.6-2.2 1.2-.6 2.2-2.4.2L12 20.2 9.2 19l-2.4.2L6.2 17 4 15.8l1.2-1.6z")}
    </nav>
  );
}

export default function App() {
  return (
    <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
      <div className="shell">
        <Switch>
          <Route path="/" component={WardPage} />
          <Route path="/p/:id" component={PatientPage} />
          <Route path="/stats" component={StatsPage} />
          <Route path="/alerts" component={StatsPage} />
          <Route path="/agents" component={AgentsPage} />
          <Route path="/settings" component={SettingsPage} />
          <Route>
            <div className="page"><div className="empty">Page not found</div></div>
          </Route>
        </Switch>
        <Nav />
      </div>
    </WouterRouter>
  );
}
