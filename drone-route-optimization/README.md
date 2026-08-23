# Emergency-Response Drone Route Planner

> **Integrating this service into another frontend? Read `INTEGRATION.md`
> first** - it has the API contract cheat sheet, the typed-client
> generation workflow, the VPS deployment recipe, and a ready-to-paste
> prompt for an integration session. The `frontend/` folder in this repo is
> a test/demo UI only.

Route planner (A* / Theta* / visibility graph) over Overture Maps
building/water data, backed by DuckDB Spatial, designed to run on a 1 GB
Azure VM. Outputs GPS waypoints only - no drone protocol, no PX4/ROS/MAVSDK:
any controller can call the REST API. The pathfinding algorithm choice is
benchmark-justified in §7, not assumed.

```
Mission Request
     ↓
Direct-line fast path    (ST_Intersects against REAL geometries only)
     │
     ├─ clear ─→ exactly 2 waypoints [start, goal]  ← skips everything below
     │
     ↓ blocked
Bounding Box Generation  (bbox_of_points + expansion)
     ↓
DuckDB Spatial           (memory_limit, threads, temp spill)
     ↓
bbox filter              (predicate pushdown → row-group pruning, verified)
     ↓
ST_Intersects refinement (R-tree served, exact)
     ↓
Temporary Region Dataset (file-backed .duckdb, RTREE index)
     ↓
Route Planner            (exact polygon rasterization → A*/Theta*/visibility
                          → LOS smoothing → geometry-exact smoothing)
     ↓
GPS Waypoints            (thinned, constant altitude)
     ↓
FastAPI Response         (JSON)
```

---

## 1. Verified research facts (measured, not assumed)

| Fact | Finding |
|---|---|
| Dataset | `punjab_buildings.parquet`: 18,234,971 buildings, 2.45 GB, 520 row groups (~35 k rows), Parquet v2 |
| bbox stats | exact per-row-group min/max on `bbox.xmin/xmax/ymin/ymax` (520/520 `min_is_exact=true`) |
| Row-group pruning | 0.1° bbox filter scanned 122,890 of 18.2 M rows in ~0.09 s (`EXPLAIN ANALYZE`: filter inside `READ_PARQUET`) |
| `ST_Intersects` alone | NOT prunable (WKB BLOB) - full 18.2 M-row scan, 22.7 s |
| bbox-only false positives | 0.7 % (500 m) down to 0.015 % (5 km): bbox refines candidates, `ST_Intersects` refines truth |
| R-tree | `CREATE INDEX ... USING RTREE (geometry)` works; planner emits `RTREE_INDEX_SCAN` |
| Memory | both query paths peak < 300 MB; full-province one-time index build peaks at 765 MB |

The pipeline never loads the whole GeoParquet into RAM: only pruned row
groups are read, only the working region is materialised, and only lean
columns (`id, height, level, class, subtype, num_floors, geometry`) are
projected.

---

## 2. Project structure

```
overture-test/
├── pyproject.toml
├── planner/
│   ├── api/main.py            # FastAPI: /generate-route /replan /mission /health
│   ├── core/                  # config.py, geometry.py, missions.py, exceptions.py
│   ├── models/                # Pydantic request/response schemas
│   ├── overture/              # DuckDB Spatial data layer (bbox pushdown, RTREE region),
│   │                          # no_fly.py (DGCA airspace zone import/load)
│   ├── routing/               # grid.py (exact-polygon + legacy envelope
│   │                          # rasterization), obstacles.py, astar.py,
│   │                          # theta_star.py, visibility.py, smoothing.py
│   │                          # (cell + geometry-exact), waypoints.py,
│   │                          # direct_path.py (straight-line fast path),
│   │                          # planner.py (RoutePlanner facade)
│   ├── tests/                 # 103 pytest tests (synthetic GeoParquet fixtures)
│   └── data/                  # runtime artifacts (spill, region .duckdb) - gitignored
├── benchmarks/                # research + planner + algorithm-comparison + rasterization
│                              # (raster_mode.py: envelope-vs-exact) benchmarks
│                              # (results/ gitignored)
├── scripts/build_region_db.py       # one-time full/region index builder
└── scripts/import_no_fly_zones.py   # one-time DGCA airspace zone import (Punjab bbox)
```

Responsibilities are separated: the data layer knows DuckDB/GeoParquet, the
routing layer knows grids/A*/smoothing, the API layer knows HTTP, and
`RoutePlanner` is a thin facade orchestrating them (SOLID: each class has one
job; obstacle types plug in via an `ObstacleSource` protocol - buildings,
water, no-fly zones today, airports tomorrow).

---

## 3. Quick start

```bash
uv sync
uv run pytest                          # 103 tests
uv run uvicorn planner.api.main:app --host 0.0.0.0 --port 8000
```

