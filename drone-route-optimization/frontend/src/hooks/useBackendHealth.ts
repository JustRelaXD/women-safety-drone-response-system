import { useCallback, useEffect, useState } from "react";

import { missionApi } from "../services/mission";
import type { HealthResponse } from "../types";

type Health = { state: "checking" | "ok" | "degraded" | "offline"; data: HealthResponse | null };

/**
 * Polls GET /health so the UI can degrade gracefully when the Python
 * backend is not running (demo routes + mock telemetry still work).
 */
export function useBackendHealth(intervalMs = 30_000): { health: Health; refresh: () => void } {
  const [health, setHealth] = useState<Health>({ state: "checking", data: null });

  const refresh = useCallback(async () => {
    try {
      const data = await missionApi.health();
      setHealth({
        state: data.status === "ok" ? "ok" : "degraded",
        data,
      });
    } catch {
      setHealth({ state: "offline", data: null });
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(refresh, intervalMs);
    return () => clearInterval(id);
  }, [refresh, intervalMs]);

  return { health, refresh };
}
