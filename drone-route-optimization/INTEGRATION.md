# Drone Route Planner - Integration Handoff

This document is the complete context for integrating the **route-planning
backend** with an external drone website frontend. The `frontend/` folder
in this repo was a **test/demo UI only** - it is NOT the target frontend.

The planner runs as a standalone FastAPI service (on a VPS) and is consumed
over HTTP. It outputs GPS waypoints only. No drone protocol, no PX4/ROS/
MAVSDK - any controller or web app can call the REST API.

> The `README.md` in this repo is the deep technical reference (research
> findings, benchmark tables, design decisions). This document is the
> **integration cheat sheet**.

---

## 1. What this project is

- **Goal:** autonomous emergency-response drone route planning over
  real map data.
- **Data:** Overture Maps buildings GeoParquet (Punjab:
  `punjab_buildings.parquet`, 18.2 M buildings, ~2.45 GB) + optional water +
  DGCA no-fly zones (red/amber overlay, India-wide).
- **Engine:** DuckDB Spatial (bbox pushdown + `ST_Intersects` refinement +
  R-tree region materialization) -> exact-polygon rasterization -> grid
  A* / Theta* / visibility -> LOS + geometry-exact smoothing -> GPS
  waypoints.
- **Fast path:** if the straight start->goal line hits no real obstacle,
  the response is exactly 2 waypoints (start, goal) and everything else is
  skipped.
- **Hardware target:** 1 GB RAM VPS. Measured peak RSS: ~220-350 MB.
- **Language/stack:** Python 3.12, `uv`, FastAPI, DuckDB Spatial, Shapely.

---

## 2. The API contract

Base URL (local dev): `http://localhost:8000`
OpenAPI schema: `GET http://localhost:8000/openapi.json` (auto-generated,
single source of truth for client types).

### Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /health` | liveness + config echo |
| `GET /no-fly-zones?scope=punjab\|india` | red/amber overlay rings for the map |
| `POST /generate-route` | compute a route (blocking JSON) |
| `POST /generate-route/stream` | same route as NDJSON stream (live progress) |
| `POST /replan` | recompute from a new current position (same body) |
| `POST /mission` | register a mission + plan it |

### `POST /generate-route` request body

```json
{
  "start_lat": 30.7365, "start_lon": 75.5859,
  "goal_lat": 30.7635,  "goal_lon": 75.6141,
  "altitude_m": 80,
  "grid_resolution_m": 10,
  "safety_margin_m": 0,
  "speed_mps": 20,
  "snap_start_goal": true,
  "algorithm": "astar"
}
```

Only `start_lat/lon` and `goal_lat/lon` are required. Everything else is
optional and falls back to server config. `algorithm`: `"astar"` (default)
| `"theta_star"` | `"visibility"`. `safety_margin_m` is the clearance knob
(0-200, 0 = tightest corridor).`snap_start_goal` shifts a start/goal that lands on a building to the nearest free cell (recommended for GPS). `safety_margin_m` defaults to 0 m - the corridor hugs building footprints; raise it (0-200) for clearance.

### Response

```json
{
  "mission_id": "mission-92f1d33a9ce5",
  "distance": 4270.96,
  "estimated_time": 213.55,
  "waypoints": [
    {"lat": 30.7365, "lon": 75.5859, "alt": 80.0}
  ],
  "warning": null,
  "backup_waypoints": [
    {"lat": 30.7365, "lon": 75.5859, "alt": 80.0}
  ],
  "zones_crossed": [
    {"kind": "amber", "name": "Adampur approach", "ring": [[30.5, 75.3], "..."]}
  ]
}
```

- `waypoints`: the route the drone should fly (`[{lat, lon, alt}]`).
- `warning`: `null` on a normal route. On a degraded route (no
  collision-free corridor exists), a human-readable explanation - the
  planner never errors for "no path", it returns a best-effort route +
  warning.
- `backup_waypoints`: the direct start->goal line, always included as an
  operator-verifiable backup.
- `zones_crossed`: every amber airspace zone the route passes through.
  **Amber = passable with permission** (operator must request it and notify
  the airport authority). **Red zones are hard obstacles** - a normal route
  never crosses one.
- Status codes: `200` success, `422` validation / infeasible algorithm,
  `409` legacy no-route (most paths now degrade instead), `500` data errors.

### Streaming (`POST /generate-route/stream`)

NDJSON (one JSON object per line, HTTP response is always `200`):

- `{"type":"stage","stage":"region"|"grid"|"search"|"path"|"smooth"|"geometry",...}`
  - `search` frames carry growing `waypoints` + `epoch` - draw them live as
    the route is constructed (the line only grows toward the goal;
    `epoch` increments per search attempt, reset the live line on change).
  - `path` / `smooth` / `geometry` frames carry the current best route.
- `{"type":"complete","data":{...}}` - the final `RouteResponse`.
- `{"type":"error","status":...,"detail":...}` - error in-band.

Use streaming for a good UX; it shows the route taking shape instead of a
blank map for 3-30 s. The blocking endpoint is identical otherwise.

---

## 3. Typed client generation (do NOT hand-write interfaces)

