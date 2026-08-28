import { useLocation } from "wouter";
import { api, timeAgo, type LiveBoard } from "../lib/api";
import { useLiveBoard } from "../hooks/use-data";
import { PassRow, PerformerCard } from "../components/pass-card";

export default function WardPage() {
  const [, nav] = useLocation();
  const board = useLiveBoard<LiveBoard>(() => api("api/stats"));
  const d = board.data;
  const live = d?.live ?? [];
  const performers = d?.performers ?? [];
  const open = (id: number) => nav(`/p/${id}`);

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">Crypsor <span>Desk</span></div>
        <div className="fresh">
          {board.connected ? "live" : "polling"}
          {d?.at ? ` · ${timeAgo(d.at)}` : ""}
          {live.length ? ` · ${live.length} hot` : ""}
        </div>
        <div className={`live-dot ${board.connected ? "on" : ""}`} />
      </header>

      {performers.length > 0 && (
        <>
          <div className="section-h">Performers</div>
          <div className="performer-row">
            {performers.map((p) => (
              <PerformerCard key={p.token_id} p={p} onOpen={() => open(p.token_id)} />
            ))}
          </div>
        </>
      )}

      <div className="section-h">Live</div>
      {board.loading && !d && (
        <>
          <div className="skel" /><div className="skel" /><div className="skel" />
        </>
      )}
      {board.error && <div className="empty err">{board.error}</div>}
      {!board.loading && live.length === 0 && !board.error && (
        <div className="empty">
          Nothing hot enough yet. Scanner is running in the background — names only land here once heat clears the floor.
        </div>
      )}
      {live.map((p) => (
        <PassRow key={p.token_id} p={p} onOpen={() => open(p.token_id)} />
      ))}
    </div>
  );
}
