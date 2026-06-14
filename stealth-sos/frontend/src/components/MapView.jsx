/**
 * MapView.jsx
 * Dark-themed interactive map showing user position and drone in transit.
 */

import { MapContainer, TileLayer, Marker, Polyline, useMap } from 'react-leaflet'
import { useEffect, useRef } from 'react'
import L from 'leaflet'
import DroneMarker from './DroneMarker'

// ── User location marker ──────────────────────────────────────────────
function createUserIcon() {
  return L.divIcon({
    className: '',
    iconSize: [20, 20],
    iconAnchor: [10, 10],
    html: `
      <div style="position:relative; width:20px; height:20px;">
        <div style="
          position:absolute; inset:-8px;
          border-radius:50%;
          background: rgba(59,130,246,0.15);
          animation: ping 1.8s cubic-bezier(0,0,0.2,1) infinite;
        "></div>
        <div style="
          width:20px; height:20px;
          border-radius:50%;
          background:#3B82F6;
          border:3px solid #ffffff;
          box-shadow: 0 0 20px rgba(59,130,246,0.8);
        "></div>
      </div>
    `,
  })
}

// ── Auto-fit bounds when drone appears ───────────────────────────────
function BoundsController({ userPos, dronePos }) {
  const map = useMap()

  useEffect(() => {
    if (userPos && dronePos) {
      const bounds = L.latLngBounds(
        [userPos.lat, userPos.lng],
        [dronePos.lat, dronePos.lng]
      )
      map.fitBounds(bounds, { padding: [80, 80], animate: true, duration: 1 })
    }
  }, [dronePos?.lat])

  return null
}

// ── Main component ────────────────────────────────────────────────────
export default function MapView({ userPos, dronePos, droneArrived }) {
  const userIconRef = useRef(createUserIcon())

  const center = userPos
    ? [userPos.lat, userPos.lng]
    : [51.5074, -0.1278] // London fallback

  // Build polyline path showing route travelled
  const pathPoints = []
  if (dronePos)  pathPoints.push([dronePos.lat, dronePos.lng])
  if (userPos)   pathPoints.push([userPos.lat, userPos.lng])

  return (
    <MapContainer
      center={center}
      zoom={14}
      style={{ width: '100%', height: '100%' }}
      zoomControl={true}
      attributionControl={false}
    >
      {/* Dark CartoDB tiles */}
      <TileLayer
        url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
        maxZoom={19}
      />

      {/* Auto-fit controller */}
      {dronePos && (
        <BoundsController userPos={userPos} dronePos={dronePos} />
      )}

      {/* User position */}
      {userPos && (
        <Marker
          position={[userPos.lat, userPos.lng]}
          icon={userIconRef.current}
          zIndexOffset={20}
        />
      )}

      {/* Drone path line */}
      {pathPoints.length === 2 && (
        <Polyline
          positions={pathPoints}
          pathOptions={{
            color: '#3B82F6',
            weight: 1.5,
            opacity: 0.4,
            dashArray: '6 8',
          }}
        />
      )}

      {/* Drone marker */}
      <DroneMarker position={dronePos} arrived={droneArrived} />
    </MapContainer>
  )
}
