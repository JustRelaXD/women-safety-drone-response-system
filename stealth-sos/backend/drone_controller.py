"""
drone_controller.py
Handles drone fleet management and real-time movement simulation.
"""

import asyncio
import math
from typing import Any

# ---------------------------------------------------------------------------
# Mock drone fleet – positions near a generic city centre
# ---------------------------------------------------------------------------
DRONE_FLEET = [
    {"id": "DR-001", "name": "Guardian Alpha",  "lat": 51.5074, "lng": -0.1278},
    {"id": "DR-002", "name": "Guardian Beta",   "lat": 51.5120, "lng": -0.1100},
    {"id": "DR-003", "name": "Guardian Gamma",  "lat": 51.5000, "lng": -0.1400},
    {"id": "DR-004", "name": "Guardian Delta",  "lat": 51.5200, "lng": -0.0950},
]

STEPS        = 60      # animation steps
STEP_DELAY   = 0.5     # seconds between each broadcast


def _haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Return approximate distance in kilometres between two lat/lng points."""
    R = 6371.0
    d_lat = math.radians(lat2 - lat1)
    d_lng = math.radians(lng2 - lng1)
    a = (
        math.sin(d_lat / 2) ** 2
        + math.cos(math.radians(lat1))
        * math.cos(math.radians(lat2))
        * math.sin(d_lng / 2) ** 2
    )
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


class DroneController:
    def __init__(self, sio: Any):
        self.sio = sio

    # ------------------------------------------------------------------
    def dispatch_nearest_drone(self, target_lat: float, target_lng: float) -> dict:
        """Find the closest drone and return its metadata + ETA."""
        best = None
        best_dist = float("inf")

        for drone in DRONE_FLEET:
            dist = _haversine_km(drone["lat"], drone["lng"], target_lat, target_lng)
            if dist < best_dist:
                best_dist = dist
                best = drone

        # ETA: rough estimate – drone speed ≈ 60 km/h
        eta_seconds = int((best_dist / 60) * 3600)
        eta_seconds = max(10, min(eta_seconds, 120))  # clamp 10–120 s for demo

        return {**best, "distance_km": round(best_dist, 2), "eta": eta_seconds}

    # ------------------------------------------------------------------
    async def simulate_drone_movement(
        self,
        drone_id: str,
        target_lat: float,
        target_lng: float,
    ) -> None:
        """
        Gradually moves a drone from its starting position to the target.
        Broadcasts `drone_position` events via Socket.IO at each step,
        followed by a final `drone_arrived` event.
        """
        # Retrieve starting position from fleet
        start = next((d for d in DRONE_FLEET if d["id"] == drone_id), DRONE_FLEET[0])
        start_lat, start_lng = start["lat"], start["lng"]

        # Easing helper – slow-in slow-out
        def ease(t: float) -> float:
            return t * t * (3 - 2 * t)

        for step in range(STEPS + 1):
            t = ease(step / STEPS)
            cur_lat = start_lat + (target_lat - start_lat) * t
            cur_lng = start_lng + (target_lng - start_lng) * t

            payload = {
                "drone_id": drone_id,
                "lat": round(cur_lat, 7),
                "lng": round(cur_lng, 7),
                "progress": round(t * 100, 1),
            }

            await self.sio.emit("drone_position", payload)
            await asyncio.sleep(STEP_DELAY)

        # Final arrival broadcast
        await self.sio.emit(
            "drone_arrived",
            {
                "drone_id": drone_id,
                "lat": target_lat,
                "lng": target_lng,
                "message": "Guardian has arrived. Stay calm.",
            },
        )
