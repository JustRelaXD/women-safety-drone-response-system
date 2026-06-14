# Stealth SOS – Guardian Drone Response System

A silent emergency-response system where a discreet trigger (phone shake or S key)
dispatches a guardian drone to the user's location with zero visible indication.

---

## Project Structure

```
stealth-sos/
├── backend/
│   ├── main.py              # FastAPI + Socket.IO entrypoint
│   ├── drone_controller.py  # Drone fleet management & simulation
│   └── requirements.txt
└── frontend/
    ├── index.html
    ├── vite.config.js
    ├── tailwind.config.js
    ├── postcss.config.js
    ├── package.json
    └── src/
        ├── main.jsx
        ├── App.jsx                        # Root: all sections + state
        ├── index.css                      # Tailwind + dark Leaflet overrides
        ├── hooks/
        │   └── useSocket.js               # Socket.IO connection hook
        └── components/
            ├── SOSDetector.jsx            # Shake/keypress detection (invisible)
            ├── MapView.jsx                # Leaflet dark map
            ├── DroneMarker.jsx            # Animated drone SVG marker
            └── ConfirmationPanel.jsx      # Emergency controls (post-arrival)
```

---

## Setup

### 1. Backend

```bash
cd backend
python -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate
pip install -r requirements.txt
python main.py
# → API running on http://localhost:8000
```

### 2. Frontend

```bash
cd frontend
npm install
npm run dev
# → App running on http://localhost:5173
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

---

## Usage

| Action | Result |
|--------|--------|
| Press **S** on keyboard | Triggers silent SOS (desktop demo) |
| **Shake** phone | Triggers silent SOS (mobile) |
| Click "Trigger Demo SOS" | Same as pressing S |

After 3 seconds (silent delay):
1. Drone marker appears and moves toward you
2. "Guardian arriving. Stay calm." message shows
3. On arrival: pulsing ring + emergency control panel unlocks

---

## Socket.IO Events

| Event | Direction | Payload |
|-------|-----------|---------|
| `drone_position` | Server → Client | `{ drone_id, lat, lng, progress }` |
| `drone_arrived`  | Server → Client | `{ drone_id, lat, lng, message }` |

---

## REST Endpoints

| Method | Path | Body | Response |
|--------|------|------|----------|
| POST | `/stealth-sos` | `{ latitude, longitude }` | `{ status, drone_id, drone_name, estimated_arrival_seconds, start_lat, start_lng }` |
| GET  | `/health` | — | `{ status, service }` |

---

## Environment Variables (Frontend)

Create `frontend/.env` to override the backend URL:

```
VITE_SOCKET_URL=http://localhost:8000
```

---

## Production Build

```bash
cd frontend && npm run build
# Output: frontend/dist/
# Serve with nginx, Vercel, or any static host.
# Point VITE_SOCKET_URL to your deployed backend.
```
