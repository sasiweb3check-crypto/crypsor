import { useEffect } from "react";
import { useLocation } from "wouter";
import { useAlertToasts } from "../hooks/use-data";

export default function Toasts() {
  const [, nav] = useLocation();
  const { toasts, dismiss } = useAlertToasts();

  useEffect(() => {
    if (!toasts[0]) return;
    const id = toasts[0].id;
    const t = setTimeout(() => dismiss(id), 14_000);
    return () => clearTimeout(t);
  }, [toasts, dismiss]);

  if (toasts.length === 0) return null;

  return (
    <div className="toasts">
      {toasts.map((a) => (
        <button
          key={a.id}
          type="button"
          className={`toast ${a.kind}`}
          onClick={() => {
            dismiss(a.id);
            if (a.tokenId) nav(`/p/${a.tokenId}`);
          }}
        >
          <b>{a.title}</b>
          <span>{a.body}</span>
        </button>
      ))}
    </div>
  );
}
