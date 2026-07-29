import { useEffect, useRef } from "react";

interface Star {
  x: number; y: number; r: number;
  opacity: number; twinkleSpeed: number; twinkleOffset: number;
}

interface Flake {
  x: number; y: number; r: number;
  speed: number; drift: number; opacity: number;
}

export function StarfieldBg() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let rafId = 0;
    let t = 0;

    const stars: Star[] = [];
    const flakes: Flake[] = [];

    function init(w: number, h: number) {
      stars.length = 0;
      flakes.length = 0;
      const starCount = Math.floor((w * h) / 4000);
      for (let i = 0; i < starCount; i++) {
        stars.push({
          x: Math.random() * w,
          y: Math.random() * h,
          r: Math.random() * 1.2 + 0.2,
          opacity: Math.random() * 0.6 + 0.2,
          twinkleSpeed: Math.random() * 0.015 + 0.005,
          twinkleOffset: Math.random() * Math.PI * 2,
        });
      }
      const flakeCount = Math.floor((w * h) / 12000);
      for (let i = 0; i < flakeCount; i++) {
        flakes.push({
          x: Math.random() * w,
          y: Math.random() * h,
          r: Math.random() * 1.8 + 0.4,
          speed: Math.random() * 0.4 + 0.15,
          drift: (Math.random() - 0.5) * 0.3,
          opacity: Math.random() * 0.35 + 0.08,
        });
      }
    }

    function resize() {
      const w = window.innerWidth;
      const h = window.innerHeight;
      canvas.width  = w;
      canvas.height = h;
      init(w, h);
    }

    function draw() {
      const w = canvas.width;
      const h = canvas.height;
      t += 1;

      ctx.clearRect(0, 0, w, h);

      // Stars — twinkle via sin
      for (const s of stars) {
        const o = s.opacity + Math.sin(t * s.twinkleSpeed + s.twinkleOffset) * 0.15;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(200,220,255,${Math.max(0, Math.min(1, o))})`;
        ctx.fill();
      }

      // Snow — fall + drift, wrap at bottom
      for (const f of flakes) {
        f.y += f.speed;
        f.x += f.drift + Math.sin(t * 0.008 + f.opacity * 10) * 0.12;
        if (f.y > h + 4) { f.y = -4; f.x = Math.random() * w; }
        if (f.x > w + 4) f.x = -4;
        if (f.x < -4)    f.x = w + 4;

        ctx.beginPath();
        ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(220,235,255,${f.opacity})`;
        ctx.fill();
      }

      rafId = requestAnimationFrame(draw);
    }

    resize();
    draw();

    const ro = new ResizeObserver(resize);
    ro.observe(document.documentElement);

    return () => {
      cancelAnimationFrame(rafId);
      ro.disconnect();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 w-full h-full pointer-events-none"
      style={{ zIndex: 0 }}
      aria-hidden
    />
  );
}
