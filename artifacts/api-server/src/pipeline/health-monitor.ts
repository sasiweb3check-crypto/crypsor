import { logger as rootLogger } from "../lib/logger";

const log = rootLogger.child({ module: "health-monitor" });

/** How long (ms) a service can go without an ok() before the watchdog screams. */
const STALE_THRESHOLD_MS = 10 * 60 * 1_000; // 10 minutes
/** How often the watchdog runs. */
const WATCHDOG_INTERVAL_MS = 2 * 60 * 1_000; // 2 minutes

export interface ServiceHealth {
  name: string;
  status: "ok" | "degraded" | "down";
  lastError: string | null;
  totalErrors: number;
  lastOkAt: string | null;
  avgLatencyMs: number | null;
}

class HealthMonitor {
  private services = new Map<string, ServiceHealth>();
  private latencies = new Map<string, number[]>();

  register(name: string) {
    this.services.set(name, {
      name, status: "ok", lastError: null,
      totalErrors: 0, lastOkAt: new Date().toISOString(), avgLatencyMs: null,
    });
    this.latencies.set(name, []);
  }

  ok(name: string, latencyMs?: number) {
    const svc = this.services.get(name);
    if (!svc) return;
    // Recover after success streak
    if (svc.status !== "ok") svc.totalErrors = Math.max(0, svc.totalErrors - 1);
    svc.status = svc.totalErrors > 5 ? "degraded" : "ok";
    svc.lastOkAt = new Date().toISOString();
    if (latencyMs !== undefined) {
      const arr = this.latencies.get(name) ?? [];
      arr.push(latencyMs);
      if (arr.length > 30) arr.shift();
      this.latencies.set(name, arr);
      svc.avgLatencyMs = Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
    }
  }

  error(name: string, err: unknown) {
    const svc = this.services.get(name);
    if (!svc) return;
    svc.totalErrors++;
    svc.lastError = String(err).slice(0, 300);
    svc.status = svc.totalErrors >= 10 ? "down" : "degraded";
    // Emit an immediate loud warning when status flips to "down"
    if (svc.status === "down") {
      log.error({ service: name, totalErrors: svc.totalErrors, lastError: svc.lastError },
        "PIPELINE SERVICE DOWN — exceeded error threshold");
    }
  }

  getAll(): ServiceHealth[] {
    return Array.from(this.services.values());
  }

  getSummary(): { healthy: number; degraded: number; down: number } {
    const all = this.getAll();
    return {
      healthy:  all.filter(s => s.status === "ok").length,
      degraded: all.filter(s => s.status === "degraded").length,
      down:     all.filter(s => s.status === "down").length,
    };
  }

  /** Periodic watchdog — call startWatchdog() once at startup. */
  startWatchdog(): void {
    setInterval(() => {
      const now = Date.now();
      for (const svc of this.services.values()) {
        // Alert on explicit "down" status
        if (svc.status === "down") {
          log.error(
            { service: svc.name, totalErrors: svc.totalErrors, lastOkAt: svc.lastOkAt },
            "WATCHDOG: service is DOWN",
          );
          continue;
        }
        // Alert when last successful heartbeat is too old
        if (svc.lastOkAt) {
          const staleSec = Math.round((now - new Date(svc.lastOkAt).getTime()) / 1_000);
          if (staleSec * 1_000 > STALE_THRESHOLD_MS) {
            log.error(
              { service: svc.name, staleSec, lastOkAt: svc.lastOkAt, status: svc.status },
              `WATCHDOG: service has not reported ok in ${staleSec}s`,
            );
          }
        }
      }
    }, WATCHDOG_INTERVAL_MS).unref(); // unref so the timer doesn't prevent clean shutdown
  }
}

export const healthMonitor = new HealthMonitor();

// Register all pipeline services
for (const name of [
  "price-service",
  "metadata-service",
  "lifecycle-engine",
  "momentum-engine",
  "wallet-scheduler",
  "projection-engine",
  "intelligence-engine",
  "token-updater",
  "holders-refresh",
  "helius-scanner",
  "caller-alerts",
  "pro-scanner",
]) {
  healthMonitor.register(name);
}
