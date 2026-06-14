/**
 * useSocket.js
 * Custom hook that manages a single Socket.IO connection to the backend
 * and exposes drone position / arrival events.
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import { io } from 'socket.io-client'

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:8000'

export function useSocket() {
  const socketRef      = useRef(null)
  const [dronePos, setDronePos]       = useState(null)   // { lat, lng, progress }
  const [droneArrived, setDroneArrived] = useState(false)
  const [connected, setConnected]     = useState(false)

  useEffect(() => {
    const socket = io(SOCKET_URL, {
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 10,
    })

    socketRef.current = socket

    socket.on('connect',          () => setConnected(true))
    socket.on('disconnect',       () => setConnected(false))

    // Continuous drone movement updates
    socket.on('drone_position', (data) => {
      setDronePos({ lat: data.lat, lng: data.lng, progress: data.progress })
    })

    // Final arrival event
    socket.on('drone_arrived', (data) => {
      setDronePos({ lat: data.lat, lng: data.lng, progress: 100 })
      setDroneArrived(true)
    })

    return () => {
      socket.disconnect()
    }
  }, [])

  const resetDrone = useCallback(() => {
    setDronePos(null)
    setDroneArrived(false)
  }, [])

  return { dronePos, droneArrived, connected, resetDrone }
}
