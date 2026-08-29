import { useState } from "react";
import { api } from "../lib/api";
import { usePoll } from "../hooks/use-data";

type Wallets = Array<{ id: number; address: string; label: string | null; created_at: string }>;

export default function SettingsPage() {
  const settingsQ = usePoll<Record<string, string | null>>(() => api("api/settings"), 60_000);
  const walletsQ = usePoll<Wallets>(() => api("api/wallets"), 20_000);

  const [helius, setHelius] = useState("");
  const [tgToken, setTgToken] = useState("");
  const [tgChat, setTgChat] = useState("");
  const [addr, setAddr] = useState("");
  const [label, setLabel] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  const save = async () => {
    setMsg(null);
    try {
      await api("api/settings", {
        method: "PUT",
        body: JSON.stringify({
          helius_api_key: helius,
          telegram_bot_token: tgToken,
          telegram_chat_id: tgChat,
        }),
      });
      setMsg("Saved");
      setHelius(""); setTgToken(""); setTgChat("");
      settingsQ.refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "save failed");
    }
  };

  const addWallet = async () => {
    setMsg(null);
    try {
      await api("api/wallets", { method: "POST", body: JSON.stringify({ address: addr, label }) });
      setAddr(""); setLabel("");
      walletsQ.refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "add failed");
    }
  };

  const removeWallet = async (id: number) => {
    await api(`api/wallets/${id}`, { method: "DELETE" });
    walletsQ.refresh();
  };

  const cur = settingsQ.data;

  return (
    <div className="page plain">
      <h1>Settings</h1>
      <p className="note">
        Only tracked-wallet buys are listed. Add Solana addresses — each buy is frozen at the market cap we see at that print.
      </p>

      <div className="h">Tracked wallets</div>
      <div className="row">
        <input value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="Solana address" autoCapitalize="off" />
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (optional)" />
        <button type="button" className="btn" onClick={() => void addWallet()}>Add</button>
      </div>
      <ul className="wlist">
        {(walletsQ.data ?? []).map((w) => (
          <li key={w.id}>
            <div>
              <div>{w.label || "Unnamed"}</div>
              <code>{w.address}</code>
            </div>
            <button type="button" className="chip" onClick={() => void removeWallet(w.id)}>Remove</button>
          </li>
        ))}
      </ul>
      {(walletsQ.data ?? []).length === 0 ? <p className="note">No wallets yet.</p> : null}

      <div className="h">Keys</div>
      <label>
        Helius {cur?.helius_api_key ? `· ${cur.helius_api_key}` : ""}
        <input value={helius} onChange={(e) => setHelius(e.target.value)} placeholder="New key" autoCapitalize="off" />
      </label>
      <label>
        Telegram bot {cur?.telegram_bot_token ? `· ${cur.telegram_bot_token}` : ""}
        <input value={tgToken} onChange={(e) => setTgToken(e.target.value)} placeholder="123456:ABC…" autoCapitalize="off" />
      </label>
      <label>
        Telegram chat {cur?.telegram_chat_id ? `· ${cur.telegram_chat_id}` : ""}
        <input value={tgChat} onChange={(e) => setTgChat(e.target.value)} placeholder="Chat id" autoCapitalize="off" />
      </label>
      <div className="row">
        <button type="button" className="btn" onClick={() => void save()}>Save keys</button>
        {msg ? <span className={msg === "Saved" ? "ok" : "err"}>{msg}</span> : null}
      </div>

      <div className="h">Scan</div>
      <p className="note">
        Intake polls tracked wallets. Market cap is printed every 15 minutes. Names under $5k MC go to Archived.
        On Render Starter the process stays up. If the host is Free, ping <code>/api/keepalive</code> every minute.
      </p>
    </div>
  );
}
