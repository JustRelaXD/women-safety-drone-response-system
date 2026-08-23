import { useEffect } from "react";
import L from "leaflet";
import { useMap, useMapEvents } from "react-leaflet";

import { useMissionStore } from "../../stores/missionStore";

/**
 * Click handling: first click places the start marker, the second the
 * destination; a third click starts a new mission (start moves, goal resets).
 * Uses getState() so the handler never goes stale.
 */
export function MapClickHandler() {
  useMapEvents({
    click: (e) => {
      // Clicks that originate inside UI overlays (basemap switcher, mission
      // controls) must NOT place mission markers: Leaflet fires the map's own
      // click event for any DOM element inside the map container that is not a
      // map layer, so we opt those overlays out explicitly.
      const target = e.originalEvent.target as HTMLElement | null;
      if (target && typeof target.closest === "function" && target.closest("[data-map-ui]")) {
        return;
      }
      const store = useMissionStore.getState();
      const point = { lat: e.latlng.lat, lon: e.latlng.lng };
      if (!store.start) {
        store.setStart(point);
        store.setGoal(null);
      } else if (!store.goal) {
        store.setGoal(point);
      } else {
        store.setStart(point);
        store.setGoal(null);
      }
    },
  });
  return null;
}

/**
 * Fits the map to the given bounds, but only when `fitKey` changes (a
 * stable serialised key), so panning/zooming is never interrupted.
 */
export function FitBounds({
  fitKey,
  bounds,
}: {
  fitKey: string | null;
  bounds: Array<[number, number]> | null;
}) {
  const map = useMap();
  useEffect(() => {
    if (!fitKey || !bounds || bounds.length === 0) return;
    map.fitBounds(L.latLngBounds(bounds), { padding: [48, 48], maxZoom: 17 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, fitKey]);
  return null;
}
