import { useEffect } from "react";
import { Link, useLocation } from "wouter";
import { Settings, Activity, Search } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { OPS_PING_KEY, fetchOpsPing } from "@/lib/ops-api";

export function AppShell({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const qc = useQueryClient();
  const onUtility = location === "/ops" || location === "/settings" || location.startsWith("/wallet")
    || location.startsWith("/ops/") || location.startsWith("/settings/");
  const onDetail = location.startsWith("/calls/") || location.startsWith("/tokens/");
  const onWallet = location.startsWith("/wallet");

  // Wake API early (Render free cold start) so Calls / Wallet don't black-wait
  useEffect(() => {
    void qc.prefetchQuery({
      queryKey: OPS_PING_KEY,
      queryFn: fetchOpsPing,
      staleTime: 15_000,
    });
    // Prefetch feed in parallel so Best Calls paints sooner after wake
    void qc.prefetchQuery({
      queryKey: ["calls-feed", "best"],
      queryFn: () =>
        import("@/lib/calls-api").then(m => m.fetchCallsFeed("best", 8)),
      staleTime: 6_000,
    });
  }, [qc]);

  return (
    <div className="relative min-h-screen w-full desk-surface">
      <header
        className="sticky top-0 z-50 flex items-center justify-between px-4 h-14"
        style={{
          background: "rgba(5,8,12,0.88)",
          backdropFilter: "blur(16px)",
          borderBottom: "1px solid var(--cryp-line)",
        }}
      >
        <Link href="/">
          <div className="cursor-pointer select-none">
            <div className="font-display text-[var(--cryp-mint)] font-extrabold tracking-[0.18em] text-[13px] uppercase">
              Crypsor
            </div>
            <div className="text-[var(--cryp-mute)] text-[9px] tracking-[0.2em] uppercase mt-0.5">
              {onWallet ? "Wallet intel" : onDetail ? "Call detail" : "Best Calls"}
            </div>
          </div>
        </Link>

        <div className="flex items-center gap-1">
          <span className="hidden sm:inline-flex items-center gap-1.5 mr-2 text-[10px] uppercase tracking-widest text-[var(--cryp-gain)]">
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--cryp-gain)] pulse-dot" />
            Live
          </span>
          <Link href="/wallet">
            <button
              type="button"
              aria-label="Wallet search"
              className={cn(
                "w-10 h-10 flex items-center justify-center rounded-xl transition-colors",
                onWallet
                  ? "text-[var(--cryp-mint)] bg-[rgba(61,154,139,0.14)]"
                  : "text-[var(--cryp-mute)] hover:text-[var(--cryp-text)]",
              )}
            >
              <Search className="w-[18px] h-[18px]" />
            </button>
          </Link>
          <Link href="/ops">
            <button
              type="button"
              aria-label="Logs"
              className={cn(
                "w-10 h-10 flex items-center justify-center rounded-xl transition-colors",
                location.startsWith("/ops")
                  ? "text-[var(--cryp-mint)] bg-[rgba(61,154,139,0.14)]"
                  : "text-[var(--cryp-mute)] hover:text-[var(--cryp-text)]",
              )}
            >
              <Activity className="w-[18px] h-[18px]" />
            </button>
          </Link>
          <Link href="/settings">
            <button
              type="button"
              aria-label="Settings"
              className={cn(
                "w-10 h-10 flex items-center justify-center rounded-xl transition-colors",
                location.startsWith("/settings")
                  ? "text-[var(--cryp-mint)] bg-[rgba(61,154,139,0.14)]"
                  : "text-[var(--cryp-mute)] hover:text-[var(--cryp-text)]",
              )}
            >
              <Settings className="w-[18px] h-[18px]" />
            </button>
          </Link>
        </div>
      </header>

      <main className="relative z-10 min-h-[calc(100vh-3.5rem)] flex flex-col">
        <div
          className={cn(
            "flex-1 flex flex-col min-w-0 w-full mx-auto",
            onUtility ? "max-w-3xl" : "max-w-lg",
          )}
        >
          {children}
        </div>
      </main>
    </div>
  );
}

export const Layout = AppShell;
