import { useState, useEffect } from "react";
import { Eye, EyeOff, KeyRound, ExternalLink, CheckCircle, Send, Bot, TestTube } from "lucide-react";
import { useGetSettings, useUpsertSetting } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { getApiBase } from "@/lib/api-base";

export default function Settings() {
  const { data: settings, isLoading } = useGetSettings();
  const upsertSetting = useUpsertSetting();
  const { toast } = useToast();

  // ── Helius ─────────────────────────────────────────────────────────────────
  const [heliusKey, setHeliusKey] = useState("");
  const [showHelius, setShowHelius] = useState(false);
  const [heliusSaved, setHeliusSaved] = useState(false);

  // ── Telegram ───────────────────────────────────────────────────────────────
  const [botToken, setBotToken] = useState("");
  const [chatId, setChatId] = useState("");
  const [showBot, setShowBot] = useState(false);
  const [tgSaved, setTgSaved] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    if (settings) {
      const hKey  = settings.find(s => s.key === "helius_api_key");
      const tgBot = settings.find(s => s.key === "telegram_bot_token");
      const tgId  = settings.find(s => s.key === "telegram_chat_id");
      if (hKey)  setHeliusKey(hKey.value);
      if (tgBot) setBotToken(tgBot.value);
      if (tgId)  setChatId(tgId.value);
    }
  }, [settings]);

  const saveHelius = () => {
    upsertSetting.mutate(
      { data: { key: "helius_api_key", value: heliusKey } },
      {
        onSuccess: () => {
          setHeliusSaved(true);
          toast({ title: "Saved", description: "Helius API key updated." });
          setTimeout(() => setHeliusSaved(false), 3000);
        },
        onError: () => toast({ title: "Failed to save", variant: "destructive" }),
      },
    );
  };

  const saveTelegram = () => {
    // Save both keys sequentially
    upsertSetting.mutate(
      { data: { key: "telegram_bot_token", value: botToken } },
      {
        onSuccess: () => {
          upsertSetting.mutate(
            { data: { key: "telegram_chat_id", value: chatId } },
            {
              onSuccess: () => {
                setTgSaved(true);
                toast({ title: "Saved", description: "Telegram credentials saved." });
                setTimeout(() => setTgSaved(false), 3000);
              },
              onError: () => toast({ title: "Failed to save chat ID", variant: "destructive" }),
            },
          );
        },
        onError: () => toast({ title: "Failed to save bot token", variant: "destructive" }),
      },
    );
  };

  const testTelegram = async () => {
    setTesting(true);
    try {
      const res = await fetch(`${getApiBase()}api/caller/telegram/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (res.ok) {
        toast({ title: "Test sent ✅", description: "Check your Telegram for the test message." });
      } else {
        const body = await res.json().catch(() => ({ error: "Unknown error" }));
        toast({ title: "Test failed", description: body.error ?? "Check bot token and chat ID.", variant: "destructive" });
      }
    } catch {
      toast({ title: "Network error", variant: "destructive" });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="space-y-4 max-w-lg">
      {/* Header */}
      <div>
        <h1 className="text-lg font-bold text-[#f59e0b] tracking-widest uppercase">Settings</h1>
        <p className="text-[#484f58] text-[10px] mt-0.5 tracking-widest uppercase">Configure API integrations and monitoring</p>
      </div>

      {/* ── API Keys card ──────────────────────────────────────────────────── */}
      <div className="border border-[#30363d] bg-[#161b22] overflow-hidden">
        <div className="px-5 py-4 border-b border-[#30363d] flex items-center gap-3">
          <KeyRound className="w-4 h-4 text-[#f59e0b]" />
          <div>
            <div className="text-[#c9d1d9] text-sm font-bold tracking-wide">API Keys</div>
            <div className="text-[9px] text-[#484f58] tracking-widest uppercase mt-0.5">External service credentials</div>
          </div>
        </div>

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
                <a href="https://www.helius.dev" target="_blank" rel="noopener noreferrer"
                  className="text-[#f59e0b] hover:underline inline-flex items-center gap-0.5">
                  helius.dev <ExternalLink className="w-2.5 h-2.5" />
                </a>
              </p>
            </div>
          )}
        </div>

        <div className="px-5 py-4 border-t border-[#30363d]">
          <button
            onClick={saveHelius}
            disabled={upsertSetting.isPending || isLoading}
            className={`flex items-center gap-2 h-8 px-4 text-[9px] font-bold uppercase tracking-widest border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
              heliusSaved
                ? "border-[#22c55e]/40 bg-[#22c55e]/10 text-[#22c55e]"
                : "border-[#f59e0b]/40 bg-[#f59e0b]/10 text-[#f59e0b] hover:bg-[#f59e0b]/20"
            }`}
          >
            {heliusSaved
              ? <><CheckCircle className="w-3.5 h-3.5" /> Saved</>
              : upsertSetting.isPending ? "Saving…" : "Save Changes"}
          </button>
        </div>
      </div>

      {/* ── Caller / Telegram card ─────────────────────────────────────────── */}
      <div className="border border-[#30363d] bg-[#161b22] overflow-hidden">
        <div className="px-5 py-4 border-b border-[#30363d] flex items-center gap-3">
          <Bot className="w-4 h-4 text-[#f59e0b]" />
          <div>
            <div className="text-[#c9d1d9] text-sm font-bold tracking-wide">Caller — Telegram Alerts</div>
            <div className="text-[9px] text-[#484f58] tracking-widest uppercase mt-0.5">
              GOOD SETUP · SURPRISE SIGNAL · DUMP WARNING
            </div>
          </div>
        </div>

        <div className="px-5 py-5 space-y-5">
          {isLoading ? (
            <div className="space-y-4 animate-pulse">
              <div className="h-9 bg-[#0d1117]" />
              <div className="h-9 bg-[#0d1117]" />
            </div>
          ) : (
            <>
              {/* Bot token */}
              <div className="space-y-2">
                <label className="text-[9px] text-[#8b949e] uppercase tracking-widest block">
                  Bot Token
                </label>
                <div className="relative">
                  <input
                    type={showBot ? "text" : "password"}
                    value={botToken}
                    onChange={e => setBotToken(e.target.value)}
                    placeholder="123456789:ABCdef…"
                    className="w-full h-9 px-3 pr-10 text-[11px] bg-[#0d1117] border border-[#30363d] text-[#c9d1d9] placeholder-[#484f58] focus:outline-none focus:border-[#f59e0b]/50 font-mono"
                  />
                  <button
                    type="button"
                    onClick={() => setShowBot(!showBot)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-[#484f58] hover:text-[#c9d1d9] transition-colors"
                  >
                    {showBot ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  </button>
                </div>
                <p className="text-[10px] text-[#484f58]">
                  Create a bot with{" "}
                  <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer"
                    className="text-[#f59e0b] hover:underline inline-flex items-center gap-0.5">
                    @BotFather <ExternalLink className="w-2.5 h-2.5" />
                  </a>{" "}
                  and paste the token here.
                </p>
              </div>

              {/* Chat ID */}
              <div className="space-y-2">
                <label className="text-[9px] text-[#8b949e] uppercase tracking-widest block">
                  Chat ID
                </label>
                <input
                  type="text"
                  value={chatId}
                  onChange={e => setChatId(e.target.value)}
                  placeholder="-100123456789 or @channel"
                  className="w-full h-9 px-3 text-[11px] bg-[#0d1117] border border-[#30363d] text-[#c9d1d9] placeholder-[#484f58] focus:outline-none focus:border-[#f59e0b]/50 font-mono"
                />
                <p className="text-[10px] text-[#484f58]">
                  Your Telegram user ID, group ID, or channel username.
                </p>
              </div>
            </>
          )}
        </div>

        <div className="px-5 py-4 border-t border-[#30363d] flex items-center gap-3">
          <button
            onClick={saveTelegram}
            disabled={upsertSetting.isPending || isLoading || !botToken || !chatId}
            className={`flex items-center gap-2 h-8 px-4 text-[9px] font-bold uppercase tracking-widest border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
              tgSaved
                ? "border-[#22c55e]/40 bg-[#22c55e]/10 text-[#22c55e]"
                : "border-[#f59e0b]/40 bg-[#f59e0b]/10 text-[#f59e0b] hover:bg-[#f59e0b]/20"
            }`}
          >
            {tgSaved
              ? <><CheckCircle className="w-3.5 h-3.5" /> Saved</>
              : upsertSetting.isPending ? "Saving…" : <><Send className="w-3 h-3" /> Save</>}
          </button>

          <button
            onClick={testTelegram}
            disabled={testing || isLoading || !botToken || !chatId}
            className="flex items-center gap-2 h-8 px-4 text-[9px] font-bold uppercase tracking-widest border border-[#3b82f6]/40 bg-[#3b82f6]/10 text-[#3b82f6] hover:bg-[#3b82f6]/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <TestTube className="w-3 h-3" />
            {testing ? "Sending…" : "Test"}
          </button>
        </div>
      </div>
    </div>
  );
}