```bash
curl -s localhost:8000/health

curl -s -X POST localhost:8000/generate-route -H 'content-type: application/json' -d '{
  "start_lat": 30.7365, "start_lon": 75.5859,
  "goal_lat": 30.7635, "goal_lon": 75.6141,
  "altitude_m": 80, "speed_mps": 20, "snap_start_goal": true
}'
```

```json
{
  "mission_id": "mission-92f1d33a9ce5",
  "distance": 4270.96,
  "estimated_time": 213.55,
  "waypoints": [
    {"lat": 30.7365, "lon": 75.5859, "alt": 80.0},
    {"lat": 30.7392, "lon": 75.5887, "alt": 80.0}
  ]
}
```

Use the planner from any controller code:

```python
from planner.core.config import Settings
from planner.routing.planner import RoutePlanner

planner = RoutePlanner(Settings())          # or Settings.from_env()
result = planner.plan(start=(30.7365, 75.5859), goal=(30.7635, 75.6141))
print(result.waypoints)                     # [(lat, lon, alt), ...]
planner.close()
```

---

## 4. API reference

| Endpoint | Body | Returns |
|---|---|---|
| `GET /health` | - | data availability + config echo |
| `GET /no-fly-zones` | - | imported DGCA red/amber overlay (rings + snapshot age) |
| `POST /generate-route` | `MissionRequest` | `RouteResponse` (waypoints) |
| `POST /generate-route/stream` | `MissionRequest` | NDJSON stream: `stage` events (live partial waypoints + pipeline progress) then `complete` (`RouteResponse`) or `error` |
| `POST /replan` | `ReplanRequest` (new current position) | `RouteResponse` |
| `POST /mission` | `MissionCreateRequest` (+ optional `mission_id`) | `MissionResponse` (stored mission + route) |

`MissionRequest` fields: `start_lat/lon`, `goal_lat/lon` (required);
`altitude_m`, `grid_resolution_m`, `safety_margin_m`, `speed_mps`,
`no_fly_zones` (rings of [lat, lon]), `snap_start_goal`, `algorithm`
(`"astar" | "theta_star" | "visibility"`, all optional).

Errors: `422` validation or infeasible algorithm (visibility beyond its
caps).  A missing corridor no longer errors: `plan()` degrades to a
best-effort route with a `warning` (0 m-clearance retry, then the
reachable point closest to the goal + straight segment), always alongside
the direct-line `backup_waypoints`.  `500` data errors.

**Live route streaming** (`POST /generate-route/stream`): the same plan is
streamed as newline-delimited JSON while it runs, so the frontend can draw
the route as it takes shape instead of waiting for the full computation
(which can be tens of seconds on degraded city routes).  Each line is one
of:

- `{"type": "stage", "stage": "region"|"grid"|..., **detail}` - pipeline
  progress (building counts, grid dimensions, degraded-fallback reasons);
