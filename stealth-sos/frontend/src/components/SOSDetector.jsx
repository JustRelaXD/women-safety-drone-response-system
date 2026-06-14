/**
 * SOSDetector.jsx
 * Silently listens for:
 *  – Phone shake via DeviceMotionEvent
 *  – Desktop S-key press as fallback
 * When triggered, waits 3 s then fires onSOS(coords).
 */

import { useEffect, useRef } from 'react'

const SHAKE_THRESHOLD  = 18   // m/s² acceleration delta
const SHAKE_COOLDOWN   = 5000 // ms between triggers
const SILENT_DELAY_MS  = 3000 // 3-second stealth delay

export default function SOSDetector({ onSOS, active }) {
  const lastTrigger  = useRef(0)
  const lastAcc      = useRef({ x: 0, y: 0, z: 0 })
  const pendingTimer = useRef(null)

  // ── Core trigger ──────────────────────────────────────────────────
  const fireSOS = () => {
    const now = Date.now()
    if (now - lastTrigger.current < SHAKE_COOLDOWN) return
    lastTrigger.current = now

    // 3-second silent delay before anything visible happens
    if (pendingTimer.current) return
    pendingTimer.current = setTimeout(async () => {
      pendingTimer.current = null

      let lat = 51.5074 + (Math.random() - 0.5) * 0.02   // demo coords near London
      let lng = -0.1278 + (Math.random() - 0.5) * 0.02

      // Try real GPS first
      if (navigator.geolocation) {
        try {
          const pos = await new Promise((res, rej) =>
            navigator.geolocation.getCurrentPosition(res, rej, { timeout: 5000 })
          )
          lat = pos.coords.latitude
          lng = pos.coords.longitude
        } catch (_) {
          /* fallback to mock coords */
        }
      }

      onSOS({ lat, lng })
    }, SILENT_DELAY_MS)
  }

  // ── Keyboard listener (S key for desktop demo) ────────────────────
  useEffect(() => {
    if (!active) return
    const handleKey = (e) => {
      if (e.key === 's' || e.key === 'S') fireSOS()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [active])

  // ── Device motion / shake ─────────────────────────────────────────
  useEffect(() => {
    if (!active) return
    if (!window.DeviceMotionEvent) return

    const handleMotion = (e) => {
      const acc = e.acceleration || e.accelerationIncludingGravity
      if (!acc) return

      const dx = Math.abs(acc.x - lastAcc.current.x)
      const dy = Math.abs(acc.y - lastAcc.current.y)
      const dz = Math.abs(acc.z - lastAcc.current.z)

      lastAcc.current = { x: acc.x, y: acc.y, z: acc.z }

      if (dx + dy + dz > SHAKE_THRESHOLD) fireSOS()
    }

    // iOS 13+ requires permission
    if (typeof DeviceMotionEvent.requestPermission === 'function') {
      DeviceMotionEvent.requestPermission()
        .then((r) => {
          if (r === 'granted')
            window.addEventListener('devicemotion', handleMotion)
        })
        .catch(() => {})
    } else {
      window.addEventListener('devicemotion', handleMotion)
    }

    return () => {
      window.removeEventListener('devicemotion', handleMotion)
    }
  }, [active])

  // Component renders nothing – it's a pure behaviour layer
  return null
}
