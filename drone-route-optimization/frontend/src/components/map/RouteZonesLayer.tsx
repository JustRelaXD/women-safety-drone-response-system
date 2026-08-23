import { useMemo } from "react";
import { Polygon, Tooltip } from "react-leaflet";

import { useMissionStore } from "../../stores/missionStore";
import type { NoFlyZoneInfo } from "../../types";
import { isAirfieldName } from "../../utils/airfield";

/**
 * Renders ONLY the airspace zones the planned route actually crosses
 * (backend-computed `route.zones_crossed`), so a mission never drowns in the
 * full red/amber overlay.
 *
 * Styling encodes the DGCA policy:
 * - amber = controlled airspace, PASSABLE with prior permission (dashed
 *   amber border + lighter fill so the corridor stays readable)
 * - red   = prohibited, never crossable (solid red; should only appear on a
 *   degraded route, where the final straight segment may cross one)
 *
 * Nothing is rendered until a route exists.
 */
export function RouteZonesLayer() {
  const route = useMissionStore((s) => s.route);

  const zones = useMemo(() => route?.zones_crossed ?? [], [route]);

  if (!route || zones.length === 0) return null;

  return (
    <>
      {zones.map((zone, i) => (
        <ZonePolygon key={`${zone.kind}-${zone.name}-${i}`} zone={zone} />
      ))}
    </>
  );
}

function ZonePolygon({ zone }: { zone: NoFlyZoneInfo }) {
  const positions = useMemo(
    () => zone.ring.map(([lat, lon]) => [lat, lon] as [number, number]),
    [zone],
  );
  const red = zone.kind === "red";
  const isAirfield = isAirfieldName(zone.name);

  return (
    <Polygon
      positions={positions}
      pathOptions={
        red
          ? {
              color: "#dc2626",
              weight: 2.5,
              fillColor: "#dc2626",
              fillOpacity: 0.22,
            }
          : {
              color: "#f59e0b",
              weight: 2.5,
              dashArray: "8 6",
              fillColor: "#f59e0b",
              fillOpacity: 0.12,
            }
      }
    >
      <Tooltip sticky>
        <span
          className={
            red ? "font-semibold text-rose-600" : "font-semibold text-amber-600"
          }
        >
          {red
            ? isAirfield
              ? "⛔ Runway/airfield - prohibited"
              : "⛔ Red zone - prohibited"
            : "⚠️ Amber zone - permission required"}
        </span>
        <br />
        {zone.name}
        {!red && (
          <>
            <br />
            <span className="text-[11px] text-slate-500 dark:text-slate-400">
              Route crosses this zone - prior permission + notify airport authority
            </span>
          </>
        )}
      </Tooltip>
    </Polygon>
  );
}
