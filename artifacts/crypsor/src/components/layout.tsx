import { useEffect } from "react";
import { Link, useLocation } from "wouter";
import { Settings, Activity, Search, Bell } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { OPS_PING_KEY, fetchOpsPing } from "@/lib/ops-api";
import { PAGE_SIZE, fetchCallsFeed } from "@/lib/calls-api";
import { ALERTS_UNREAD_KEY, fetchAlerts } from "@/lib/alerts-api";
import { LiveSseProvider, useLiveSse } from "@/hooks/use-live-tokens";

function ShellChrome({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const qc = useQueryClient();
  const { connected } = useLiveSse();
  const onUtility = location === "/ops" || location === "/settings" || location.startsWith("/wallet")
    || location.startsWith("/ops/") || location.startsWith("/settings/")
    || location.startsWith("/alerts");
  const onDetail = location.startsWith("/calls/") || location.startsWith("/tokens/");
  const onWallet = location.startsWith("/wallet");
  const onAlerts = location.startsWith("/alerts");

  const unreadQ = useQuery({
    queryKey: ALERTS_UNREAD_KEY,
    queryFn: async () => {
      const page = await fetchAlerts({ page: 1, limit: 1 });
      return page.unread;
    },
    refetchInterval: connected ? 45_000 : 12_000,
    staleTime: 8_000,
  });
  const unread = unreadQ.data ?? 0;

  useEffect(() => {
    void qc.prefetchQuery({
      queryKey: OPS_PING_KEY,
      queryFn: fetchOpsPing,
      staleTime: 15_000,
    });
    void qc.prefetchQuery({
      queryKey: ["calls-feed", "pump", "all", "score", 1, 0],
      queryFn: () => fetchCallsFeed("all", 1, PAGE_SIZE, "score", 0),
      staleTime: 8_000,
    });
  }, [qc]);

  return (
    <div className="relative min-h-screen w-full desk-surface">
      <header
        className="sticky top-0 z-50 flex items-center justify-between px-3 h-11"
        style={{
          background: "rgba(5,8,12,0.9)",
          backdropFilter: "blur(12px)",
          borderBottom: "1px solid var(--cryp-line)",
        }}
      >
        <Link href="/">
          <div className="cursor-pointer select-none">
            <div className="font-display text-[var(--cryp-mint)] font-extrabold tracking-[0.16em] text-[12px] uppercase">
              Crypsor
            </div>
            <div className="text-[var(--cryp-mute)] text-[8px] tracking-[0.18em] uppercase mt-0.5">
              {onWallet
                ? "Wallet Track"
                : onDetail
                  ? "Detail"
                  : onAlerts
                    ? "Alerts"
                    : location.startsWith("/ops")
                      ? "Logs"
                      : "Desk"}
            </div>
          </div>
        </Link>

        <div className="flex items-center gap-0.5">
          <span
            className={cn(
              "inline-flex items-center gap-1.5 mr-1.5 text-[9px] uppercase tracking-widest",
              connected ? "text-[var(--cryp-gain)]" : "text-[var(--cryp-mute)]",
            )}
            title={connected ? "SSE live — poll backup idle" : "SSE reconnecting — polling backup"}
          >
            <span
              className={cn(
                "w-1.5 h-1.5 rounded-full",
                connected ? "bg-[var(--cryp-gain)] pulse-dot" : "bg-[var(--cryp-mute)]",
              )}
            />
            {connected ? "Live" : "Sync"}
          </span>
          <Link href="/wallet-track">
            <button
              type="button"
              aria-label="Wallet Track"
              className={cn(
                "w-9 h-9 flex items-center justify-center rounded-lg transition-colors",
                onWallet
                  ? "text-[var(--cryp-mint)] bg-[rgba(61,154,139,0.14)]"
                  : "text-[var(--cryp-mute)] hover:text-[var(--cryp-text)]",
              )}
            >
              <Search className="w-4 h-4" />
            </button>
          </Link>
          <Link href="/alerts">
            <button
              type="button"
              aria-label="Alerts"
              className={cn(
                "relative w-9 h-9 flex items-center justify-center rounded-lg transition-colors",
                onAlerts
                  ? "text-[var(--cryp-mint)] bg-[rgba(61,154,139,0.14)]"
                  : "text-[var(--cryp-mute)] hover:text-[var(--cryp-text)]",
              )}
            >
              <Bell className="w-4 h-4" />
              {unread > 0 && (
                <span
                  className="absolute top-1 right-1 min-w-[14px] h-[14px] px-0.5 rounded-full text-[8px] font-bold flex items-center justify-center"
                  style={{ background: "var(--cryp-gain)", color: "#04120c" }}
                >
                  {unread > 99 ? "99+" : unread}
                </span>
              )}
            </button>
          </Link>
          <Link href="/ops">
            <button
              type="button"
              aria-label="Logs"
              className={cn(
                "w-9 h-9 flex items-center justify-center rounded-lg transition-colors",
                location.startsWith("/ops")
                  ? "text-[var(--cryp-mint)] bg-[rgba(61,154,139,0.14)]"
                  : "text-[var(--cryp-mute)] hover:text-[var(--cryp-text)]",
              )}
            >
              <Activity className="w-4 h-4" />
            </button>
          </Link>
          <Link href="/settings">
            <button
              type="button"
              aria-label="Settings"
              className={cn(
                "w-9 h-9 flex items-center justify-center rounded-lg transition-colors",
                location.startsWith("/settings")
                  ? "text-[var(--cryp-mint)] bg-[rgba(61,154,139,0.14)]"
                  : "text-[var(--cryp-mute)] hover:text-[var(--cryp-text)]",
              )}
            >
              <Settings className="w-4 h-4" />
            </button>
          </Link>
        </div>
      </header>

      <main className="relative z-10 min-h-[calc(100vh-2.75rem)] flex flex-col overflow-x-hidden">
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

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <LiveSseProvider>
      <ShellChrome>{children}</ShellChrome>
    </LiveSseProvider>
  );
}

export const Layout = AppShell;
