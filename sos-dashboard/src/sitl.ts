/**
 * Typed client for the local ArduPilot SITL bridge (a small Python service
 * that talks to ArduPilot SITL over MAVLink on the operator's laptop).
 *
 * The bridge runs at http://localhost:8002 during a live demo - it is NOT a
 * deployed service, so nothing here is proxied through the app backend.  The
 * base URL can be overridden at build time with VITE_SITL_URL.
 *
 * The dashboard treats the bridge as an optional upgrade to the built-in
 * GSAP drone animation: when the bridge is unreachable, every call here
 * fails silently and the app keeps simulating flights exactly as before.
 *
 * Contract (from the bridge, built and tested separately):
 *   GET  /health     -> { ok, connected, vehicle, mode, armed, home:[lat,lon],
 *                         lat, lon, alt, battery, phase }
 *   POST /mission    -> body { lat, lon, loiterSeconds } -> { ok, mission_id }
 *                       (or { ok:false, error } when the copter is busy)
 *   WS   /telemetry  -> ~10 Hz frames { lat, lon, alt, heading, battery,
 *                         mode, armed, phase }
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** What the simulated copter is doing right now. */
export type SitlPhase = "BOOTING" | "PATROL" | "EN_ROUTE" | "HOVERING" | "RTL";

/** Snapshot returned by GET /health. */
export interface SitlStatus {
  ok: boolean;
  connected: boolean;
  vehicle: string;
  mode: string;
  armed: boolean;
  /** [lat, lon] of the copter's home/patrol base. */
  home: [number, number];
  lat: number;
  lon: number;
  alt: number;
  battery: number;
  phase: SitlPhase;
}

/** One ~10 Hz telemetry frame from WS /telemetry. */
export interface SitlTelemetry {
  lat: number;
  lon: number;
  alt: number;
  heading: number;
  battery: number;
  mode: string;
  armed: boolean;
  phase: SitlPhase;
}

/** Result of POST /mission. */
export interface SitlMissionResult {
  ok: boolean;
  missionId?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Build-time override (VITE_SITL_URL); defaults to the local bridge. */
const sitlBaseUrl =
  (import.meta.env.VITE_SITL_URL as string | undefined)
    ?.trim()
    .replace(/\/+$/, "") ?? "http://localhost:8002";

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

/** GET /health - liveness + current state. Returns null when unreachable, so
 *  callers can treat it as "SITL not available" without error handling. */
export async function getSitlStatus(): Promise<SitlStatus | null> {
  try {
    const res = await fetch(`${sitlBaseUrl}/health`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    return (await res.json()) as SitlStatus;
  } catch {
    return null;
  }
}

/** POST /mission - hand an SOS target to the copter. Never throws; a failed
 *  or rejected mission returns { ok:false, error } so the caller can fall
 *  back to the simulated flight. */
export async function dispatchSitlMission(mission: {
  lat: number;
  lon: number;
  loiterSeconds: number;
}): Promise<SitlMissionResult> {
  try {
    const res = await fetch(`${sitlBaseUrl}/mission`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(mission),
    });
    const data = (await res.json().catch(() => ({}))) as SitlMissionResult;
    if (res.ok && data.ok) return { ok: true, missionId: data.missionId };
    return {
      ok: false,
      error: data.error || `mission rejected (HTTP ${res.status})`,
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** WS /telemetry - ~10 Hz position/phase stream.  Calls `onMessage` for every
 *  valid frame and returns an unsubscribe function that closes the socket.
 *  If the socket cannot be opened (bridge down), the returned unsubscribe is
 *  still safe to call and onMessage is simply never invoked. */
export function subscribeSitlTelemetry(
  onMessage: (telemetry: SitlTelemetry) => void,
): () => void {
  let socket: WebSocket | null = null;
  try {
    const wsUrl = `${sitlBaseUrl.replace(/^http/, "ws")}/telemetry`;
    socket = new WebSocket(wsUrl);
    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(String(event.data)) as SitlTelemetry;
        if (data && Number.isFinite(data.lat) && Number.isFinite(data.lon)) {
          onMessage(data);
        }
      } catch {
        // malformed frame - ignore and keep streaming
      }
    };
    socket.onerror = () => {
      try {
        socket?.close();
      } catch {
        // already closed
      }
    };
  } catch {
    // WebSocket constructor threw - nothing to close, just no-op unsubscribe
  }
  return () => {
    try {
      socket?.close();
    } catch {
      // already closed
    }
    socket = null;
  };
}
