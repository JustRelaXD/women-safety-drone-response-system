import sys
from pathlib import Path
import json
import asyncio
from datetime import datetime, timezone

sys.path.insert(0, str(Path(__file__).parent))

import server
from server import (
    app, db, signup, login, process_sos_dispatch, receive_sos, receive_location,
    resolve_mission, get_status, reset_demo, DRONES, LIVE_LOCATIONS, ACTIVE_MISSIONS, SOS_EVENTS, UserCreate, UserLogin,
    start_walk, complete_walk, get_active_walk, get_activities, DB_FILE, WalkStart
)

async def run_async_tests():
    print("--- 1. Health Check & Initial Fleet ---")
    print("Total drones:", len(DRONES))
    assert len(DRONES) >= 4
    available = [d for d in DRONES if d["status"] == "available"]
    assert len(available) == 4
    print("Initial available drones:", [d["id"] for d in available])

    print("\n--- 2. User Signup & Activity Logging ---")
    email = f"sos_test_{int(datetime.now(timezone.utc).timestamp())}@naira.app"
    signup_res = await signup(UserCreate(name="Persistence Test User", email=email, password="password123"))
    user_id = signup_res["user"]["id"]
    token = signup_res["token"]
    print("Signup success, user_id:", user_id)

    print("\n--- 3. Walk Mode Backend Persistence ---")
    walk_res = await start_walk(WalkStart(duration_minutes=15, latitude=12.9141, longitude=74.8560), authorization=f"Bearer {token}")
    print("Started walk:", walk_res)
    assert walk_res["status"] == "ACTIVE"
    assert walk_res["duration_minutes"] == 15

    active_walk = await get_active_walk(authorization=f"Bearer {token}")
    print("Retrieved active walk from DB:", active_walk)
    assert active_walk["status"] == "ACTIVE"

    complete_res = await complete_walk(authorization=f"Bearer {token}")
    print("Completed walk response:", complete_res)
    assert complete_res["status"] == "completed"

    active_walk_after = await get_active_walk(authorization=f"Bearer {token}")
    assert active_walk_after["status"] == "INACTIVE"

    print("\n--- 4. Trigger Rescue SOS Dispatch & Activity Logging ---")
    lat, lon = 12.9150, 74.8570
    doc, drone_id, nearest = await process_sos_dispatch(user_id, lat, lon, 88, "CONNECTED", "SHAKE_PATTERN")
    print(f"SOS Dispatched -> Emergency ID: {doc['id']} | Drone Assigned: {drone_id}")
    assert drone_id in ["DRONE-1", "DRONE-2", "DRONE-3", "N-01"]
    assert user_id in LIVE_LOCATIONS
    assert user_id in ACTIVE_MISSIONS

    print("\n--- 5. Verify Activities Logged in Database ---")
    activities = await get_activities(authorization=f"Bearer {token}")
    actions = [a["action"] for a in activities]
    print("Logged User Actions in DB:", actions)
    assert "USER_SIGNED_UP" in actions
    assert "WALK_STARTED" in actions
    assert "SAFE_ARRIVAL_CONFIRMED" in actions
    assert "SOS_DISPATCHED" in actions

    print("\n--- 6. Verify Persistent DB File (naira_db.json) ---")
    assert DB_FILE.exists()
    with open(DB_FILE, "r", encoding="utf-8") as f:
        db_content = json.load(f)
    print("Keys in persistent DB file:", list(db_content.keys()))
    assert "users" in db_content
    assert "emergencies" in db_content
    assert "walks" in db_content
    assert "activities" in db_content
    assert len(db_content["activities"]) >= 4

    print("\n--- 7. Reset Endpoint ---")
    reset_res = await reset_demo()
    print("Reset response:", reset_res)
    assert reset_res["status"] == "reset"

    print("\n=======================================================")
    print(">>> PERSISTENT ACTIVITY INTEGRATION TESTS PASSED! <<<")
    print("=======================================================")

if __name__ == "__main__":
    asyncio.run(run_async_tests())
