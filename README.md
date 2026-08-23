# Women Safety Drone Response System

A women safety platform built as one end-to-end emergency response system: detect threats, raise an SOS, dispatch the nearest drone, and get support — all in real time. It combines computer vision, drone routing, mobile apps, and an AI chatbot into a single repo of independently deployed projects.

## System Overview

The pieces fit together as one emergency-response flow:

1. **Detection & alerting** — `women-safety-cv` watches camera + audio feeds for falls, chases, violence, running, and distress sounds/keywords, and raises a fused alert level.
2. **User-initiated SOS** — `naira-app` (mobile/web) and `rescue-sos-system` (Android app + Flask backend) let a user raise an SOS with live location sharing; trusted contacts get notified via Twilio SMS.
3. **Dispatch & routing** — `drone-route-optimization` computes building-avoiding GPS waypoints (A* / Theta* over Overture Maps + DuckDB), and `sos-dashboard` is the command center where operators watch drones patrol, respond to SOS alerts, and run Safe Walk escorts.
4. **Support & follow-up** — `chatbot` provides a private, AI-supported conversation with Indian legal info (POSH Act) and structured case state.

## Deployed Apps

| App | Description | Link |
| --- | --- | --- |
| SOS Dashboard | Command center: drone patrols, SOS dispatch, Safe Walk escorts (Patiala demo) | https://sos-dashboard-women-safety.vercel.app/ |
| Safe Skies Website | Public site | https://safeskieswebsitev1.vercel.app/ |
| Rescue SOS System | Android SOS app + Flask dispatch backend | https://rescue-sos-system.vercel.app/ |
| Chatbot | "Here to Listen" workplace safety chatbot | https://chatbot-women-safety.vercel.app/ |
| Naira App | Safety response network (Expo app + FastAPI) | https://naira-app-women-safety.vercel.app/ |

## Repository Layout

```text
women-safety-drone-response-system/
├── chatbot/                    # AI workplace-safety support chatbot (React + Node/Express)
├── naira-app/                  # Safety response network (Expo React Native + FastAPI)
├── sos-dashboard/              # Drone dispatch & monitoring command center (React + MapLibre)
├── women-safety-cv/            # Real-time threat detection (YOLO + MediaPipe + audio)
├── drone-route-optimization/   # Drone route planner (A*/Theta*, DuckDB Spatial, FastAPI)
├── sitl-bridge/                # ArduPilot SITL bridge (FastAPI + pymavlink)
├── rescue-sos-system/          # Rescue SOS system (Android app + Flask backend)
└── screenshots-and-videos/     # Demo media for the platform
```

## Projects

### `chatbot` — Here to Listen

A private, AI-supported conversational tool for people in India dealing with workplace harassment, abuse, intimidation, coercion, or discrimination. It listens, helps organize what happened, flags safety concerns, and shares general Indian legal information (POSH Act, 2013) with citations — while being explicit that it is not a lawyer, counsellor, police officer, or emergency service.

- **Frontend:** React + Vite chat UI with typing indicator, safety banner, and privacy controls (delete/export conversation).
- **Backend:** Node/Express orchestrator coordinating five agents: Response Composer (LISTEN → UNDERSTAND → SAFETY → CLARIFY → SUPPORT → LAW → OPTIONS → PLAN), Situation Understanding, Safety (fails toward caution), Indian Legal Information (with mandatory citations), and Action Planning.
- **Security:** helmet, CORS allow-list, rate limiting, input validation, prompt-injection guard.
- **Tests:** 11 unit tests + 12 integration tests (integration needs a live API key).

### naira-app — Safety Response Network

Real-time emergency safety response platform: a FastAPI backend (mock MongoDB + Twilio SMS + drone dispatch simulation) and an Expo React Native frontend with a web build.

- **API:** Vercel serverless entrypoint with Swagger docs at `/docs`; emergency lifecycle endpoints and a WebSocket (`/ws/emergencies/{id}`, REST polling on Vercel).
- **SMS alerts:** Twilio integration to notify trusted contacts; falls back to `PENDING_PROVIDER_SETUP` without credentials.
- **Database:** in-memory mock DB seeded from `backend/data/naira_db.json`; set `USE_MOCK_DB=false` + `MONGO_URL` for real MongoDB.

### sos-dashboard — Drone Command Center

Real-time drone dispatch and monitoring visualization, scoped to **Patiala (Punjab)**. Interactive MapLibre GL map with patrol routes, danger-zone heatmaps, live drone tracking, and:

- **Continuous Patrol Loops** — drones travel predefined corridors at constant speed (segment-by-segment Turf.js + GSAP).
- **SOS Emergency Dispatch** — nearest drone re-routed to the caller, orbits on arrival, with simulated audio/video telemetry.
- **Safe Walk Escort** — drone picks up the user and escorts them along a generated safe route with live progress and ETA.
- **Danger Zone Heatmaps** — high-risk areas as dynamic zoom-adjusted layers.
- **Planner integration** — patrol loops, SOS legs, and Safe Walk legs are routed by `drone-route-optimization` (building-avoiding), cached in `localStorage`, with graceful straight-line fallback. No-fly zone overlay from the planner's DGCA data.

