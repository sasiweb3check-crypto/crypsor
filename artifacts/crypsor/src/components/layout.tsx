import { useEffect } from "react";
import { Link, useLocation } from "wouter";
import { Settings, Activity, Search } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { OPS_PING_KEY, fetchOpsPing } from "@/lib/ops-api";
import { PAGE_SIZE, fetchCallsFeed } from "@/lib/calls-api";
import { useLiveTokens } from "@/hooks/use-live-tokens";

export function AppShell({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const qc = useQueryClient();
  const { connected } = useLiveTokens();
  const onUtility = location === "/ops" || location === "/settings" || location.startsWith("/wallet")
    || location.startsWith("/ops/") || location.startsWith("/settings/");
  const onDetail = location.startsWith("/calls/") || location.startsWith("/tokens/");
  const onWallet = location.startsWith("/wallet");

  // Wake API early + prefetch first page of each mode
  useEffect(() => {
    void qc.prefetchQuery({
      queryKey: OPS_PING_KEY,
      queryFn: fetchOpsPing,
      staleTime: 15_000,
    });
    const modes = ["waiting", "best", "hot", "latest"] as const;
    for (const mode of modes) {
      void qc.prefetchQuery({
        queryKey: ["calls-feed", mode, 1, {}],
        queryFn: () => fetchCallsFeed(mode, 1, PAGE_SIZE, {}),
        staleTime: 8_000,
      });
    }
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
              {onWallet ? "Wallet" : onDetail ? "Detail" : location.startsWith("/ops") ? "Logs" : "Desk"}
            </div>
          </div>
        </Link>

        <div className="flex items-center gap-1">
          <span
            className={cn(
              "hidden sm:inline-flex items-center gap-1.5 mr-2 text-[10px] uppercase tracking-widest",
              connected ? "text-[var(--cryp-gain)]" : "text-[var(--cryp-mute)]",
            )}
            title={connected ? "SSE connected" : "SSE reconnecting — polling backup"}
          >
            <span
              className={cn(
                "w-1.5 h-1.5 rounded-full",
                connected ? "bg-[var(--cryp-gain)] pulse-dot" : "bg-[var(--cryp-mute)]",
              )}
            />
            {connected ? "Live" : "Sync"}
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

      <main className="relative z-10 min-h-[calc(100vh-3.5rem)] flex flex-col overflow-x-hidden">
        <div
          className={cn(
            "flex-1 flex flex-col min-w-0 w-full mx-auto px-0",
            onUtility ? "max-w-3xl" : "max-w-2xl",
          )}
        >
          {children}
        </div>
      </main>
    </div>
  );
}

export const Layout = AppShell;
