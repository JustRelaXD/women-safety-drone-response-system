/**
 * Mission service - the only module that talks to the planner backend.
 *
 * Each method maps 1:1 to a REST endpoint.  If the backend is unreachable,
 * `demoRoute()` fabricates a plausible route so the UI remains fully
 * explorable without the Python service running.
 */
import { API_BASE, ApiError, client, errorMessage } from "./api";
import type {
  GeoPoint,
  HealthResponse,
  MissionRequest,
  MissionResponse,
  NoFlyZonesResponse,
  RouteResponse,
  Waypoint,
} from "../types";
import { bearingDeg, haversineM } from "../utils/geo";

// ---------------------------------------------------------------------------
// Streaming route generation (NDJSON)
//
// POST /generate-route/stream answers with newline-delimited JSON while the
// backend computes: `stage` events carry the pipeline progress (region /
// grid / degraded) and the current best route as `waypoints` (raw path,
// then LOS-smoothed, then geometry-refined), and a final `complete` event
// carries the same RouteResponse as the classic endpoint.  This lets the
// map draw the route as it takes shape instead of after a long wait.
//
// The NDJSON envelope is a transport detail the OpenAPI schema cannot
// express, so it is typed here rather than in the generated client.
// ---------------------------------------------------------------------------

export type RouteStage =
  | "region"
  | "grid"
  | "search"
  | "path"
  | "smooth"
  | "geometry"
  | "direct"
  | "degraded";

/** One parsed NDJSON line from the stream endpoint. */
export interface RouteStreamEvent {
  type: "stage" | "complete" | "error";
  stage?: RouteStage;
  /** stage waypoints arrive as JSON arrays (Python tuples); the complete
   *  event carries Pydantic Waypoint objects */
  waypoints?: Waypoint[] | Array<[number, number, number]>;
  buildings?: number;
  water?: number;
  width?: number;
  height?: number;
  cell_size_m?: number;
  reason?: string;
  /** search attempt counter: a new value means a NEW search started (the
   *  degraded fallback runs several), so the live line must reset */
  epoch?: number;
  data?: RouteResponse;
  status?: number;
  detail?: string;
}

export interface RouteStreamHandlers {
  /** A pipeline stage advanced (region/grid/path/smooth/geometry/degraded). */
  onStage: (stage: RouteStage, payload: Record<string, unknown>) => void;
  /** The current best route changed - redraw the live polyline. */
  onPartial: (waypoints: Waypoint[]) => void;
}

/**
 * Normalise a partial-waypoint payload into Waypoint objects.
 *
 * The backend serialises Python ``(lat, lon, alt)`` tuples as JSON arrays
 * (``[lat, lon, alt]``), while the final ``complete`` event carries
 * Pydantic ``Waypoint`` objects (``{lat, lon, alt}``).  Accept both so the
 * live polyline always gets valid coordinates.
 */
function normalizeWaypoints(raw: Waypoint[] | Array<[number, number, number]>): Waypoint[] {
  return raw.map((w) => {
    if (Array.isArray(w)) {
      return { lat: w[0], lon: w[1], alt: w[2] ?? 0 };
    }
    return w;
  });
}

/** Human-readable status line for a pipeline stage. */
export function stageLabel(
  stage: RouteStage,
  payload: Record<string, unknown>,
): string {
  switch (stage) {
    case "region":
      return `Querying buildings (${payload.buildings ?? "…"} found)`;
    case "grid":
      return `Building the grid (${payload.width}×${payload.height} cells)`;
    case "search":
      return "Searching - route growing toward the destination…";
    case "path":
      return "Path found - refining…";
    case "smooth":
      return "Smoothing the path…";
    case "geometry":
      return "Refining against building footprints…";
    case "direct":
      return "Direct line clear";
    case "degraded":
      return `Degraded: ${payload.reason ?? "no direct corridor"}`;
    default:
      return "Planning…";
  }
}

/**
 * Stream a route from the backend, invoking handlers as events arrive.
 * Resolves with the final RouteResponse (the `complete` event).  Throws an
 * ApiError with status 404 when the stream endpoint is unavailable so the
 * caller can fall back to the classic call.
 */
