import { useEffect, useMemo, useState } from "react";
import { Marker } from "react-leaflet";
import type L from "leaflet";

import { droneIcon } from "./icons";
import type { DroneTelemetry } from "../../services/telemetry";

/**
 * The animated drone marker.  react-leaflet calls `setLatLng` when the
 * position prop changes; the heading arrow is rotated via a direct style
 * write on the marker's icon element, so no icon is re-created per frame.
 */
export function DroneMarker({ telemetry }: { telemetry: DroneTelemetry }) {
  const [marker, setMarker] = useState<L.Marker | null>(null);
  const icon = useMemo(() => droneIcon(), []);

  useEffect(() => {
    const el = marker?.getElement();
    const arrow = el?.querySelector<HTMLElement>("[data-rotate]");
    if (arrow) arrow.style.transform = `rotate(${telemetry.headingDeg}deg)`;
  }, [marker, telemetry.headingDeg]);

  return (
    <Marker
      ref={setMarker}
      position={[telemetry.lat, telemetry.lon]}
      icon={icon}
    />
  );
}