- `{"type": "stage", "stage": "search", "waypoints": [...], "epoch": n}`
  - the growing start->goal line WHILE the search is still running.  The
    waypoints end at the expanded cell with the smallest heuristic distance
    to the goal found so far, so the line extends toward the destination
    instead of swinging through the 360-degree frontier A* explores early
    (the endpoint's heuristic distance is monotonic).  `epoch` increments
    per search attempt (the degraded fallback runs several: requested
    margin, 0 m retry, red-zone reroute) so clients can tell a fresh
    search line - which restarts from the start cell - from the previous
    attempt's;
- `{"type": "stage", "stage": "path"|"smooth"|"geometry",
  "waypoints": [...]}` - the current best route: the raw A* path, then the
  LOS-smoothed path, then the geometry-refined one (each closer to the
  final answer).  The frontend draws these live and swaps in the final
  polyline when planning completes;
- `{"type": "complete", "data": {RouteResponse}}` - same payload as
  `/generate-route`;
- `{"type": "error", "status": ..., "detail": ...}` - HTTP-style status
  in-band (the transport response is always `200`).

The plan runs in a daemon thread; the response generator drains a
thread-safe queue.  The classic endpoint is unchanged - streaming is an
additive, drop-in enhancement.

---

## 5. Config (`planner/core/config.py`, env `PLANNER_*`)

| Setting | Default | Meaning |
|---|---|---|
| `planner_algorithm` | astar | pathfinding: `astar` / `theta_star` / `visibility` (see §7) |
| `visibility_max_buildings` | 1,500 | visibility graph cap (O(V²); 2 km+ rejected fast) |
| `visibility_max_vertices` | 4,000 | visibility graph vertex cap |
| `grid_resolution_m` | 10 | cell size; auto-coarsens to respect `max_grid_cells` |
| `max_grid_cells` | 4,000,000 | cap on grid size (RAM bound) |
| `safety_margin_m` | 0 | THE clearance knob (sent per request, 0-200 m): enforced by the geometry smoothing; in exact mode it also caps the grid corridor via `min(polygon_buffer_m, safety_margin_m)` - down to 0 m |
| `polygon_buffer_m` | 1 | exact-mode buffer around the ACTUAL building polygon; the grid-corridor default (the effective buffer is `min(polygon_buffer_m, safety_margin_m)`) |
| `rasterize_exact_polygons` | true | paint exact polygons (+ `polygon_buffer_m`) instead of buffered bounding boxes |
| `default_altitude_m` | 50 | constant mission altitude |
| `min_waypoint_spacing_m` | 25 | GPS waypoint thinning |
| `bbox_expansion_m` | 200 | region query margin around the mission |
| `raster_envelope_max_cells` | 4096 | legacy envelope-mode only: small obstacles block their envelope, larger ones rasterise exactly |
| `memory_limit` | 512MB | DuckDB memory cap (spills to `temp_directory`) |
| `threads` | 1 | DuckDB parallelism |
| `temp_directory` | planner/data/spill | spill directory |
| `buildings_parquet` / `water_parquet` | - | data sources (`water_parquet=None` disables water) |
| `region_db_path` | None | None = in-memory DuckDB; else file-backed `.duckdb` |
| `drone_speed_mps` | 15 | used for `estimated_time` |
| `no_fly_zones` | () | typed zone records (kind red/amber + ring + name); red = obstacle, amber = passable-with-permission (reported via `zones_crossed`, never an obstacle) |
| `no_fly_zones_file` | None | local snapshot of DGCA airspace zones (loaded at startup, merged into `no_fly_zones`; also feeds `GET /no-fly-zones`) |
| `red_reroute_max_expansion_m` | 20000 | max extra search-box expansion (in metres on each side) the degraded fallback tries to route AROUND a blocking red ring |
| `airport_red_radius_km` | 1.0 | radius of the airport no-drone circle; the import replaces the DGCA `type=airport` red circle (~11-14 km wide) with this smaller circle so cities with an airport stay reachable (0 = keep the DGCA circle) |

---

## 6. Phase 6 benchmark (real Punjab data, 512 MB DuckDB cap, 1 thread)

Centre 30.7500 N, 75.6000 E (rural/suburban Punjab; missions whose start/goal
land inside dense village clusters auto-shift the centre - see §8). Peak RSS
is `ru_maxrss` per isolated subprocess. This table is the A* (default)
column of §7.

> The rows below were measured with the legacy buffered-bounding-box
> rasterizer (the default when they were captured).  The exact-polygon
> rasterizer that is the default now paints strictly fewer cells and keeps
> route quality equal or better - see §8.2 for the side-by-side.

| box | planning wall | planning CPU | peak RSS | buildings | waypoints | distance | grid | nodes explored |
|---|---|---|---|---|---|---|---|---|
| 500 m | 1.06 s | 1.86 s | 214 MB | 731 | 5 | 712 m | 94×94 | 225 |
| 1 km | 1.14 s | 1.91 s | 214 MB | 1,474 | 6 | 1,420 m | 144×144 | 847 |
| 2 km | 0.86 s | 1.34 s | 215 MB | 1,725 | 14 | 3,139 m | 244×243 | 15,251 |
| 5 km | 1.11 s | 1.64 s | 219 MB | 4,336 | 19 | 7,298 m | 544×544 | 31,605 |
| 10 km | 2.07 s | 2.63 s | 235 MB | 23,214 | 16 | 14,285 m | 1044×1044 | 88,566 |
| 20 km | 3.02 s | 3.68 s | 284 MB | 89,085 | 43 | 28,445 m | 1948×1946 | 146,424 |

**Every mission plans in ≤ 3 s and peaks at ≤ 284 MB - comfortably inside a
1 GB VM** (process baseline ~75 MB; DuckDB itself tracks only tens of MB for
the region). Raw results: `benchmarks/results/planner_bench_*.csv`.

Research-phase per-box comparison (Option A GeoDataFrame+STRtree vs Option B
DuckDB-only) is in `benchmarks/results/benchmark_*.csv`.

---

## 7. Pathfinding algorithm comparison (measured, not assumed)

Which planner to run was decided from benchmarks, not defaults. Three were
implemented and measured on the real Punjab parquet (same centre, box sizes
500 m - 20 km, `ru_maxrss` in isolated subprocesses); two were deliberately
not implemented (reasoned exclusions below). Detour = (route / straight
line) - 1, the path-quality metric; all routes are LOS-smoothed and thinned
to 25 m waypoints.

| box | algorithm | planning | peak RSS | buildings | waypoints | detour |
|---|---|---|---|---|---|---|
| 500 m | A* (grid) | 1.13 s | 214 MB | 731 | 5 | 0.8 % |
| 500 m | Theta* | 3.30 s | 214 MB | 731 | 3 | 0.6 % |
| 500 m | visibility | 7.43 s | 290 MB | 787 | 4 | 5.8 % |
| 1 km | A* (grid) | 1.19 s | 215 MB | 1,474 | 6 | 0.5 % |
| 1 km | Theta* | 11.41 s | 215 MB | 1,474 | 4 | 0.3 % |
| 1 km | visibility | 38.65 s | 331 MB | 1,474 | 7 | 1.4 % |
| 2 km | A* (grid) | 0.86 s | 214 MB | 1,725 | 14 | 11.1 % |
| 2 km | Theta* | 10.62 s | 215 MB | 1,725 | 12 | 6.6 % |
| 2 km | visibility | 322.9 s | 483 MB | 1,725 | 10 | 1.3 % |
| 5 km | A* (grid) | 1.12 s | 218 MB | 4,336 | 19 | 3.3 % |
| 5 km | Theta* | 23.70 s | 219 MB | 4,336 | 10 | 0.8 % |
| 10 km | A* (grid) | 2.60 s | 235 MB | 23,214 | 16 | 1.1 % |
| 10 km | Theta* | 100.49 s | 235 MB | 23,214 | 12 | 0.3 % |
| 20 km | A* (grid) | 3.33 s | 283 MB | 89,085 | 43 | 0.7 % |
| 20 km | Theta* | 104.23 s | 283 MB | 89,085 | 28 | 0.1 % |

(visibility beyond 1 km is skipped by the driver: construction is O(V²); the
2 km row was measured once manually. Raw: `benchmarks/results/algorithm_bench_*.csv`.)

### 7.1 Scorecard on the four criteria

**Planning time** - A* wins outright: 0.9-3.3 s at *every* box size. Theta*
is 3x slower at 500 m and ~30x slower at 10-20 km (its line-of-sight
shortcuts turn into long segment scans on big grids). Visibility graph
construction (the bottleneck, not the search: `vis_search_s` < 0.1 s) is
7 s at 500 m, 38 s at 1 km, 323 s at 2 km - quadratic in obstacle vertices.

**Path quality** - Theta* (with its admissible euclidean heuristic) is the
quality champion: it beats or ties A* at every size (500 m: 0.6 % vs 0.8 %;
2 km: 6.6 % vs 11.1 %; 20 km: 0.1 % vs 0.7 %) and emits fewer waypoints
(3-28 vs 5-43) because its raw paths have fewer vertices. In open terrain
the gap is tiny, because A* is already followed by LOS smoothing (the same
any-angle post-processing Theta* bakes into its search); the gap widens on
real detours (2 km village box: 4 % shorter route). Visibility has the
*exact* shortest path but its convex-hull approximation of building clusters
can over-block alleyways and measure *worse* than grid A* (500 m: 5.8 %
detour) - exactness on an approximate map.

**Memory** - A* and Theta* are identical (same grid, ~215-282 MB).
Visibility is the heaviest (290 MB at 500 m, 483 MB at 2 km). All fit the
1 GB VM, but the visibility graph is the only one that grows superlinearly.

**Dynamic replanning** - `POST /replan` re-runs the search on the same grid:
A* ~1-3 s, Theta* 3-30x slower, visibility requires a full O(V²) rebuild per
replan. For a mid-mission emergency replan, latency is the deciding factor.

### 7.2 Decision

**Default stays uniform-grid A* + LOS smoothing.** A* is within ~0.5-1 % of
the straight line on most missions (and at worst 11 % on a tight 2 km
village detour - Theta* would cut that to 6.6 %, but at 10-30x the latency:
0.9 s vs 10.6 s). It is memory-identical to Theta* and replans in seconds.
**Theta*** is opt-in (`algorithm: "theta_star"` in a request, or
`PLANNER_ALGORITHM=theta_star`) for missions that are path-quality-critical
and latency-tolerant (fewer waypoints, shorter detours). The **visibility
graph** is a reference / small-region tool: its exact-shortest-path
character comes with O(V²) construction (2 km+ boxes are rejected fast by
the caps) and an approximate (hulled) obstacle map, so it is rarely the
right default.

### 7.3 Why not Hybrid A* and PRM?

**Hybrid A*** plans in the vehicle's configuration space (state lattice,
Dubins/Reeds-Shepp turn constraints). Our contract deliberately decouples
planning from the aircraft: we emit GPS waypoints and any controller
(PX4/ROS2/ArduPilot) flies them. Baking turn-radius assumptions in would tie
the planner to one drone. A (near-)holonomic multirotor already follows
any-angle paths well, which is exactly what Theta* provides when needed.

