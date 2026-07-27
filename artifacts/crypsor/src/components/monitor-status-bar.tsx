import { useQuery } from "@tanstack/react-query";
import { Wifi, WifiOff, Scan } from "lucide-react";
import { formatTimeAgo } from "@/lib/utils";

interface MonitorStatus {
  running: boolean;
  heliusConfigured: boolean;
  heliusLastError: string | null;
  lastScanAt: string | null;
  lastScanDurationMs: number | null;
  cycleCount: number;
  engines?: Record<string, boolean>;
}

async function triggerScan(baseUrl: string) {
  await fetch(`${baseUrl}api/monitor/scan`, { method: "POST" });
}

const ENGINE_LABELS: Record<string, string> = {
  price: "Price",
  metadata: "Metadata",
  lifecycle: "Lifecycle",
  momentum: "Momentum",
  scheduler: "Scheduler",
  "projection-engine": "Proj",
  "token-updater": "Updater",
};

export function MonitorStatusBar() {
  const { data, refetch } = useQuery<MonitorStatus>({
    queryKey: ["monitor-status"],
    queryFn:  () => fetch(`${import.meta.env.BASE_URL}api/monitor/status`).then(r => r.json()),
    refetchInterval: 15_000,
    staleTime: 10_000,
  });

  const heliusOk = data?.heliusConfigured;
  const lastScan = data?.lastScanAt ? formatTimeAgo(data.lastScanAt) : null;
  const duration = data?.lastScanDurationMs;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[10px] tracking-widest uppercase font-mono">
      {/* Scanning indicator */}
      <div className="flex items-center gap-1.5">
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${data?.running ? "bg-[#22c55e] pulse-dot" : "bg-[#30363d]"}`} />
        <span className={data?.running ? "text-[#22c55e]" : "text-[#8b949e]"}>
          {data?.running ? "Scanning" : "Stopped"}
        </span>
      </div>

      <span className="text-[#30363d]">·</span>

      {/* Helius */}
      <div className="flex items-center gap-1.5">
        {heliusOk
          ? <Wifi className="w-3 h-3 text-[#22c55e]" />
          : <WifiOff className="w-3 h-3 text-[#f59e0b]" />}
        <span className={heliusOk ? "text-[#22c55e]" : "text-[#f59e0b]"}>
          Helius: {heliusOk ? "Connected" : "No Key"}
        </span>
      </div>

      {/* Last scan */}
      {lastScan && (
        <>
          <span className="text-[#30363d]">·</span>
          <span className="text-[#8b949e]">
            Last scan {lastScan} ago
            {duration != null && <span className="text-[#484f58] ml-1">({duration}ms)</span>}
          </span>
        </>
      )}

      {/* Engine status pills */}
      {data?.engines && (
        <div className="flex items-center gap-1.5 ml-1">
          {Object.entries(data.engines).map(([key, ok]) => (
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

      {/* Scan now */}
      <button
        className="ml-auto flex items-center gap-1.5 px-2.5 py-1 border border-[#30363d] text-[#8b949e] hover:text-[#f59e0b] hover:border-[#f59e0b]/40 transition-colors"
        onClick={() => triggerScan(import.meta.env.BASE_URL).then(() => refetch())}
      >
        <Scan className="w-3 h-3" />
        Scan Now
      </button>
    </div>
  );
}
