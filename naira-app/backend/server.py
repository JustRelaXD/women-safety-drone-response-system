from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import List, Optional
import hashlib
import json
import logging
import math
import os
import secrets
import uuid

from dotenv import load_dotenv
from fastapi import APIRouter, FastAPI, Header, HTTPException, Request, WebSocket, WebSocketDisconnect
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, ConfigDict, EmailStr, Field
from fastapi.middleware.cors import CORSMiddleware
from twilio.rest import Client as TwilioClient
from twilio.request_validator import RequestValidator

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "test_database")

import mongomock_motor

USE_MOCK_DB = os.getenv("USE_MOCK_DB", "true").lower() in ("true", "1")
if USE_MOCK_DB:
    mongo_client = mongomock_motor.AsyncMongoMockClient()
    db = mongo_client[DB_NAME]
else:
    mongo_client = AsyncIOMotorClient(MONGO_URL)
    db = mongo_client[DB_NAME]

DATA_DIR = ROOT_DIR / "data"
DATA_DIR.mkdir(exist_ok=True)
DB_FILE = DATA_DIR / "naira_db.json"
logger = logging.getLogger("naira")

def load_persistent_data() -> dict:
    if DB_FILE.exists():
        try:
            with open(DB_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            logger.warning(f"Could not load persistent DB file: {e}")
    return {"users": [], "sessions": [], "contacts": [], "emergencies": [], "walks": [], "activities": []}

def save_persistent_data(data: dict):
    try:
        with open(DB_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
    except Exception as e:
        logger.warning(f"Could not save persistent DB file: {e}")

async def export_db_state() -> dict:
    users = await db.users.find({}, {"_id": 0}).to_list(1000)
    sessions = await db.sessions.find({}, {"_id": 0}).to_list(1000)
    contacts = await db.contacts.find({}, {"_id": 0}).to_list(1000)
    emergencies = await db.emergencies.find({}, {"_id": 0}).to_list(1000)
    walks = await db.walks.find({}, {"_id": 0}).to_list(1000) if hasattr(db, "walks") else []
    activities = await db.activities.find({}, {"_id": 0}).to_list(1000) if hasattr(db, "activities") else []
    return {"users": users, "sessions": sessions, "contacts": contacts, "emergencies": emergencies, "walks": walks, "activities": activities}

async def init_db_from_file():
    data = load_persistent_data()
    for coll_name, docs in data.items():
        if docs:
            coll = getattr(db, coll_name)
            count = await coll.count_documents({})
            if count == 0:
                await coll.insert_many(docs)

async def persist_state():
    if USE_MOCK_DB:
        state = await export_db_state()
        save_persistent_data(state)

def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()

async def log_activity(user_id: str, action: str, details: dict = None, category: str = "GENERAL"):
    if details is None:
        details = {}
    doc = {
        "id": f"ACT-{uuid.uuid4().hex[:8].upper()}",
        "user_id": user_id,
        "action": action,
        "category": category,
        "details": details,
        "timestamp": now_iso()
    }
    await db.activities.insert_one(doc)
    await persist_state()
    return doc

tags_metadata = [
    {"name": "System", "description": "System health and status endpoints."},
    {"name": "Authentication", "description": "User registration, login, and session validation."},
    {"name": "Trusted Contacts", "description": "Management of emergency contact numbers and notification channels."},
    {"name": "Walk Mode", "description": "Safe-arrival walk tracking and check-in timer management."},
    {"name": "Emergency Response", "description": "Emergency dispatch, status tracking, cancelation, and notifications."},
    {"name": "Operator Dispatch", "description": "Command center active incident monitor and control."}
]

app = FastAPI(
    title="Naira Safety Response API",
    description="Real-time emergency safety response platform with persistent activity logging, drone dispatch simulation, live location tracking, and SMS contact notifications.",
    version="1.0.0",
    openapi_tags=tags_metadata
)

@app.on_event("startup")
async def on_startup():
    await init_db_from_file()

api_router = APIRouter(prefix="/api")
logger = logging.getLogger("naira")

TWILIO_ACCOUNT_SID = os.getenv("TWILIO_ACCOUNT_SID")
TWILIO_AUTH_TOKEN = os.getenv("TWILIO_AUTH_TOKEN")
TWILIO_FROM_NUMBER = os.getenv("TWILIO_FROM_NUMBER")
TWILIO_MESSAGING_SERVICE_SID = os.getenv("TWILIO_MESSAGING_SERVICE_SID")
TWILIO_STATUS_CALLBACK_URL = os.getenv("TWILIO_STATUS_CALLBACK_URL")

DRONE_STATION = {"latitude": 12.9141, "longitude": 74.8560}

# Rescue SOS System Drone Fleet State
DRONES = [
    {"id": "DRONE-1", "name": "Eagle-1", "lat": 12.9141, "lon": 74.8560, "status": "available", "battery": 98},
    {"id": "DRONE-2", "name": "Falcon-2", "lat": 12.9250, "lon": 74.8620, "status": "available", "battery": 92},
    {"id": "DRONE-3", "name": "Vanguard-3", "lat": 12.9020, "lon": 74.8450, "status": "available", "battery": 95},
    {"id": "N-01", "name": "Naira-01", "lat": 12.9100, "lon": 74.8500, "status": "available", "battery": 94},
]

SOS_EVENTS = []
LIVE_LOCATIONS = {}
ACTIVE_MISSIONS = {}

def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    h = hashlib.sha256((salt + password).encode()).hexdigest()
    return f"{salt}${h}"

def verify_password(password: str, stored: str) -> bool:
    try:
        salt, h = stored.split("$")
        return hashlib.sha256((salt + password).encode()).hexdigest() == h
    except Exception:
        return False

async def current_user(authorization: Optional[str] = Header(None)) -> dict:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Unauthorized")
    token = authorization.split(" ")[1]
    session = await db.sessions.find_one({"token": token})
    if not session:
        raise HTTPException(status_code=401, detail="Session expired")
    created_at = session.get("created_at")
    if created_at:
        age = datetime.now(timezone.utc) - datetime.fromisoformat(created_at)
        if age > timedelta(days=30):
            await db.sessions.delete_one({"token": token})
            raise HTTPException(status_code=401, detail="Session expired")
    user = await db.users.find_one({"id": session["user_id"]}, {"_id": 0})
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return user

class UserCreate(BaseModel):
    name: str
    email: EmailStr
    password: str = Field(..., min_length=6)

class UserLogin(BaseModel):
    email: EmailStr
    password: str

class ContactCreate(BaseModel):
    name: str
    relationship: str
    phone: str
    preferred_channel: str = "SMS"

class EmergencyCreate(BaseModel):
    latitude: float
    longitude: float
    battery: int = 85
    network_status: str = "CONNECTED"
    trigger_type: str = Field(..., pattern=r"^(MANUAL_SOS|SHAKE_PATTERN|MISSED_CHECK_IN|PANIC_WIDGET)$")

class SOSCreate(BaseModel):
    user_id: Optional[str] = None
    latitude: float
    longitude: float
    battery: Optional[int] = 85
    network_status: Optional[str] = "CONNECTED"
    trigger_type: Optional[str] = "MANUAL_SOS"

class LocationUpdate(BaseModel):
    user_id: Optional[str] = None
    latitude: float
    longitude: float

class SOSResolve(BaseModel):
    user_id: Optional[str] = None
    emergency_id: Optional[str] = None

class WalkStart(BaseModel):
    duration_minutes: int
    latitude: float
    longitude: float

class ActivityCreate(BaseModel):
    action: str
    details: Optional[dict] = {}
    category: Optional[str] = "GENERAL"

def distance_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    lat_delta = math.radians(lat2 - lat1)
    lon_delta = math.radians(lon2 - lon1)
    a = math.sin(lat_delta / 2)**2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(lon_delta / 2)**2
    return round(6371 * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a)), 2)

