"""Benchmark: buffered-bounding-box vs exact-polygon building rasterization.

The exact-polygon rasterizer (``rasterize_exact_polygons=True``) paints only
the cells whose rectangles intersect buffer(footprint, polygon_buffer_m)
instead of every cell in the buffered bounding box.  This benchmark measures
what that actually buys on real Punjab data, on identical missions.

Two ways to run:

1. One mission in one subprocess (RSS-isolated):

       python -m benchmarks.raster_mode --variant envelope --parquet punjab_buildings.parquet \\
           --start-lat 30.7500 --start-lon 75.6000 --goal-lat 30.7545 --goal-lon 75.6071

       python -m benchmarks.raster_mode --variant exact --parquet ...  (same points)

   ``envelope`` - legacy buffered-bounding-box rasterization (margin 5 m).
   ``exact``    - exact polygon rasterization (polygon buffer 1 m).
   Both run the same pipeline afterwards (A* -> LOS smooth -> waypoints ->
   geometry-exact smoothing), so the only difference measured is the paint.

2. Driver across 500 m / 1 km / 2 km / 5 km / 20 km:

       python -m benchmarks.raster_mode --all --parquet punjab_buildings.parquet

   For each box size the driver sweeps bearings (0..330 deg) from the anchor,
   running the envelope variant first.  It stops at the first mission where
   at least one variant plans, then runs the other variant on that exact
   mission, so each row compares both rasterizers on identical geometry.
   Missions where envelope fails but exact succeeds are the headline result
   (a no-path -> path flip).  Sweep success counts and no-path failures are
   also reported per size.  Writes markdown + raw JSON to
   ``benchmarks/results/raster_mode_bench.{md,json}``.

Peak RSS is ``ru_maxrss`` per isolated subprocess (the only honest RAM
numbers with DuckDB around).  ``--max-angles`` caps the sweep (driver only).
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
from planner.core.geometry import bbox_of_points, path_length_m  # noqa: E402
from planner.overture.memory import peak_rss_kb  # noqa: E402
from planner.overture.region import REGION_TABLE, WATER_TABLE  # noqa: E402
from planner.routing.obstacles import (  # noqa: E402
    BuildingsSource,
    NoFlySource,
    WaterSource,
)
from planner.routing.planner import RoutePlanner  # noqa: E402

SIZES_M = (500, 1_000, 2_000, 5_000, 20_000)
#: deterministic candidate bearings (degrees) searched per size
ANGLES = tuple(float(a) for a in range(0, 360, 30))
#: rural/suburban Punjab anchor (the research-benchmark centre where every
#: box size has a planable mission)
ANCHOR = (30.7500, 75.6000)


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


def _run_variant(cfg: Settings, start, goal) -> dict:
    """Replicate the plan() grid pipeline via planner internals.

    Both variants run the identical pipeline (region load -> rasterize ->
    A* -> LOS smooth -> waypoints -> geometry smoothing); the only difference
    is how the obstacle cells were painted.
    """
    t_wall0 = time.perf_counter()
    t_cpu0 = time.process_time()
    bbox = bbox_of_points(
        [start, goal],
        cfg.bbox_expansion_m + cfg.safety_margin_m + cfg.grid_resolution_m,
    )
    planner = RoutePlanner(cfg)
    out: dict = {}
    try:
        stats = planner.load_region(bbox)
        out["buildings_queried"] = stats.buildings
        sources = [BuildingsSource(planner.con, REGION_TABLE, bbox)]
        if cfg.water_parquet:
            sources.append(WaterSource(planner.con, WATER_TABLE, bbox))
        if cfg.obstacle_rings:
            sources.append(NoFlySource(list(cfg.obstacle_rings)))
        planner.generate_grid(bbox, sources)
        out["blocked_cells"] = int(planner.grid.blocked.sum())
        out["grid_cells"] = int(planner.grid.n_cells)
        planner.find_path(start, goal, snap=False)
        planner.smooth_path()
        wps = planner.generate_waypoints()
        # the geometry-exact shortcut pass is part of the current planner;
        # include it in BOTH variants so the only difference measured is the
        # rasterization mode
        wps = planner.smooth_waypoints_geometry(list(wps), sources)
        out.update(
            {
                "path_found": True,
                "waypoint_count": len(wps),
                "distance_m": round(path_length_m([(la, lo) for la, lo, _ in wps]), 2),
            }
        )
    except Exception as exc:  # noqa: BLE001 - NoPathError etc. are data
        out["path_found"] = False
        out["error"] = str(exc)[:200]
    finally:
        planner.close()
    out["wall_s"] = round(time.perf_counter() - t_wall0, 4)
    out["cpu_s"] = round(time.process_time() - t_cpu0, 4)
    return out


def _offset(lat: float, lon: float, size_m: float, angle_deg: float):
    """Point at ``size_m`` from (lat, lon) bearing ``angle_deg`` (0 = east)."""
    rad = math.radians(angle_deg)
    dlat = size_m * math.sin(rad) / 111_320.0
    dlon = size_m * math.cos(rad) / (111_320.0 * math.cos(math.radians(lat)))
    return (lat + dlat, lon + dlon)


def run_scenario(args) -> dict:
    cfg = _settings(args.parquet, args.variant)
    start = (args.start_lat, args.start_lon)
    goal = (args.goal_lat, args.goal_lon)
    base_rss = peak_rss_kb()
    out: dict = {"variant": args.variant, "start": start, "goal": goal}
    out.update(_run_variant(cfg, start, goal))
    out["base_rss_mb"] = round(base_rss / 1024.0, 1)
    out["peak_rss_mb"] = round(peak_rss_kb() / 1024.0, 1)
    out["rss_delta_mb"] = round((peak_rss_kb() - base_rss) / 1024.0, 1)
    return out


def _spawn(repo_root: Path, args: list[str], timeout_s: int = 600) -> dict:
    cmd = [sys.executable, "-m", "benchmarks.raster_mode", *args]
    proc = subprocess.run(
        cmd, cwd=repo_root, capture_output=True, text=True, timeout=timeout_s
    )
    if proc.returncode != 0:
        raise RuntimeError(f"subprocess failed: {' '.join(cmd)}\n{proc.stderr[-800:]}")
    return json.loads(proc.stdout.strip().splitlines()[-1])


def run_driver(parquet: str, max_angles: int | None = None) -> None:
    repo_root = Path(__file__).resolve().parent.parent
    angles = ANGLES[:max_angles] if max_angles else ANGLES
    results: list[dict] = []
    for size in SIZES_M:
        tried: list[dict] = []
        chosen: dict | None = None
        for angle in angles:
            goal = _offset(*ANCHOR, size, angle)
            common = [
                "--parquet", parquet,
                "--start-lat", str(ANCHOR[0]), "--start-lon", str(ANCHOR[1]),
                "--goal-lat", f"{goal[0]:.6f}", "--goal-lon", f"{goal[1]:.6f}",
            ]
            env = _spawn(repo_root, ["--variant", "envelope", *common])
            record: dict = {"bearing_deg": angle, "envelope": env}
            if env["path_found"]:
                record["exact"] = _spawn(repo_root, ["--variant", "exact", *common])
            else:
                exact = _spawn(repo_root, ["--variant", "exact", *common])
                record["exact"] = exact
                if not exact["path_found"]:
                    record["both_failed"] = True
            tried.append(record)
            print(
                f"  size {size:>6} m  bearing {angle:>4.0f} deg  "
                f"envelope={'path' if env['path_found'] else 'NO PATH'}  "
                f"exact={'path' if record['exact']['path_found'] else 'NO PATH'}  "
                f"(env {env['wall_s']:.1f} s)",
                flush=True,
            )
            if env["path_found"] or record["exact"]["path_found"]:
                chosen = record
                break
        if chosen is None and tried:
            chosen = tried[-1]
        results.append(
            {
                "size_m": size,
                "angles_tried": [r["bearing_deg"] for r in tried],
                "envelope_success": sum(
                    1 for r in tried if r["envelope"]["path_found"]
                ),
                "exact_success": sum(
                    1 for r in tried if r["exact"]["path_found"]
                ),
                "no_path_both": sum(1 for r in tried if r.get("both_failed")),
                "envelope_path_flip_to_exact": sum(
                    1 for r in tried
                    if not r["envelope"]["path_found"] and r["exact"]["path_found"]
                ),
                "chosen": chosen,
            }
        )

    _emit(results, repo_root / "benchmarks" / "results")


def _emit(results: list[dict], out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "raster_mode_bench.json").write_text(json.dumps(results, indent=2))

    def _cell(v: dict, key: str, missing="-") -> str:
        if not v.get("path_found"):
            return "no path"
        return str(v.get(key, missing))

    def _dist(v: dict) -> str:
        if not v.get("path_found"):
            return "no path"
        return f"{v.get('distance_m', 0) / 1000:.2f} km"

    rows = []
    for r in results:
        chosen = r.get("chosen") or {}
        e: dict = chosen.get("envelope") or {}
        x: dict = chosen.get("exact") or {}
        rows.append(
            f"| {r['size_m'] / 1000:g} km | "
            f"{r['chosen']['bearing_deg']:>4.0f} | "
            f"{'yes' if e['path_found'] else 'NO'} | {'yes' if x['path_found'] else 'NO'} | "
            f"{e['wall_s']:.2f} s | {x['wall_s']:.2f} s | "
            f"{e['cpu_s']:.2f} s | {x['cpu_s']:.2f} s | "
            f"{e['peak_rss_mb']:.0f} MB | {x['peak_rss_mb']:.0f} MB | "
            f"{_cell(e, 'blocked_cells')} | {_cell(x, 'blocked_cells')} | "
            f"{e.get('blocked_cells', 0) - x.get('blocked_cells', 0)} | "
            f"{_cell(e, 'waypoint_count')} | {_cell(x, 'waypoint_count')} | "
            f"{_dist(e)} | {_dist(x)} | "
            f"{r['envelope_success']}/{len(r['angles_tried'])} | "
            f"{r['exact_success']}/{len(r['angles_tried'])} | "
            f"{r['envelope_path_flip_to_exact']}\n"
        )
    header = (
        "| box | bearing | env path | exact path | env t | exact t | env CPU | "
        "exact CPU | env RSS | exact RSS | env blocked | exact blocked | freed | "
        "env wps | exact wps | env dist | exact dist | env ok/tr | exact ok/tr | "
        "no-path->path flips |\n"
        "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n"
    )
    md = (
        "# Rasterization benchmark: buffered bbox vs exact polygon (real Punjab data)\n\n"
        "One mission per box size (anchor 30.7500, 75.6000; bearings swept every "
        "30 deg, first mission where at least one variant plans). `envelope` = "
        "legacy buffered-bounding-box painting (margin 5 m); `exact` = exact "
        "polygon painting (buffer 1 m). Both run the identical A* pipeline "
        "afterwards. `freed` = envelope blocked cells - exact blocked cells "
        "(positive means exact paints less). `env ok/tr` / `exact ok/tr` = "
        "planable missions over bearings tried; `no-path->path flips` = missions "
        "where envelope had NO path but exact found one. Wall and CPU times per "
        "isolated subprocess; peak RSS is `ru_maxrss`. water_parquet not "
        "configured.\n\n"
        + header
        + "".join(rows)
    )
    (out_dir / "raster_mode_bench.md").write_text(md)
    print("\n" + md)
    print(f"saved -> {out_dir / 'raster_mode_bench.md'}")


def main() -> None:
    ap = argparse.ArgumentParser(description="Rasterization mode benchmark")
    ap.add_argument("--variant", choices=["envelope", "exact"])
    ap.add_argument("--parquet", default="punjab_buildings.parquet")
    ap.add_argument("--start-lat", type=float)
    ap.add_argument("--start-lon", type=float)
    ap.add_argument("--goal-lat", type=float)
    ap.add_argument("--goal-lon", type=float)
    ap.add_argument("--all", action="store_true", help="driver: all box sizes")
    ap.add_argument("--max-angles", type=int, default=None,
                    help="cap the bearing sweep (driver only)")
    args = ap.parse_args()

    if args.all:
        run_driver(args.parquet, max_angles=args.max_angles)
        return
    if args.variant is None or any(
        v is None for v in (args.start_lat, args.start_lon, args.goal_lat, args.goal_lon)
    ):
        ap.error("need --variant plus start/goal, or --all")
    print(json.dumps(run_scenario(args)))


if __name__ == "__main__":
    main()
