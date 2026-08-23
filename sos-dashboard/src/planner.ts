/**
 * Typed client for the drone route planner backend (the `overture-test`
 * repo: FastAPI + DuckDB Spatial over Overture building data).
 *
 * The backend runs on the VPS and is reached from the browser through the
 * public tunnel URL.  Every planner call in this app goes through this
 * module - no raw fetch calls elsewhere.
 *
 * The tunnel URL rotates whenever the `netbird expose` process restarts
 * (VPS reboot etc).  To avoid a frontend rebuild on every rotation, the
 * URL + API key are resolved at RUNTIME from the same-origin backend
 * (`/api/planner-config`, which reads server-side PLANNER_API_URL /
 * PLANNER_API_KEY env vars).  The build-time VITE_PLANNER_API_URL /
 * VITE_PLANNER_API_KEY values remain as a fallback when the config
 * endpoint is unreachable or unset.
 *
 * The types below mirror the backend's OpenAPI schema (exported by
 * overture-test/frontend/scripts/export-openapi.py).  If the backend models
 * evolve, regenerate the schema and update these by hand - they are a small,
 * stable subset (planning + no-fly overlay + health).
 */

// ---------------------------------------------------------------------------
// Types (subset of the backend OpenAPI schema)
// ---------------------------------------------------------------------------

export interface Waypoint {
  lat: number;
  lon: number;
  alt: number;
}

export interface NoFlyZoneInfo {
  kind: "red" | "amber";
  name: string;
  /** closed ring of [lat, lon] vertices */
  ring: Array<[number, number]>;
}

export interface RouteResponse {
  mission_id: string;
  /** route length in metres */
  distance: number;
  /** flight time in seconds */
  estimated_time: number;
  waypoints: Waypoint[];
  /** null on a normal route; a human explanation on a degraded route */
  warning?: string | null;
  /** the direct start->goal line, always included for operator sanity checks */
  backup_waypoints?: Waypoint[] | null;
  /** every amber zone the route passes through (amber = passable WITH permission) */
  zones_crossed?: NoFlyZoneInfo[];
}

export type AlgorithmName = "astar" | "theta_star" | "visibility";

export interface MissionRequest {
  start_lat: number;
  start_lon: number;
  goal_lat: number;
  goal_lon: number;
  altitude_m?: number | null;
  grid_resolution_m?: number | null;
  safety_margin_m?: number | null;
  speed_mps?: number | null;
  snap_start_goal?: boolean;
  algorithm?: AlgorithmName | null;
}

export interface NoFlyZonesResponse {
  scope: string;
  fetched_at?: string | null;
  source?: string | null;
  zones: NoFlyZoneInfo[];
}

