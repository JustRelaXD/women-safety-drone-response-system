/**
 * Planner settings, persisted to localStorage.
 *
 * These mirror the optional overrides the backend accepts on every mission
 * request (altitude_m, safety_margin_m, grid_resolution_m, speed_mps,
 * algorithm) plus the UI's own preferences (dark mode, map basemap).
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";

import { ALGORITHMS, type AlgorithmName } from "../types";
import { AUTO_BASEMAP, type BaseMapSetting } from "../utils/basemaps";

export interface SettingsState {
  algorithm: AlgorithmName;
  altitudeM: number;
  safetyMarginM: number;
  gridResolutionM: number;
  speedMps: number;
  darkMode: boolean;
  /** Map basemap; "auto" follows darkMode. */
  baseMap: BaseMapSetting;
  /** Show the imported DGCA red/amber no-fly overlay on the map. */
  showNoFlyZones: boolean;
  /** Which no-fly snapshot to display ("punjab", "india", ...). */
  noFlyScope: string;
  setAlgorithm: (v: AlgorithmName) => void;
  setAltitudeM: (v: number) => void;
  setSafetyMarginM: (v: number) => void;
  setGridResolutionM: (v: number) => void;
  setSpeedMps: (v: number) => void;
  setDarkMode: (v: boolean) => void;
  setBaseMap: (v: BaseMapSetting) => void;
  setShowNoFlyZones: (v: boolean) => void;
  setNoFlyScope: (v: string) => void;
  reset: () => void;
}

const DEFAULTS = {
  algorithm: "astar" as AlgorithmName,
  altitudeM: 50,
  safetyMarginM: 0,
  gridResolutionM: 10,
  speedMps: 15,
  darkMode: true,
  baseMap: AUTO_BASEMAP as BaseMapSetting,
  showNoFlyZones: true,
  noFlyScope: "punjab",
};

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      ...DEFAULTS,
      setAlgorithm: (v) =>
        set({ algorithm: ALGORITHMS.includes(v) ? v : DEFAULTS.algorithm }),
      setAltitudeM: (v) => set({ altitudeM: Math.min(500, Math.max(1, v)) }),
      setSafetyMarginM: (v) =>
        set({ safetyMarginM: Math.min(200, Math.max(0, v)) }),
      setGridResolutionM: (v) =>
        set({ gridResolutionM: Math.min(500, Math.max(1, v)) }),
      setSpeedMps: (v) => set({ speedMps: Math.min(200, Math.max(1, v)) }),
      setDarkMode: (v) => set({ darkMode: v }),
      setBaseMap: (v) => set({ baseMap: v }),
      setShowNoFlyZones: (v) => set({ showNoFlyZones: v }),
      setNoFlyScope: (v) => set({ noFlyScope: v }),
      reset: () => set({ ...DEFAULTS }),
    }),
    {
      // Adding a persisted field is backward compatible with the default
      // shallow merge, so the version must stay 1 or saved settings are wiped.
      name: "planner-settings",
      version: 1,
    },
  ),
);
