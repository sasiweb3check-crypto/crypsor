import { Route, Switch, Link, Router as WouterRouter, useLocation } from "wouter";
import WardPage from "./pages/ward";
import PatientPage from "./pages/patient";
import AlertsPage from "./pages/alerts";
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
    <Link href={href} className={loc === href || (href === "/" && loc.startsWith("/p/")) ? "on" : ""}>
      <Icon d={d} />
      {label}
    </Link>
  );
  return (
    <nav className="nav">
      {item("/", "Trades", "M3 10.5 12 4l9 6.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z")}
      {item("/alerts", "Book", "M12 4a7 7 0 0 1 7 7v4l1.5 2.5H3.5L5 15v-4a7 7 0 0 1 7-7zm0 16a2.5 2.5 0 0 0 2.5-2.5h-5A2.5 2.5 0 0 0 12 20z")}
      {item("/agents", "Agents", "M12 3 4 7v5c0 5 3.4 8.4 8 9 4.6-.6 8-4 8-9V7l-8-4zm0 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6z")}
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
          <Route path="/alerts" component={AlertsPage} />
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
