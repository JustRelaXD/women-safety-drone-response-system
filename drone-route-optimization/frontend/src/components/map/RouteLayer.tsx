import { useMemo } from "react";
import { Marker, Polyline, Tooltip } from "react-leaflet";
import MarkerClusterGroup from "react-leaflet-cluster";

import type { Waypoint } from "../../types";
import { goalIcon, startIcon, waypointIcon } from "./icons";

interface RouteLayerProps {
  waypoints: Waypoint[];
  start: { lat: number; lon: number } | null;
  goal: { lat: number; lon: number } | null;
  /** the direct start->goal line (operator backup, dashed on the map) */
  backup?: Waypoint[] | null;
  /** the live route being drawn while the backend is still planning */
  partial?: Waypoint[] | null;
}

/** Cluster waypoint markers only when there are enough to overlap. */
const CLUSTER_THRESHOLD = 20;

/** True when a coordinate is a usable number (defensive: partial waypoints
 * come from the backend and must never feed Leaflet invalid positions). */
const isFiniteCoord = (v: number | undefined): v is number =>
  typeof v === "number" && Number.isFinite(v);

export function RouteLayer({ waypoints, start, goal, backup, partial }: RouteLayerProps) {
  const positions = useMemo(
    () => waypoints.map((w) => [w.lat, w.lon] as [number, number]),
    [waypoints],
  );

  // the live partial route: drawn as a thin animated "drawing" line while
  // the backend refines it; replaced by the final route when complete
  const partialPositions = useMemo(
    () =>
      partial
        ? partial
            .filter((w) => isFiniteCoord(w.lat) && isFiniteCoord(w.lon))
            .map((w) => [w.lat, w.lon] as [number, number])
        : [],
    [partial],
  );

  // the direct start->goal line: dashed, drawn only when it differs from
  // the planned route (backup is null when the route IS the direct line)
  const backupPositions = useMemo(
    () => (backup ? backup.map((w) => [w.lat, w.lon] as [number, number]) : []),
    [backup],
  );

  const waypointNodes = useMemo(
    () =>
      waypoints.map((w, i) => (
        <Marker
          key={`${w.lat.toFixed(6)}-${w.lon.toFixed(6)}-${i}`}
          position={[w.lat, w.lon]}
          icon={waypointIcon(i + 1)}
        >
          <Tooltip direction="top" offset={[0, -14]}>
            Waypoint {i + 1}
          </Tooltip>
        </Marker>
      )),
    [waypoints],
  );

  return (
    <>
      {/* live partial route (planning in flight): sky-blue draw animation.
          Rendered even before the final route arrives - this is the whole
          point of the streaming feature. */}
      {partialPositions.length >= 2 && (
        <Polyline
          positions={partialPositions}
          pathOptions={{
            color: "#38bdf8",
            weight: 4,
            opacity: 0.9,
            lineCap: "round",
            className: "route-partial",
          }}
        />
      )}
      {waypoints.length === 0 && (
        <>
          {start ? <Marker position={[start.lat, start.lon]} icon={startIcon()} /> : null}
          {goal ? <Marker position={[goal.lat, goal.lon]} icon={goalIcon()} /> : null}
        </>
      )}
      {backupPositions.length >= 2 && (
        <Polyline
          positions={backupPositions}
          pathOptions={{
            color: "#f59e0b",
            weight: 2,
            opacity: 0.75,
            dashArray: "6 8",
            lineCap: "round",
          }}
        >
          <Tooltip sticky direction="top">
            Direct backup line - verify clearance before flying
          </Tooltip>
        </Polyline>
      )}
      {positions.length >= 2 && (
        <>
          {/* white casing keeps the route visible on satellite and dark basemaps */}
          <Polyline
            positions={positions}
            pathOptions={{ color: "#ffffff", weight: 8, opacity: 0.45, lineCap: "round" }}
          />
          <Polyline
            positions={positions}
            pathOptions={{
              color: "#10b981",
              weight: 4,
              opacity: 0.95,
              dashArray: "1 10",
              lineCap: "round",
              className: "route-final",
            }}
          />
          {waypoints.length > CLUSTER_THRESHOLD ? (
            <MarkerClusterGroup
              chunkedLoading
              spiderfyOnMaxZoom
              showCoverageOnHover={false}
              maxClusterRadius={40}
            >
              {waypointNodes}
            </MarkerClusterGroup>
          ) : (
            waypointNodes
          )}
          {start ? <Marker position={[start.lat, start.lon]} icon={startIcon()} /> : null}
          {goal ? <Marker position={[goal.lat, goal.lon]} icon={goalIcon()} /> : null}
        </>
      )}
    </>
  );
}
