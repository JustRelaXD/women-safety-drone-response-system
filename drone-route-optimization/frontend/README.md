# Drone Planner Web - React frontend

React + Vite + TypeScript + React Leaflet + TailwindCSS frontend for the
emergency-response drone route planner. It consumes the FastAPI REST API and
knows nothing about DuckDB, Overture Maps, or the Python planner internals.

## Architecture

```
src/
  components/
    layout/     Sidebar, TopBar, responsive app shell
    map/        Leaflet map, route polyline, numbered waypoints, animated drone
    mission/    stats panel, live telemetry panel, mission controls
    ui/         Button, Card, StatCard, Field, Feedback primitives
  pages/        Dashboard, Mission Planner, Mission History, Settings
  hooks/        useBackendHealth, useTelemetryLoop (mocked live telemetry)
  services/     api.ts (typed client) + mission.ts (endpoint methods) + telemetry.ts
  stores/       Zustand stores: mission, settings (persisted), telemetry
  types/        index.ts re-exports + api.generated.ts (codegen - do not edit)
  utils/        geo math (haversine/bearing), formatting, cn()
```

The data flow:

```
React components
      │  (read/write Zustand stores - no direct fetch anywhere)
      ▼
missionStore / telemetryStore
      │
      ▼
services/mission.ts   ──►   services/api.ts (openapi-fetch client)
                                    │
                                    ▼
                        FastAPI (POST /generate-route, /replan,
                        /mission, GET /health)
```

## Types generated from the OpenAPI spec

The backend emits an OpenAPI schema automatically. Instead of hand-writing
interfaces, `openapi-typescript` generates `src/types/api.generated.ts` from
that schema, and `openapi-fetch` uses it to type every request and response.
When the backend models evolve (new fields, new endpoints), regenerate:

```bash
# 1. Re-export the current spec from the backend (repo root):
uv run python frontend/scripts/export-openapi.py

# 2. Regenerate the TypeScript types:
npm run generate:api
```

`scripts/export-openapi.py` imports the FastAPI app and dumps `app.openapi()`
to `frontend/openapi.json`. Both the checked-in spec and the generated types
are updated in the same flow, so the frontend can never drift silently from
the backend contract. Regenerated files are the single source of truth for
request/response shapes; `src/types/index.ts` only re-exports them with
friendly aliases.

## Services

- `services/api.ts` - the only module that knows about HTTP. Wraps
  `openapi-fetch` with a normalized `ApiError` and a `errorMessage()` helper
  that surfaces the backend's `detail` field. No other file calls `fetch`.
- `services/mission.ts` - one method per endpoint (`generateRoute`, `replan`,
  `registerMission`, `health`), plus `demoRoute()` which fabricates a plausible
  route when the backend is unreachable so the whole UI stays explorable
  offline (the map labels demo routes clearly).
- `services/telemetry.ts` - mocked telemetry engine that simulates a drone
  flying the planned waypoints at the configured speed, producing position,
  heading, altitude, battery, and remaining-waypoint state. Swapping in real
  MAVLink/MAVSDK telemetry later only requires implementing the same interface.

## State management

Zustand (no Redux), three stores:

- `missionStore` - start/goal points, current route, request status/error,
  and mission history (persisted to localStorage, capped at 50 entries).
- `settingsStore` - planner algorithm, altitude, safety margin, grid
  resolution, speed; persisted to localStorage so Settings survives reloads.
- `telemetryStore` - live drone state driven by the mock engine.

## Map

- React Leaflet; basemap chosen via the "layers" picker (top-right of the
  map) or Settings > Map layer, persisted to localStorage. Available layers:
  Satellite (Esri), Streets (Esri), Buildings (OSM.de), OpenStreetMap,
  Voyager (light), Dark (Carto). All were verified to serve real tiles for
  the Punjab region. The default "auto" follows the app theme.
- The building-visible layers (Satellite, Streets, OSM.de, OSM) let you
  visually verify that a generated route does not cut through buildings
  before dispatch. Note: OSM-derived layers only show OSM footprints, while
  Overture also contains Microsoft imagery-detected buildings - the Satellite
  layer is the ground truth.
- Click to set start, click again for the destination, then generate.
- Route drawn as a white-cased emerald polyline (visible on satellite and
  dark basemaps) with numbered waypoint markers.
- Animated drone marker that tracks the mock telemetry along the route.
- `leaflet.markercluster` used for the waypoint markers when a route has
  many (dense urban scenes), so the map stays smooth on mobile.

## Running

Requirements: Node 18+ (`npm install` once), and the FastAPI backend
(`uv run uvicorn planner.api.main:app` from the repo root, port 8000).

```bash
npm install
npm run dev        # http://localhost:5173, proxies /api/* to :8000
npm run typecheck  # tsc --noEmit
npm run build      # typecheck + production bundle into dist/
npm run preview    # serve the production build locally
```

Environment: see `.env.example`. `VITE_API_BASE_URL` (default `/api`) is the
base the client calls; the Vite dev server proxies `/api` to
`VITE_API_TARGET` (default `http://localhost:8000`) so there is no
cross-origin traffic in development. In production, serve `dist/` behind a
reverse proxy that routes `/api/*` to the planner service.

## Notes on the demo fallback

With the backend stopped, route generation shows a zig-zag demo route (marked
as such) and telemetry still animates, so the Dashboard, Mission Planner and
Live Mission panels can be demonstrated end-to-end. Start the Python service
and press Generate Route for a real plan.