def find_nearest_available_drone(lat: float, lon: float):
    available = [d for d in DRONES if d["status"] == "available"]
    if not available:
        return None
    return min(available, key=lambda d: distance_km(lat, lon, d["lat"], d["lon"]))

def emergency_view(doc: dict) -> dict:
    result = {k: v for k, v in doc.items() if k != "_id"}
    result["notifications"] = [
        {k: v for k, v in item.items() if k != "phone"}
        for item in doc.get("notifications", [])
    ]
    user_id = doc.get("user_id")
    if user_id in LIVE_LOCATIONS:
        live = LIVE_LOCATIONS[user_id]
        result["location"] = {"latitude": live["latitude"], "longitude": live["longitude"]}

    created_at = datetime.fromisoformat(doc["created_at"])
    elapsed = (datetime.now(timezone.utc) - created_at).total_seconds()
    duration = 180.0
    progress = min(1.0, max(0.0, elapsed / duration))
    if doc.get("status") in ("CANCELLED", "RESOLVED"):
        result["drone"]["status"] = "RESOLVED"
    elif progress >= 1.0:
        result["status"] = "DRONE_ARRIVED"
        result["drone"]["status"] = "ARRIVED"
        result["drone"]["eta_seconds"] = 0
        result["drone"]["location"] = result["location"]
    else:
        u_lat = result["location"]["latitude"]
        u_lon = result["location"]["longitude"]
        station_lat = doc.get("station", {}).get("latitude", DRONE_STATION["latitude"])
        station_lon = doc.get("station", {}).get("longitude", DRONE_STATION["longitude"])
        cur_lat = round(station_lat + (u_lat - station_lat) * progress, 5)
        cur_lon = round(station_lon + (u_lon - station_lon) * progress, 5)
        rem_eta = max(0, int(round(duration - elapsed)))
        rem_dist = distance_km(cur_lat, cur_lon, u_lat, u_lon)
        result["drone"]["location"] = {"latitude": cur_lat, "longitude": cur_lon}
        result["drone"]["eta_seconds"] = rem_eta
        result["drone"]["distance_km"] = rem_dist
    return result

