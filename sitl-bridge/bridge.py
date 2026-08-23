import asyncio
import json
import time
import threading
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pymavlink import mavutil

# ---- CONFIG ----
SITL_CONN = 'udp:127.0.0.1:14550'
HOME_LAT = 30.765
HOME_LON = 76.600
PATROL_ALT = 20  # meters
LOITER_RADIUS = 30  # meters, for patrol circling

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---- SHARED STATE ----
state = {
    "connected": False,
    "lat": HOME_LAT,
    "lon": HOME_LON,
    "alt": 0,
    "heading": 0,
    "battery": 100,
    "mode": "INIT",
    "armed": False,
    "phase": "BOOTING",  # BOOTING | PATROL | EN_ROUTE | HOVERING | RTL | DONE
}

master = None
mission_lock = threading.Lock()


def connect_sitl():
    global master
    print("Connecting to SITL...")
    master = mavutil.mavlink_connection(SITL_CONN)
    master.wait_heartbeat()
    print(f"Connected. System ID: {master.target_system}")
    state["connected"] = True


def set_mode(mode_name):
    mode_id = master.mode_mapping()[mode_name]
    master.mav.set_mode_send(
        master.target_system,
        mavutil.mavlink.MAV_MODE_FLAG_CUSTOM_MODE_ENABLED,
        mode_id
    )
    time.sleep(1)


def arm():
    master.mav.command_long_send(
        master.target_system, master.target_component,
        mavutil.mavlink.MAV_CMD_COMPONENT_ARM_DISARM,
        0, 1, 0, 0, 0, 0, 0, 0
    )
    master.recv_match(type='COMMAND_ACK', blocking=True, timeout=5)
    time.sleep(1)


def takeoff(alt):
    master.mav.command_long_send(
        master.target_system, master.target_component,
        mavutil.mavlink.MAV_CMD_NAV_TAKEOFF,
        0, 0, 0, 0, 0, 0, 0, alt
    )
    master.recv_match(type='COMMAND_ACK', blocking=True, timeout=5)


def goto(lat, lon, alt):
    master.mav.set_position_target_global_int_send(
        0, master.target_system, master.target_component,
        mavutil.mavlink.MAV_FRAME_GLOBAL_RELATIVE_ALT_INT,
        0b0000111111111000,  # use position only
        int(lat * 1e7), int(lon * 1e7), alt,
        0, 0, 0, 0, 0, 0, 0, 0
    )


def telemetry_reader():
    """Background thread: continuously read MAVLink messages and update state."""
    while True:
        if master is None:
            time.sleep(0.1)
            continue
        msg = master.recv_match(
            type=['GLOBAL_POSITION_INT', 'SYS_STATUS', 'HEARTBEAT'],
            blocking=True, timeout=1
        )
        if msg is None:
            continue
        t = msg.get_type()
        if t == 'GLOBAL_POSITION_INT':
            state["lat"] = msg.lat / 1e7
            state["lon"] = msg.lon / 1e7
            state["alt"] = msg.relative_alt / 1000
            state["heading"] = msg.hdg / 100
        elif t == 'SYS_STATUS':
            if msg.battery_remaining >= 0:
                state["battery"] = msg.battery_remaining
        elif t == 'HEARTBEAT':
            state["armed"] = bool(msg.base_mode & mavutil.mavlink.MAV_MODE_FLAG_SAFETY_ARMED)
            try:
                state["mode"] = mavutil.mode_string_v10(msg)
            except Exception:
                pass


def start_patrol():
    """Boot sequence: arm, take off, hold at home point as 'patrol'."""
    state["phase"] = "BOOTING"
    set_mode("GUIDED")
    arm()
    takeoff(PATROL_ALT)
    time.sleep(8)  # let it reach altitude
    goto(HOME_LAT, HOME_LON, PATROL_ALT)
    state["phase"] = "PATROL"
    print("Patrol established at home point.")


def run_sos_mission(target_lat, target_lon, loiter_seconds=15):
    """Divert from patrol to SOS location, hover, then return to patrol."""
    with mission_lock:
        state["phase"] = "EN_ROUTE"
        goto(target_lat, target_lon, PATROL_ALT)

        # wait until close to target (simple distance check loop)
        for _ in range(60):
            dlat = abs(state["lat"] - target_lat)
            dlon = abs(state["lon"] - target_lon)
            if dlat < 0.0003 and dlon < 0.0003:
                break
            time.sleep(1)

        state["phase"] = "HOVERING"
        print(f"Hovering at SOS location for {loiter_seconds}s (camera ON)...")
        time.sleep(loiter_seconds)

        state["phase"] = "RTL"
        goto(HOME_LAT, HOME_LON, PATROL_ALT)
        for _ in range(60):
            dlat = abs(state["lat"] - HOME_LAT)
            dlon = abs(state["lon"] - HOME_LON)
            if dlat < 0.0003 and dlon < 0.0003:
                break
            time.sleep(1)

        state["phase"] = "PATROL"
        print("Returned to patrol.")


# ---- API ROUTES ----

@app.get("/health")
def health():
    return {
        "ok": True,
        "connected": state["connected"],
        "vehicle": "ArduCopter",
        "mode": state["mode"],
        "armed": state["armed"],
        "home": [HOME_LAT, HOME_LON],
        "lat": state["lat"],
        "lon": state["lon"],
        "alt": state["alt"],
        "battery": state["battery"],
        "phase": state["phase"],
    }


@app.post("/mission")
async def mission(payload: dict):
    lat = payload["lat"]
    lon = payload["lon"]
    loiter_seconds = payload.get("loiterSeconds", 15)

    if state["phase"] not in ("PATROL",):
        return {"ok": False, "error": f"Drone busy, phase={state['phase']}"}

    threading.Thread(
        target=run_sos_mission, args=(lat, lon, loiter_seconds), daemon=True
    ).start()

    return {"ok": True, "mission_id": f"mission-{int(time.time())}"}


@app.websocket("/telemetry")
async def telemetry_ws(websocket: WebSocket):
    await websocket.accept()
    try:
        while True:
            await websocket.send_json({
                "lat": state["lat"],
                "lon": state["lon"],
                "alt": state["alt"],
                "heading": state["heading"],
                "battery": state["battery"],
                "mode": state["mode"],
                "armed": state["armed"],
                "phase": state["phase"],
            })
            await asyncio.sleep(0.1)  # 10Hz
    except WebSocketDisconnect:
        pass


# ---- STARTUP ----

@app.on_event("startup")
def on_startup():
    connect_sitl()
    threading.Thread(target=telemetry_reader, daemon=True).start()
    threading.Thread(target=start_patrol, daemon=True).start()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8002)
