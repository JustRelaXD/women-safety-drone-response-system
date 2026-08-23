import { useEffect } from "react";

import { useTelemetryStore } from "../stores/telemetryStore";

/**
 * Advances the mock telemetry engine every animation frame while a mission
 * is in-flight.  Mounted once at the app root, so the drone keeps moving on
 * every page (the planner page just renders the snapshot).
 */
export function useTelemetryLoop(): void {
  const status = useTelemetryStore((s) => s.status);
  const tick = useTelemetryStore((s) => s.tick);

  useEffect(() => {
    if (status !== "in-flight") return;
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.1); // clamp long gaps
      last = now;
      tick(dt);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [status, tick]);
}