export interface HealthResponse {
  status: string;
  version: string;
  buildings_parquet: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Configuration (build-time fallback + runtime override)
// ---------------------------------------------------------------------------

/** Build-time fallback base URL (VITE_PLANNER_API_URL). Empty string =
 *  planner not configured -> the app degrades to straight-line fallback
 *  routes until configurePlanner() resolves a runtime URL. */
let plannerApiUrl =
  (import.meta.env.VITE_PLANNER_API_URL as string | undefined)
    ?.trim()
    .replace(/\/+$/, "") ?? "";

/** Build-time fallback shared secret (VITE_PLANNER_API_KEY). */
let plannerApiKey =
  (import.meta.env.VITE_PLANNER_API_KEY as string | undefined)?.trim() ?? "";

/** configurePlanner() runs at most once per page load. */
let plannerConfigResolved = false;

/** True once a planner base URL is known (build-time or runtime). */
export function isPlannerConfigured(): boolean {
  return Boolean(plannerApiUrl);
}

export function getPlannerApiKey(): string {
  return plannerApiKey;
}

/**
 * Resolve the planner URL + key from the same-origin backend
 * (`/api/planner-config` on server.js, which reads the server-side
 * PLANNER_API_URL / PLANNER_API_KEY env vars).  Called once at startup -
 * the tunnel URL rotates whenever the VPS tunnel restarts, and the
 * server-side vars can be updated + redeployed without rebuilding the
 * frontend bundle.  Falls back to the build-time VITE_ values on any
 * failure or when the endpoint reports empty values.
 */
export async function configurePlanner(): Promise<void> {
  if (plannerConfigResolved) return;
  plannerConfigResolved = true;
  try {
    const res = await fetch("/api/planner-config", {
      headers: { accept: "application/json" },
    });
    if (!res.ok) return;
    const data = (await res.json()) as { url?: string | null; key?: string | null };
    const url = String(data.url ?? "").trim().replace(/\/+$/, "");
    if (url) {
      plannerApiUrl = url;
      const key = String(data.key ?? "").trim();
      if (key) plannerApiKey = key;
    }
  } catch {
    // same-origin fetch failed (e.g. dev without the node server) -
    // keep the build-time values
  }
}

// ---------------------------------------------------------------------------
// Errors + transport
// ---------------------------------------------------------------------------

export class PlannerError extends Error {
  readonly status: number | undefined;
  /** True when the failure is infrastructure (network / proxy / protocol),
   *  not a planner answer - callers may retry via the blocking endpoint. */
  readonly transport: boolean;

