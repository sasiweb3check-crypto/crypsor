import { Route, Switch, Link, Router as WouterRouter, useLocation } from "wouter";
import VaultPage from "./pages/vault";
import PipelinePage from "./pages/pipeline";
import TokenPage from "./pages/token";
import SettingsPage from "./pages/settings";

function Nav() {
  const [loc] = useLocation();
  const item = (href: string, label: string) => (
    <Link href={href} className={loc === href ? "v-nav-item is-on" : "v-nav-item"}>
      {label}
    </Link>
  );
  return (
    <nav className="v-nav">
      <span className="v-logo">CRYPSOR<span className="v-green">_</span></span>
      {item("/", "VAULT")}
      {item("/pipeline", "PIPELINE")}
      {item("/settings", "SETTINGS")}
    </nav>
  );
}

export default function App() {
  return (
    <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
      <div className="v-shell">
        <Nav />
        <Switch>
          <Route path="/" component={VaultPage} />
          <Route path="/pipeline" component={PipelinePage} />
          <Route path="/t/:id" component={TokenPage} />
          <Route path="/settings" component={SettingsPage} />
          <Route>
            <div className="v-page"><div className="v-empty">404</div></div>
          </Route>
        </Switch>
      </div>
    </WouterRouter>
  );
}