**PRM** is probabilistically complete and non-deterministic: routes vary
between runs, need post-smoothing, and dense roadmaps cost memory. In 2D
with fully-known static polygonal obstacles, deterministic planners
dominate on worst-case time, reproducibility, and replanning predictability.
PRM earns its keep in high-DOF configuration spaces - not here.

---

## 8. Key design decisions and findings

1. **bbox first, ST_Intersects second** - the only combination that is both
   fast (pruned) and exact (verified above).
2. **Working-region pattern** - materialise buildings within the mission bbox
   (expanded by `bbox_expansion_m`) into a DuckDB table with an R-tree index;
   never hold more than a region in RAM.
3. **Exact-polygon rasterization (default)** - buildings are painted by
   fetching their ACTUAL geometry (bbox-filtered subset, never the whole
   dataset), buffering it by `polygon_buffer_m` and blocking every cell
   whose rectangle intersects it.  The bounding box is used ONLY as the
   DuckDB spatial-query filter, never as the painted footprint.  The legacy
   buffered-bounding-box path (envelope-streamed, 4 floats per obstacle)
   remains as a configurable fallback (`rasterize_exact_polygons=false`).
4. **Dense-urban finding, revisited**: the diagnostic showed the city
   "wall" was mostly NOT real buildings - on the Amritsar wall 112 of 181
   line-blockers were envelope-only (the buffered bounding box, not the
   footprint).  Exact painting removes that over-blocking: narrow passages
   the envelope sealed open up (see §8.2).  Where streets are still
   narrower than a grid cell, the planner honestly reports `409` - lower
   `grid_resolution_m` and/or `polygon_buffer_m`, or fly above building
   height (typical for emergency-response drones) and treat buildings as
   coarse obstacles only.
