"""
Stealth SOS – Guardian Drone Response System
FastAPI + Socket.IO Backend
"""

import uvicorn
import socketio
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import asyncio

from drone_controller import DroneController

# ---------------------------------------------------------------------------
# Socket.IO + FastAPI setup
# ---------------------------------------------------------------------------
sio = socketio.AsyncServer(
    async_mode="asgi",
    cors_allowed_origins="*",
    logger=False,
    engineio_logger=False,
)

app = FastAPI(title="Stealth SOS API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Wrap FastAPI with Socket.IO ASGI app
socket_app = socketio.ASGIApp(sio, other_asgi_app=app)

# Global drone controller instance
drone_ctrl = DroneController(sio)

# ---------------------------------------------------------------------------
# REST Endpoints
# ---------------------------------------------------------------------------
class SOSRequest(BaseModel):
    latitude: float
    longitude: float

@app.post("/stealth-sos")
async def receive_sos(payload: SOSRequest):
    """
    Receive a silent SOS trigger.
    Returns the nearest drone info and kicks off simulation.
    """
    drone = drone_ctrl.dispatch_nearest_drone(payload.latitude, payload.longitude)

    # Start async simulation (non-blocking)
    asyncio.create_task(
        drone_ctrl.simulate_drone_movement(
            drone["id"], payload.latitude, payload.longitude
        )
    )

    return {
        "status": "dispatched",
        "drone_id": drone["id"],
        "drone_name": drone["name"],
        "estimated_arrival_seconds": drone["eta"],
        "start_lat": drone["lat"],
        "start_lng": drone["lng"],
    }

@app.get("/health")
async def health():
    return {"status": "ok", "service": "Stealth SOS Guardian"}

# ---------------------------------------------------------------------------
# Socket.IO Events
# ---------------------------------------------------------------------------
@sio.event
async def connect(sid, environ):
    print(f"[WS] Client connected: {sid}")

@sio.event
async def disconnect(sid):
    print(f"[WS] Client disconnected: {sid}")

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    uvicorn.run(
        "main:socket_app",
        host="0.0.0.0",
        port=8000,
        reload=True,
        log_level="warning",
    )
