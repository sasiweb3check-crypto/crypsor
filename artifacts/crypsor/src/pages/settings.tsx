import { useState, useEffect } from "react";
import { Eye, EyeOff, KeyRound, ExternalLink, CheckCircle } from "lucide-react";
import { useGetSettings, useUpsertSetting } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";

export default function Settings() {
  const { data: settings, isLoading } = useGetSettings();
  const upsertSetting = useUpsertSetting();
  const { toast } = useToast();

  const [heliusKey, setHeliusKey] = useState("");
  const [showHelius, setShowHelius] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (settings) {
      const hKey = settings.find(s => s.key === "helius_api_key");
      if (hKey) setHeliusKey(hKey.value);
    }
  }, [settings]);

  const handleSave = () => {
    upsertSetting.mutate(
      { data: { key: "helius_api_key", value: heliusKey } },
      {
        onSuccess: () => {
          setSaved(true);
          toast({ title: "Saved", description: "Helius API key updated." });
          setTimeout(() => setSaved(false), 3000);
        },
        onError: () => toast({ title: "Failed to save", variant: "destructive" }),
      },
    );
  };

  return (
    <div className="space-y-4 max-w-lg">
      {/* Header */}
      <div>
        <h1 className="text-lg font-bold text-[#f59e0b] tracking-widest uppercase">Settings</h1>
        <p className="text-[#484f58] text-[10px] mt-0.5 tracking-widest uppercase">Configure API integrations and monitoring</p>
      </div>

      {/* API Keys card */}
      <div className="border border-[#30363d] bg-[#161b22] overflow-hidden">
        {/* Card header */}
        <div className="px-5 py-4 border-b border-[#30363d] bg-[#161b22] flex items-center gap-3">
          <KeyRound className="w-4 h-4 text-[#f59e0b]" />
          <div>
            <div className="text-[#c9d1d9] text-sm font-bold tracking-wide">API Keys</div>
            <div className="text-[9px] text-[#484f58] tracking-widest uppercase mt-0.5">External service credentials</div>
          </div>
        </div>

        {/* Card body */}
        <div className="px-5 py-5 space-y-5">
          {isLoading ? (
            <div className="space-y-3 animate-pulse">
              <div className="h-3 w-32 bg-[#0d1117]" />
              <div className="h-9 bg-[#0d1117]" />
            </div>
          ) : (
            <div className="space-y-2">
              <label className="text-[9px] text-[#8b949e] uppercase tracking-widest block">
                Helius API Key
              </label>
              <div className="relative">
                <input
                  type={showHelius ? "text" : "password"}
                  value={heliusKey}
                  onChange={e => setHeliusKey(e.target.value)}
                  placeholder="Enter your Helius API key"
                  className="w-full h-9 px-3 pr-10 text-[11px] bg-[#0d1117] border border-[#30363d] text-[#c9d1d9] placeholder-[#484f58] focus:outline-none focus:border-[#f59e0b]/50 font-mono"
                />
                <button
                  type="button"
                  onClick={() => setShowHelius(!showHelius)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-[#484f58] hover:text-[#c9d1d9] transition-colors"
                >
                  {showHelius ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              </div>
              <p className="text-[10px] text-[#484f58]">
                Required for Solana wallet monitoring.{" "}
                <a
                  href="https://www.helius.dev"
                  target="_blank" rel="noopener noreferrer"
                  className="text-[#f59e0b] hover:underline inline-flex items-center gap-0.5"
                >
                  helius.dev <ExternalLink className="w-2.5 h-2.5" />
                </a>
              </p>
            </div>
          )}
        </div>

        {/* Card footer */}
        <div className="px-5 py-4 border-t border-[#30363d]">
          <button
            onClick={handleSave}
            disabled={upsertSetting.isPending || isLoading}
            className={`flex items-center gap-2 h-8 px-4 text-[9px] font-bold uppercase tracking-widest border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
              saved
                ? "border-[#22c55e]/40 bg-[#22c55e]/10 text-[#22c55e]"
                : "border-[#f59e0b]/40 bg-[#f59e0b]/10 text-[#f59e0b] hover:bg-[#f59e0b]/20"
            }`}
          >
            {saved
              ? <><CheckCircle className="w-3.5 h-3.5" /> Saved</>
              : upsertSetting.isPending
              ? "Saving…"
              : "Save Changes"}
          </button>
        </div>
      </div>
    </div>
  );
}
