import L from "leaflet";

/** Start pin (emerald). */
export function startIcon(): L.DivIcon {
  return L.divIcon({
    className: "drone-pin",
    html: `
      <div class="pin start">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a7 7 0 0 0-7 7c0 5.25 7 13 7 13s7-7.75 7-13a7 7 0 0 0-7-7Zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5Z"/></svg>
      </div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 28],
    popupAnchor: [0, -26],
  });
}

/** Goal pin (rose). */
export function goalIcon(): L.DivIcon {
  return L.divIcon({
    className: "drone-pin",
    html: `
      <div class="pin goal">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a7 7 0 0 0-7 7c0 5.25 7 13 7 13s7-7.75 7-13a7 7 0 0 0-7-7Zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5Z"/></svg>
      </div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 28],
    popupAnchor: [0, -26],
  });
}

/** Numbered waypoint marker. */
export function waypointIcon(index: number): L.DivIcon {
  return L.divIcon({
    className: "drone-wp",
    html: `<div class="wp">${index}</div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  });
}

/**
 * Drone marker - the pulsing ring and the heading arrow.  The arrow element
 * carries `data-rotate` so the marker can be rotated in place (no icon
 * recreation per telemetry frame).
 */
export function droneIcon(): L.DivIcon {
  return L.divIcon({
    className: "drone-icon",
    html: `
      <div class="drone-wrap">
        <span class="drone-ring"></span>
        <svg class="drone-arrow" data-rotate viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 2 15 20l-3-4-3 4Z"/>
        </svg>
      </div>`,
    iconSize: [44, 44],
    iconAnchor: [22, 22],
  });
}
