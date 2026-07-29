import { Link, useLocation } from "wouter";
import { Settings, Zap } from "lucide-react";
import { StarfieldBg } from "@/components/starfield";

export function AppShell({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const onSettings = location === "/settings";

  return (
    <div className="relative min-h-screen w-full overflow-hidden" style={{ background: "#03060f" }}>
      {/* Background */}
      <StarfieldBg />

      {/* Top bar */}
      <header
        className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-4 h-12"
        style={{ background: "rgba(3,6,15,0.72)", backdropFilter: "blur(8px)", borderBottom: "1px solid rgba(255,255,255,0.05)" }}
      >
        {/* Logo */}
        <Link href="/">
          <div className="flex items-center gap-2 cursor-pointer select-none">
            <Zap className="w-4 h-4 text-[#f59e0b] shrink-0" />
            <div className="leading-none">
              <div className="text-[#f59e0b] font-black tracking-widest text-xs uppercase">CRYPSOR</div>
              <div className="text-[#8b949e] text-[8px] tracking-widest uppercase" style={{ marginTop: 1 }}>Token Intel</div>
            </div>
          </div>
        </Link>

        {/* Settings icon */}
        <Link href={onSettings ? "/" : "/settings"}>
          <button
            title={onSettings ? "Back to Caller" : "Settings"}
            className="p-2 rounded-full transition-colors"
            style={{ color: onSettings ? "#f59e0b" : "#484f58" }}
            onMouseEnter={e => (e.currentTarget.style.color = "#f59e0b")}
            onMouseLeave={e => (e.currentTarget.style.color = onSettings ? "#f59e0b" : "#484f58")}
          >
            <Settings className="w-4 h-4" />
          </button>
        </Link>
      </header>

      {/* Page content — scrollable, above bg, below top bar */}
      <main className="relative z-10 pt-12 min-h-screen flex flex-col">
        {children}
      </main>
    </div>
  );
}
