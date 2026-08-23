"""
sos_server.py

This is "the SOS system." It's a small web server with 3 jobs:

1. Receive an SOS from the phone app (POST /sos)
2. Figure out which drone is nearest, and mark it dispatched
3. Receive ongoing live-location updates from the phone (POST /location) —
   this is what lets a drone keep tracking a person who is moving, not
   just fly to wherever they were the moment they shook the phone
4. Let the dashboard (website) ask "what's happening right now?" (GET /status)

Run it with:
    pip install flask
    python3 sos_server.py

It will print a URL like http://0.0.0.0:5000 — that address, with your
laptop's real IP instead of 0.0.0.0, is what BOTH your Android app and your
dashboard website will talk to.
"""

from flask import Flask, request, jsonify
from datetime import datetime, timezone
import math

app = Flask(__name__)

# --------------------------------------------------------------------
# A pretend fleet of drones with fixed positions, standing in for real
# drone GPS data your Green Kimono system will provide later. Swap this
# for a real drone-location source when it exists — nothing else in this
# file needs to change.
# --------------------------------------------------------------------
DRONES = [
    {"id": "DRONE-1", "lat": 12.3060, "lon": 76.6550, "status": "available"},
    {"id": "DRONE-2", "lat": 12.2960, "lon": 76.6390, "status": "available"},
    {"id": "DRONE-3", "lat": 12.3150, "lon": 76.6470, "status": "available"},
]

# In-memory list of SOS events, most recent first. This is what the
# dashboard reads. (For a real system this would be a database — a plain
# list is enough for a hackathon demo.)
SOS_EVENTS = []

# The MOST RECENT location for each user, overwritten every time a new one
# arrives. This is the "live location" — separate from SOS_EVENTS, which is
# a history log. The dashboard/drone should always read from HERE for
# "where is this person right now," not from the original SOS event.
#   { user_id: {"latitude": .., "longitude": .., "updated_at": ..} }
LIVE_LOCATIONS = {}

# Which users currently have an active (undelivered) SOS, and which drone
# is responding — lets the dashboard show "DRONE-2 is currently tracking
# user X toward this live-updating point."
ACTIVE_MISSIONS = {}


def distance_km(lat1, lon1, lat2, lon2):
    """Straight-line distance between two GPS points, in kilometers."""
    R = 6371
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2
         + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2)
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def find_nearest_available_drone(lat, lon):
    available = [d for d in DRONES if d["status"] == "available"]
    if not available:
        return None
    return min(available, key=lambda d: distance_km(lat, lon, d["lat"], d["lon"]))


@app.route("/sos", methods=["POST"])
def receive_sos():
    """
    This is the ONE endpoint your Android app calls when a triple-shake is
    detected. Expected JSON body:
        { "user_id": "some-id", "latitude": 12.30, "longitude": 76.65 }
    """
    data = request.get_json(force=True, silent=True) or {}
    lat = data.get("latitude")
    lon = data.get("longitude")
    user_id = data.get("user_id", "unknown")

    if lat is None or lon is None:
        return jsonify({"error": "latitude and longitude are required"}), 400

    nearest = find_nearest_available_drone(lat, lon)
    if nearest is None:
        return jsonify({"error": "no drones available"}), 503

    nearest["status"] = "dispatched"

    # Record this first fix as both the initial event AND the current live
    # location — the app will keep overwriting LIVE_LOCATIONS from here on
    # via /location, so the drone always has a fresh point to fly toward.
    LIVE_LOCATIONS[user_id] = {
        "latitude": lat,
        "longitude": lon,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    ACTIVE_MISSIONS[user_id] = {"drone_id": nearest["id"], "status": "en_route"}

    event = {
        "user_id": user_id,
        "latitude": lat,
        "longitude": lon,
        "dispatched_drone": nearest["id"],
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    SOS_EVENTS.insert(0, event)

    print(f"[SOS] Received from {user_id} at ({lat},{lon}) -> dispatching {nearest['id']}")

    return jsonify({
        "status": "dispatched",
        "drone_id": nearest["id"],
        "message": f"{nearest['id']} is on the way",
    }), 200


@app.route("/location", methods=["POST"])
def receive_location():
    """
    Called repeatedly by the phone app — every few seconds while
    Protection is ON, and MORE often once an SOS is active — so this
    always holds the person's current position, not just where they were
    when they shook the phone.

    Expected JSON body: { "user_id": "some-id", "latitude": .., "longitude": .. }
    This does NOT dispatch a drone by itself — /sos is what starts a
    mission. This endpoint only keeps an already-started mission's target
    point up to date (and is harmless to call even with no active mission,
    for a future "always show live position on the dashboard" feature).
    """
    data = request.get_json(force=True, silent=True) or {}
    lat = data.get("latitude")
    lon = data.get("longitude")
    user_id = data.get("user_id", "unknown")

    if lat is None or lon is None:
        return jsonify({"error": "latitude and longitude are required"}), 400

    LIVE_LOCATIONS[user_id] = {
        "latitude": lat,
        "longitude": lon,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }

    return jsonify({"status": "location_updated"}), 200


@app.route("/sos/resolve", methods=["POST"])
def resolve_mission():
    """
    Call this when a mission is finished (the drone reached the person, or
    the situation is over) — e.g. from the dashboard's "resolve" button.
    Frees the drone back up and stops treating this user as an active
    mission. Expected JSON body: { "user_id": "some-id" }
    """
    data = request.get_json(force=True, silent=True) or {}
    user_id = data.get("user_id", "unknown")

    mission = ACTIVE_MISSIONS.pop(user_id, None)
    if mission:
        for d in DRONES:
            if d["id"] == mission["drone_id"]:
                d["status"] = "available"
    return jsonify({"status": "resolved"}), 200


@app.route("/status", methods=["GET"])
def get_status():
    """The dashboard (website) calls this to show current SOS activity and
    drone fleet status. Poll this every few seconds from the dashboard for
    a live-updating view."""
    # Build a live view of every active mission with its CURRENT location
    # (from LIVE_LOCATIONS), not the location from when the SOS first fired
    # — this is what the dashboard/drone should track a moving person with.
    active_missions_with_location = []
    for user_id, mission in ACTIVE_MISSIONS.items():
        active_missions_with_location.append({
            "user_id": user_id,
            "drone_id": mission["drone_id"],
            "status": mission["status"],
            "current_location": LIVE_LOCATIONS.get(user_id),
        })

    return jsonify({
        "drones": DRONES,
        "recent_sos_events": SOS_EVENTS[:10],
        "active_missions": active_missions_with_location,
    })


@app.route("/reset", methods=["POST"])
def reset_demo():
    """Convenience endpoint for testing — puts all drones back to
    'available' and clears the event log, so you can re-run a demo without
    restarting the server."""
    for d in DRONES:
        d["status"] = "available"
    SOS_EVENTS.clear()
    LIVE_LOCATIONS.clear()
    ACTIVE_MISSIONS.clear()
    return jsonify({"status": "reset"})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
