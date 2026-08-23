/** Presentation helpers. */

export function formatDistance(m: number): string {
  if (m >= 1000) return `${(m / 1000).toFixed(2)} km`;
  return `${Math.round(m)} m`;
}

export function formatDuration(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "-";
  const total = Math.round(s);
  const min = Math.floor(total / 60);
  const sec = total % 60;
  if (min >= 60) {
    const h = Math.floor(min / 60);
    return `${h}h ${min % 60}m`;
  }
  return `${min}:${String(sec).padStart(2, "0")}`;
}

export function formatLatLon(lat: number, lon: number, digits = 5): string {
  return `${lat.toFixed(digits)}, ${lon.toFixed(digits)}`;
}

export function formatHeading(deg: number): string {
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const idx = Math.round(((deg % 360) + 360) % 360 / 45) % 8;
  return `${dirs[idx]} (${Math.round(deg)}°)`;
}

export function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString();
}