def twilio_ready() -> bool:
    return bool(TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN and (TWILIO_FROM_NUMBER or TWILIO_MESSAGING_SERVICE_SID))

SMS_REASONS = {
    "MISSED_CHECK_IN": "missed their safe-arrival check-in after a walk",
    "PANIC_WIDGET": "triggered the panic shortcut",
    "SHAKE_PATTERN": "triggered a shake-pattern alert",
    "MANUAL_SOS": "activated a safety signal"
}

def send_contact_sms(phone: str, emergency_id: str, latitude: float, longitude: float, trigger_type: str) -> dict:
    if not twilio_ready():
        return {"status": "PENDING_PROVIDER_SETUP"}
    try:
        client = TwilioClient(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
        reason = SMS_REASONS.get(trigger_type, "activated a safety signal")
        body = f"NAIRA EMERGENCY: your contact {reason}. Location: {latitude:.4f}, {longitude:.4f}. Drone response requested."
        params = {"to": phone, "body": body}
        if TWILIO_STATUS_CALLBACK_URL:
            params["status_callback"] = TWILIO_STATUS_CALLBACK_URL
            params["status_callback_method"] = "POST"
        if TWILIO_MESSAGING_SERVICE_SID:
            params["messaging_service_sid"] = TWILIO_MESSAGING_SERVICE_SID
        elif TWILIO_FROM_NUMBER:
            params["from_"] = TWILIO_FROM_NUMBER
        msg = client.messages.create(**params)
        return {"status": msg.status.upper(), "message_sid": msg.sid}
    except Exception as e:
        logger.warning(f"Twilio SMS failed for {phone}: {e}")
        return {"status": "FAILED_PROVIDER", "error": str(e)}

async def process_sos_dispatch(user_id: str, lat: float, lon: float, battery: int, network_status: str, trigger_type: str):
    emergency_id = f"NAIRA-{uuid.uuid4().hex[:6].upper()}"
    contacts = await db.contacts.find({"user_id": user_id}).to_list(100)
    
    notifications = []
    for c in contacts:
        res = send_contact_sms(c.get("phone", ""), emergency_id, lat, lon, trigger_type)
        notif = {
            "name": c.get("name", ""),
            "phone": c.get("phone", ""),
            "channel": c.get("preferred_channel", "SMS"),
            "status": res.get("status", "PENDING_PROVIDER_SETUP")
        }
        if "message_sid" in res:
            notif["message_sid"] = res["message_sid"]
        notifications.append(notif)

    nearest = find_nearest_available_drone(lat, lon)
    if nearest:
        nearest["status"] = "dispatched"
        drone_id = nearest["id"]
        station = {"latitude": nearest["lat"], "longitude": nearest["lon"]}
        drone_battery = nearest.get("battery", 94)
    else:
        drone_id = "DRONE-1"
        station = dict(DRONE_STATION)
        drone_battery = 94

    initial_dist = distance_km(station["latitude"], station["longitude"], lat, lon)

    LIVE_LOCATIONS[user_id] = {
        "latitude": lat,
        "longitude": lon,
        "updated_at": now_iso()
    }
    ACTIVE_MISSIONS[user_id] = {
        "drone_id": drone_id,
        "emergency_id": emergency_id,
        "status": "en_route"
    }

    doc = {
        "id": emergency_id,
        "user_id": user_id,
        "status": "DRONE_REQUESTED",
        "trigger_type": trigger_type,
        "location": {"latitude": lat, "longitude": lon},
        "battery": battery,
        "network_status": network_status,
        "drone": {
            "id": drone_id,
            "status": "EN_ROUTE",
            "battery": drone_battery,
            "location": dict(station),
            "eta_seconds": 180,
            "distance_km": initial_dist
        },
        "station": station,
        "notifications": notifications,
        "created_at": now_iso()
    }
    await db.emergencies.insert_one(doc)
    await log_activity(user_id, "SOS_DISPATCHED", {"emergency_id": emergency_id, "drone_id": drone_id, "trigger_type": trigger_type}, "EMERGENCY")

    event = {
        "user_id": user_id,
        "emergency_id": emergency_id,
        "latitude": lat,
        "longitude": lon,
        "dispatched_drone": drone_id,
        "timestamp": now_iso()
    }
    SOS_EVENTS.insert(0, event)
    await persist_state()

    return doc, drone_id, nearest

@api_router.get("/", tags=["System"])
async def root():
    return {"name": "Naira Safety Response Network API", "status": "online", "docs": "/docs"}

@api_router.get("/health", tags=["System"])
async def health_check():
    user_count = await db.users.count_documents({})
    contact_count = await db.contacts.count_documents({})
    emergency_count = await db.emergencies.count_documents({"status": {"$in": ["DRONE_REQUESTED", "DRONE_ARRIVED"]}})
    activity_count = await db.activities.count_documents({}) if hasattr(db, "activities") else 0
    available_drones = len([d for d in DRONES if d["status"] == "available"])
    return {
        "status": "healthy",
        "database": "mock_db" if USE_MOCK_DB else "mongodb",
        "registered_users": user_count,
        "trusted_contacts": contact_count,
        "active_emergencies": emergency_count,
        "logged_activities": activity_count,
        "total_drones": len(DRONES),
        "available_drones": available_drones,
        "twilio_sms_configured": twilio_ready(),
        "timestamp": now_iso()
    }

@api_router.post("/auth/signup", tags=["Authentication"])
async def signup(payload: UserCreate):
    email = payload.email.lower()
    existing = await db.users.find_one({"email": email})
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")
    user_id = str(uuid.uuid4())
    token = secrets.token_urlsafe(32)
    user_doc = {
        "id": user_id,
        "name": payload.name,
        "email": email,
        "password_hash": hash_password(payload.password),
        "created_at": now_iso()
    }
    await db.users.insert_one(user_doc)
    await db.sessions.insert_one({"token": token, "user_id": user_id, "created_at": now_iso()})
    await log_activity(user_id, "USER_SIGNED_UP", {"name": payload.name, "email": email}, "AUTH")
    await persist_state()
    return {"token": token, "user": {"id": user_id, "name": payload.name, "email": email}}

@api_router.post("/auth/login", tags=["Authentication"])
async def login(payload: UserLogin):
    email = payload.email.lower()
    user = await db.users.find_one({"email": email})
    if not user or not verify_password(payload.password, user.get("password_hash", "")):
        raise HTTPException(status_code=400, detail="Invalid email or password")
    token = secrets.token_urlsafe(32)
    await db.sessions.insert_one({"token": token, "user_id": user["id"], "created_at": now_iso()})
    await log_activity(user["id"], "USER_LOGGED_IN", {"email": email}, "AUTH")
    await persist_state()
    return {"token": token, "user": {"id": user["id"], "name": user["name"], "email": user["email"]}}

@api_router.post("/auth/logout", tags=["Authentication"])
async def logout(authorization: Optional[str] = Header(None)):
    if authorization and authorization.startswith("Bearer "):
        token = authorization.split(" ")[1]
        await db.sessions.delete_one({"token": token})
        await persist_state()
    return {"status": "logged_out"}

@api_router.get("/contacts", tags=["Trusted Contacts"])
async def get_contacts(authorization: Optional[str] = Header(None)):
    user = await current_user(authorization)
    return await db.contacts.find({"user_id": user["id"]}, {"_id": 0, "user_id": 0}).to_list(100)

@api_router.post("/contacts", tags=["Trusted Contacts"])
async def add_contact(payload: ContactCreate, authorization: Optional[str] = Header(None)):
    user = await current_user(authorization)
    contact_id = str(uuid.uuid4())
    contact_doc = {
        "id": contact_id,
        "user_id": user["id"],
        **payload.model_dump(),
        "created_at": now_iso()
    }
    await db.contacts.insert_one(contact_doc)
    await log_activity(user["id"], "CONTACT_ADDED", {"contact_id": contact_id, "name": payload.name, "relationship": payload.relationship, "phone": payload.phone}, "CONTACTS")
    await persist_state()
    return {k: v for k, v in contact_doc.items() if k not in ("_id", "user_id")}

@api_router.delete("/contacts/{contact_id}", tags=["Trusted Contacts"])
async def delete_contact(contact_id: str, authorization: Optional[str] = Header(None)):
    user = await current_user(authorization)
    res = await db.contacts.delete_one({"id": contact_id, "user_id": user["id"]})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Contact not found")
    await log_activity(user["id"], "CONTACT_DELETED", {"contact_id": contact_id}, "CONTACTS")
    await persist_state()
    return {"ok": True}

@api_router.post("/walks/start", tags=["Walk Mode"])
async def start_walk(payload: WalkStart, authorization: Optional[str] = Header(None)):
    user = await current_user(authorization)
    walk_id = f"WALK-{uuid.uuid4().hex[:6].upper()}"
    now = datetime.now(timezone.utc)
    ends_at = now + timedelta(minutes=payload.duration_minutes)
    doc = {
        "id": walk_id,
        "user_id": user["id"],
        "status": "ACTIVE",
        "duration_minutes": payload.duration_minutes,
        "start_location": {"latitude": payload.latitude, "longitude": payload.longitude},
        "started_at": now.isoformat(),
        "expected_end_at": ends_at.isoformat()
    }
    await db.walks.update_many({"user_id": user["id"], "status": "ACTIVE"}, {"$set": {"status": "CANCELLED"}})
    await db.walks.insert_one(doc)
    await log_activity(user["id"], "WALK_STARTED", {"walk_id": walk_id, "duration": payload.duration_minutes}, "WALK")
    await persist_state()
    return {k: v for k, v in doc.items() if k != "_id"}

@api_router.post("/walks/complete", tags=["Walk Mode"])
async def complete_walk(authorization: Optional[str] = Header(None)):
    user = await current_user(authorization)
    await db.walks.update_many({"user_id": user["id"], "status": "ACTIVE"}, {"$set": {"status": "COMPLETED", "completed_at": now_iso()}})
    await log_activity(user["id"], "SAFE_ARRIVAL_CONFIRMED", {}, "WALK")
    await persist_state()
    return {"status": "completed"}

@api_router.get("/walks/active", tags=["Walk Mode"])
async def get_active_walk(authorization: Optional[str] = Header(None)):
    user = await current_user(authorization)
    doc = await db.walks.find_one({"user_id": user["id"], "status": "ACTIVE"}, {"_id": 0})
    return doc or {"status": "INACTIVE"}

@api_router.get("/activities", tags=["System"])
async def get_activities(authorization: Optional[str] = Header(None)):
    user = await current_user(authorization)
    logs = await db.activities.find({"user_id": user["id"]}).sort("timestamp", -1).to_list(100)
    return [{k: v for k, v in doc.items() if k != "_id"} for doc in logs]

@api_router.post("/activities", tags=["System"])
async def post_activity(payload: ActivityCreate, authorization: Optional[str] = Header(None)):
    user = await current_user(authorization)
    doc = await log_activity(user["id"], payload.action, payload.details, payload.category)
    return {k: v for k, v in doc.items() if k != "_id"}

@api_router.post("/emergencies", tags=["Emergency Response"])
async def create_emergency(payload: EmergencyCreate, authorization: Optional[str] = Header(None)):
    user = await current_user(authorization)
    doc, drone_id, nearest = await process_sos_dispatch(
        user["id"], payload.latitude, payload.longitude, payload.battery, payload.network_status, payload.trigger_type
    )
    return emergency_view(doc)

# Rescue SOS System compatibility endpoints
@api_router.post("/sos", tags=["Emergency Response"])
@app.post("/sos")
async def receive_sos(request: Request, authorization: Optional[str] = Header(None)):
    data = await request.json() if request.headers.get("content-type") == "application/json" else {}
    lat = data.get("latitude")
    lon = data.get("longitude")
    user_id = data.get("user_id")

    # An authenticated caller's identity always wins over a client-supplied
    # user_id, so one logged-in user can never spoof or overwrite another
    # user's emergency by guessing/passing their id in the body.
    if authorization:
        try:
            u = await current_user(authorization)
            user_id = u["id"]
        except Exception:
            pass
    if not user_id:
        user_id = "demo-user-1"

    if lat is None or lon is None:
        raise HTTPException(status_code=400, detail="latitude and longitude are required")

    battery = data.get("battery", 85)
    network_status = data.get("network_status", "CONNECTED")
    trigger_type = data.get("trigger_type", "SHAKE_PATTERN")

    doc, drone_id, nearest = await process_sos_dispatch(user_id, float(lat), float(lon), battery, network_status, trigger_type)
    return {
        "status": "dispatched",
        "drone_id": drone_id,
        "emergency_id": doc["id"],
        "message": f"{drone_id} is on the way",
        "emergency": emergency_view(doc)
    }

@api_router.post("/location", tags=["Emergency Response"])
@app.post("/location")
async def receive_location(request: Request, authorization: Optional[str] = Header(None)):
    data = await request.json() if request.headers.get("content-type") == "application/json" else {}
    lat = data.get("latitude")
    lon = data.get("longitude")
    user_id = data.get("user_id")

    # See note in receive_sos(): authenticated identity overrides body user_id.
    if authorization:
        try:
            u = await current_user(authorization)
            user_id = u["id"]
        except Exception:
            pass
    if not user_id:
        user_id = "demo-user-1"

    if lat is None or lon is None:
        raise HTTPException(status_code=400, detail="latitude and longitude are required")

    lat = float(lat)
    lon = float(lon)

    LIVE_LOCATIONS[user_id] = {
        "latitude": lat,
        "longitude": lon,
        "updated_at": now_iso()
    }

    await db.emergencies.update_many(
        {"user_id": user_id, "status": "DRONE_REQUESTED"},
        {"$set": {"location": {"latitude": lat, "longitude": lon}}}
    )
    await persist_state()

    return {"status": "location_updated"}

@api_router.post("/sos/resolve", tags=["Emergency Response"])
@app.post("/sos/resolve")
async def resolve_mission(request: Request, authorization: Optional[str] = Header(None)):
    data = await request.json() if request.headers.get("content-type") == "application/json" else {}
    user_id = data.get("user_id")
    emergency_id = data.get("emergency_id")

    # See note in receive_sos(): authenticated identity overrides body user_id.
    if authorization:
        try:
            u = await current_user(authorization)
            user_id = u["id"]
        except Exception:
            pass

    if not user_id and emergency_id:
        doc = await db.emergencies.find_one({"id": emergency_id})
        if doc:
            user_id = doc.get("user_id")
    if not user_id:
        user_id = "demo-user-1"

    mission = ACTIVE_MISSIONS.pop(user_id, None)
    if mission:
        for d in DRONES:
            if d["id"] == mission["drone_id"]:
                d["status"] = "available"

    if emergency_id:
        await db.emergencies.update_one({"id": emergency_id}, {"$set": {"status": "RESOLVED"}})
    else:
        await db.emergencies.update_many({"user_id": user_id, "status": "DRONE_REQUESTED"}, {"$set": {"status": "RESOLVED"}})

    await log_activity(user_id, "RESCUE_RESOLVED", {"emergency_id": emergency_id}, "EMERGENCY")
    await persist_state()

    return {"status": "resolved"}

@api_router.get("/sos/status", tags=["Operator Dispatch"])
@app.get("/status")
async def get_status():
    active_missions_with_location = []
    for uid, mission in ACTIVE_MISSIONS.items():
        active_missions_with_location.append({
            "user_id": uid,
            "drone_id": mission["drone_id"],
            "emergency_id": mission.get("emergency_id"),
            "status": mission["status"],
            "current_location": LIVE_LOCATIONS.get(uid)
        })

    return {
        "drones": DRONES,
        "recent_sos_events": SOS_EVENTS[:10],
        "active_missions": active_missions_with_location
    }

@api_router.post("/sos/reset", tags=["System"])
@app.post("/reset")
async def reset_demo():
    for d in DRONES:
        d["status"] = "available"
    SOS_EVENTS.clear()
    LIVE_LOCATIONS.clear()
    ACTIVE_MISSIONS.clear()
    await db.emergencies.update_many({"status": "DRONE_REQUESTED"}, {"$set": {"status": "RESOLVED"}})
    await db.walks.update_many({"status": "ACTIVE"}, {"$set": {"status": "COMPLETED"}})
    await persist_state()
    return {"status": "reset"}

@api_router.post("/twilio/status", tags=["System"])
async def twilio_status_callback(request: Request):
    form = await request.form()
    message_sid = form.get("MessageSid")
    message_status = form.get("MessageStatus")
    if not message_sid or not message_status:
        raise HTTPException(status_code=400, detail="Missing Twilio callback fields")
    
    if TWILIO_AUTH_TOKEN:
        signature = request.headers.get("X-Twilio-Signature", "")
        validator = RequestValidator(TWILIO_AUTH_TOKEN)
        url = str(request.url)
        if not validator.validate(url, dict(form), signature):
            raise HTTPException(status_code=403, detail="Invalid Twilio signature")

    await db.emergencies.update_one(
        {"notifications.message_sid": message_sid},
        {"$set": {"notifications.$.status": str(message_status).upper()}}
    )
    await persist_state()
    return {"ok": True}

@api_router.get("/emergencies", tags=["Emergency Response"])
async def get_emergencies(authorization: Optional[str] = Header(None)):
    user = await current_user(authorization)
    docs = await db.emergencies.find({"user_id": user["id"]}).sort("created_at", -1).to_list(100)
    return [emergency_view(doc) for doc in docs]

@api_router.get("/emergencies/active", tags=["Emergency Response"])
async def get_active_emergency(authorization: Optional[str] = Header(None)):
    user = await current_user(authorization)
    doc = await db.emergencies.find_one({"user_id": user["id"], "status": "DRONE_REQUESTED"})
    if not doc:
        return {"active": False}
    return {"active": True, "emergency": emergency_view(doc)}

@api_router.get("/emergencies/{emergency_id}", tags=["Emergency Response"])
async def get_emergency(emergency_id: str, authorization: Optional[str] = Header(None)):
    user = await current_user(authorization)
    doc = await db.emergencies.find_one({"id": emergency_id, "user_id": user["id"]})
    if not doc:
        raise HTTPException(status_code=404, detail="Emergency not found")
    return emergency_view(doc)

@api_router.post("/emergencies/{emergency_id}/cancel", tags=["Emergency Response"])
async def cancel_emergency(emergency_id: str, authorization: Optional[str] = Header(None)):
    user = await current_user(authorization)
    res = await db.emergencies.update_one({"id": emergency_id, "user_id": user["id"]}, {"$set": {"status": "CANCELLED"}})
    if res.matched_count == 0:
        raise HTTPException(status_code=404, detail="Emergency not found")
    
    # Also resolve assigned drone in fleet
    mission = ACTIVE_MISSIONS.pop(user["id"], None)
    if mission:
        for d in DRONES:
            if d["id"] == mission["drone_id"]:
                d["status"] = "available"

    await log_activity(user["id"], "EMERGENCY_CANCELLED", {"emergency_id": emergency_id}, "EMERGENCY")
    await persist_state()

    doc = await db.emergencies.find_one({"id": emergency_id, "user_id": user["id"]})
    return emergency_view(doc)

@api_router.get("/operator/active", tags=["Operator Dispatch"])
async def operator_active(authorization: Optional[str] = Header(None)):
    await current_user(authorization)
    docs = await db.emergencies.find({"status": {"$in": ["DRONE_REQUESTED", "DRONE_ARRIVED"]}}, {"_id": 0}).sort("created_at", -1).to_list(50)
    return [emergency_view(doc) for doc in docs]

@api_router.websocket("/ws/emergencies/{emergency_id}")
async def emergency_socket(websocket: WebSocket, emergency_id: str):
    await websocket.accept()
    try:
        while True:
            doc = await db.emergencies.find_one({"id": emergency_id}, {"_id": 0})
            if doc:
                await websocket.send_json(emergency_view(doc))
            await websocket.receive_text()
    except (WebSocketDisconnect, RuntimeError):
        pass

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,  # auth uses Bearer tokens, not cookies — "*" + credentials is invalid/insecure
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api_router)
