import { useEffect, useMemo, useState } from "react";
import { MapContainer, TileLayer, useMap } from "react-leaflet";
import type { Map as LeafletMap } from "leaflet";

import { useSettingsStore } from "../../stores/settingsStore";
import { useMissionStore } from "../../stores/missionStore";
import { useTelemetryStore } from "../../stores/telemetryStore";
import { RouteLayer } from "./RouteLayer";
import { NoFlyLayer } from "./NoFlyLayer";
import { RouteZonesLayer } from "./RouteZonesLayer";
import { NoFlyScopeSwitcher } from "./NoFlyScopeSwitcher";
import { DroneMarker } from "./DroneMarker";
import { FitBounds, MapClickHandler } from "./MapBehaviors";
import { Button } from "../ui/Button";
import { cn } from "../../utils/cn";
import { BASEMAPS, resolveBasemap } from "../../utils/basemaps";

const DEFAULT_CENTER: [number, number] = [30.75, 75.6]; // Punjab, India

/** True when a coordinate is a usable number (defensive: streamed waypoints
 * must never feed Leaflet invalid positions, which white-screens the map). */
const isFiniteCoord = (v: number | undefined): v is number =>
  typeof v === "number" && Number.isFinite(v);

/** Subscribes to telemetry narrowly so the 60 fps drone updates never
 * re-render the whole map. */
function DroneLayer() {
  const status = useTelemetryStore((s) => s.status);
  const telemetry = useTelemetryStore((s) => s.telemetry);
  if (status === "idle" || status === "aborted" || !telemetry) return null;
  return <DroneMarker telemetry={telemetry} />;
}

/**
 * Exposes the Leaflet map instance to overlay components that are rendered
 * OUTSIDE <MapContainer> (interactive UI must live outside the map container
 * so its clicks never reach the Leaflet container and place map markers).
 */
function MapBridge({ onReady }: { onReady: (map: LeafletMap) => void }) {
  const map = useMap();
  useEffect(() => {
    onReady(map);
  }, [map, onReady]);
  return null;
}

/** Floating basemap picker (top-right). Persists the choice via settings.
 *
 * Rendered as a sibling of <MapContainer> (never inside it): clicks on the
 * menu can then not bubble into the Leaflet container, which would otherwise
 * fire the map's own click handler and place/reset mission markers.
 */
function BasemapSwitcher({ map }: { map: LeafletMap }) {
  const baseMap = useSettingsStore((s) => s.baseMap);
  const setBaseMap = useSettingsStore((s) => s.setBaseMap);
  const darkMode = useSettingsStore((s) => s.darkMode);
  const [open, setOpen] = useState(false);

  const selected = resolveBasemap(baseMap, darkMode);

  // close the menu when the map itself is clicked
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    map.on("click", close);
    return () => {
      map.off("click", close);
    };
  }, [open, map]);

  return (
    <div data-map-ui className="absolute right-2 top-2 z-[1000]">
      <Button
        size="sm"
        variant="ghost"
        className="bg-white/95 shadow-md dark:bg-slate-900/95"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <svg
          className="mr-1.5 h-3.5 w-3.5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m12 2 10 6.5-10 6.5L2 8.5 12 2Z" />
          <path d="m2 15.5 10 6.5 10-6.5" />
        </svg>
        {selected.label}
      </Button>
      {open && (
        <div className="mt-1 w-72 rounded-lg border border-slate-200 bg-white/95 p-1 shadow-lg backdrop-blur dark:border-slate-700 dark:bg-slate-900/95">
          {BASEMAPS.map((b) => {
            const active = selected.id === b.id;
            return (
              <button
                key={b.id}
                type="button"
                onClick={() => {
                  setBaseMap(b.id);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors",
                  active
                    ? "bg-emerald-50 dark:bg-emerald-900/20"
                    : "hover:bg-slate-100 dark:hover:bg-slate-800/60",
                )}
              >
                <span
                  className={cn(
                    "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2",
                    active
                      ? "border-emerald-500"
                      : "border-slate-300 dark:border-slate-600",
                  )}
                >
                  {active && <span className="h-2 w-2 rounded-full bg-emerald-500" />}
                </span>
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5">
                    <span className="text-sm font-medium text-slate-800 dark:text-slate-100">
                      {b.label}
                    </span>
                    {b.showsBuildings && (
                      <span className="rounded bg-emerald-100 px-1 py-px text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                        buildings
                      </span>
                    )}
                  </span>
                  <span className="block text-xs leading-snug text-slate-500 dark:text-slate-400">
                    {b.description}
                  </span>
                </span>
              </button>
            );
          })}
          <p className="border-t border-slate-200 px-2.5 pt-2 text-[11px] leading-snug text-slate-400 dark:border-slate-700 dark:text-slate-500">
            OSM layers only show OSM footprints - Overture also has buildings
            from Microsoft imagery. Satellite shows the real ground truth.
          </p>
        </div>
      )}
    </div>
  );
}

