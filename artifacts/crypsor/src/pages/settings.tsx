import { useState, useEffect } from "react";
import { Eye, EyeOff, KeyRound, ExternalLink, CheckCircle } from "lucide-react";
import { useGetSettings, useUpsertSetting } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { getApiBase } from "@/lib/api-base";
import { Link } from "wouter";

export default function Settings() {
  const { data: settings, isLoading, error: settingsError, refetch } = useGetSettings();
  const upsertSetting = useUpsertSetting();
  const { toast } = useToast();

  const [heliusKey, setHeliusKey] = useState("");
  const [showHelius, setShowHelius] = useState(false);
  const [heliusSaved, setHeliusSaved] = useState(false);

  const apiBase = getApiBase();

  useEffect(() => {
    if (settings) {
      const hKey = settings.find(s => s.key === "helius_api_key");
      if (hKey) setHeliusKey(hKey.value);
    }
  }, [settings]);

  const saveHelius = () => {
    upsertSetting.mutate(
      { data: { key: "helius_api_key", value: heliusKey.trim() } },
      {
        onSuccess: () => {
          setHeliusSaved(true);
          toast({ title: "Saved", description: "Helius API key updated." });
          setTimeout(() => setHeliusSaved(false), 3000);
        },
        onError: (err) => toast({
          title: "Failed to save",
          description: err instanceof Error ? err.message : `Check API at ${apiBase}`,
          variant: "destructive",
        }),
      },
    );
  };

  return (
    <div className="space-y-4 px-4 py-5 max-w-lg mx-auto w-full">
      <div>
        <h1 className="font-display text-[18px] font-extrabold tracking-tight text-[var(--cryp-text)]">
          Settings
        </h1>
        <p className="text-[var(--cryp-mute)] text-[12px] mt-1">
          Keys for wallet scanning. Calls stay in-app — no push / Telegram.
        </p>
      </div>

      {settingsError && (
        <div
          className="px-3 py-2 rounded-xl text-[11px] text-[var(--cryp-loss)]"
          style={{ border: "1px solid rgba(232,93,93,0.35)", background: "rgba(232,93,93,0.08)" }}
        >
          Settings load failed. API: <span className="font-mono">{apiBase}</span>
          {" · "}
          <button type="button" className="underline" onClick={() => void refetch()}>Retry</button>
          {" · "}
          <Link href="/ops"><span className="underline cursor-pointer">Open Logs</span></Link>
        </div>
      )}

      <div className="call-card overflow-hidden !p-0">
        <div className="px-5 py-4 flex items-center gap-3" style={{ borderBottom: "1px solid var(--cryp-line)" }}>
          <KeyRound className="w-4 h-4 text-[var(--cryp-teal)]" />
          <div>
            <div className="text-[var(--cryp-text)] text-sm font-bold tracking-wide">API Keys</div>
            <div className="text-[10px] text-[var(--cryp-mute)] tracking-widest uppercase mt-0.5">
              Wallet scan credentials
            </div>
          </div>
        </div>

        <div className="px-5 py-5 space-y-5">
          {isLoading ? (
            <div className="space-y-3 animate-pulse">
              <div className="h-3 w-32 bg-[var(--cryp-elevated)]" />
              <div className="h-9 bg-[var(--cryp-elevated)]" />
            </div>
          ) : (
            <div className="space-y-2">
              <label className="text-[10px] text-[var(--cryp-mute)] uppercase tracking-widest block">
                Helius API Key
              </label>
              <div className="relative">
                <input
                  type={showHelius ? "text" : "password"}
                  value={heliusKey}
                  onChange={e => setHeliusKey(e.target.value)}
                  placeholder="Enter your Helius API key"
                  className="w-full h-10 px-3 pr-10 text-[12px] rounded-xl bg-[var(--cryp-ink)] border border-[var(--cryp-line)] text-[var(--cryp-text)] placeholder-[var(--cryp-mute)] focus:outline-none focus:border-[var(--cryp-teal)] font-mono"
                />
                <button
                  type="button"
                  onClick={() => setShowHelius(!showHelius)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--cryp-mute)] hover:text-[var(--cryp-text)]"
                >
                  {showHelius ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              </div>
              <p className="text-[11px] text-[var(--cryp-mute)]">
                Required for Solana wallet multi-buys.{" "}
                <a
                  href="https://www.helius.dev"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[var(--cryp-mint)] hover:underline inline-flex items-center gap-0.5"
                >
                  helius.dev <ExternalLink className="w-2.5 h-2.5" />
                </a>
              </p>
            </div>
          )}
        </div>

        <div className="px-5 py-4" style={{ borderTop: "1px solid var(--cryp-line)" }}>
          <button
            onClick={saveHelius}
            disabled={upsertSetting.isPending || isLoading}
            className={`flex items-center gap-2 h-9 px-4 rounded-xl text-[11px] font-bold uppercase tracking-widest transition-colors disabled:opacity-40 ${
              heliusSaved
                ? "bg-[rgba(62,207,142,0.14)] text-[var(--cryp-gain)]"
                : "bg-[var(--cryp-teal)] text-[var(--cryp-ink)]"
            }`}
          >
            {heliusSaved
              ? <><CheckCircle className="w-3.5 h-3.5" /> Saved</>
              : upsertSetting.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      <div className="call-card text-[12px] text-[var(--cryp-mute)] leading-relaxed">
        <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--cryp-mint)] mb-1.5">
          Notifications
        </div>
        Telegram / push alerts are off. Quality calls surface on the home desk only.
        Pipeline health stays under{" "}
        <Link href="/ops"><span className="text-[var(--cryp-mint)] underline cursor-pointer">Logs</span></Link>.
      </div>
    </div>
  );
}
