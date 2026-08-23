/**
 * Telemetry store: the latest drone snapshot + mission execution status.
 *
 * Driven by the mock engine (services/telemetry.ts) through a
 * requestAnimationFrame loop (hooks/useTelemetryLoop.ts).  When a real
 * controller streams telemetry later, only this store's producer changes.
 */
import { create } from "zustand";

import type { Waypoint } from "../types";
import {
  TelemetryEngine,
  type DroneTelemetry,
  type MissionStatus,
} from "../services/telemetry";

export interface TelemetryState {
  status: MissionStatus;
  telemetry: DroneTelemetry | null;
  /** engine instance is runtime-only (not serialised) */
  engine: TelemetryEngine | null;
  start: (waypoints: Waypoint[], speedMps: number) => void;
  pause: () => void;
  resume: () => void;
  abort: () => void;
  tick: (dtSeconds: number) => void;
  reset: () => void;
}

export const useTelemetryStore = create<TelemetryState>()((set, get) => ({
  status: "idle",
  telemetry: null,
  engine: null,

  start: (waypoints, speedMps) => {
    const engine = new TelemetryEngine(waypoints, speedMps);
    const first = engine.tick(0);
    set({
      engine,
      status: "in-flight",
      telemetry: first ?? null,
    });
  },

  pause: () => {
    if (get().status === "in-flight") set({ status: "paused" });
  },

  resume: () => {
    if (get().status === "paused") set({ status: "in-flight" });
  },

  abort: () => set({ status: "aborted", engine: null }),

  tick: (dtSeconds) => {
    const { engine, status } = get();
    if (status !== "in-flight" || !engine) return;
    const telemetry = engine.tick(dtSeconds);
    if (telemetry === null) {
      set({ status: "completed", engine: null });
    } else {
      set({ telemetry });
    }
  },

  reset: () => set({ status: "idle", telemetry: null, engine: null }),
}));
