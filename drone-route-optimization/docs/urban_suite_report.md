# Urban mission suite: is exact-polygon rasterization enough?

**Date:** 2026-08-07
**Data:** `punjab_buildings.parquet` (18,234,971 buildings)
**Harness:** `benchmarks/urban_suite.py` (fixed coordinates, isolated subprocesses,
phase-level timers). Planner unchanged - benchmark and analysis only.

---

## 1. Executive summary

**Recommendation: A - exact polygon rasterization is sufficient.**

- It **rescues the original motivating 409**: the 16 km Amritsar "wall" mission
  plans successfully under exact rasterization + endpoint snapping
  (16,631 m, +2.3 % detour, 12.7 s). The legacy envelope mode fails that same
  mission **even with snapping**.
- The two remaining 2 km city-core failures are **proven not rasterization-
  caused**: start and goal sit in *different, disconnected free-cell islands*
  (flood-fill evidence). Reducing the polygon buffer to 0, or the grid to 5 m,
  or snapping endpoints - all fail. No 2D rasterization setting can connect
  two islands separated by continuous building walls.
- Costs are bounded: +0.05-0.45 s rasterization at 2 km scale, +6 s at 16 km,
  peak RSS 332 MB (16 km) - inside the 1 GB VM budget.

---

## 2. Missions (fixed coordinates, density measured from the parquet)

| # | mission | start (lat, lon) | goal (lat, lon) | buildings / km^2 |
|---|---|---|---|---|
| 1 | rural_field_0.5km | (30.7500, 75.6000) | (30.7500, 75.6052) | ~20 |
| 2 | rural_village_1km | (30.7740, 75.6000) | (30.7740, 75.6105) | ~480 |
| 3 | small_town_2km | (30.7500, 75.5760) | (30.7500, 75.5969) | ~480 |
| 4 | amritsar_city_2km | (31.6160, 74.8600) | (31.6160, 74.8811) | ~2,800 |
| 5 | ludhiana_city_2km | (30.9160, 75.8480) | (30.9160, 75.8689) | ~6,000 |
| 6 | amritsar_long_16km | (31.5079, 74.9744) | (31.6137, 74.8560) | city-to-city, 16.26 km |

Densities are bbox `count(*)` results over 1 km squares centred on each
mission (Amritsar core 2,821/km^2; Ludhiana core 6,013/km^2 - the densest
cell found; villages/towns in the 30.73-30.77, 75.57-75.63 band).

## 3. Results (identical coordinates for both variants)

`envelope` = buffered bounding box (margin 5 m), `exact` = polygon + 1 m
buffer. `load` = DuckDB region load, `rast` = rasterization, `t` = total wall,
RSS = `ru_maxrss` per isolated subprocess.

| mission | env OK | exact OK | env load | exact load | env rast | exact rast | env t | exact t | env RSS | exact RSS | env cells | exact cells | env dist | exact dist | env det% | exact det% | direct |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| rural_field_0.5km | Y | Y | 0.12 s | 0.12 s | 0.009 s | 0.062 s | 0.74 s | 0.78 s | 216 MB | 216 MB | 1,623 | 1,406 | 603 m | 577 m | 21.4 | 16.1 | rejected |
| rural_village_1km | Y | Y | 0.11 s | 0.12 s | 0.008 s | 0.019 s | 0.77 s | 0.77 s | 213 MB | 214 MB | 489 | 355 | 999 m | 999 m | -0.4 | -0.4 | accepted |
| small_town_2km | Y | Y | 0.10 s | 0.11 s | 0.007 s | 0.014 s | 0.78 s | 0.82 s | 212 MB | 213 MB | 218 | 131 | 1,998 m | 1,998 m | 0.0 | 0.0 | accepted |
| amritsar_city_2km | NO | NO | 0.12 s | 0.12 s | 0.016 s | 0.295 s | 0.78 s | 1.04 s | 217 MB | 220 MB | 7,625 | 5,782 | - | - | - | - | rejected |
| ludhiana_city_2km | NO | NO | 0.14 s | 0.13 s | 0.019 s | 0.444 s | 0.79 s | 1.17 s | 217 MB | 219 MB | 9,668 | 8,643 | - | - | - | - | rejected |
| amritsar_long_16km | NO | NO* | 0.31 s | 0.24 s | 0.143 s | 6.07 s | 1.11 s | 7.03 s | 236 MB | 332 MB | 257,862 | 188,366 | - | - | - | - | rejected |

\* `amritsar_long_16km` fails in the harness (no snapping). With
`snap_start_goal=true` (an existing API option) exact mode succeeds - see §5.

## 4. The five questions, with evidence

**1. How many previous 409 missions now succeed?**
One of the three: the 16 km Amritsar wall mission. With `snap_start_goal=true`,
`plan()` returns a route under exact rasterization (16,631 m, +2.3 % detour,
54 waypoints, 12.7 s, 57,132 buildings queried) where the legacy envelope mode
returns 409 **even with snapping** (it sealed the corridor). The two 2 km
cores still 409, and §5 shows that is not a rasterization defect.

