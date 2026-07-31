import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  LayoutDashboard, Settings, Wallet, Users, Activity, Zap,
  ScrollText, Coins, Menu, X,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { getApiBase } from "@/lib/api-base";
import { StarfieldBg } from "@/components/starfield";

type NavItem = {
  href: string;
  label: string;
  short?: string;
  icon: React.ElementType;
  desc: string;
  pro?: boolean;
};

/** Primary destinations — bottom nav + top of sidebar */
const PRIMARY_NAV: NavItem[] = [
  { href: "/",          label: "Pro",    short: "Pro",    icon: Zap,             desc: "Quality caller intel", pro: true },
  { href: "/dashboard", label: "Dash",   short: "Dash",   icon: LayoutDashboard, desc: "Token intelligence" },
  { href: "/tokens",    label: "Tokens", short: "Tokens", icon: Coins,           desc: "Full token list" },
  { href: "/holders",   label: "Intel",  short: "Intel",  icon: Users,           desc: "Holder activity" },
];

/** Secondary — desktop sidebar + mobile More sheet */
const SECONDARY_NAV: NavItem[] = [
  { href: "/wallets",   label: "Wallets",   icon: Wallet,     desc: "Monitored wallets" },
  { href: "/intel-log", label: "Score Log", icon: ScrollText, desc: "Intel score history" },
  { href: "/ops",       label: "Ops",       icon: Activity,   desc: "Buys · API · alerts" },
  { href: "/settings",  label: "Settings",  icon: Settings,   desc: "API keys & alerts" },
];

const ALL_NAV = [...PRIMARY_NAV, ...SECONDARY_NAV];

function isActive(location: string, href: string) {
  if (href === "/") {
    return location === "/" || location === "/pro" || location === "/caller";
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

function SidebarNavItem({ href, label, icon: Icon, desc, pro }: NavItem) {
  const [location] = useLocation();
  const active = isActive(location, href);
  return (
    <Link href={href}>
      <div
        className={cn(
          "relative flex items-center gap-3 px-3 py-2.5 cursor-pointer select-none transition-colors duration-150",
          active
            ? "border-l-2 border-[#f59e0b] bg-[#f59e0b]/8 text-[#f59e0b]"
            : "border-l-2 border-transparent text-[#8b949e] hover:text-[#c9d1d9] hover:bg-white/[0.03]",
        )}
      >
        <Icon className={cn("w-4 h-4 shrink-0", pro && !active && "text-[#f59e0b]/80")} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-semibold tracking-wide uppercase leading-none">{label}</span>
            {pro && (
              <span
                className="px-1 py-px rounded text-[7px] font-black tracking-wider uppercase"
                style={{ background: "#f59e0b22", color: "#f59e0b", border: "1px solid #f59e0b35" }}
              >
                Live
              </span>
            )}
          </div>
          <div className={cn("text-[10px] mt-0.5 leading-none", active ? "text-[#f59e0b]/60" : "text-[#484f58]")}>
            {desc}
          </div>
        </div>
      </div>
    </Link>
  );
}

function SidebarContent() {
  const heliusOk = useHeliusOk();
  return (
    <div
      className="flex flex-col h-full"
      style={{ background: "rgba(3,6,15,0.92)", borderRight: "1px solid rgba(255,255,255,0.06)" }}
    >
      <div className="px-4 py-5" style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
        <Link href="/">
          <div className="flex items-center gap-2.5 cursor-pointer select-none">
            <Zap className="w-4 h-4 text-[#f59e0b] shrink-0" />
            <div>
              <div className="text-[#f59e0b] font-black tracking-widest text-sm uppercase">CRYPSOR</div>
              <div className="text-[#484f58] text-[9px] tracking-widest uppercase mt-0.5">Token Intelligence</div>
            </div>
          </div>
        </Link>
      </div>

      <nav className="flex-1 py-2 overflow-y-auto no-scrollbar">
        <div className="px-3 pb-1.5 pt-1">
          <span className="text-[8px] font-bold tracking-[0.2em] uppercase text-[#30363d]">Primary</span>
        </div>
        {PRIMARY_NAV.map(item => (
          <SidebarNavItem key={item.href} {...item} />
        ))}
        <div className="px-3 pb-1.5 pt-4">
          <span className="text-[8px] font-bold tracking-[0.2em] uppercase text-[#30363d]">More</span>
        </div>
        {SECONDARY_NAV.map(item => (
          <SidebarNavItem key={item.href} {...item} />
        ))}
      </nav>

      <div className="px-4 py-3 space-y-1.5" style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}>
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "w-1.5 h-1.5 rounded-full shrink-0",
              heliusOk ? "bg-[#22c55e] pulse-dot" : "bg-[#f59e0b]/60",
            )}
          />
          <span className="text-[10px] text-[#8b949e] tracking-widest uppercase">
            {heliusOk ? "Scanning" : "No Helius Key"}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <Activity className="w-2.5 h-2.5 text-[#484f58]" />
          <span className="text-[9px] text-[#484f58] tracking-widest">v0.4 — Pro Intel</span>
        </div>
      </div>
    </div>
  );
}

function MoreSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [location] = useLocation();
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] md:hidden" role="dialog" aria-modal="true" aria-label="More navigation">
      <button
        type="button"
        className="absolute inset-0 bg-black/70 backdrop-blur-[2px]"
        aria-label="Close menu"
        onClick={onClose}
      />
      <div
        className="absolute bottom-0 left-0 right-0 rounded-t-2xl pb-safe animate-in slide-in-from-bottom duration-200"
        style={{
          background: "linear-gradient(180deg, #0d1424 0%, #03060f 100%)",
          borderTop: "1px solid rgba(245,158,11,0.2)",
          boxShadow: "0 -12px 40px rgba(0,0,0,0.55)",
        }}
      >
        <div className="flex items-center justify-between px-4 pt-3 pb-2">
          <div>
            <div className="text-[11px] font-black tracking-widest uppercase text-white">More</div>
            <div className="text-[9px] text-[#484f58] tracking-wide">Wallets, logs & settings</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-full"
            style={{ color: "#8b949e", background: "rgba(255,255,255,0.04)" }}
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-3 pb-3 grid grid-cols-1 gap-1.5">
          {SECONDARY_NAV.map(({ href, label, icon: Icon, desc }) => {
            const active = isActive(location, href);
            return (
              <Link key={href} href={href} onClick={onClose}>
                <div
                  className={cn(
                    "flex items-center gap-3 px-3 py-3 rounded-xl cursor-pointer transition-colors",
                    active ? "text-[#f59e0b]" : "text-[#c9d1d9]",
                  )}
                  style={{
                    background: active ? "rgba(245,158,11,0.1)" : "rgba(255,255,255,0.03)",
                    border: `1px solid ${active ? "rgba(245,158,11,0.35)" : "rgba(255,255,255,0.06)"}`,
                  }}
                >
                  <div
                    className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
                    style={{ background: active ? "rgba(245,158,11,0.15)" : "rgba(255,255,255,0.04)" }}
                  >
                    <Icon className="w-4 h-4" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[12px] font-bold tracking-wide uppercase">{label}</div>
                    <div className="text-[10px] text-[#484f58]">{desc}</div>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function BottomNav({ onMore }: { onMore: () => void }) {
  const [location] = useLocation();
  const moreActive = SECONDARY_NAV.some(n => isActive(location, n.href));

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-50 md:hidden"
      style={{
        background: "rgba(3,6,15,0.88)",
        backdropFilter: "blur(12px)",
        borderTop: "1px solid rgba(255,255,255,0.06)",
      }}
    >
      <div className="flex items-stretch justify-around px-1 pt-1.5 pb-safe">
        {PRIMARY_NAV.map(({ href, label, short, icon: Icon, pro }) => {
          const active = isActive(location, href);
          return (
            <Link key={href} href={href} className="flex-1 min-w-0">
              <div
                className={cn(
                  "relative flex flex-col items-center gap-0.5 px-1 py-1.5 cursor-pointer select-none",
                  active ? "text-[#f59e0b]" : "text-[#484f58]",
                )}
              >
                <div
                  className={cn(
                    "relative flex items-center justify-center w-9 h-7 rounded-lg transition-colors",
                    active && "bg-[#f59e0b]/12",
                    pro && !active && "bg-[#f59e0b]/06",
                  )}
                >
                  <Icon className={cn("w-[18px] h-[18px]", pro && !active && "text-[#f59e0b]/75")} />
                  {pro && (
                    <span
                      className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full"
                      style={{ background: "#f59e0b", boxShadow: "0 0 6px #f59e0b" }}
                    />
                  )}
                </div>
                <span
                  className={cn(
                    "text-[9px] font-bold tracking-widest uppercase truncate max-w-full",
                    active ? "text-[#f59e0b]" : pro ? "text-[#f59e0b]/70" : "text-[#484f58]",
                  )}
                >
                  {short ?? label}
                </span>
                {active && <div className="absolute bottom-0 w-5 h-0.5 rounded-full bg-[#f59e0b]" />}
              </div>
            </Link>
          );
        })}

        <button
          type="button"
          onClick={onMore}
          className={cn(
            "flex-1 min-w-0 relative flex flex-col items-center gap-0.5 px-1 py-1.5 select-none",
            moreActive ? "text-[#f59e0b]" : "text-[#484f58]",
          )}
        >
          <div
            className={cn(
              "flex items-center justify-center w-9 h-7 rounded-lg",
              moreActive && "bg-[#f59e0b]/12",
            )}
          >
            <Menu className="w-[18px] h-[18px]" />
          </div>
          <span className="text-[9px] font-bold tracking-widest uppercase">More</span>
          {moreActive && <div className="absolute bottom-0 w-5 h-0.5 rounded-full bg-[#f59e0b]" />}
        </button>
      </div>
    </nav>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const [moreOpen, setMoreOpen] = useState(false);
  const [location] = useLocation();
  const pageTitle =
    ALL_NAV.find(n => isActive(location, n.href))?.label ??
    (location.startsWith("/tokens/") ? "Token" : "Crypsor");

  useEffect(() => {
    setMoreOpen(false);
  }, [location]);

  return (
    <div className="relative min-h-screen w-full" style={{ background: "#03060f" }}>
      <StarfieldBg />

      {/* Desktop sidebar */}
      <aside className="hidden md:flex flex-col w-52 lg:w-56 fixed inset-y-0 z-50">
        <SidebarContent />
      </aside>

      {/* Mobile top bar */}
      <header
        className="fixed top-0 left-0 right-0 z-50 flex md:hidden items-center justify-between px-4 h-12"
        style={{
          background: "rgba(3,6,15,0.78)",
          backdropFilter: "blur(10px)",
          borderBottom: "1px solid rgba(255,255,255,0.05)",
        }}
      >
        <Link href="/">
          <div className="flex items-center gap-2 cursor-pointer select-none">
            <Zap className="w-4 h-4 text-[#f59e0b] shrink-0" />
            <div className="leading-none">
              <div className="text-[#f59e0b] font-black tracking-widest text-xs uppercase">CRYPSOR</div>
              <div className="text-[#8b949e] text-[8px] tracking-widest uppercase" style={{ marginTop: 1 }}>
                {pageTitle}
              </div>
            </div>
          </div>
        </Link>
        <Link href="/settings">
          <button
            type="button"
            title="Settings"
            className="p-2 rounded-full transition-colors"
            style={{ color: isActive(location, "/settings") ? "#f59e0b" : "#484f58" }}
          >
            <Settings className="w-4 h-4" />
          </button>
        </Link>
      </header>

      {/* Main */}
      <main className="relative z-10 min-h-screen flex flex-col md:pl-52 lg:pl-56 pt-12 md:pt-0">
        <div className="flex-1 flex flex-col min-w-0 w-full max-w-screen-2xl mx-auto pb-24 md:pb-6">
          {children}
        </div>
      </main>

      <BottomNav onMore={() => setMoreOpen(true)} />
      <MoreSheet open={moreOpen} onClose={() => setMoreOpen(false)} />
    </div>
  );
}

/** @deprecated alias — prefer AppShell */
export const Layout = AppShell;