  constructor(message: string, status?: number, transport = false) {
    super(message);
    this.name = "PlannerError";
    this.status = status;
    this.transport = transport;
  }
}

function buildHeaders(withJson: boolean): Record<string, string> {
  const headers: Record<string, string> = {};
  if (withJson) headers["content-type"] = "application/json";
  const apiKey = getPlannerApiKey();
  if (apiKey) headers["X-API-Key"] = apiKey;
  return headers;
}

/** Normalise a failed request into a PlannerError with the backend's
 *  `detail` message when available. */
async function toPlannerError(res: Response, fallback: string): Promise<PlannerError> {
  let detail: unknown = null;
  try {
    const data = await res.json();
    detail = (data as { detail?: unknown })?.detail;
  } catch {
    // non-JSON error body - use the fallback
  }
  const message =
    typeof detail === "string"
      ? detail
      : Array.isArray(detail)
        ? "Request validation failed"
        : fallback;
  // A non-2xx response means the planner never answered - treat as
  // infrastructure so the stream fallback can retry via the blocking call.
  return new PlannerError(message, res.status, true);
}

async function postJson(path: string, body: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${plannerApiUrl}${path}`, {
      method: "POST",
      headers: buildHeaders(true),
      body: JSON.stringify(body),
    });
  } catch (err) {
    // Fetch-level failure (network / proxy / protocol / CORS) - no status, so
    // callers can distinguish "the wire broke" from a real planner answer and
    // retry.
    throw new PlannerError(
      `Cannot reach the planner API at "${plannerApiUrl}" (${(err as Error).message})`,
      undefined,
      true,
    );
  }
  if (!res.ok) throw await toPlannerError(res, `Planner request failed (HTTP ${res.status})`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

/** POST /generate-route - blocking plan from start to goal. */
export async function generateRoute(body: MissionRequest): Promise<RouteResponse> {
  return (await postJson("/generate-route", body)) as RouteResponse;
}

export interface RouteStreamHandlers {
  /** The current best route changed - redraw the live polyline. */
  onPartial: (waypoints: Waypoint[]) => void;
}

/**
 * POST /generate-route/stream - same plan, streamed as NDJSON so the route
 * can be drawn while it is being computed.  Resolves with the final
 * RouteResponse (the `complete` event); throws PlannerError on an in-band
 * `error` event or transport failure.
 */
export async function generateRouteStream(
  body: MissionRequest,
  handlers: RouteStreamHandlers,
): Promise<RouteResponse> {
  let res: Response;
  try {
    res = await fetch(`${plannerApiUrl}/generate-route/stream`, {
      method: "POST",
      headers: { ...buildHeaders(true), accept: "application/x-ndjson" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new PlannerError(
      `Cannot reach the planner API at "${plannerApiUrl}" (${(err as Error).message})`,
      undefined,
      true,
    );
  }
  if (!res.ok) throw await toPlannerError(res, `stream endpoint unavailable (HTTP ${res.status})`);
  const reader = res.body?.getReader();
  if (!reader) throw new PlannerError("stream has no body", 502, true);
  const decoder = new TextDecoder();
  let buffer = "";
  let complete: RouteResponse | null = null;
  let streamError: PlannerError | null = null;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line);
        } catch {
          continue; // tolerate a malformed line rather than killing the stream
        }
        if (event.type === "stage") {
          const waypoints = event.waypoints as unknown;
          if (Array.isArray(waypoints) && waypoints.length) {
            handlers.onPartial(normalizeWaypoints(waypoints));
          }
        } else if (event.type === "complete" && event.data) {
          complete = event.data as unknown as RouteResponse;
        } else if (event.type === "error") {
          streamError = new PlannerError(
            typeof event.detail === "string" ? event.detail : "route planning failed",
            typeof event.status === "number" ? event.status : undefined,
          );
        }
      }
    }
  } catch (err) {
    // The connection died mid-stream - most commonly the tunnel proxy's
    // HTTP/2 handling of long-lived responses (the browser reports
    // ERR_HTTP2_PROTOCOL_ERROR; curl over HTTP/1.1 works fine).  Mark it as
    // transport so the caller retries via the blocking endpoint, which the
    // proxy serves without issue.
    throw new PlannerError(
      `route stream interrupted (${(err as Error)?.message ?? "connection error"})`,
      undefined,
      true,
    );
  } finally {
    reader.releaseLock();
  }
  if (streamError) throw streamError;
  if (!complete) throw new PlannerError("stream ended without a route", 502, true);
  return complete;
}

/** Stage waypoints arrive as JSON arrays (Python tuples); the complete event
 *  carries Pydantic Waypoint objects - accept both. */
function normalizeWaypoints(raw: unknown): Waypoint[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((waypoint) => {
    if (Array.isArray(waypoint)) {
      return { lat: Number(waypoint[0]), lon: Number(waypoint[1]), alt: Number(waypoint[2] ?? 0) };
    }
    return waypoint as Waypoint;
  });
}

/** GET /no-fly-zones?scope=... - imported DGCA airspace overlay (red/amber).
 *  ``bbox`` ("xmin,ymin,xmax,ymax" lon,lat) optionally restricts the
 *  response to zones overlapping the box - the backend hosts a full-region
 *  snapshot (india) and filters it server-side, so the browser only ever
 *  receives the local overlay. */
export async function fetchNoFlyZones(
  scope = "punjab",
  bbox?: string,
): Promise<NoFlyZonesResponse> {
  let res: Response;
  try {
    const params = new URLSearchParams({ scope });
    if (bbox) params.set("bbox", bbox);
    res = await fetch(`${plannerApiUrl}/no-fly-zones?${params.toString()}`, {
      headers: buildHeaders(false),
    });
  } catch (err) {
    throw new PlannerError(
      `Cannot reach the planner API at "${plannerApiUrl}" (${(err as Error).message})`,
      undefined,
      true,
    );
  }
  if (!res.ok) throw await toPlannerError(res, `no-fly zones fetch failed (HTTP ${res.status})`);
  return (await res.json()) as NoFlyZonesResponse;
}

/** GET /health - liveness + version. Returns null when unreachable. */
export async function fetchHealth(): Promise<HealthResponse | null> {
  try {
    const res = await fetch(`${plannerApiUrl}/health`, { headers: buildHeaders(false) });
    if (!res.ok) return null;
    return (await res.json()) as HealthResponse;
  } catch {
    return null;
  }
}
