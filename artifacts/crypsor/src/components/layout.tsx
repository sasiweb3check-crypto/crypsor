import { Link, useLocation } from "wouter";
import { LayoutDashboard, Settings, Wallet, Users, Activity, Zap, ScrollText, Radio, Flame } from "lucide-react";
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";

const NAV = [
  { href: "/",          label: "Dashboard", icon: LayoutDashboard, desc: "Token intelligence" },
  { href: "/feed",      label: "Feed",      icon: Radio,           desc: "Live activity timeline" },
  { href: "/wallets",   label: "Wallets",   icon: Wallet,          desc: "Monitored wallets" },
  { href: "/holders",   label: "Intel",     icon: Users,           desc: "Holder activity" },
  { href: "/intel-log", label: "Score Log",     icon: ScrollText, desc: "Intel score history" },
  { href: "/caller",    label: "Degen Caller", icon: Flame,       desc: "Two-phase call scores" },
  { href: "/settings",  label: "Settings",     icon: Settings,    desc: "API keys" },
];

function useHeliusOk() {
  const { data } = useQuery<{ running: boolean; heliusConfigured: boolean }>({
    queryKey: ["monitor-status-mini"],
    queryFn: () => fetch(`${import.meta.env.BASE_URL}api/monitor/status`).then(r => r.json()),
    refetchInterval: 30_000,
    staleTime: 20_000,
  });
  return data?.heliusConfigured;
}

function NavItem({ href, label, icon: Icon, desc }: {
  href: string; label: string; icon: React.ElementType; desc: string;
}) {
  const [location] = useLocation();
  const active = location === href || (href !== "/" && location.startsWith(href));
  return (
    <Link href={href}>
      <div className={cn(
        "flex items-center gap-3 px-3 py-2.5 cursor-pointer select-none transition-all duration-100",
        active
          ? "border-l-2 border-[#f59e0b] bg-[#f59e0b]/8 text-[#f59e0b]"
          : "border-l-2 border-transparent text-[#8b949e] hover:text-[#c9d1d9] hover:bg-[#161b22]",
      )}>
        <Icon className="w-4 h-4 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-xs font-semibold tracking-wide uppercase leading-none">{label}</div>
          <div className={cn("text-[10px] mt-0.5 leading-none", active ? "text-[#f59e0b]/60" : "text-[#484f58]")}>{desc}</div>
        </div>
      </div>
    </Link>
  );
}

function SidebarContent() {
  const heliusOk = useHeliusOk();
  return (
    <div className="flex flex-col h-full border-r border-[#30363d] bg-[#0d1117]">
      {/* Logo */}
      <div className="px-4 py-5 border-b border-[#30363d]">
        <div className="flex items-center gap-2.5">
          <Zap className="w-4 h-4 text-[#f59e0b] shrink-0" />
          <div>
            <div className="text-[#f59e0b] font-bold tracking-widest text-sm uppercase">CRYPSOR</div>
            <div className="text-[#484f58] text-[9px] tracking-widest uppercase mt-0.5">Token Intelligence</div>
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 py-2">
        {NAV.map(item => <NavItem key={item.href} {...item} />)}
      </nav>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-[#30363d] space-y-1.5">
        <div className="flex items-center gap-2">
          <span className={cn(
            "w-1.5 h-1.5 rounded-full shrink-0",
            heliusOk ? "bg-[#22c55e] pulse-dot" : "bg-[#f59e0b]/60",
          )} />
          <span className="text-[10px] text-[#8b949e] tracking-widest uppercase">
            {heliusOk ? "Scanning" : "No Helius Key"}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <Activity className="w-2.5 h-2.5 text-[#484f58]" />
          <span className="text-[9px] text-[#484f58] tracking-widest">v0.3 — Pipeline</span>
        </div>
      </div>
    </div>
  );
}

function BottomNav() {
  const [location] = useLocation();
  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 md:hidden bg-[#161b22] border-t border-[#30363d]">
      <div className="flex items-center justify-around px-2 py-2 pb-safe">
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = location === href || (href !== "/" && location.startsWith(href));
          return (
            <Link key={href} href={href}>
              <div className="flex flex-col items-center gap-1 px-3 py-1 cursor-pointer">
                <Icon className={cn("w-5 h-5 transition-colors", active ? "text-[#f59e0b]" : "text-[#484f58]")} />
                <span className={cn("text-[9px] font-semibold tracking-widest uppercase", active ? "text-[#f59e0b]" : "text-[#484f58]")}>
                  {label}
                </span>
                {active && <div className="w-4 h-px bg-[#f59e0b]" />}
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex w-full bg-[#0d1117]">
      {/* Desktop sidebar */}
      <aside className="hidden md:flex flex-col w-52 lg:w-56 fixed inset-y-0 z-50">
        <SidebarContent />
      </aside>

      {/* Main content */}
      <main className="flex-1 flex flex-col min-w-0 md:pl-52 lg:pl-56">
        {/* Mobile top bar */}
        <header className="h-12 flex items-center px-4 md:hidden sticky top-0 z-40 bg-[#0d1117] border-b border-[#30363d]">
          <div className="flex items-center gap-2">
            <Zap className="w-4 h-4 text-[#f59e0b]" />
            <span className="text-[#f59e0b] font-bold tracking-widest text-sm uppercase">CRYPSOR</span>
          </div>
        </header>

        <div className="flex-1 p-4 md:p-6 max-w-screen-2xl mx-auto w-full pb-24 md:pb-6">
          {children}
        </div>
      </main>

      {/* Mobile bottom nav */}
      <BottomNav />
    </div>
  );
}
