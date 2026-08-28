import { useState } from "react";
import { useLocation } from "wouter";
import { api, timeAgo, type LiveBoard, type LiveSort } from "../lib/api";
import { usePoll, useSse } from "../hooks/use-data";
import { PassRow, PerformerCard } from "../components/pass-card";

const HOTS = [40, 55, 70] as const;
const SORTS: Array<{ id: LiveSort; label: string }> = [
  { id: "hot", label: "Hot" },
  { id: "gain", label: "Gain" },
  { id: "ath", label: "ATH" },
  { id: "mc", label: "MC" },
  { id: "new", label: "New" },
];

export default function WardPage() {
  const [, nav] = useLocation();
  const [hot, setHot] = useState<number>(40);
  const [sort, setSort] = useState<LiveSort>("hot");
  const { connected } = useSse();
  const board = usePoll<LiveBoard>(
    () => api(`api/stats?hot=${hot}&sort=${sort}`),
    6_000,
    [hot, sort],
  );
  const d = board.data;
  const live = d?.live ?? [];
  const performers = d?.performers ?? [];
  const open = (id: number) => nav(`/p/${id}`);

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">Crypsor <span>Desk</span></div>
        <div className="fresh">
          {connected ? "live" : "polling"}
          {d?.at ? ` · ${timeAgo(d.at)}` : ""}
          {live.length ? ` · ${live.length} hot` : ""}
        </div>
        <div className={`live-dot ${connected ? "on" : ""}`} />
      </header>

      {performers.length > 0 ? (
        <>
          <div className="section-h">Performers</div>
          <div className="performer-row">
            {performers.map((p) => (
              <PerformerCard key={p.token_id} p={p} onOpen={() => open(p.token_id)} />
            ))}
          </div>
        </>
      ) : null}

      <div className="section-row">
        <div className="section-h">Live</div>
        <div className="chips tight">
          {SORTS.map((s) => (
            <button
              key={s.id}
              type="button"
              className={sort === s.id ? "chip on" : "chip"}
              onClick={() => setSort(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>
      <div className="chips">
        {HOTS.map((n) => (
          <button
            key={n}
            type="button"
            className={hot === n ? "chip on" : "chip"}
            onClick={() => setHot(n)}
          >
            hot {n}+
          </button>
        ))}
      </div>

      {board.loading && !d ? (
        <>
          <div className="skel" /><div className="skel" /><div className="skel" />
        </>
      ) : null}
      {board.error ? <div className="empty err">{board.error}</div> : null}
      {!board.loading && live.length === 0 && !board.error ? (
        <div className="empty">
          Nothing at hotness {hot}+ yet. Names land here from the database once heat clears this floor.
        </div>
      ) : null}
      {live.map((p) => (
        <PassRow key={p.token_id} p={p} onOpen={() => open(p.token_id)} />
      ))}
    </div>
  );
}
