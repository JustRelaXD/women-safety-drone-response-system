/**
 * Application types.
 *
 * The backend request/response models are NOT hand-written here: they are
 * generated from the FastAPI OpenAPI schema by `npm run generate:api`
 * (source: frontend/openapi.json, exported from the running backend by
 * frontend/scripts/export-openapi.py).  Whenever the backend models evolve,
 * re-run those two steps and this app stays in lockstep with the API.
 */
import type { components } from "./api.generated";

export type Waypoint = components["schemas"]["Waypoint"];
export type RouteResponse = components["schemas"]["RouteResponse"];
export type MissionResponse = components["schemas"]["MissionResponse"];
export type HealthResponse = components["schemas"]["HealthResponse"];
export type MissionRequest = components["schemas"]["MissionRequest"];
export type ReplanRequest = components["schemas"]["ReplanRequest"];
export type NoFlyZone = components["schemas"]["NoFlyZone"];
export type NoFlyZonesResponse = components["schemas"]["NoFlyZonesResponse"];
export type NoFlyZoneInfo = components["schemas"]["NoFlyZoneInfo"];
export type NoFlyZoneScopeInfo = components["schemas"]["NoFlyZoneScopeInfo"];

export type AlgorithmName = NonNullable<MissionRequest["algorithm"]>;

export const ALGORITHMS: AlgorithmName[] = ["astar", "theta_star", "visibility"];

export const ALGORITHM_LABELS: Record<AlgorithmName, string> = {
  astar: "A* (grid)",
  theta_star: "Theta* (any-angle)",
  visibility: "Visibility graph",
};

export const ALGORITHM_DESCRIPTIONS: Record<AlgorithmName, string> = {
  astar: "Fastest, grid search + line-of-sight smoothing (default)",
  theta_star: "Any-angle paths, fewer waypoints, slower on big grids",
  visibility: "Exact shortest path - small missions only",
};

/** A lat/lon pair as the planner speaks them (lat, lon in degrees). */
export interface GeoPoint {
  lat: number;
  lon: number;
}

/** A stored mission history entry (frontend-local). */
export interface MissionRecord {
  mission_id: string;
  created_at: string;
  request: MissionRequest;
  route: RouteResponse;
}
