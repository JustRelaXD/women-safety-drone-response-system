/** Geographic helpers (WGS84, haversine-based - no mapping library needed). */

const EARTH_RADIUS_M = 6_371_000;
const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

export function haversineM(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const p1 = lat1 * DEG2RAD;
  const p2 = lat2 * DEG2RAD;
  const dp = (lat2 - lat1) * DEG2RAD;
  const dl = (lon2 - lon1) * DEG2RAD;
  const a =
    Math.sin(dp / 2) ** 2 +
    Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

/** Initial bearing in degrees (0 = north, clockwise). */
export function bearingDeg(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const p1 = lat1 * DEG2RAD;
  const p2 = lat2 * DEG2RAD;
  const dl = (lon2 - lon1) * DEG2RAD;
  const y = Math.sin(dl) * Math.cos(p2);
  const x =
    Math.cos(p1) * Math.sin(p2) -
    Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) * RAD2DEG + 360) % 360;
}

export interface LatLon {
  lat: number;
  lon: number;
}

/**
 * Walk `distanceM` metres along the polyline `pts` (clamped at the end).
 * Returns the interpolated point, the next waypoint index and how many
 * waypoints were passed.
 */
export function pointAlongPolyline(
  pts: readonly LatLon[],
  distanceM: number,
): { point: LatLon; segmentIndex: number } {
  if (pts.length === 0) return { point: { lat: 0, lon: 0 }, segmentIndex: 0 };
  if (pts.length === 1) return { point: pts[0], segmentIndex: 0 };
  let remaining = Math.max(0, distanceM);
  for (let k = 1; k < pts.length; k++) {
    const seg = haversineM(pts[k - 1].lat, pts[k - 1].lon, pts[k].lat, pts[k].lon);
    if (remaining <= seg) {
      const t = seg === 0 ? 0 : remaining / seg;
      return {
        point: {
          lat: pts[k - 1].lat + (pts[k].lat - pts[k - 1].lat) * t,
          lon: pts[k - 1].lon + (pts[k].lon - pts[k - 1].lon) * t,
        },
        segmentIndex: k,
      };
    }
    remaining -= seg;
  }
  return { point: pts[pts.length - 1], segmentIndex: pts.length - 1 };
}

export function polylineLengthM(pts: readonly LatLon[]): number {
  let total = 0;
  for (let k = 1; k < pts.length; k++) {
    total += haversineM(pts[k - 1].lat, pts[k - 1].lon, pts[k].lat, pts[k].lon);
  }
  return total;
}
