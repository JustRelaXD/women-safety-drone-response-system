"""Realistic-mission suite: legacy buffered-bbox vs exact-polygon rasterization.

Runs a fixed set of REAL Punjab missions (fixed start/goal coordinates, chosen
from measured building density) through both rasterization modes and reports
phase-level metrics, so the rasterization change can be judged on realistic
routing problems - not synthetic scenes.

Missions
--------
1. rural_field_0.5km  - open farmland, ~20 buildings / km^2
2. rural_village_1km  - a village cluster, ~480 buildings / km^2
3. small_town_2km     - a small town, ~480 buildings / km^2 (density dips)
4. amritsar_city_2km  - Amritsar core, ~2,800 buildings / km^2
5. ludhiana_city_2km  - Ludhiana core, ~6,000 buildings / km^2 (densest)
6. amritsar_long_16km - the original 409 "wall" mission (16 km, city-to-city)

Each mission runs in an isolated subprocess per variant (``envelope`` =
rasterize_exact_polygons=False, ``exact`` = True) so ``ru_maxrss`` is honest.
The harness mirrors plan()'s grid pipeline with per-phase timers, so the
report splits DuckDB load / rasterization / search / geometry smoothing.

Usage::

    python -m benchmarks.urban_suite --mission amritsar_city_2km --variant exact \\
        --parquet punjab_buildings.parquet            # one run, JSON out
    python -m benchmarks.urban_suite --all --parquet punjab_buildings.parquet

Writes ``benchmarks/results/urban_suite_bench.{md,json}``.
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import math
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from planner.core.config import Settings  # noqa: E402
from planner.core.exceptions import NoPathError  # noqa: E402
from planner.core.geometry import bbox_of_points, path_length_m  # noqa: E402
from planner.overture.memory import peak_rss_kb  # noqa: E402
from planner.overture.region import REGION_TABLE, WATER_TABLE  # noqa: E402
from planner.routing.direct_path import is_direct_path_clear  # noqa: E402
from planner.routing.obstacles import (  # noqa: E402
    BuildingsSource,
    NoFlySource,
    WaterSource,
)
from planner.routing.planner import RoutePlanner  # noqa: E402

#: name -> (start (lat, lon), goal (lat, lon), one-line description)
MISSIONS: dict[str, tuple[tuple[float, float], tuple[float, float], str]] = {
    "rural_field_0.5km": (
        (30.7500, 75.6000), (30.7500, 75.6052),
        "open farmland, ~20 bldg / km^2",
    ),
    "rural_village_1km": (
        (30.7740, 75.6000), (30.7740, 75.6105),
        "village cluster, ~480 bldg / km^2",
    ),
    "small_town_2km": (
        (30.7500, 75.5760), (30.7500, 75.5969),
        "small town, ~480 bldg / km^2",
    ),
    "amritsar_city_2km": (
        (31.6160, 74.8600), (31.6160, 74.8811),
        "Amritsar core, ~2,800 bldg / km^2",
    ),
    "ludhiana_city_2km": (
        (30.9160, 75.8480), (30.9160, 75.8689),
        "Ludhiana core, ~6,000 bldg / km^2 (densest)",
    ),
    "amritsar_long_16km": (
        (31.5079, 74.9744), (31.6137, 74.8560),
        "the original 409 'wall' mission, city-to-city",
    ),
}


def _settings(parquet: str, variant: str) -> Settings:
    cfg = Settings.from_env()
    cfg = dataclasses.replace(cfg, buildings_parquet=parquet)
    if variant == "exact":
        return dataclasses.replace(
            cfg, rasterize_exact_polygons=True, polygon_buffer_m=1.0
        )
    return dataclasses.replace(
        cfg, rasterize_exact_polygons=False, safety_margin_m=5.0
    )


def _staircase_metrics(wps: list, proj) -> dict:
    """Quantify staircase zigzags in the final waypoint polyline.

    A 'staircase turn' is an interior vertex where both adjacent segments are
    short (< 60 m) and the heading changes by >= 10 deg - i.e. a micro-zigzag
    that a straight line through open space would not have.
    """
    pts = [proj.to_local(lat, lon) for lat, lon, _ in wps]
    segs = [
        math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(pts, pts[1:])
    ]
    if len(pts) < 3:
        return {"segments": len(segs), "mean_segment_m": 0.0,
                "min_segment_m": 0.0, "micro_segments_lt40m": 0,
                "staircase_turns": 0}
    turns = 0
    for i in range(1, len(pts) - 1):
        ax, ay = pts[i - 1]
        bx, by = pts[i]
        cx, cy = pts[i + 1]
        v1 = (bx - ax, by - ay)
        v2 = (cx - bx, cy - by)
        cross = v1[0] * v2[1] - v1[1] * v2[0]
        dot = v1[0] * v2[0] + v1[1] * v2[1]
        angle = abs(math.degrees(math.atan2(cross, dot)))
        if segs[i - 1] < 60.0 and segs[i] < 60.0 and angle >= 10.0:
            turns += 1
    return {
        "segments": len(segs),
        "mean_segment_m": round(sum(segs) / len(segs), 1),
        "min_segment_m": round(min(segs), 1),
        "micro_segments_lt40m": sum(1 for s in segs if s < 40.0),
        "staircase_turns": turns,
    }


def run_mission(cfg: Settings, start, goal) -> dict:
    """Run the plan() grid pipeline with per-phase timers and counts."""
    t_wall0 = time.perf_counter()
    t_cpu0 = time.process_time()
    planner = RoutePlanner(cfg)
    out: dict = {"start": start, "goal": goal}
    try:
        # direct-path decision (real geometries only - mode independent)
        try:
            chk = is_direct_path_clear(
                planner.con, cfg, start, goal, list(cfg.obstacle_rings)
            )
            out["direct_accepted"] = bool(chk.clear)
            out["direct_check_s"] = round(chk.check_time_s, 4)
        except Exception as exc:  # noqa: BLE001
            out["direct_accepted"] = None
            out["direct_error"] = str(exc)[:120]

        bbox = bbox_of_points(
            [start, goal],
            cfg.bbox_expansion_m + cfg.safety_margin_m + cfg.grid_resolution_m,
        )
        t1 = time.perf_counter()
        stats = planner.load_region(bbox)
        out["t_duckdb_load_s"] = round(time.perf_counter() - t1, 4)
        out["buildings_queried"] = stats.buildings
        out["water_queried"] = stats.water

        sources = [BuildingsSource(planner.con, REGION_TABLE, bbox)]
        if cfg.water_parquet:
            sources.append(WaterSource(planner.con, WATER_TABLE, bbox))
        if cfg.obstacle_rings:
            sources.append(NoFlySource(list(cfg.obstacle_rings)))

        t2 = time.perf_counter()
        planner.generate_grid(bbox, sources)
        out["t_rasterize_s"] = round(time.perf_counter() - t2, 4)
        grid = planner.grid
        out["blocked_cells"] = int(grid.blocked.sum())
        out["grid_cells"] = int(grid.n_cells)
        out["free_ratio"] = round(1.0 - out["blocked_cells"] / out["grid_cells"], 4)
        out["cell_size_m"] = grid.cell_size_m

        t3 = time.perf_counter()
        planner.find_path(start, goal, snap=False)
        planner.smooth_path()
        wps = planner.generate_waypoints()
        out["waypoints_before_geo"] = len(wps)
        out["t_search_s"] = round(time.perf_counter() - t3, 4)

        t4 = time.perf_counter()
        wps = planner.smooth_waypoints_geometry(list(wps), sources)
        out["t_geosmooth_s"] = round(time.perf_counter() - t4, 4)
        out["smoothing_shortcuts"] = out["waypoints_before_geo"] - len(wps)
        out["waypoints"] = len(wps)

        distance = path_length_m([(la, lo) for la, lo, _ in wps])
        straight = path_length_m([start, goal])
        out["path_found"] = True
        out["distance_m"] = round(distance, 2)
        out["straight_m"] = round(straight, 2)
        out["detour_pct"] = round((distance / straight - 1.0) * 100.0, 2)
        out["staircase"] = _staircase_metrics(wps, grid.proj)
        out["nodes_explored"] = planner._last_nodes_explored
    except NoPathError:
        out["path_found"] = False
    except Exception as exc:  # noqa: BLE001 - data/scale errors
        out["path_found"] = False
        out["error"] = str(exc)[:200]
    finally:
        planner.close()
    out["t_total_s"] = round(time.perf_counter() - t_wall0, 4)
    out["t_cpu_s"] = round(time.process_time() - t_cpu0, 4)
    out["peak_rss_mb"] = round(peak_rss_kb() / 1024.0, 1)
    return out


def _spawn(repo_root: Path, args: list[str], timeout_s: int = 900) -> dict:
    cmd = [sys.executable, "-m", "benchmarks.urban_suite", *args]
    proc = subprocess.run(
        cmd, cwd=repo_root, capture_output=True, text=True, timeout=timeout_s
    )
    if proc.returncode != 0:
        raise RuntimeError(f"subprocess failed: {' '.join(cmd)}\n{proc.stderr[-800:]}")
    return json.loads(proc.stdout.strip().splitlines()[-1])


def run_driver(parquet: str) -> None:
    repo_root = Path(__file__).resolve().parent.parent
    results: list[dict] = []
    for name, (start, goal, note) in MISSIONS.items():
        common = [
            "--mission", name, "--parquet", parquet,
            "--start-lat", f"{start[0]:.6f}", "--start-lon", f"{start[1]:.6f}",
            "--goal-lat", f"{goal[0]:.6f}", "--goal-lon", f"{goal[1]:.6f}",
        ]
        print(f"== {name}: {note}", flush=True)
        env = _spawn(repo_root, ["--variant", "envelope", *common])
        exact = _spawn(repo_root, ["--variant", "exact", *common])
        results.append({
            "mission": name,
            "note": note,
            "start": start,
            "goal": goal,
            "envelope": env,
            "exact": exact,
        })
        print(
            f"   envelope: {'OK ' if env['path_found'] else '409'} "
            f"{env['t_total_s']:.1f} s  {env['blocked_cells']:,} cells  "
            f"detour {env.get('detour_pct', float('nan'))}%"
            f"\n   exact   : {'OK ' if exact['path_found'] else '409'} "
            f"{exact['t_total_s']:.1f} s  {exact['blocked_cells']:,} cells  "
            f"detour {exact.get('detour_pct', float('nan'))}%",
            flush=True,
        )
    _emit(results, repo_root / "benchmarks" / "results")


def _emit(results: list[dict], out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "urban_suite_bench.json").write_text(json.dumps(results, indent=2))
    # keep the phase metrics visible for failed missions too
    print("\n[phase metrics for failed missions]")
    for r in results:
        for variant in ("envelope", "exact"):
            v = r[variant]
            if not v.get("path_found"):
                print(
                    f"  {r['mission']} [{variant}]: bldg={v.get('buildings_queried')} "
                    f"cells={v.get('blocked_cells')}/{v.get('grid_cells')} "
                    f"free={v.get('free_ratio')} load={v.get('t_duckdb_load_s')}s "
                    f"rast={v.get('t_rasterize_s')}s total={v.get('t_total_s')}s "
                    f"rss={v.get('peak_rss_mb')}MB err={v.get('error')}"
                )

    def _cell(v: dict, key: str, missing="-") -> str:
        # phase/count metrics stay visible on failures (they diagnose WHY);
        # only route-dependent fields fall back to "no path"
        route_keys = {"waypoints", "distance_m", "detour_pct",
                      "smoothing_shortcuts", "t_search_s", "t_geosmooth_s"}
        if key in route_keys and not v.get("path_found"):
            return "no path"
        return str(v.get(key, missing))

    rows = []
    for r in results:
        e, x = r["envelope"], r["exact"]
        rows.append(
            f"| {r['mission']} | "
            f"{'Y' if e['path_found'] else 'NO'} | {'Y' if x['path_found'] else 'NO'} | "
            f"{_cell(e, 't_duckdb_load_s')} | {_cell(x, 't_duckdb_load_s')} | "
            f"{_cell(e, 't_rasterize_s')} | {_cell(x, 't_rasterize_s')} | "
            f"{_cell(e, 't_total_s')} | {_cell(x, 't_total_s')} | "
            f"{_cell(e, 'peak_rss_mb')} | {_cell(x, 'peak_rss_mb')} | "
            f"{_cell(e, 'buildings_queried')} | {_cell(x, 'buildings_queried')} | "
            f"{_cell(e, 'blocked_cells')} | {_cell(x, 'blocked_cells')} | "
            f"{_cell(e, 'waypoints')} | {_cell(x, 'waypoints')} | "
            f"{_cell(e, 'distance_m')} | {_cell(x, 'distance_m')} | "
            f"{_cell(e, 'detour_pct')} | {_cell(x, 'detour_pct')} | "
            f"{'accepted' if e.get('direct_accepted') else 'rejected'} | "
            f"{_cell(e, 'smoothing_shortcuts')} | {_cell(x, 'smoothing_shortcuts')} | "
            f"{e.get('staircase', {}).get('staircase_turns', '-')} | "
            f"{x.get('staircase', {}).get('staircase_turns', '-')}\n"
        )
    header = (
        "| mission | env OK | exact OK | env load | exact load | env rast | "
        "exact rast | env t | exact t | env RSS | exact RSS | env bldg | "
        "exact bldg | env cells | exact cells | env wps | exact wps | "
        "env dist | exact dist | env det% | exact det% | direct | env cut | "
        "exact cut | env stair | exact stair |\n"
        "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n"
    )
    md = (
        "# Urban mission suite: legacy vs exact rasterization (real Punjab data)\n\n"
        "Six fixed-coordinate missions chosen from measured building density "
        "(counts below are buildings / km^2 from bbox queries). `envelope` = "
        "buffered-bounding-box painting (margin 5 m), `exact` = exact polygon "
        "painting (buffer 1 m). `load` = DuckDB region load, `rast` = "
        "rasterization, `t` = total wall, `cut` = geometry-smoothing "
        "shortcuts (waypoints dropped), `stair` = staircase-turn count "
        "(short segments with >=10 deg heading changes). Direct = the "
        "direct-line fast path decision (mode-independent). Peak RSS per "
        "isolated subprocess. water_parquet not configured.\n\n"
        + header
        + "".join(rows)
    )
    (out_dir / "urban_suite_bench.md").write_text(md)
    print("\n" + md)
    print(f"saved -> {out_dir / 'urban_suite_bench.md'}")


def main() -> None:
    ap = argparse.ArgumentParser(description="Urban mission suite benchmark")
    ap.add_argument("--mission", choices=sorted(MISSIONS))
    ap.add_argument("--variant", choices=["envelope", "exact"])
    ap.add_argument("--parquet", default="punjab_buildings.parquet")
    ap.add_argument("--start-lat", type=float)
    ap.add_argument("--start-lon", type=float)
    ap.add_argument("--goal-lat", type=float)
    ap.add_argument("--goal-lon", type=float)
    ap.add_argument("--all", action="store_true", help="driver: all missions")
    args = ap.parse_args()

    if args.all:
        run_driver(args.parquet)
        return
    if args.mission is None or args.variant is None:
        ap.error("need --mission + --variant, or --all")
    if args.start_lat is not None and args.goal_lat is not None:
        start = (args.start_lat, args.start_lon)
        goal = (args.goal_lat, args.goal_lon)
    else:
        # fall back to the fixed coordinates in the MISSIONS table
        start, goal, _ = MISSIONS[args.mission]
    cfg = _settings(args.parquet, args.variant)
    print(json.dumps(run_mission(cfg, start, goal)))


if __name__ == "__main__":
    main()
