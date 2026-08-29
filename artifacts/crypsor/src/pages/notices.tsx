import { useLocation } from "wouter";
import { api, timeAgo, type NoticeBoard } from "../lib/api";
import { usePoll, useSse } from "../hooks/use-data";
import { ScoreStrip } from "../components/pass-card";

export default function NoticesPage() {
  const [, nav] = useLocation();
  const { tick } = useSse();
  const q = usePoll<NoticeBoard>(() => api("api/notices"), 15_000, [tick]);
  const items = q.data?.items ?? [];
  const stats = q.data?.scoreStats ?? [];

  return (
    <div className="page">
      <div className="head">
        <h1>Notifications</h1>
        <span className="muted">High-MC alerts stay here — not on the desk.</span>
      </div>
      <p className="note">
        Screen and Telegram alerts are only the $5k–$30k detected band. Names above that
        still list on the desk; their admits / confirms / rungs land here. Score is frozen
        at each scan print (not live-ticked) so you can see which score range actually
        preceded 2× / 5×.
      </p>
      {stats.length ? <ScoreStrip stats={stats} /> : null}

      {q.loading && !q.data ? <div className="skel" /> : null}
      {q.error ? <div className="empty err">{q.error}</div> : null}
      {!q.loading && items.length === 0 && !q.error ? (
        <div className="empty">No high-range alerts stored yet.</div>
      ) : null}
      <div className="rows">
        {items.map((a) => (
          <button
            key={a.id}
            type="button"
            className="row-card notice-row"
            onClick={() => a.tokenId && nav(`/p/${a.tokenId}`)}
          >
            <div className="card-main">
              <div className="sym">
                {a.title}
                <span className={`st ${a.kind}`}>{a.kind}</span>
                {a.score != null ? <span className="lb watch">score {a.score}</span> : null}
              </div>
              <div className="meta">{a.body}</div>
            </div>
            <div className="side muted">{timeAgo(a.at)}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