5. **`snap_start_goal`** - controllers' GPS points often land on a building;
   the option shifts them to the nearest free cell (off by default so
   planning stays strict).
6. **Fast large-obstacle rasterization** - obstacles spanning more than
   `FAST_PAINT_MIN_CELLS` cells (typically no-fly rings, which can span the
   whole grid) take a fast paint path that is bit-identical to the exact
   per-cell path: a vectorised point-in-polygon test decides the bulk of
   the area and only boundary cells (found by an O(perimeter) edge walk
   over the polygon boundary, dilated one cell) are verified exactly.  An
   India-scope snapshot with 1722 red rings rasterizes a mission grid in
   ~0.37 s instead of transforming, buffering and painting every ring, and
   a giant ring that blocks nothing costs ~0.2 s instead of ~2 s.  This is
   what keeps degraded dense-city missions (which rasterize twice - once
   at the requested margin, once at 0 m) at ~2.5 s instead of ~8 s.
7. **Obstacles are bbox-culled against the grid** before transform/buffer/
   paint: a static no-fly snapshot can hold hundreds to thousands of zones
   but only the handful overlapping the mission bbox are ever processed.
8. **Grid memory is bounded** by `max_grid_cells` (arrays are a few tens of
   MB even at 4 M cells); A* uses float32 g-values and int32 parents.
9. **Extension point** - `ObstacleSource` protocol: `AirportSource` is a
   ready-made placeholder; point it at an airports GeoParquet and the
   planner, rasterizer and API are unchanged.
8. **Two-stage smoothing** - the grid branch runs cell-level LOS smoothing
   and then a geometry-exact shortcut pass (`smooth_waypoints_geometry`)
   over the FINAL waypoint polyline.  It tests every candidate segment
   against the ACTUAL obstacle polygons + `safety_margin_m` (STRtree
   `dwithin`), so it straightens through cells the envelope-rasterization
   over-blocks while never approaching a real obstacle closer than the
   margin.  Measured on a real 5 km field mission: 24 -> 14 waypoints,
   +2.4% -> +1.3% detour, the staircase micro-zigzags eliminated.  Only the
   obstacles near the route corridor are fetched (bbox filter + chunked
   WKB), so the pass costs ~35 ms on typical missions and ~2 s at 20 km
   (the extend-while-clear greedy keeps dense-terrain cost linear, not
   O(n²)).

### 8.1 Direct-line fast path (`planner/routing/direct_path.py`)

**Why it exists.** The diagnostic tool proved that open-field missions
detour ~5 % even with *zero* obstacles on the line - a pure grid/smoothing
artefact (A* walks cell centres and the conservative corner-safe LOS
smoother only jumps to cells on the A* path). Before any region
materialisation / rasterization / search, `plan()` now tests the true
straight start→goal segment against the ACTUAL obstacle polygons via
`ST_Intersects` (bbox predicate used only for row-group pruning; `LIMIT 1`
stops at the first hit). If nothing intersects, it returns exactly two
waypoints and skips the grid entirely. Any failure of the check (missing
file, unsupported schema, connection error) logs a warning and falls back to
the existing pipeline unchanged - the fast path is an optimisation, never a
correctness gate.

**Why envelopes are ignored ONLY during the direct-path check.** The check
answers one binary question: "does any real obstacle geometry lie on this
line?" Margins and buffered envelopes cannot change that answer - they only
exaggerate it. The diagnostic found that on the 16 km Amritsar wall, 112 of
181 blockers were envelope-only (rasterization artefacts, not buildings), so
honouring envelopes here would re-introduce exactly the detours being
eliminated. `ST_Intersects` also counts boundary touches as intersections,
so a line grazing a building edge conservatively falls back to the grid.

**Why envelopes remain in the fallback planner for safety.** The fast path
is a strict "nothing on the line" guarantee. When it fails, the drone needs
an actual clearance corridor to fly through - the grid rasterizes every
obstacle with `safety_margin_m` and the A*/Theta*/visibility planners then
respect that corridor. The two stages have different jobs: the fast path
proves empty space, the grid engineers safe separation.

