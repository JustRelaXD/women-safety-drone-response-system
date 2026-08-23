import { useEffect, useState } from "react";
import { Polygon, Tooltip } from "react-leaflet";

import { useSettingsStore } from "../../stores/settingsStore";
import { missionApi } from "../../services/mission";
import type { NoFlyZoneInfo } from "../../types";
import { isAirfieldName } from "../../utils/airfield";

/**
 * Renders the imported DGCA airspace overlay: red no-fly polygons and amber
 * (controlled-airspace) polygons fetched from GET /no-fly-zones.  The data
 * comes from the local snapshot produced by scripts/import_no_fly_zones.py
 * (never from the live network at request time), so the overlay works fully
 * offline.  When the toggle is off, or the backend has no snapshot, nothing
 * is rendered.
 */
export function NoFlyLayer() {
  const enabled = useSettingsStore((s) => s.showNoFlyZones);
  const scope = useSettingsStore((s) => s.noFlyScope);
  const [zones, setZones] = useState<NoFlyZoneInfo[] | null>(null);

  useEffect(() => {
    let alive = true;
    if (!enabled) return;
    setZones(null);
    missionApi
      .noFlyZones(scope)
      .then((res) => {
        if (alive) setZones(res.zones ?? []);
      })
      .catch(() => {
        if (alive) setZones([]);
      });
    return () => {
      alive = false;
    };
  }, [enabled, scope]);

  if (!enabled || !zones || zones.length === 0) return null;

  return (
    <>
      {zones.map((zone, i) => {
        // ring arrives as [[lat, lon], ...] pairs
        const positions = zone.ring.map(([lat, lon]) => [lat, lon] as [number, number]);
        const red = zone.kind === "red";
        const isAirfield = isAirfieldName(zone.name);
        return (
          <Polygon
            key={`${zone.kind}-${zone.name}-${i}`}
            positions={positions}
            pathOptions={
              red
                ? { color: "#dc2626", weight: 1.5, fillColor: "#dc2626", fillOpacity: 0.28 }
                : { color: "#f59e0b", weight: 1.5, fillColor: "#f59e0b", fillOpacity: 0.16 }
            }
          >
            <Tooltip sticky>
              <span className={red ? "font-semibold text-rose-600" : "font-semibold text-amber-600"}>
                {red
                  ? isAirfield
                    ? "⛔ Runway/airfield - prohibited"
                    : "⛔ Red zone - prohibited"
                  : "⚠️ Amber zone - permission required"}
              </span>
              <br />
              {zone.name}
              {!red && isAirfield && (
                <>
                  <br />
                  <span className="text-[11px] text-slate-500 dark:text-slate-400">
                    Controlled airspace around the airfield - the runway
                    footprint is red (never crossable); approach funnels and
                    circles are amber (passable with permission)
                  </span>
                </>
              )}
            </Tooltip>
          </Polygon>
        );
      })}
    </>
  );
}