The backend auto-generates an OpenAPI spec. Generate TS types from it
(exactly like the demo frontend already does):

```bash
# backend: dump the live schema to a file
uv run python frontend/scripts/export-openapi.py   # -> frontend/openapi.json

# frontend: generate types + typed client
npm i -D openapi-typescript
npm i openapi-fetch
npx openapi-typescript openapi.json -o src/types/api.generated.ts
```

Then in the app: `import createClient from "openapi-fetch"` and
`import type { paths } from "./types/api.generated"`. Requests and responses
are typed from the schema; when the backend models evolve, just re-run the
two commands - no manual interface drift.

---

## 4. Running the backend

```bash
uv sync
uv run uvicorn planner.api.main:app --host 0.0.0.0 --port 8000 --workers 1
```

Env vars (all optional, `PLANNER_*` prefix):

| Env | Default | Why |
|---|---|---|
| `PLANNER_BUILDINGS_PARQUET` | `punjab_buildings.parquet` | the Overture GeoParquet |
| `PLANNER_NO_FLY_ZONES_FILE` | none | DGCA snapshot - use `planner/data/no_fly_zones_india.json` (the file the VPS actually carries; a configured-but-missing file now falls back to the india snapshot automatically) |
| `PLANNER_MEMORY_LIMIT` | `512MB` | DuckDB memory cap (spills to disk) |
| `PLANNER_THREADS` | `1` | DuckDB parallelism |
| `PLANNER_ALGORITHM` | `astar` | default algorithm |
| `PLANNER_AIRPORT_RED_RADIUS_KM` | `1.0` | airport no-drone circle radius |

Recommended start for the VPS:

```bash
PLANNER_NO_FLY_ZONES_FILE=planner/data/no_fly_zones_india.json \
uv run uvicorn planner.api.main:app --host 0.0.0.0 --port 8000 --workers 1
```

`uv run pytest` = 144 tests, all green.

---

## 5. What's on GitHub vs what must be set up on the VPS

The repo is on GitHub (`git@github.com:JustRelaXD/drone-route-optimization.git`)
with **code only** - all heavy data is gitignored and must be (re)created on
the VPS:

| Item | On GitHub? | VPS setup |
|---|---|---|
| All code (`planner/`, `benchmarks/`, `scripts/`, demo `frontend/`, tests) | yes | `git clone` + `uv sync` |
| `punjab_buildings.parquet` (2.45 GB) | no (gitignored) | download ONCE on the VPS with the `overturemaps` CLI (STAC-filtered, ~100-300 MB RAM, ~5-15 min) - exact commands in `SETUP.md` step 2 |

> **Full VPS playbook: `SETUP.md`** (in this repo). Agent-runnable:
> clone -> `uv sync` -> download buildings (direct on the VPS, no local
> transfer needed) -> no-fly snapshot -> systemd uvicorn -> `netbird
> expose 8000` -> Vercel env vars -> E2E checks, plus the 1 GB RAM/disk
> budget and troubleshooting.
| No-fly snapshot (`planner/data/no_fly_zones.json`) | no (gitignored) | `uv run python scripts/import_no_fly_zones.py --bbox none` (one-time; fetches once from the public DGCA airspace backend, caches locally) |
| No-fly raw facilities cache | no | created by the import |
| `planner/data/spill/`, region `.duckdb` | no | created at runtime |

Extending beyond Punjab (e.g. Punjab + Haryana + Delhi): download the extra
state GeoParquets from Overture and either point `PLANNER_BUILDINGS_PARQUET`
at a merged file or query each file (the architecture is per-file; a simple
merge step can combine them).

---

## 6. The integration plan (for the new session)

**Deployment topology (confirmed):**

```
Vercel (drone website frontend, browser)
        │  HTTPS
        ▼
public HTTPS URL  (e.g. https://<hash>.proxy.netbird.io)
        │
        ▼  outbound tunnel (Netbird exposes the port publicly)
VPS (this repo - the route planner, FastAPI :8000)
        │
        ▼
DuckDB Spatial + punjab_buildings.parquet + no-fly snapshot
```

**Key fact: Vercel never dials INTO your VPS.** The VPS has no public IP
(only reachable over the Netbird mesh), but it has outbound internet. So
connectivity is solved with an **outbound tunnel**: a process on the VPS
connects out to a public relay, which publishes a public HTTPS URL that
Vercel (or any browser) can call. Three ways, in order of fit for this
project:

1. **`netbird expose` (recommended - zero new infra, you already use
   Netbird).** On the VPS, `netbird expose 8000` publishes the planner on
a public `https://*.proxy.netbird.io` URL with automatic TLS, no inbound
ports, free on your plan. The CLI form is **ephemeral** (service dies with
the process) - run it as a persistent `systemd` unit so it survives, and
test whether the URL survives restarts; for a permanent URL + custom
domain, create the exposed service via the Netbird dashboard/API instead
(dashboard/API services persist until deleted).
2. **Cloudflare Tunnel (`cloudflared`).** A daemon on the VPS keeps an
outbound connection to Cloudflare's edge and gives a stable public
hostname + TLS, free - but a **named tunnel needs a domain on Cloudflare**
(you currently have only `*.vercel.app`). Quick tunnels
(`cloudflared tunnel --url http://localhost:8000`) work domain-free but
give a random, temporary URL - fine for a smoke test, not production.
3. **ngrok.** Same idea; free tier gives a random URL, paid for static.