Measured on real Punjab data (anchor 30.7500, 75.6000; `grid` = the
pre-fast-path pipeline recreated via planner internals, `fast` =
`RoutePlanner.plan()` with the fast path; peak RSS per isolated subprocess;
`water_parquet` not configured):

| box | direct | grid t | fast t | speedup | grid RSS | fast RSS | grid wps | fast wps | grid dist | fast dist | grid bldg | fast bldg |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0.5 km | yes | 0.79 s | 0.74 s | 1.07x | 215 MB | 197 MB | 3 | 2 | 0.56 km | 0.50 km | 304 | 0 |
| 1 km | yes | 0.85 s | 0.76 s | 1.12x | 215 MB | 202 MB | 4 | 2 | 1.01 km | 1.00 km | 323 | 0 |
| 2 km | yes | 0.89 s | 0.77 s | 1.16x | 216 MB | 202 MB | 5 | 2 | 2.06 km | 2.00 km | 416 | 0 |
| 5 km | yes | 1.29 s | 0.75 s | 1.71x | 220 MB | 204 MB | 5 | 2 | 5.06 km | 4.99 km | 3721 | 0 |
| 20 km | no | 6.04 s | 6.04 s | 1.00x | 260 MB | 260 MB | 26 | 26 | 21.14 km | 21.14 km | 42266 | 42266 |

(Both variants now include the geometry-exact smoothing pass, so the grid
column reflects it too: on accepted lines the grid route still carries a
small envelope-artifact detour - e.g. 0.56 km vs the 0.50 km straight line
at 500 m - which the fast path eliminates entirely with 2 waypoints.)

Accepted lines return 2 waypoints, load **zero** buildings into the region,
use 10-20 MB less RSS, and are up to 1.7x faster (5 km). The 500 m row is
the tell: the grid route was 0.58 km vs the 0.50 km straight line - a +16 %
detour on a geometrically clear line, eliminated by the fast path. Rejected
lines (20 km) pay a ~4 % check overhead and plan exactly as before.
Raw results: `benchmarks/results/direct_path_bench.{md,json}`.

### 8.2 Exact polygon vs buffered bounding box (`benchmarks/raster_mode.py`)

**Why it exists.** The rasterizer used to block every cell inside the
building's buffered BOUNDING BOX.  Three compounding over-blocks wasted
corridors: the axis-aligned box covers empty corner regions of diagonal
buildings, the safety margin was applied to the rectangle instead of the
footprint, and grid snapping added up to a cell on every side.  In dense
blocks that sealed streets narrower than ~20 m - the "city wall" that
produced `409 no route` in areas a drone could actually thread.

**What it does.** `rasterize_exact_polygons=true` (default) paints only the
cells whose RECTANGLE intersects `buffer(actual polygon, polygon_buffer_m)`.
This is deliberately cell-rectangle intersection, not cell-centre
containment: a cell that stays free has its entire rectangle outside the
buffered polygon, so EVERY point a route can pass through inside it is
>= `polygon_buffer_m` from the real footprint - a diagonal segment can never
clip a building corner between two "free" cells.  The cost is one extra cell
of blocking around each obstacle, which is what makes the guarantee exact.

**The invariant (tested).** For the same margin value, exact rasterization
never blocks more cells than the buffered-bounding-box path - proven as a
set-inclusion test over a mixed scene (rotated + rect + L-shape buildings,
margins 0/2/5) plus dedicated tests for diagonal buildings, L-shapes, a
narrow street, two close buildings and a city-block courtyard.

**Measured on real Punjab data** (anchor 30.7500, 75.6000; identical
missions, identical A* pipeline afterwards; peak RSS per isolated
subprocess):

| box | env t | exact t | env CPU | exact CPU | env RSS | exact RSS | env blocked | exact blocked | freed | env dist | exact dist |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 0.5 km | 0.76 s | 0.83 s | 1.14 s | 1.24 s | 213 MB | 215 MB | 1,623 | 1,406 | 217 | 0.60 km | 0.58 km |
| 1 km | 0.85 s | 0.83 s | 1.25 s | 1.25 s | 214 MB | 214 MB | 1,829 | 1,539 | 290 | 1.07 km | 1.06 km |
| 2 km | 0.95 s | 1.61 s | 1.46 s | 2.73 s | 213 MB | 214 MB | 1,896 | 1,575 | 321 | 2.03 km | 2.06 km |
| 5 km | 1.11 s | 1.16 s | 1.57 s | 1.58 s | 216 MB | 216 MB | 3,806 | 2,778 | 1,028 | 5.06 km | 5.08 km |
| 20 km | 6.94 s | 12.02 s | 8.01 s | 14.04 s | 259 MB | 320 MB | 205,964 | 148,642 | 57,322 | 21.14 km | 21.08 km |

