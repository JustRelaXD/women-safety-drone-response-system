/**
 * DroneMarker.jsx
 * Renders the drone SVG icon as a Leaflet DivIcon.
 * Also renders a pulsing ring when the drone has arrived.
 */

import { useEffect, useRef } from 'react'
import { Marker, Circle, useMap } from 'react-leaflet'
import L from 'leaflet'

// ── Drone SVG icon ────────────────────────────────────────────────────
function createDroneIcon() {
  return L.divIcon({
    className: '',
    iconSize: [44, 44],
    iconAnchor: [22, 22],
    html: `
      <div style="
        width:44px; height:44px;
        display:flex; align-items:center; justify-content:center;
        filter: drop-shadow(0 0 10px rgba(59,130,246,0.9));
      ">
        <svg width="40" height="40" viewBox="0 0 40 40" fill="none"
             xmlns="http://www.w3.org/2000/svg">
          <!-- Arm TL -->
          <line x1="20" y1="20" x2="6"  y2="6"  stroke="#3B82F6" stroke-width="2"/>
          <!-- Arm TR -->
          <line x1="20" y1="20" x2="34" y2="6"  stroke="#3B82F6" stroke-width="2"/>
          <!-- Arm BL -->
          <line x1="20" y1="20" x2="6"  y2="34" stroke="#3B82F6" stroke-width="2"/>
          <!-- Arm BR -->
          <line x1="20" y1="20" x2="34" y2="34" stroke="#3B82F6" stroke-width="2"/>
          <!-- Rotors -->
          <circle cx="6"  cy="6"  r="5" fill="#0D1117" stroke="#3B82F6" stroke-width="1.5"/>
          <circle cx="34" cy="6"  r="5" fill="#0D1117" stroke="#3B82F6" stroke-width="1.5"/>
          <circle cx="6"  cy="34" r="5" fill="#0D1117" stroke="#3B82F6" stroke-width="1.5"/>
          <circle cx="34" cy="34" r="5" fill="#0D1117" stroke="#3B82F6" stroke-width="1.5"/>
          <!-- Body -->
          <circle cx="20" cy="20" r="6" fill="#1D4ED8"/>
          <circle cx="20" cy="20" r="3" fill="#93C5FD"/>
        </svg>
      </div>
    `,
  })
}

// ── Pulsing arrival ring (CSS animation) ─────────────────────────────
function createPulseRingIcon() {
  return L.divIcon({
    className: '',
    iconSize: [60, 60],
    iconAnchor: [30, 30],
    html: `
      <div style="position:relative; width:60px; height:60px;">
        <div class="drone-pulse-ring" style="
          position:absolute; inset:0;
          border-radius:50%;
          border:2px solid rgba(59,130,246,0.7);
        "></div>
        <div class="drone-pulse-ring" style="
          position:absolute; inset:0;
          border-radius:50%;
          border:2px solid rgba(59,130,246,0.4);
          animation-delay:0.5s;
        "></div>
      </div>
    `,
  })
}

// ── Component ─────────────────────────────────────────────────────────
export default function DroneMarker({ position, arrived }) {
  const droneIcon  = useRef(createDroneIcon())
  const pulseIcon  = useRef(createPulseRingIcon())
  const map        = useMap()

  // Smoothly pan map to keep drone visible
  useEffect(() => {
    if (position) {
      map.panTo([position.lat, position.lng], { animate: true, duration: 0.8 })
    }
  }, [position])

  if (!position) return null

  return (
    <>
      {/* Arrival pulse rings */}
      {arrived && (
        <Marker
          position={[position.lat, position.lng]}
          icon={pulseIcon.current}
          zIndexOffset={-10}
        />
      )}

      {/* Drone body marker */}
      <Marker
        position={[position.lat, position.lng]}
        icon={droneIcon.current}
        zIndexOffset={10}
      />
    </>
  )
}