### women-safety-cv — Real-Time Threat Detection

Multi-modal computer vision + audio pipeline detecting threats from a webcam/audio feed, fused into a single alert level:

| Signal | Module | Approach |
| --- | --- | --- |
| Fall | `fall_detection.py` | MediaPipe pose landmarks, per person |
| Running | `running_detection.py` | YOLO bounding-box dynamics |
| Chase | `chase_detection.py` | Pairwise proximity + motion vectors |
| Violence | `violence_detection.py` | Close pair + fast repeated wrist motion |
| Audio distress | `audio_service.py` | YAMNet sound events |
| Keyword distress | `distress_keywords.py` | faster-whisper transcription |

The fusion engine (`fusion_engine.py`) weights each signal with cross-modal corroboration and debounces asymmetrically (escalate fast, de-escalate slowly). Outputs: MJPEG annotated stream (port 8000), WebSocket alert pushes (port 8765), and saved critical clips. Requires two separate Python envs (`venv_vision`, `venv_audio`) because mediapipe and tensorflow pin conflicting `protobuf` versions.

### drone-route-optimization — Route Planner

Route planner (A* / Theta* / visibility graph) over Overture Maps building and water data, backed by DuckDB Spatial. Outputs GPS waypoints only — no drone protocol — so any controller can use the REST API. Designed to run on a 1 GB Azure VM.

- Direct-line fast path when unobstructed; bounded candidate region generation; row-group pruning and R-tree index verification against an 18.2 M-building Punjab dataset.
- Benchmark-justified algorithm choice (see its README §7).
- `frontend/` is a test UI: mission planner, dashboard, live telemetry, mission history, no-fly zone layers.
- Heavy geospatial data is downloaded at runtime and never committed (see `scripts/download_buildings.py`, `dl_punjab.py`).

### sitl-bridge — ArduPilot SITL Bridge

Bridges a simulated drone (ArduPilot SITL) to the command center: connects over MAVLink (UDP), streams live telemetry (position, altitude, heading), and exposes patrol/loiter control over a WebSocket for the dashboard.

- **FastAPI + pymavlink** — `udp:127.0.0.1:14550` SITL endpoint, patrol altitude and loiter radius config at the top of `bridge.py`.
- WebSocket endpoint for live state + control from `sos-dashboard`.

### rescue-sos-system — SOS System + Android App

A small, hackathon-style end-to-end SOS system:

- **Flask backend** (`backend/sos_server.py`) — receives SOS from the phone (`POST /sos`), tracks live location (`POST /location`) so a drone can follow a moving person, marks the nearest drone dispatched, and answers `GET /status` for the dashboard.
- **Android app** (Kotlin, `android-app/`) — shake-triggered SOS with a foreground service.
- **Vercel serverless entry** (`api/index.py`) wraps the Flask app and serves `index.html`.
- `docs/STEP_BY_STEP.md` walks through a laptop test in exact order — backend, then phone app, then dashboard.

## Local Development

Each subproject is self-contained; enter it, follow its README. The quick starts:

```bash
# Chatbot (backend on :3001 by default, frontend with Vite)
cd chatbot && npm install

# Naira backend + frontend
cd naira-app/backend && pip install -r requirements.txt && uvicorn server:app --reload --port 8001
cd naira-app/frontend && npm install

# SOS Dashboard (Patiala command center)
cd sos-dashboard && npm install && npm run dev   # http://localhost:5173

# Threat detection (two envs required)
cd women-safety-cv
python -m venv venv_vision && venv_vision/bin/pip install -r requirements-vision.txt
python -m venv venv_audio  && venv_audio/bin/pip install -r requirements-audio.txt
venv_audio/bin/python audio_service.py      # terminal 1
venv_vision/bin/python unified_detection.py  # terminal 2

# Route planner (uv + DuckDB; see SETUP.md)
cd drone-route-optimization && uv sync

# SITL bridge (needs ArduPilot SITL running on udp:127.0.0.1:14550)
cd sitl-bridge && pip install fastapi pymavlink uvicorn && python bridge.py

# SOS system laptop demo: backend first, then Android app (Android Studio), then dashboard
cd rescue-sos-system/backend && pip install flask && python sos_server.py
```

## Conventions & Notes

- Each subproject has its own git history-independent lifecycle; this monorepo holds the current working tree of each.
- Generated folders (`node_modules/`, `dist/`, `__pycache__/`, venvs) and large datasets (building footprints, `.parquet`) are never committed here.
- Secrets live in per-project env files / Vercel project settings — never commit real `.env` values.
- `screenshots-and-videos/` holds demo imagery and video.

## Deployments

Each app deploys to Vercel independently (settings mirror in `vercel.json` within each subproject). See per-project READMEs for env var requirements (`VITE_PLANNER_API_URL`, `EXPO_PUBLIC_BACKEND_URL`, `TWILIO_*`, `USE_MOCK_DB`, etc).