Exact painting frees 217-57,322 blocked cells per mission (28 % at 20 km),
never exceeds ~320 MB peak RSS (comfortably inside the 1 GB target), and
keeps route distance equal or better on these open-terrain missions.  The
planning-time and RSS deltas at 20 km are the fetch + buffer + paint of the
~40 k real polygons in the corridor - the price of painting truth instead of
boxes (painting is row-chunked so a single huge lake/no-fly polygon can
never blow up RAM).  The `no-path -> path` flips this is designed to produce
happen in dense cores, not open fields; the unit tests pin that flip
deterministically (narrow street, courtyard), and the diagnoser shows the
per-mission freed cell count.

**Interplay with the geometry smoothing (why waypoint counts can rise).**
The grid's corridor clearance is `polygon_buffer_m` (1 m default), and the
geometry-exact smoothing validates shortcuts at `safety_margin_m` (0 m
default).  Because `plan()` caps the grid buffer at
`min(polygon_buffer_m, safety_margin_m)`, the safety margin works as THE
user-facing clearance knob: lower it (down to 0 m in the Settings UI) and
both the grid corridor and the smoothing tighten together - opening gaps
wider margins seal - while raising it above `polygon_buffer_m` only widens
the smoothing (the grid never gets looser than the config default).  The
route is never unsafe (every free cell is entirely >= the effective buffer
from every footprint); it just preserves more waypoints in tight corridors.

Raw results: `benchmarks/results/raster_mode_bench.{md,json}`.

## 9. DGCA no-fly zones (red / amber overlay)

The planner avoids restricted airspace out of the box.  Red and amber
(controlled-airspace) zone polygons come from a one-time import of the DGCA
Digital Sky airspace data (via the public, unauthenticated facilities
endpoint of the airspace map backend - the same data the airspacemap.in map
renders; robots.txt allows crawling, no login, no ToS page; the zone
boundaries themselves are DGCA regulatory facts).  The import fetches ONCE
and caches locally - the planner never touches the network at request time,
and the raw dataset is never redistributed.

```bash
# default: Punjab bbox (lon 73.5..77.0, lat 29.5..32.5)
uv run python scripts/import_no_fly_zones.py
# custom area or all-India:
uv run python scripts/import_no_fly_zones.py --bbox 75.5,30.5,76.5,31.5
uv run python scripts/import_no_fly_zones.py --bbox none
# airport no-drone circle radius (default 2 km; 0 keeps the DGCA circle):
uv run python scripts/import_no_fly_zones.py --airport-red-radius-km 1.5
```

What it writes (``planner/data/no_fly_zones.json``, gitignored):

```json
{
  "fetched_at": "2026-08-08T17:29:31+00:00",
  "source": "https://airspace-map-backend-.../api/facilities",
  "zones": [
    {"kind": "red", "name": "Adampur Airport", "ring": [[lat, lon], ...]}
  ]
}
```

**How it flows through the planner** (the no-fly machinery already
existed; the amber policy is enforced by the kind split):

1. Start the backend with the snapshot configured
   (`PLANNER_NO_FLY_ZONES_FILE=planner/data/no_fly_zones.json`, or the
   default config path).  At startup the rings are loaded into typed
   records (kind + ring + name) in the planner's static ``no_fly_zones``.
2. Every mission then treats zones by kind:
   - **red zones are hard obstacles**: they block the direct-line fast
     path (``no_fly_hit``) and are rasterized onto the grid
     (``NoFlySource``).  A normal route never crosses one;
   - **amber zones are passable WITH prior permission**: they are never
     obstacles.  Every amber crossing is reported on the route response
     as ``zones_crossed`` (kind, name, ring), the map shows the crossed
     zones in dashed amber, and the stats panel flags "request permission
     + notify the airport authority";
   - the frontend map also offers the full red/amber overlay (toggle in
     Settings > Appearance, data from ``GET /no-fly-zones``, punjab /
     india scopes).

**Only the runway and a small airport circle are red; funnels and the
large circles are amber.**  The DGCA data ships each airfield as several
polygons, and the planner's kind split follows what each polygon actually
is on the ground:

- **red** - the runway/airfield footprint itself (small, ~0.5-1 km, from
  the ``type=approach`` records) and, for airports, a round no-drone
  circle around the airport reference point.  Both are hard obstacles: a
  drone must never fly through the runway or the airport's no-drone
  circle.
- **amber** - the **approach/departure funnels** extending from the runway
  ends (the elongated "two triangular shapes" pointing away from the
  airport, where aircraft climb out and descend) and the large ROUND
  controlled-airspace circles (inner/outer yellow).  All of these are
  passable-with-permission, reported on the route as ``zones_crossed``.

Why the funnels are amber (policy decision, 2026-08): they span tens of km
(the Beas/Adampur/Pathankot funnels measure ~120 km² each, ~15 km per
side), so treating them as hard red made whole cities with an airport
unreachable - the funnel tips even overshoot DGCA's own yellow band
(8-12 km from the airport perimeter, which is passable with permission).

