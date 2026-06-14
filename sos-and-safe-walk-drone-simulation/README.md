# Women Safety Drone System

A real-time drone-assisted women safety platform built for Mangalore, India. The system combines an interactive map, autonomous drone simulation, emergency SOS response, and a Safe Walk escort feature into a unified command center interface.

---

## Project Overview

The Women Safety Drone System is a web application that simulates how a city-level drone fleet can be used to improve safety for women in public spaces. Operators (or users) can monitor drone patrol activity, trigger emergency responses, and request aerial escorts — all visualized live on a MapLibre map centered on Mangalore.

The project has three core modes:

- **Dashboard** — Live drone patrol and hotspot monitoring
- **SOS Mode** — Emergency alert detection and automated drone dispatch
- **Safe Walk** — On-demand drone escort from origin to destination

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 19, TypeScript, Vite |
| Map | MapLibre GL JS |
| Spatial computation | Turf.js |
| Animation | GSAP, Framer Motion |
| Backend | Node.js, Express |
| Database | PostgreSQL, PostGIS, pgRouting |
| Icons | Lucide React |
| Deployment | Vercel |

---

## Features

### 1. Dashboard — Drone Patrol Simulation

The dashboard is the default view and shows the full drone fleet operating over Mangalore in real time.

- **5 drone stations** are spread across the city: Ladyhill, Pumpwell, Panambur, Bejai Campus, and a southern post.
- Each drone continuously patrols a named safety corridor (e.g. *Pumpwell–Kankanady corridor*, *Panambur coastal sweep*).
- Drone patrol routes are dynamically optimized using a **cheapest insertion algorithm** — known crime hotspots are automatically injected into the nearest drone's route to ensure coverage.
- The map displays patrol paths, drone station markers, and a **risk heatmap** built from hotspot severity scores and active alert positions.
- A live **activity timeline** logs system events such as patrol refreshes, drone dispatches, and arrivals.
- Drone battery levels drain during patrol and recharge when docked, simulating real fleet management constraints.
- A **status panel** shows active drone count, critical alert count, and per-drone telemetry (battery, status, response time).

### 2. SOS Mode — Emergency Response

SOS Mode handles emergency alerts triggered by users in distress. Alerts can come from phone shake detection or manual emergency calls.

**How it works:**

1. An SOS alert is received (seeded demo alerts include events like *Phone shake SOS near Kankanady* and *Emergency call near Lalbagh*).
2. The system displays a **🚨 SOS Received** banner and logs the alert.
3. After 2 seconds, **🔔 Alerted Authorities** — police and emergency services are notified in the timeline.
4. After 4 seconds, **🚁 Dispatching Drone** — the nearest available drone is identified using proximity scoring and dispatched.
5. The drone animates across the map along a curved dispatch route toward the caller's pinned location.
6. On arrival, the drone **orbits the target** in a 50-meter holding circle, simulating an aerial watch-over.
7. The alert panel updates the incident status at each phase: *Awaiting drone → Drone dispatching → Drone dispatched*.

The SOS panel also lists all active incidents with priority labels (Critical / High / Watch), timestamps, and drone assignments. Clicking an incident focuses the map on that alert's location.

### 3. Safe Walk — Drone Escort

Safe Walk lets a user request a drone escort from their current location to a destination. The drone accompanies them overhead for the entire journey.

**How it works:**

1. The operator enters the **Safe Walk** view, which shows all users currently waiting for an escort on the map.
2. Selecting a user draws their planned route on the map (origin → destination).
3. Pressing **Start Escort** triggers a three-phase sequence animated with GSAP:
   - **Phase 1 — Pickup:** The nearest drone leaves its station and flies to the user's origin.
   - **Phase 2 — Escort:** The drone follows alongside the user as they walk to their destination, offset slightly from their path to simulate aerial coverage.
   - **Phase 3 — Arrival & Return:** Once the user arrives safely, the drone returns to its home station and resumes patrol.
4. The map tracks both the user's position and the drone's position live throughout.
5. A **progress bar** and status label update in real time (en route → pickup → escorting → arrived → returning).
6. The activity timeline logs each handoff phase.

Seeded demo users include scenarios like *Priya walking home from Bejai market* and *Ananya at Panambur beach area*.

---

## Map Layers

The interactive map renders several overlapping data layers:

- **Patrol routes** — polylines showing each drone's assigned corridor
- **Drone station markers** — fixed base locations with halo indicators
- **Risk heatmap** — intensity overlay combining hotspot severity and active alert positions
- **Hotspot markers** — clustered points for known danger zones (unlit walkways, harassment reports, isolated corridors, campus return paths)
- **SOS target markers** — pulsing indicators for active emergency locations
- **Safe Walk route** — the planned walking path with origin/destination pins
- **Safe user marker** — live position of the user being escorted
- **Active route line** — the drone's current dispatch or escort path drawn progressively

Layers are zoom-sensitive — detailed markers and route points become visible only at closer zoom levels to keep the overview clean.

---

## Project Structure

```
women-safety-main/
├── src/
│   └── main.tsx          # Entire React frontend — map, state, all three modes
│   └── styles.css        # UI styling and animations
├── server.js             # Express backend with PostGIS/pgRouting API
├── 01_schema.sql         # PostgreSQL schema (locations, routing tables, triggers)
├── demo.sql              # Sample data for testing
├── public/
│   └── index.html
├── dist/                 # Built frontend (served by Express)
├── vercel.json           # Vercel deployment config
├── vite.config.ts
├── tsconfig.json
└── package.json
```

---

## Backend & Database

The backend is an Express server (`server.js`) that serves the built frontend and exposes a REST API backed by PostgreSQL with PostGIS and pgRouting.

The database uses a `mangalore` schema with tables for locations, routing network nodes, route plans, and route segments. Key capabilities include:

- Snapping map locations to the nearest road network vertex
- Running `pgr_dijkstra` for shortest-path routing between points
- Generating area-clustered pickup route plans using cost matrices
- Returning all spatial data as GeoJSON for the frontend

The frontend itself is largely self-contained — the drone simulation, SOS flow, and Safe Walk escort are all client-side, using Turf.js for spatial math and GSAP for animation. The backend is used for persistent location and route data when a live database is connected.

---

## Running the Project

**Install dependencies:**
```bash
npm install
```

**Development (frontend only):**
```bash
npm run dev
```

**Build and run with backend:**
```bash
npm run build
npm start
```

The app runs at `http://localhost:3000`.

**Environment variables** (copy `.env.example` to `.env`):
```
DATABASE_URL=postgresql://user:password@host:5432/dbname
PORT=3000
```

The app works without a database — drone simulation, SOS demo, and Safe Walk all run fully in the browser. A database connection is only needed to persist location data and use the routing API.

---

## Demo Flow

To see all three features in action:

1. Open the app — the **Dashboard** loads with drones already patrolling their corridors.
2. Click **SOS** in the nav bar, then press **Run SOS Demo** — watch the full emergency dispatch sequence unfold on the map.
3. Click **Safe Walk** in the nav bar — select a user from the list, then press **Start Escort** to see the drone fly to them, escort them to their destination, and return to base.