export function MissionMap() {
  const darkMode = useSettingsStore((s) => s.darkMode);
  const baseMap = useSettingsStore((s) => s.baseMap);
  const start = useMissionStore((s) => s.start);
  const goal = useMissionStore((s) => s.goal);
  const route = useMissionStore((s) => s.route);
  const partialWaypoints = useMissionStore((s) => s.partialWaypoints);
  const [map, setMap] = useState<LeafletMap | null>(null);

  const basemap = useMemo(
    () => resolveBasemap(baseMap, darkMode),
    [baseMap, darkMode],
  );

  const bounds = useMemo(() => {
    const pts: Array<[number, number]> = [];
    if (start && isFiniteCoord(start.lat) && isFiniteCoord(start.lon)) {
      pts.push([start.lat, start.lon]);
    }
    if (goal && isFiniteCoord(goal.lat) && isFiniteCoord(goal.lon)) {
      pts.push([goal.lat, goal.lon]);
    }
    if (route) {
      for (const w of route.waypoints) {
        if (isFiniteCoord(w.lat) && isFiniteCoord(w.lon)) pts.push([w.lat, w.lon]);
      }
    }
    // always keep the live partial route in view while planning is in
    // flight (during a replan the stale route is still present, but the
    // partial is what the user is watching)
    for (const w of partialWaypoints) {
      if (isFiniteCoord(w.lat) && isFiniteCoord(w.lon)) pts.push([w.lat, w.lon]);
    }
    return pts;
  }, [start, goal, route, partialWaypoints]);

  // stable key so FitBounds only runs when the geometry actually changes
  const fitKey = useMemo(
    () => (bounds.length ? JSON.stringify(bounds) : null),
    [bounds],
  );

  return (
    <div className="relative h-full w-full overflow-hidden rounded-xl border border-slate-200 dark:border-slate-800">
      <MapContainer
        center={start ? [start.lat, start.lon] : DEFAULT_CENTER}
        zoom={14}
        scrollWheelZoom
        className="h-full w-full"
      >
        <TileLayer
          key={basemap.id}
          url={basemap.url}
          attribution={basemap.attribution}
          maxZoom={basemap.maxZoom}
          {...(basemap.subdomains ? { subdomains: basemap.subdomains } : {})}
          {...(basemap.maxNativeZoom ? { maxNativeZoom: basemap.maxNativeZoom } : {})}
        />
        <MapBridge onReady={setMap} />
        <MapClickHandler />
        <FitBounds fitKey={fitKey} bounds={bounds} />
        <NoFlyLayer />
        <RouteZonesLayer />
        <RouteLayer
          waypoints={route?.waypoints ?? []}
          backup={route?.backup_waypoints ?? null}
          start={start}
          goal={goal}
          partial={partialWaypoints.length ? partialWaypoints : null}
        />
        <DroneLayer />
      </MapContainer>

      {map && <BasemapSwitcher map={map} />}
      <NoFlyScopeSwitcher />
      <PlanningChip />
      <MapOverlay start={!!start} goal={!!goal} />
    </div>
  );
}

/**
 * Live planning status pill (top-centre) while the backend computes: shows
 * the current pipeline stage and how many partial waypoints have arrived.
 */
function PlanningChip() {
  const status = useMissionStore((s) => s.status);
  const stageMessage = useMissionStore((s) => s.stageMessage);
  const partialCount = useMissionStore((s) => s.partialWaypoints.length);
  if (status !== "loading") return null;
  return (
    <div
      data-map-ui
      className="pointer-events-none absolute left-1/2 top-2 z-[1000] -translate-x-1/2"
    >
      <div className="flex items-center gap-2 rounded-full border border-sky-200 bg-white/95 px-3 py-1.5 text-xs text-sky-800 shadow-md backdrop-blur dark:border-sky-900/60 dark:bg-slate-900/95 dark:text-sky-200">
        <span className="h-2 w-2 animate-pulse rounded-full bg-sky-500" />
        <span className="font-medium">{stageMessage ?? "Planning…"}</span>
        {partialCount > 0 && (
          <span className="rounded-full bg-sky-100 px-1.5 py-0.5 text-[10px] font-semibold dark:bg-sky-900/40">
            {partialCount} wp
          </span>
        )}
      </div>
    </div>
  );
}

function MapOverlay({ start, goal }: { start: boolean; goal: boolean }) {
  const clearRoute = useMissionStore((s) => s.clearRoute);
  const setStart = useMissionStore((s) => s.setStart);
  const setGoal = useMissionStore((s) => s.setGoal);

  const hint = !start
    ? "Click the map to place the start point"
    : !goal
      ? "Now click the destination"
      : "Route ready - click again to start a new mission";

  return (
    <div
      data-map-ui
      className="pointer-events-none absolute left-2 top-2 z-[1000] flex flex-col gap-2"
    >
      <div className="pointer-events-auto flex items-center gap-2 rounded-lg bg-white/95 px-3 py-2 text-xs text-slate-700 shadow-md backdrop-blur dark:bg-slate-900/95 dark:text-slate-200">
        <span
          className={cn(
            "h-2 w-2 rounded-full",
            start ? "bg-emerald-500" : "bg-slate-300 dark:bg-slate-600",
          )}
        />
        <span>Start</span>
        <span
          className={cn(
            "ml-1 h-2 w-2 rounded-full",
            goal ? "bg-rose-500" : "bg-slate-300 dark:bg-slate-600",
          )}
        />
        <span>Goal</span>
        <span className="ml-2 font-medium text-slate-500 dark:text-slate-400">{hint}</span>
      </div>
      {(start || goal) && (
        <div className="pointer-events-auto">
          <Button
            size="sm"
            variant="ghost"
            className="bg-white/95 shadow-md dark:bg-slate-900/95"
            onClick={() => {
              setStart(null);
              setGoal(null);
              clearRoute();
            }}
          >
            Clear
          </Button>
        </div>
      )}
    </div>
  );
}
