import { useQuery } from "@tanstack/react-query";
import { Wifi, WifiOff, Scan, AlertTriangle } from "lucide-react";
import { formatTimeAgo } from "@/lib/utils";
import { getApiBase } from "@/lib/api-base";
import { Link } from "wouter";

interface MonitorStatus {
  running: boolean;
  heliusConfigured: boolean;
  heliusLastError: string | null;
  lastScanAt: string | null;
  lastScanDurationMs: number | null;
  lastBuysDetected?: number;
  nextScanAt?: string | null;
  cycleCount: number;
  engines?: Record<string, boolean>;
}

interface OpsSummaryLite {
  scan?: { delayed?: boolean; stopped?: boolean; scanAgeSec?: number | null };
  telegram?: { configured?: boolean; lastError?: string | null; pendingFirstCalls?: number };
  blockers?: Array<{ code: string; level: string; msg: string }>;
}

async function triggerScan(baseUrl: string) {
  await fetch(`${baseUrl}api/monitor/scan`, { method: "POST" });
}

const ENGINE_LABELS: Record<string, string> = {
  "price-service": "Price",
  "metadata-service": "Meta",
  "lifecycle-engine": "Life",
  "momentum-engine": "Mom",
  "wallet-scheduler": "Sched",
  "projection-engine": "Proj",
  "token-updater": "Upd",
  "intelligence-engine": "Intel",
  "holders-refresh": "Hold",
  "helius-scanner": "Helius",
  "caller-alerts": "Alert",
  "pro-scanner": "Pro",
};

export function MonitorStatusBar() {
  const base = getApiBase();
  const { data, refetch, isError } = useQuery<MonitorStatus>({
    queryKey: ["monitor-status"],
    queryFn:  () => fetch(`${base}api/monitor/status`).then(r => {
      if (!r.ok) throw new Error(`status ${r.status}`);
      return r.json();
    }),
    refetchInterval: 15_000,
    staleTime: 10_000,
    retry: 1,
  });

  const { data: ops } = useQuery<OpsSummaryLite>({
    queryKey: ["opsSummaryLite"],
    queryFn: () => fetch(`${base}api/ops/summary`).then(r => r.ok ? r.json() : {}),
    refetchInterval: 20_000,
    staleTime: 15_000,
    retry: 0,
  });

  const heliusOk = data?.heliusConfigured && !data?.heliusLastError;
  const lastScan = data?.lastScanAt ? formatTimeAgo(data.lastScanAt) : null;
  const duration = data?.lastScanDurationMs;
  const delayed = ops?.scan?.delayed;
  const topBlocker = ops?.blockers?.find(b => b.level === "error" || b.level === "warn");

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[10px] tracking-widest uppercase font-mono">
      {isError && (
        <div className="flex items-center gap-1.5 text-[#ef4444]">
          <AlertTriangle className="w-3 h-3" />
          API fetch failed
        </div>
      )}

      <div className="flex items-center gap-1.5">
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
          delayed ? "bg-[#f59e0b] pulse-dot"
            : data?.running ? "bg-[#22c55e] pulse-dot" : "bg-[#30363d]"
        }`} />
        <span className={delayed ? "text-[#f59e0b]" : data?.running ? "text-[#22c55e]" : "text-[#8b949e]"}>
          {delayed ? "Delayed" : data?.running ? "Scanning" : "Stopped"}
        </span>
      </div>

      <span className="text-[#30363d]">·</span>

      <div className="flex items-center gap-1.5">
        {heliusOk
          ? <Wifi className="w-3 h-3 text-[#22c55e]" />
          : <WifiOff className="w-3 h-3 text-[#f59e0b]" />}
        <span className={heliusOk ? "text-[#22c55e]" : "text-[#f59e0b]"}>
          Helius: {data?.heliusConfigured ? (data.heliusLastError ? "Error" : "Connected") : "No Key"}
        </span>
      </div>

      {lastScan && (
        <>
          <span className="text-[#30363d]">·</span>
          <span className="text-[#8b949e]">
            Last scan {lastScan} ago
            {duration != null && <span className="text-[#484f58] ml-1">({duration}ms)</span>}
            {data?.lastBuysDetected != null && data.lastBuysDetected > 0 && (
              <span className="text-[#22c55e] ml-1">+{data.lastBuysDetected} buys</span>
            )}
          </span>
        </>
      )}

      {ops?.telegram && (
        <>
          <span className="text-[#30363d]">·</span>
          <span className={ops.telegram.configured && !ops.telegram.lastError ? "text-[#22c55e]" : "text-[#f59e0b]"}>
            TG {ops.telegram.configured
              ? (ops.telegram.lastError ? "fail" : (ops.telegram.pendingFirstCalls ? `${ops.telegram.pendingFirstCalls} pending` : "ok"))
              : "off"}
          </span>
        </>
      )}

      {data?.engines && (
        <div className="flex items-center gap-1.5 ml-1">
          {Object.entries(data.engines)
            .filter(([key]) => ENGINE_LABELS[key])
            .slice(0, 8)
            .map(([key, ok]) => (
              <span
                key={key}
                className={`text-[9px] px-1.5 py-0.5 border ${ok
                  ? "border-[#22c55e]/20 text-[#22c55e]/70 bg-[#22c55e]/5"
                  : "border-[#ef4444]/20 text-[#ef4444]/70 bg-[#ef4444]/5"
                }`}
              >
                {ENGINE_LABELS[key] ?? key}
              </span>
            ))}
        </div>
      )}

      {topBlocker && (
        <Link href="/ops">
          <span className="text-[9px] text-[#f59e0b] truncate max-w-[180px] cursor-pointer hover:underline">
            {topBlocker.msg.slice(0, 60)}
          </span>
        </Link>
      )}

      <button
        className="ml-auto flex items-center gap-1.5 px-2.5 py-1 border border-[#30363d] text-[#8b949e] hover:text-[#f59e0b] hover:border-[#f59e0b]/40 transition-colors"
        onClick={() => triggerScan(base).then(() => refetch())}
      >
        <Scan className="w-3 h-3" />
        Scan Now
      </button>
    </div>
  );
}