Why the airport no-drone circle is shrunk to a configurable 1 km radius
(``airport_red_radius_km``, env ``PLANNER_AIRPORT_RED_RADIUS_KM``): the
DGCA ``type=airport`` records ship a huge red circle (~11-14 km wide) that
sat right on top of city centres (Patiala, Pathankot, Ludhiana, Adampur),
making them unreachable.  The import replaces that circle with a 1 km
radius circle around the airport reference point - cities like Patiala and
Pathankot become reachable while the runway footprint stays red and the
area between the small circle and the old one is covered by the amber
innerYellow circle (passable with permission, reported).  Non-airport red
zones - border strips, cantonments (e.g. the Jalandhar army area), jails,
railway stations, power plants - keep their exact DGCA polygons and stay
hard obstacles.

The map tooltips spell this out: a red "Runway/airfield - prohibited"
polygon, with the amber funnel/circle labelled as controlled airspace,
passable with permission.

**Automatic red-zone reroute.**  When normal A* fails *and* a red ring
actually overlaps the corridor, the planner does not just give up: it
re-runs the search on a larger box sized from the blocking ring's bounds
(so the route can go *around* the whole red polygon - e.g. an airport's
no-drone circle), trying a ladder of expansion factors (1x, 2x) and using
the fast envelope rasterizer so the retry stays cheap.  A route that must
go around an airport no-drone circle now plans around it and reaches the
real goal.  Two guards keep it safe and fast: if the start *or* goal sits
inside a red polygon, or no red ring overlaps the corridor, the reroute is
skipped entirely (inside-red goals stay a fast degraded fallback - a red
zone can never be entered, even to reach a goal).  The `warning` names only
the blocking rings, not every red zone in scope.  Configured via
`red_reroute_max_expansion_m` (default 20000).

One import subtlety: the bbox filter is **facility-level**.  As soon as ANY
zone of an airfield overlaps the operating area (e.g. its approach circle
pokes into Punjab), the whole facility is kept - including the runway even
if the runway polygon itself sits just outside the bbox.  Per-zone
filtering used to silently drop those runways (Shimla Airstrip, lon 77.064
vs the Punjab cut at 77.0), leaving the airstrip fully passable; the import
now guarantees every airstrip in scope keeps its red runway.

Re-running the import from an already-fetched payload (no network) is
supported: ``scripts/import_no_fly_zones.py --input <facilities.json>``.

**Zone semantics** - red = no-drone zone (the airport no-drone circle,
shrunk to ``airport_red_radius_km`` = 1 km by default, plus sensitive
facilities: border strips, cantonments, jails, railway stations, power
plants): hard obstacles, a normal route never crosses one.  Amber =
inner/outer yellow + approach funnels (controlled airspace around
operational airports): passable only with prior permission - the planner
routes through it, reports every crossing, and the operator must notify
the airport authority.  Green is absent from the data (it is "everything
else") and always allowed.  The zone map is dynamic, so
re-run the import on a schedule to refresh; for actual flight
authorization the official Digital Sky portal remains the authority - the
imported overlay is a planning aid only.

## 10. 1 GB VM operating recipe

```
PRAGMA memory_limit = 512MB     (config: memory_limit="512MB")
PRAGMA threads = 1
temp_directory on local SSD     (config: temp_directory="planner/data/spill")
uvicorn planner.api.main:app --workers 1
```

- First request after boot pays cold page-cache reads of the 2.45 GB
  parquet; keep it on local NVMe. Optional: re-write a lean parquet once
  (`SELECT id, height, ..., geometry`) to shrink cold-read time.
- For interactive whole-province querying, build `punjab_buildings.duckdb`
  once (`scripts/build_region_db.py` without `--bbox`; 114 s, 765 MB peak,
  2.72 GB on disk) and point `region_db_path` at it.

## 11. Tests & benchmarks

```bash
uv run pytest                                # 103 tests: config, geometry, grid
                                             # (exact + envelope rasterization),
                                             # A*, Theta*, visibility, cell +
                                             # geometry-exact smoothing,
                                             # waypoints, direct path, no-fly
                                             # import, planner, API (synthetic
                                             # GeoParquet fixtures)
uv run python -m benchmarks.planner_bench \
    --parquet punjab_buildings.parquet --center 30.7500,75.6000
uv run python -m benchmarks.algorithm_bench \
    --parquet punjab_buildings.parquet --center 30.7500,75.6000
uv run python -m benchmarks.direct_path --all \
    --parquet punjab_buildings.parquet    # fast-path vs grid, 500 m - 20 km
uv run python -m benchmarks.raster_mode --all \
    --parquet punjab_buildings.parquet    # envelope vs exact painting, 500 m - 20 km
uv run python -m benchmarks.urban_suite --all \
    --parquet punjab_buildings.parquet    # realistic-mission suite (rural -> dense city cores)
# analysis + before/after viewers: benchmarks/results/urban_suite_report.md
```
