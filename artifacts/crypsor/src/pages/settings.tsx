/**
 * SETTINGS — API keys + tracked wallets (buy-source list).
 */
import { useState } from "react";
import { api } from "../lib/api";
import { usePoll } from "../hooks/use-data";

type Wallets = Array<{ id: number; address: string; label: string | null; created_at: string }>;

export default function SettingsPage() {
  const settingsQ = usePoll<Record<string, string | null>>(() => api("api/settings"), 60_000);
  const walletsQ = usePoll<Wallets>(() => api("api/wallets"), 30_000);

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
      setMsg("saved ✓");
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
    <div className="v-page">
      <h2 className="v-h2">SETTINGS</h2>

      <h3 className="v-h3">API KEYS</h3>
      <div className="v-form">
        <label className="v-field">
          <span>Helius API key {cur?.helius_api_key && <em className="v-green">set {cur.helius_api_key}</em>}</span>
          <input value={helius} onChange={(e) => setHelius(e.target.value)} placeholder="new key…" />
        </label>
        <label className="v-field">
          <span>Telegram bot token {cur?.telegram_bot_token && <em className="v-green">set {cur.telegram_bot_token}</em>}</span>
          <input value={tgToken} onChange={(e) => setTgToken(e.target.value)} placeholder="123456:ABC…" />
        </label>
        <label className="v-field">
          <span>Telegram chat id {cur?.telegram_chat_id && <em className="v-green">set {cur.telegram_chat_id}</em>}</span>
          <input value={tgChat} onChange={(e) => setTgChat(e.target.value)} placeholder="chat id…" />
        </label>
        <button type="button" className="v-btn" onClick={() => void save()}>SAVE</button>
        {msg && <span className="v-muted">{msg}</span>}
      </div>

      <h3 className="v-h3">TRACKED WALLETS (buy source)</h3>
      <div className="v-form v-form-row">
        <input value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="wallet address" className="v-grow" />
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="label" />
        <button type="button" className="v-btn" onClick={() => void addWallet()}>ADD</button>
      </div>
      <div className="v-table">
        {(walletsQ.data ?? []).map((w) => (
          <div key={w.id} className="v-tr3 v-row-static">
            <span className="v-mono">{w.address.slice(0, 8)}…{w.address.slice(-6)}</span>
            <span>{w.label ?? "—"}</span>
            <button type="button" className="v-chip v-red" onClick={() => void removeWallet(w.id)}>remove</button>
          </div>
        ))}
        {(walletsQ.data ?? []).length === 0 && <div className="v-empty">no wallets tracked yet</div>}
      </div>
    </div>
  );
}