> **Status (2026-08-10):** the women-safety frontend integration is done -
> Patiala scenario, planner-routed patrol loops (computed once + cached in
> localStorage, regenerated when danger zones change or via the Dashboard
> button), planner-routed SOS dispatch and Safe Walk legs, and the red/amber
> no-fly overlay. CORS + optional API key are implemented in `main.py`. The
> remaining work is purely operational: deploy this repo on the VPS (data
> setup below), publish the port with the tunnel, and set
> `VITE_PLANNER_API_URL` (+ `VITE_PLANNER_API_KEY`) on Vercel.

**CORS:** the API ships with `CORSMiddleware` (allow_origin_regex covering
`http://localhost:*` and `https://*.vercel.app`, so preview/PR domains also
work) - no further change needed.

**Security:** the public URL exposes the planner to the internet - a simple
shared secret is built in: set `PLANNER_API_KEY` on the VPS and every
planning endpoint (`/generate-route`, `/generate-route/stream`, `/replan`,
`/mission`, `/no-fly-zones`) requires an `X-API-Key` header (`/health` stays
open for liveness). The frontend sends it when `VITE_PLANNER_API_KEY` is
set. (Netbird's dashboard-created exposed services can also be gated by
group membership/PIN.)

**Where the frontend lives (decided): KEEP IT ON VERCEL.** Hosting and
connectivity are separate decisions - the tunnel above solves connectivity
no matter where the frontend is hosted. Hosting the frontend on the EU VPS
instead would only slow first page load for Indian users (~600 ms vs
~140 ms from Vercel's Mumbai PoP) and would NOT speed up API calls, which
go to the EU VPS either way (and route computation dominates at 1-6 s per
mission regardless). The 1 GB RAM is not a blocker (nginx static hosting is
~10-20 MB) - it is purely a slower-first-load tradeoff with zero upside.

---

## 7. Ready-to-paste prompt for the integration session

Copy the block below into the new session (with the drone website repo
cloned alongside this one):

````text
You are a senior React + backend integration engineer.

Context: I have a standalone drone route-planning service (FastAPI +
DuckDB Spatial) in the repo next to this one. It generates GPS waypoints
for an emergency-response drone over real Overture building data + DGCA
no-fly zones. It outputs ONLY waypoints - no drone protocol. The demo
frontend in that repo is test-only; I am now integrating with THIS
website's frontend for real.

Backend repo: <path to drone-route-optimization clone>
- API: GET /health, GET /no-fly-zones?scope=punjab|india,
  POST /generate-route, POST /generate-route/stream (NDJSON live
  progress), POST /replan, POST /mission
- OpenAPI schema at /openapi.json - generate the TS client from it
  (openapi-typescript + openapi-fetch), do NOT hand-write interfaces
- Request: {start_lat, start_lon, goal_lat, goal_lon, altitude_m?,
  grid_resolution_m?, safety_margin_m?, speed_mps?, snap_start_goal?,
  algorithm?}
- Response: {mission_id, distance, estimated_time,
  waypoints: [{lat, lon, alt}], warning?, backup_waypoints?,
  zones_crossed: [{kind: red|amber, name, ring}]}
- Amber zones are passable with permission (report them + flag "request
  permission, notify airport authority"); red zones are hard obstacles.
  Route starts immediately when waypoints arrive; use the /stream
  endpoint to render the route as it is constructed.

Your tasks:
1. Add a typed API client for this service to the website frontend
   (generated from the OpenAPI spec).
2. Add a mission planner page/flow: pick start + goal on the map, call
   /generate-route, render the waypoint polyline + markers, show
   distance / ETA / waypoint count / any warning, and display the amber
   zones_crossed overlay with the permission flag.
3. Add a no-fly overlay layer (GET /no-fly-zones, red vs amber styling).
4. Add mission controls (generate / start / pause / resume / abort) -
   start/pause/resume/abort can be frontend stubs for now; generate
   must call the backend.
5. Handle loading states, errors (422/409/500 + the "degraded route"
   warning case - it's a 200 with a warning, not an error), and mobile
   layout.
6. CORS + network: this website runs on Vercel, the planner on a VPS
   with NO public IP (reachable only via the Netbird mesh). Vercel cannot
   dial into the VPS - publish the planner with an OUTBOUND tunnel instead:
   `netbird expose 8000` on the VPS (recommended, you already use
   Netbird; run as a systemd unit since CLI-exposed services are
   ephemeral, or create a permanent service via the Netbird dashboard), or
   Cloudflare Tunnel (needs a domain for a stable hostname). Then add CORS
   middleware allowlisting the Vercel site, and an X-API-Key shared secret
   since the URL is public.
7. Do NOT modify the planner backend's routing logic. Do NOT add any
   drone protocol code (no PX4/ROS/MAVSDK).
8. README documenting the integration.

Report your plan before implementing.
````
