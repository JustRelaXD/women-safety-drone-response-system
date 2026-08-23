# Women Safety Drone System

## Project Purpose

This project is a real-time drone dispatch and monitoring visualization system built to enhance women's safety, currently scoped to **Patiala (Punjab)** as the demonstration city. It features an interactive map displaying optimized drone patrol routes, high-risk danger zones (heatmaps), and live tracking of autonomous drones.

The system provides a command center interface to:
- Monitor drones as they continuously patrol predefined safe corridors and high-risk zones.
- Respond to SOS alerts by automatically dispatching the nearest available drone to the incident location.
- Provide a "Safe Walk" feature, where a drone escorts a user from their origin to their destination.
- Visualize real-time tracking, response metrics, and operational timelines.

## Tech Stack

- **Frontend:** React, Vite
- **Mapping:** MapLibre GL
- **Geospatial Analysis:** Turf.js (for route calculations, segment lengths, and distance checks)
- **Animations:** GSAP (for smooth, constant-speed drone movement along paths)
- **Styling:** Framer Motion, Lucide-React (icons)
- **Backend:** Express / Node.js (for serving API/static assets)

## Main Features

### 1. Continuous Patrol Loops
Drones continuously travel along predefined `LineString` patrol paths. The movement is calculated segment-by-segment using Turf.js and GSAP to ensure drones strictly adhere to their designated routes at a constant speed, without cutting corners.

### 2. SOS Emergency Dispatch
When an SOS alert is triggered, the system identifies the nearest available drone and dispatches it immediately. 
- The drone leaves its patrol route and takes a direct path to the SOS target.
- Upon arrival, it initiates an orbit pattern around the incident zone.
- Simulated telemetry (Audio Recording, Video Broadcast) is displayed to the command center.

### 3. Safe Walk Escort
Users can request a "Safe Walk" drone escort.
- The user selects an origin and destination.
- The nearest drone is dispatched to the user's origin.
- The drone then escorts the user to their destination along a generated safe route.
- Progress and ETA are updated dynamically on the map and the sidebar.

### 4. Danger Zones & Heatmaps
High-risk areas are identified and displayed on the map using a customized heatmap layer. Danger zone markers sit directly on the patrol paths, ensuring drones pass through these high-priority areas regularly during their normal patrols.

### 5. Dynamic Zoom Visibility
Map layers dynamically adjust based on zoom levels to reduce clutter:
- **Zoom ≥ 11.6:** Full detail (patrol routes, hotspots, drone stations, drones).
- **Zoom 10.8 to 11.6:** Only drones and the heatmap are visible, allowing operators to track fleet positions easily from a higher level.
- **Zoom < 10.8:** Drones fade out to show only the macro-level heatmap.

## Route Planner Integration

This frontend is the operator surface for the drone route planner backend
(the `overture-test` repo - a FastAPI + DuckDB Spatial service running on the
VPS). The backend computes building-avoiding GPS waypoints over Overture
building data + DGCA no-fly zones; **this app never does pathfinding itself**.

### What is routed by the planner

- **Patrol loops** - each patrol drone has a corridor with a station and 3-4
danger zones (see `src/patiala.ts`). On startup the app orders the zones
nearest-neighbour from the station and plans every leg with the backend, then
**caches the result in `localStorage`** (`patiala-patrol-routes-v1`) so the
loops are computed once and reused until the layout changes or the operator
hits **Regenerate Patrol Routes** on the Dashboard. Add a new danger zone in
the Command Studio and save - the cache invalidates automatically.
- **SOS dispatch** - the nearest drone's flight to the caller is planned
(building-avoiding), drawn live via the NDJSON stream endpoint, and the
airspace-crossing warning (`zones_crossed`) is surfaced to the operator.
- **Safe Walk** - pickup, escort and return legs are all planner-routed.
- **No-fly overlay** - the DGCA red/amber airspace snapshot is fetched from
`GET /no-fly-zones` and rendered on the map (toggle in the top bar). Red =
prohibited (never crossed), amber = passable with permission (reported).

Straight lines are still used whenever they are safe - the backend's fast path
returns exactly the direct line when nothing blocks it, so open-terrain
dispatches stay instant. If the planner is unreachable, the app gracefully
falls back to straight lines so the demo never breaks.

### Configuration

| Env var | Purpose |
|---|---|
| `VITE_PLANNER_API_URL` | Public URL of the planner backend (the outbound-tunnel URL, e.g. `https://<hash>.proxy.netbird.io`). Empty = straight-line fallback mode. Set in the Vercel project env and rebuild. |
| `VITE_PLANNER_API_KEY` | Optional shared secret sent as `X-API-Key` (only if the backend sets `PLANNER_API_KEY`). |

See `overture-test/INTEGRATION.md` for the full backend deployment recipe
(VPS data setup, systemd units, `netbird expose 8000`, CORS, API key).

## Running the Project

### Installation
Make sure you have Node.js installed, then run:
```bash
npm install
```

### Development Server
You can start the development server using Vite:
```bash
npm run dev
```
Alternatively, you can run the provided `run_dev.sh` script.

The application will be accessible at:
`http://localhost:5173`

### Production Build
To build the project for production:
```bash
npm run build
```
To serve the production build:
```bash
npm run server
```
