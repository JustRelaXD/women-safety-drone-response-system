import { useEffect, useState } from "react";

import { useSettingsStore } from "../../stores/settingsStore";
import { missionApi } from "../../services/mission";
import type { NoFlyZoneScopeInfo } from "../../types";
import { cn } from "../../utils/cn";

/**
 * Switches which no-fly snapshot the overlay displays (e.g. "punjab" vs
 * "india").  The available scopes come from GET /no-fly-zones (display-only:
 * this never changes the planner's obstacle set).  Hidden when the overlay
 * is off or the backend reports fewer than two scopes.
 *
 * Rendered as a sibling of <MapContainer> (never inside it), like
 * BasemapSwitcher, so button clicks cannot bubble into the Leaflet container
 * and place mission markers.
 */
export function NoFlyScopeSwitcher() {
  const enabled = useSettingsStore((s) => s.showNoFlyZones);
  const scope = useSettingsStore((s) => s.noFlyScope);
  const setScope = useSettingsStore((s) => s.setNoFlyScope);
  const [available, setAvailable] = useState<NoFlyZoneScopeInfo[] | null>(null);

  useEffect(() => {
    let alive = true;
    if (!enabled) return;
    missionApi
      .noFlyZones("punjab")
      .then((res) => {
        if (alive) setAvailable(res.available ?? []);
      })
      .catch(() => {
        if (alive) setAvailable([]);
      });
    return () => {
      alive = false;
    };
  }, [enabled]);

  if (!enabled || !available || available.length < 2) return null;

  return (
    <div
      data-map-ui
      className="absolute right-2 top-14 z-[1000] flex items-center gap-1 rounded-lg bg-white/95 p-1 shadow-md backdrop-blur dark:bg-slate-900/95"
    >
      {available.map((a) => {
        const active = a.name === scope;
        return (
          <button
            key={a.name}
            type="button"
            onClick={() => setScope(a.name)}
            title={`No-fly overlay: ${a.name} (${a.zones.toLocaleString()} zones)`}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors",
              active
                ? "bg-rose-500 text-white shadow-sm"
                : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800/60",
            )}
          >
            <span className="capitalize">{a.name}</span>
            <span
              className={cn(
                "rounded px-1 text-[10px] tabular-nums",
                active
                  ? "bg-white/20 text-white"
                  : "bg-slate-200 text-slate-500 dark:bg-slate-700 dark:text-slate-400",
              )}
            >
              {a.zones.toLocaleString()}
            </span>
          </button>
        );
      })}
    </div>
  );
}
