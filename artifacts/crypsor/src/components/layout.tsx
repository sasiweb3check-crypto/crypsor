import { Link, useLocation } from "wouter";
import { Settings, Activity, Zap, Bell } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { getApiBase } from "@/lib/api-base";
import { RUNNER_ALERTS_KEY, fetchRunnerAlerts } from "@/lib/runner-api";

type NavItem = {
  href: string;
  label: string;
  icon: React.ElementType;
  desc: string;
  pro?: boolean;
  prefetch?: "alerts";
};

const NAV: NavItem[] = [
  { href: "/",        label: "Runner",  icon: Zap,      desc: "Radar · entry", pro: true },
  { href: "/alerts",  label: "Alerts",  icon: Bell,     desc: "ENTRY pings", prefetch: "alerts" },
  { href: "/ops",     label: "Logs",    icon: Activity, desc: "Buys · pipeline" },
  { href: "/settings",label: "Settings",icon: Settings, desc: "Keys · Telegram" },
];

function isActive(location: string, href: string) {
  if (href === "/") {
    return location === "/" || location === "/pro" || location === "/caller"
      || location.startsWith("/tokens/");
  }
  return location === href || location.startsWith(`${href}/`);
}

function useHeliusOk() {
  const { data } = useQuery<{ running: boolean; heliusConfigured: boolean }>({
    queryKey: ["monitor-status-mini"],
    queryFn: () => fetch(`${getApiBase()}api/monitor/status`).then(r => r.json()),
    refetchInterval: 60_000,
    staleTime: 45_000,
  });
  return data?.heliusConfigured;
}

function usePrefetchAlerts() {
  const qc = useQueryClient();
  return () => {
    void qc.prefetchQuery({
      queryKey: RUNNER_ALERTS_KEY,
      queryFn: fetchRunnerAlerts,
      staleTime: 6_000,
    });
  };
}

function NavLink({ href, label, icon: Icon, desc, pro, prefetch }: NavItem) {
  const [location] = useLocation();
  const active = isActive(location, href);
  const prefetchAlerts = usePrefetchAlerts();
  return (
    <Link href={href}>
      <div
        className={cn(
          "relative flex items-center gap-3 px-3 py-2.5 cursor-pointer select-none transition-colors",
          active ? "text-[var(--cryp-mint)]" : "text-[var(--cryp-mute)] hover:text-[var(--cryp-text)]",
        )}
        style={{
          borderLeft: active ? "2px solid var(--cryp-teal)" : "2px solid transparent",
          background: active ? "rgba(61,154,139,0.08)" : "transparent",
        }}
        onMouseEnter={() => { if (prefetch === "alerts") prefetchAlerts(); }}
        onFocus={() => { if (prefetch === "alerts") prefetchAlerts(); }}
        onTouchStart={() => { if (prefetch === "alerts") prefetchAlerts(); }}
      >
        <Icon className="w-4 h-4 shrink-0" />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-display text-[12px] font-bold tracking-wide uppercase">{label}</span>
            {pro && (
              <span className="text-[8px] font-bold tracking-wider uppercase px-1.5 py-0.5"
                style={{ color: "var(--cryp-teal)", background: "rgba(61,154,139,0.12)" }}>
                Live
              </span>
            )}
          </div>
          <div className="text-[10px] mt-0.5 opacity-60">{desc}</div>
        </div>
      </div>
    </Link>
  );
}

function Sidebar() {
  const heliusOk = useHeliusOk();
  return (
    <div className="flex flex-col h-full" style={{ background: "rgba(5,10,15,0.96)", borderRight: "1px solid var(--cryp-line)" }}>
      <div className="px-4 py-6" style={{ borderBottom: "1px solid var(--cryp-line)" }}>
        <Link href="/">
          <div className="cursor-pointer select-none">
            <div className="font-display text-[var(--cryp-mint)] font-extrabold tracking-[0.18em] text-sm uppercase">
              Crypsor
            </div>
            <div className="text-[var(--cryp-mute)] text-[10px] tracking-[0.22em] uppercase mt-1">
              Runner Entry
            </div>
          </div>
        </Link>
      </div>
      <nav className="flex-1 py-3">
        {NAV.map(item => <NavLink key={item.href} {...item} />)}
      </nav>
      <div className="px-4 py-4" style={{ borderTop: "1px solid var(--cryp-line)" }}>
        <div className="flex items-center gap-2">
          <span className={cn("w-1.5 h-1.5 rounded-full", heliusOk ? "bg-[var(--cryp-gain)] pulse-dot" : "bg-[var(--cryp-warn)]")} />
          <span className="text-[10px] text-[var(--cryp-mute)] tracking-widest uppercase">
            {heliusOk ? "Scanning" : "No Helius"}
          </span>
        </div>
      </div>
    </div>
  );
}

function BottomNav() {
  const [location] = useLocation();
  const prefetchAlerts = usePrefetchAlerts();
  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-50 md:hidden"
      style={{
        background: "rgba(5,10,15,0.92)",
        backdropFilter: "blur(14px)",
        borderTop: "1px solid var(--cryp-line)",
      }}
    >
      <div className="flex items-stretch justify-around px-2 pt-1.5 pb-safe">
        {NAV.map(({ href, label, icon: Icon, pro, prefetch }) => {
          const active = isActive(location, href);
          return (
            <Link key={href} href={href} className="flex-1">
              <div
                className={cn(
                  "relative flex flex-col items-center gap-0.5 py-1.5",
                  active ? "text-[var(--cryp-mint)]" : "text-[var(--cryp-mute)]",
                )}
                onTouchStart={() => { if (prefetch === "alerts") prefetchAlerts(); }}
              >
                <Icon className="w-[18px] h-[18px]" />
                <span className="text-[9px] font-bold tracking-widest uppercase">{label}</span>
                {active && (
                  <div className="absolute bottom-0 w-6 h-0.5" style={{ background: "var(--cryp-teal)" }} />
                )}
                {pro && !active && (
                  <span className="absolute top-1 right-[28%] w-1 h-1 rounded-full" style={{ background: "var(--cryp-teal)" }} />
                )}
              </div>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const title = NAV.find(n => isActive(location, n.href))?.label
    ?? (location.startsWith("/tokens/") ? "Token" : "Crypsor");

  return (
    <div className="relative min-h-screen w-full desk-surface">
      <aside className="hidden md:flex flex-col w-48 lg:w-52 fixed inset-y-0 z-50">
        <Sidebar />
      </aside>

      <header
        className="fixed top-0 left-0 right-0 z-50 flex md:hidden items-center justify-between px-4 h-12"
        style={{ background: "rgba(5,10,15,0.85)", backdropFilter: "blur(10px)", borderBottom: "1px solid var(--cryp-line)" }}
      >
        <Link href="/">
          <div className="cursor-pointer">
            <div className="font-display text-[var(--cryp-mint)] font-extrabold tracking-[0.16em] text-xs uppercase">Crypsor</div>
            <div className="text-[var(--cryp-mute)] text-[8px] tracking-widest uppercase">{title}</div>
          </div>
        </Link>
        <Link href="/settings">
          <Settings className="w-4 h-4 text-[var(--cryp-mute)]" />
        </Link>
      </header>

      <main className="relative z-10 min-h-screen flex flex-col md:pl-48 lg:pl-52 pt-12 md:pt-0">
        <div className="flex-1 flex flex-col min-w-0 w-full max-w-screen-2xl mx-auto pb-24 md:pb-8">
          {children}
        </div>
      </main>

      <BottomNav />
    </div>
  );
}

export const Layout = AppShell;
