/**
 * Mission state: start/goal points, the planned route, request status and
 * local mission history.  All backend interaction goes through missionApi
 * (services/mission.ts); this store only orchestrates + holds results.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";

import type {
  GeoPoint,
  MissionRequest,
  MissionRecord,
  RouteResponse,
  Waypoint,
} from "../types";
import { ApiError } from "../services/api";
import {
  demoRoute,
  generateRouteStream,
  missionApi,
  planningErrorMessage,
  stageLabel,
} from "../services/mission";
import type { SettingsState } from "./settingsStore";

export type MissionStatus =
  | "idle"
  | "loading"
  | "success"
  | "error";

export interface MissionState {
  start: GeoPoint | null;
  goal: GeoPoint | null;
  route: RouteResponse | null;
  status: MissionStatus;
  error: string | null;
  usedDemo: boolean;
  missionId: string | null;
  /** the live route being drawn while planning is in flight */
  partialWaypoints: Waypoint[];
  /** human-readable current planning stage ("Querying buildings…") */
  stageMessage: string | null;
  history: MissionRecord[];
  setStart: (p: GeoPoint | null) => void;
  setGoal: (p: GeoPoint | null) => void;
  clearRoute: () => void;
  generateRoute: (settings: SettingsState) => Promise<void>;
  replan: (from: GeoPoint, settings: SettingsState) => Promise<void>;
  registerMission: (settings: SettingsState) => Promise<string | null>;
  loadDemo: () => void;
  loadFromHistory: (record: MissionRecord) => void;
  removeFromHistory: (id: string) => void;
}

export function requestFromPoints(
  start: GeoPoint,
  goal: GeoPoint,
  settings: SettingsState,
): MissionRequest {
  return {
    start_lat: start.lat,
    start_lon: start.lon,
    goal_lat: goal.lat,
    goal_lon: goal.lon,
    altitude_m: settings.altitudeM,
    grid_resolution_m: settings.gridResolutionM,
    safety_margin_m: settings.safetyMarginM,
    speed_mps: settings.speedMps,
    snap_start_goal: true,
    algorithm: settings.algorithm,
  };
}

const MAX_HISTORY = 50;

export const useMissionStore = create<MissionState>()(
  persist(
    (set, get) => ({
      start: null,
      goal: null,
      route: null,
      status: "idle",
      error: null,
      usedDemo: false,
      missionId: null,
      partialWaypoints: [],
      stageMessage: null,
      history: [],

      setStart: (p) => set({ start: p }),
      setGoal: (p) => set({ goal: p }),

      clearRoute: () =>
        set({
          route: null,
          status: "idle",
          error: null,
          usedDemo: false,
          missionId: null,
          partialWaypoints: [],
          stageMessage: null,
        }),

      /**
       * Plan with live streaming: partial waypoints appear on the map as
       * the backend computes (raw path, then smoothed, then final), with a
       * stage message alongside.  Falls back to the classic one-shot call
       * when the stream endpoint is unavailable (older backend).
       */
      generateRoute: async (settings) => {
        const { start, goal } = get();
        if (!start || !goal) {
          set({ status: "error", error: "Pick both a start and a destination on the map first." });
          return;
        }
        const body = requestFromPoints(start, goal, settings);
        set({ status: "loading", error: null, usedDemo: false, partialWaypoints: [], stageMessage: null });
        try {
          const route = await generateRouteStream(body, {
            onStage: (stage, payload) =>
              set({ stageMessage: stageLabel(stage, payload) }),
            onPartial: (waypoints) => set({ partialWaypoints: waypoints }),
          });
          set({ route, status: "success", missionId: route.mission_id, usedDemo: false, partialWaypoints: [], stageMessage: null });
        } catch (err) {
          // stream endpoint unavailable (older backend / 404): classic call
          if (err instanceof ApiError && err.status === 404) {
            try {
              const route = await missionApi.generateRoute(body);
              set({ route, status: "success", missionId: route.mission_id, usedDemo: false, partialWaypoints: [], stageMessage: null });
              return;
            } catch (fallbackErr) {
              set({
                status: "error",
                error: planningErrorMessage(fallbackErr, "Route generation failed"),
                partialWaypoints: [],
                stageMessage: null,
              });
              return;
            }
          }
          set({
            status: "error",
            error: planningErrorMessage(err, "Route generation failed"),
            partialWaypoints: [],
            stageMessage: null,
          });
        }
      },

      replan: async (from, settings) => {
        const { goal, route } = get();
        if (!goal) return;
        if (!route) {
          // no route yet - treat as a fresh generate from the new position
          await get().generateRoute(settings);
          return;
        }
        const body = requestFromPoints(from, goal, settings);
        set({ status: "loading", error: null, partialWaypoints: [], stageMessage: null });
        try {
          const newRoute = await generateRouteStream(body, {
            onStage: (stage, payload) =>
              set({ stageMessage: stageLabel(stage, payload) }),
            onPartial: (waypoints) => set({ partialWaypoints: waypoints }),
          });
          set({ route: newRoute, status: "success", missionId: newRoute.mission_id, usedDemo: false, partialWaypoints: [], stageMessage: null });
        } catch (err) {
          if (err instanceof ApiError && err.status === 404) {
            try {
              const newRoute = await missionApi.replan(body);
              set({ route: newRoute, status: "success", missionId: newRoute.mission_id, usedDemo: false, partialWaypoints: [], stageMessage: null });
              return;
            } catch (fallbackErr) {
              set({
                status: "error",
                error: planningErrorMessage(fallbackErr, "Replan failed"),
                partialWaypoints: [],
                stageMessage: null,
              });
              return;
            }
          }
          set({
            status: "error",
            error: planningErrorMessage(err, "Replan failed"),
            partialWaypoints: [],
            stageMessage: null,
          });
        }
      },

      registerMission: async (settings) => {
        const { start, goal, route } = get();
        if (!start || !goal || !route) return null;
        try {
          const id = route.mission_id;
          const resp = await missionApi.registerMission(id, requestFromPoints(start, goal, settings));
          const record: MissionRecord = {
            mission_id: resp.mission_id,
            created_at: new Date().toISOString(),
            request: requestFromPoints(start, goal, settings),
            route,
          };
          set((s) => ({
            history: [record, ...s.history].slice(0, MAX_HISTORY),
            missionId: resp.mission_id,
          }));
          return resp.mission_id;
        } catch {
          // registration is best-effort; route display is unaffected
          return null;
        }
      },

      loadDemo: () => {
        const { start, goal } = get();
        if (!start || !goal) return;
        const route = demoRoute(start, goal);
        set({
          route,
          status: "success",
          usedDemo: true,
          missionId: route.mission_id,
          error: null,
          partialWaypoints: [],
          stageMessage: null,
        });
      },

      loadFromHistory: (record) =>
        set({
          start: {
            lat: record.request.start_lat,
            lon: record.request.start_lon,
          },
          goal: { lat: record.request.goal_lat, lon: record.request.goal_lon },
          route: record.route,
          status: "success",
          missionId: record.mission_id,
          error: null,
          usedDemo: false,
          partialWaypoints: [],
          stageMessage: null,
        }),

      removeFromHistory: (id) =>
        set((s) => ({ history: s.history.filter((m) => m.mission_id !== id) })),
    }),
    {
      name: "planner-history",
      version: 1,
      partialize: (s) => ({ history: s.history }),
    },
  ),
);