export async function generateRouteStream(
  body: MissionRequest,
  handlers: RouteStreamHandlers,
): Promise<RouteResponse> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/generate-route/stream`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/x-ndjson",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw errorMessage(err, "streaming generate-route failed");
  }
  if (!res.ok) {
    // stream endpoint missing (older backend): caller falls back to classic
    throw new ApiError(`stream endpoint unavailable (HTTP ${res.status})`, res.status);
  }
  const reader = res.body?.getReader();
  if (!reader) throw new ApiError("stream has no body", 502);
  const decoder = new TextDecoder();
  let buffer = "";
  let complete: RouteResponse | null = null;
  let streamError: ApiError | null = null;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let evt: RouteStreamEvent;
        try {
          evt = JSON.parse(line);
        } catch {
          continue; // tolerate a malformed line rather than killing the stream
        }
        if (evt.type === "stage") {
          if (evt.stage) handlers.onStage(evt.stage, evt as unknown as Record<string, unknown>);
          if (evt.waypoints?.length) {
            // partialWaypoints is replaced wholesale on every frame, so a
            // new search attempt (degraded fallback runs several: 0 m
            // retry, red-zone reroute, flood fill) naturally resets the
            // line to the new search's start.  The per-search ``epoch``
            // on search frames remains available to clients that want to
            // animate a distinct reset.
            handlers.onPartial(normalizeWaypoints(evt.waypoints));
          }
        } else if (evt.type === "complete" && evt.data) {
          complete = evt.data;
        } else if (evt.type === "error") {
          streamError = new ApiError(
            evt.detail ?? "route planning failed",
            evt.status,
          );
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (streamError) throw streamError;
  if (!complete) throw new ApiError("stream ended without a route", 502);
  return complete;
}

/**
 * Build an ApiError from an openapi-fetch error body.  The body is read
 * through `unknown` so it does not rely on the generated error schema
 * (endpoints that document no error response type their error branch as
 * `never`).  FastAPI 422 responses carry a `detail` array of validation
 * errors - surfaced as "Request validation failed".
 */
function badDetail(
  error: unknown,
  fallback: string,
  status: number | undefined,
): ApiError {
  const detail = (error as { detail?: unknown } | null)?.detail;
  const message =
    typeof detail === "string"
      ? detail
      : Array.isArray(detail)
        ? "Request validation failed"
        : fallback;
  return new ApiError(message, status);
}

export const missionApi = {
  /** POST /generate-route */
  async generateRoute(body: MissionRequest): Promise<RouteResponse> {
    try {
      const { data, error, response } = await client.POST("/generate-route", {
        body,
      });
      const status = response.status;
      if (error) throw badDetail(error, "generate-route failed", status);
      if (!data) throw new ApiError("generate-route returned no data", status);
      return data;
    } catch (err) {
      throw errorMessage(err, "generate-route failed");
    }
  },

  /** POST /replan - recompute from a new current position */
  async replan(body: MissionRequest): Promise<RouteResponse> {
    try {
      const { data, error, response } = await client.POST("/replan", { body });
      const status = response.status;
      if (error) throw badDetail(error, "replan failed", status);
      if (!data) throw new ApiError("replan returned no data", status);
      return data;
    } catch (err) {
      throw errorMessage(err, "replan failed");
    }
  },

  /** POST /mission - register a mission and plan it */
  async registerMission(
    missionId: string,
    body: MissionRequest,
  ): Promise<MissionResponse> {
    try {
      const { data, error, response } = await client.POST("/mission", {
        body: { ...body, mission_id: missionId },
      });
      const status = response.status;
      if (error) throw badDetail(error, "mission registration failed", status);
      if (!data) throw new ApiError("mission registration returned no data", status);
      return data;
    } catch (err) {
      throw errorMessage(err, "mission registration failed");
    }
  },

  /** GET /no-fly-zones - imported DGCA airspace overlay (scope = snapshot) */
  async noFlyZones(scope: string = "punjab"): Promise<NoFlyZonesResponse> {
    try {
      const { data, error, response } = await client.GET("/no-fly-zones", {
        params: { query: { scope } },
      });
      const status = response.status;
      if (error) throw badDetail(error, "no-fly zones fetch failed", status);
      if (!data) throw new ApiError("no-fly zones returned no data", status);
      return data;
    } catch (err) {
      throw errorMessage(err, "no-fly zones fetch failed");
    }
  },

  /** GET /health */
  async health(): Promise<HealthResponse> {
    try {
      const { data, error, response } = await client.GET("/health");
      const status = response.status;
      if (error) throw badDetail(error, "health check failed", status);
      if (!data) throw new ApiError("health check returned no data", status);
      return data;
    } catch (err) {
      throw errorMessage(err, "health check failed");
    }
  },
};

/**
 * A plausible demo route (used when the backend is unreachable) so the map,
 * statistics and telemetry panels can be explored offline.  It draws a
 * gentle zig-zag between start and goal with ~12 waypoints.
 */
export function demoRoute(start: GeoPoint, goal: GeoPoint): RouteResponse {
  const waypoints: RouteResponse["waypoints"] = [];
  const steps = 12;
  const alt = 50;
  for (let k = 0; k <= steps; k++) {
    const t = k / steps;
    const lat = start.lat + (goal.lat - start.lat) * t;
    const lon = start.lon + (goal.lon - start.lon) * t;
    // offset perpendicular to the direct line to fake a detour
    const off = Math.sin(t * Math.PI * 2) * (Math.min(haversineM(start.lat, start.lon, goal.lat, goal.lon), 3000) * 0.04);
    const perpLat = -(goal.lon - start.lon) / (haversineM(start.lat, start.lon, goal.lat, goal.lon) / 111_320 || 1);
    const perpLon = (goal.lat - start.lat) / (haversineM(start.lat, start.lon, goal.lat, goal.lon) / 95_500 || 1);
    const len = Math.hypot(perpLat, perpLon) || 1;
    waypoints.push({
      lat: lat + (perpLat / len) * off / 111_320,
      lon: lon + (perpLon / len) * off / 95_500,
      alt,
    });
  }
  let distance = 0;
  for (let k = 1; k < waypoints.length; k++) {
    distance += haversineM(waypoints[k - 1].lat, waypoints[k - 1].lon, waypoints[k].lat, waypoints[k].lon);
  }
  return {
    mission_id: `demo-${Date.now().toString(36)}`,
    distance: Math.round(distance),
    estimated_time: Math.round(distance / 15),
    waypoints,
  };
}

/** Bearing (deg) of the final approach, used for the demo drone heading. */
export function demoHeading(start: GeoPoint, goal: GeoPoint): number {
  return bearingDeg(start.lat, start.lon, goal.lat, goal.lon);
}

/**
 * Turn a failed planning call into an actionable message.  A 409 from the
 * backend means it honestly found no collision-free corridor.  The message
 * must not suggest remedies that cannot work: a coarser grid blocks MORE
 * area per building, so it can only remove corridors, never create one
 * (verified: the Amritsar 16 km mission fails at 10/25/50 m alike).  The
 * realistic operator options are picking a destination in open terrain and
 * sweeping the safety margin down: 0 m is the tightest the grid will plan
 * (the corridor is capped at the margin), so lower values open gaps that
 * wider margins seal.  In the densest cores the free space can be split
 * into disconnected islands - then no 2D setting helps and altitude-aware
 * planning is the long-term fix.
 */
export function planningErrorMessage(
  err: unknown,
  fallback: string,
): string {
  if (err instanceof ApiError && err.status === 409) {
    return (
      "No collision-free route exists between these points at the current " +
      "grid resolution and safety margin. In dense built-up areas the free " +
      "space can be split into disconnected islands, so no corridor exists " +
      "at any setting. Try a destination in more open terrain, or sweep the " +
      "safety margin down to 0 m in Settings - 0 m is the tightest corridor " +
      "the grid will plan and can open gaps that wider margins seal."
    );
  }
  return err instanceof Error ? err.message : fallback;
}
