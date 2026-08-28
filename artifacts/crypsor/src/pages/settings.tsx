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
    <div className="page">
      <header className="topbar">
        <div className="brand">Settings</div>
      </header>
      <p className="blurb">
        The only data source is wallet buys. Add Solana addresses you trust — every buy becomes a patient.
      </p>

      <div className="section-h">Tracked wallets</div>
      <div className="form">
        <input value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="Solana address" autoCapitalize="off" />
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (optional)" />
        <button type="button" className="btn" onClick={() => void addWallet()}>Admit wallet</button>
      </div>
      <div className="list">
        {(walletsQ.data ?? []).map((w) => (
          <div key={w.id} className="wallet">
            <div className="card-main">
              <div className="sym">{w.label || "Unnamed"}</div>
              <code>{w.address}</code>
            </div>
            <button type="button" className="btn ghost" onClick={() => void removeWallet(w.id)}>Remove</button>
          </div>
        ))}
        {(walletsQ.data ?? []).length === 0 && <div className="row"><span className="blurb">No wallets yet.</span></div>}
      </div>

      <div className="section-h">Keys</div>
      <div className="form">
        <label className="field">
          <span>Helius {cur?.helius_api_key && <em className="tape-buyers"> · {cur.helius_api_key}</em>}</span>
          <input value={helius} onChange={(e) => setHelius(e.target.value)} placeholder="New key" autoCapitalize="off" />
        </label>
        <label className="field">
          <span>Telegram bot {cur?.telegram_bot_token && <em className="tape-buyers"> · {cur.telegram_bot_token}</em>}</span>
          <input value={tgToken} onChange={(e) => setTgToken(e.target.value)} placeholder="123456:ABC…" autoCapitalize="off" />
        </label>
        <label className="field">
          <span>Telegram chat {cur?.telegram_chat_id && <em className="tape-buyers"> · {cur.telegram_chat_id}</em>}</span>
          <input value={tgChat} onChange={(e) => setTgChat(e.target.value)} placeholder="Chat id" autoCapitalize="off" />
        </label>
        <button type="button" className="btn" onClick={() => void save()}>Save keys</button>
        {msg && <span className="blurb">{msg}</span>}
      </div>

      <div className="section-h">24/7</div>
      <p className="blurb">
        The scanner already loops inside this process. On Render <b>Starter</b> it never sleeps — confirm the service plan is Starter and instance count is 1.
        If the host is <b>Free</b>, add a cron-job.org ping every minute to <code>/api/keepalive</code> (or <code>/api/cron/tick</code> with <code>CRON_SECRET</code>),
        and set the GitHub repo variable <code>APP_URL</code> to this origin so Actions pings every 10 minutes.
      </p>
    </div>
  );
}
