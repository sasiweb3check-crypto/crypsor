import { useLocation } from "wouter";
import { api, timeAgo, type NoticeBoard } from "../lib/api";
import { usePoll, useSse } from "../hooks/use-data";

export default function NoticesPage() {
  const [, nav] = useLocation();
  const { tick } = useSse();
  const q = usePoll<NoticeBoard>(() => api("api/notices"), 15_000, [tick]);
  const items = q.data?.items ?? [];

  return (
    <div className="page">
      <div className="head">
        <h1>Calls</h1>
        <span className="muted">Rungs vs detected, plus score 40 / 60 / 80</span>
      </div>
      <p className="note">
        Tracked wallets only source names. Calls fire on 2× / 3× / 5× / 10× / 20× vs the
        buy freeze, when the frozen score crosses 40 / 60 / 80, and when top holders
        cluster enough to flag holders rug possible. Mint/freeze revoked is not a pass.
        Same-token extra wallets are not a signal.
      </p>

      {q.loading && !q.data ? <div className="skel" /> : null}
      {q.error ? <div className="empty err">{q.error}</div> : null}
      {!q.loading && items.length === 0 && !q.error ? (
        <div className="empty">No calls yet.</div>
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
                <span className={`st ${a.kind}`}>{a.kind === "rung" ? "call" : a.kind === "score" ? "score" : a.kind === "rug" ? "rug" : a.kind}</span>
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