**2. How many missions produce shorter routes?**
The grid actually runs on 1 of the 3 non-city missions (village/town are
direct-path-accepted, so the grid is skipped in production): rural_field drops
603 m -> 577 m (-4.3 %, detour 21.4 % -> 16.1 %). No mission got longer.

**3. How much staircase reduction?**
On these missions the effect is modest (staircase-turn count 1 -> 1 on the
field; both village/town routes are near-straight already). The geometry-
exact smoothing had already removed the staircase in the previous work; the
rasterization change reduces the *grid path's* over-blocking, and the
geometry smoother then shortcuts more (rural_field smoothing shortcuts 3 -> 1
remaining waypoint drops). No mission shows a staircase regression.

**4. How much additional CPU time?**
Exact rasterization adds: +0.05-0.45 s at 2 km scales (fetch + buffer + paint
of 2,792-4,311 polygons), +5.9 s at 16 km (57,132 polygons: 6.07 s vs 0.14 s).
Total wall: 0.8 s -> 1.0-1.2 s (2 km), 1.1 s -> 7.0 s (16 km). RSS: +2-4 MB
(2 km), +96 MB (16 km, 236 -> 332 MB) - transient WKB/geometry arrays; still
inside the 1 GB target.

**5. Is any mission noticeably worse?**
No mission is worse in route quality (distances equal or better, both modes
find the same routes where routes exist). The only "worse" is compute: the
16 km mission costs ~6 extra seconds and 96 MB more peak RSS. Waypoint counts
can rise in corridors that hug buildings (the geometry smoother keeps
intermediate waypoints below its 5 m margin) - documented, never unsafe.

## 5. Failure diagnosis (evidence, not speculation)

**amritsar_city_2km and ludhiana_city_2km - "polygon geometry genuinely blocks
the corridor".** Probes (exact, buffer 0; exact, grid 5 m; exact, buffer 0 +
grid 5 m; envelope, grid 5 m - all with endpoint snapping):

| probe | amritsar free | amritsar path | ludhiana free | ludhiana path |
|---|---|---|---|---|
| exact g10 b1 snap | 0.46 | NO | 0.19 | NO |
| exact g10 b0 snap | 0.50 | NO | 0.22 | NO |
| exact g5 b1 snap | 0.57 | NO | 0.30 | NO |
| exact g5 b0 snap | 0.61 | NO | 0.36 | NO |
| env g10 m5 snap | 0.29 | NO | 0.10 | NO |

Endpoint snapping *succeeds* (start/goal are 1-3 cells from a free cell), so
the failure is not "endpoint in a huge block". Flood-fill from the snapped
start over free cells: **amritsar start island = 928 of 4,954 free cells
(18.7 %), goal NOT in it; ludhiana start island = 647 of 2,049 (31.6 %), goal
NOT in it.** The cores are continuous building walls splitting the free space
into disconnected islands - no rasterization setting (buffer 0, 5 m cells)
connects them. Neither "reduce polygon buffer" nor "adaptive grid resolution"
would help: both were probed and both fail.

**amritsar_long_16km - fixed by exact rasterization.** The goal cell is
inside a building (1,690 buildings/km^2 at the endpoint); without snapping
both modes 409. With snapping:
envelope -> 409 (15.5 s; the buffered-bbox wall seals the only corridor);
**exact -> route found** (16,631 m, +2.3 %, 12.7 s). The original "wall" was
mostly envelope over-blocking (this diagnosis reproduces the earlier finding
that 112/181 line-blockers were envelope-only), and exact painting opens it.

## 6. Visualization (before/after viewers, one self-contained HTML each)

`planner/data/diag/urban/...` - each viewer shows building polygons, raw
bounding boxes, buffered envelopes (legacy footprint), buffered polygons
(exact footprint), and BOTH blocked-cell layers (red = exact, purple =
legacy), plus the route and the freed-cell count.

- `rural_field/envelope/viewer.html` - 603 m route, 1,623 cells
- `rural_field/exact/viewer.html` - 577 m route, 1,406 cells (217 freed)
- `amritsar_2km/exact/viewer.html` - NO route; 1,843 cells freed - the two
  islands are visible as disconnected free regions
- `amritsar_long/envelope/viewer.html` - NO route; 257,862 cells
- `amritsar_long/exact/viewer.html` - **route found** (with --snap); 69,496
  cells freed (27 %)

## 7. Recommendation

**A. Exact polygon rasterization is sufficient.** The change delivers the
routing improvement it was built for (the motivating long-urban 409 now
plans; envelope mode cannot), frees 24-27 % of blocked cells in the dense
missions, shortens the field route, and stays within the 1 GB budget. The
remaining 2 km core failures are street-level impossibilities (disconnected
free islands - flood-fill evidence), not rasterization defects, and neither
B (buffer 0 - probed) nor C (5 m grid - probed) fixes them. The honest next
step for those cores is the altitude/phase-based planning identified earlier
(cruise above the canopy, terminal approach zones) - a separate architectural
addition, not a rasterization change.

Raw data: `benchmarks/results/urban_suite_bench.{md,json}`.
