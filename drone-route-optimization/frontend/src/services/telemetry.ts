/**
 * Mock drone telemetry engine.
 *
 * Simulates a drone flying along the planned waypoint polyline at a fixed
 * ground speed: position is integrated along the route, heading follows the
 * bearing to the next waypoint, altitude is the mission altitude and battery
 * drains with distance.  The UI is "future-ready": when a real controller
 * (PX4/ROS2/ArduPilot) streams telemetry, only the data source behind the
 * telemetry store changes - the panels and drone marker stay the same.
 */
import type { Waypoint } from "../types";
import { bearingDeg, pointAlongPolyline, polylineLengthM } from "../utils/geo";

export type MissionStatus =
  | "idle"
  | "in-flight"
  | "paused"
  | "aborted"
  | "completed";

export interface DroneTelemetry {
  lat: number;
  lon: number;
  alt: number;
  speedMps: number;
  /** degrees, 0 = north, clockwise */
  headingDeg: number;
  /** 0..100 */
  batteryPct: number;
  /** index of the next waypoint to fly to */
  waypointIndex: number;
  distanceFlownM: number;
  progressPct: number;
}

/** full battery drains to 20 % after this distance (mock) */
const BATTERY_FULL_RANGE_M = 4000;

export class TelemetryEngine {
  private readonly pts: readonly Waypoint[];
  private readonly totalM: number;
  private readonly speedMps: number;
  private flownM = 0;

  constructor(waypoints: readonly Waypoint[], speedMps: number) {
    this.pts = waypoints;
    this.totalM = polylineLengthM(waypoints);
    this.speedMps = Math.max(1, speedMps);
  }

  /** Advance by `dtSeconds`; returns null when the mission is complete. */
  tick(dtSeconds: number): DroneTelemetry | null {
    if (this.pts.length === 0) return null;
    const advance = dtSeconds * this.speedMps;
    this.flownM = Math.min(this.totalM, this.flownM + advance);
    const { point, segmentIndex } = pointAlongPolyline(this.pts, this.flownM);

    // heading: bearing to the next waypoint (or the last segment bearing)
    const next = this.pts[Math.min(segmentIndex, this.pts.length - 1)];
    const headingDeg =
      segmentIndex < this.pts.length
        ? bearingDeg(point.lat, point.lon, next.lat, next.lon)
        : bearingDeg(
            this.pts[this.pts.length - 2].lat,
            this.pts[this.pts.length - 2].lon,
            this.pts[this.pts.length - 1].lat,
            this.pts[this.pts.length - 1].lon,
          );

    const batteryPct = Math.max(
      20,
      100 - (this.flownM / BATTERY_FULL_RANGE_M) * 80,
    );
    const progressPct =
      this.totalM === 0 ? 100 : (this.flownM / this.totalM) * 100;

    const done = this.flownM >= this.totalM - 1e-6;
    return {
      lat: point.lat,
      lon: point.lon,
      alt: next.alt,
      speedMps: this.speedMps,
      headingDeg,
      batteryPct,
      waypointIndex: done ? this.pts.length : segmentIndex,
      distanceFlownM: this.flownM,
      progressPct,
    };
  }
}
