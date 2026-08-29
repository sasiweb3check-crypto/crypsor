import { Route, Switch, Link, Router as WouterRouter, useLocation } from "wouter";
import DeskPage from "./pages/ward";
import TokenPage from "./pages/patient";
import SettingsPage from "./pages/settings";
import Toasts from "./components/toasts";

function Nav() {
  const [loc] = useLocation();
  const on = (href: string) => loc === href || (href === "/" && loc.startsWith("/p/"));
  return (
    <nav className="nav">
      <span className="brand">Crypsor</span>
      <Link href="/" className={on("/") ? "on" : ""}>Desk</Link>
      <Link href="/settings" className={on("/settings") ? "on" : ""}>Settings</Link>
    </nav>
  );
}

export default function App() {
  return (
    <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
      <div className="app">
        <Nav />
        <Toasts />
        <Switch>
          <Route path="/" component={DeskPage} />
          <Route path="/p/:id" component={TokenPage} />
          <Route path="/settings" component={SettingsPage} />
          <Route>
            <div className="page"><div className="empty">Page not found</div></div>
          </Route>
        </Switch>
      </div>
    </WouterRouter>
  );
}
