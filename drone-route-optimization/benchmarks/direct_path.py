"""Benchmark: full grid pipeline vs the direct-line fast path.

Two ways to run:

1. One scenario in one subprocess (RSS-isolated, like ``scenario.py``):

       python -m benchmarks.direct_path --variant grid --parquet punjab_buildings.parquet \\
           --start-lat 30.7500 --start-lon 75.6000 \\
           --goal-lat 30.7545 --goal-lon 75.6071

       python -m benchmarks.direct_path --variant fastpath --parquet ...  (same points)
       python -m benchmarks.direct_path --variant check    --parquet ...  (check only)

   ``grid``     - the pre-fast-path pipeline (region load -> rasterize -> A*
                  -> LOS smooth -> waypoints), recreated via planner internals.
   ``fastpath`` - ``RoutePlanner.plan()``: the check first, grid only when the
                  straight line is blocked.
   ``check``    - just ``is_direct_path_clear`` (used by the driver to search
                  for an accepted mission cheaply).

2. Driver across 500 m / 1 km / 2 km / 5 km / 20 km:

       python -m benchmarks.direct_path --all --parquet punjab_buildings.parquet

   For each size the driver searches for a straight line the fast path
   ACCEPTS (open terrain), then runs both variants on that exact mission, so
   each row honestly compares "what the old planner did" vs "what plan()
   does now" on identical geometry.  Writes a markdown table and raw JSON to
   ``benchmarks/results/direct_path_bench.{md,json}``.

Peak RSS is ``ru_maxrss`` per isolated subprocess - the only way to get
honest RAM numbers with DuckDB around.
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
from planner.routing.direct_path import is_direct_path_clear  # noqa: E402
from planner.routing.obstacles import (  # noqa: E402
    BuildingsSource,
    NoFlySource,
    WaterSource,
)
from planner.routing.planner import RoutePlanner  # noqa: E402

SIZES_M = (500, 1_000, 2_000, 5_000, 20_000)
#: deterministic candidate offsets (angle degrees) searched per size
ANGLES = tuple(float(a) for a in range(0, 360, 30))
#: rural/suburban Punjab - the research-benchmark centre where every box
#: size plans successfully (central Ludhiana is too dense: even the grid
#: returns 409 there, which would pollute the comparison)
ANCHOR = (30.7500, 75.6000)


def _settings(parquet: str) -> Settings:
    cfg = Settings.from_env()
    return dataclasses.replace(cfg, buildings_parquet=parquet)


def _run_grid_variant(cfg: Settings, start, goal) -> dict:
    """Replicate the pre-fast-path pipeline via planner internals.

    This is benchmark harness code only: it mirrors what ``plan()`` did
    before the fast path existed, so the comparison is apples-to-apples.
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
        planner.find_path(start, goal, snap=False)
        planner.smooth_path()
        wps = planner.generate_waypoints()
        # the geometry-exact shortcut pass is part of the current planner;
        # include it in BOTH variants so the only difference measured is the
        # direct-line fast path
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


def _run_fastpath_variant(cfg: Settings, start, goal) -> dict:
    t_wall0 = time.perf_counter()
    t_cpu0 = time.process_time()
    planner = RoutePlanner(cfg)
    out: dict = {}
    try:
        result = planner.plan(start=start, goal=goal, mission_id="bench")
        out = {
            "path_found": True,
            "direct_path": bool(result.stats.direct_path),
            "buildings_queried": result.stats.buildings_queried,
            "waypoint_count": len(result.waypoints),
            "distance_m": result.distance,
        }
    except Exception as exc:  # noqa: BLE001
        out = {"path_found": False, "error": str(exc)[:200]}
    finally:
        planner.close()
    out["wall_s"] = round(time.perf_counter() - t_wall0, 4)
    out["cpu_s"] = round(time.process_time() - t_cpu0, 4)
    return out


def _run_check(cfg: Settings, start, goal) -> dict:
    planner = RoutePlanner(cfg)
    try:
        res = is_direct_path_clear(planner.con, cfg, start, goal, list(cfg.obstacle_rings))
        return {
            "accepted": bool(res.clear),
            "check_time_s": round(res.check_time_s, 4),
            "building_hit": res.building_hit,
            "water_hit": res.water_hit,
            "no_fly_hit": res.no_fly_hit,
        }
    finally:
        planner.close()


def _offset(lat: float, lon: float, size_m: float, angle_deg: float):
    """Point at ``size_m`` from (lat, lon) bearing ``angle_deg`` (0 = east)."""
    rad = math.radians(angle_deg)
    dlat = size_m * math.sin(rad) / 111_320.0
    dlon = size_m * math.cos(rad) / (111_320.0 * math.cos(math.radians(lat)))
    return (lat + dlat, lon + dlon)


def run_scenario(args) -> dict:
    cfg = _settings(args.parquet)
    start = (args.start_lat, args.start_lon)
    goal = (args.goal_lat, args.goal_lon)
    base_rss = peak_rss_kb()
    out: dict = {"variant": args.variant, "start": start, "goal": goal}
    if args.variant == "grid":
        out.update(_run_grid_variant(cfg, start, goal))
    elif args.variant == "fastpath":
        out.update(_run_fastpath_variant(cfg, start, goal))
    else:
        out.update(_run_check(cfg, start, goal))
    # ru_maxrss is the process high-water mark: read it AFTER the variant runs
    out["base_rss_mb"] = round(base_rss / 1024.0, 1)
    out["peak_rss_mb"] = round(peak_rss_kb() / 1024.0, 1)
    out["rss_delta_mb"] = round((peak_rss_kb() - base_rss) / 1024.0, 1)
    return out


def _spawn(repo_root: Path, args: list[str], timeout_s: int = 300) -> dict:
    cmd = [sys.executable, "-m", "benchmarks.direct_path", *args]
    proc = subprocess.run(
        cmd, cwd=repo_root, capture_output=True, text=True, timeout=timeout_s
    )
    if proc.returncode != 0:
        raise RuntimeError(f"subprocess failed: {' '.join(cmd)}\n{proc.stderr[-800:]}")
    return json.loads(proc.stdout.strip().splitlines()[-1])


def run_driver(parquet: str) -> None:
    repo_root = Path(__file__).resolve().parent.parent
    results: list[dict] = []
    for size in SIZES_M:
        # 1) find a mission the fast path accepts (open terrain), cheap check
        mission: tuple | None = None
        for angle in ANGLES:
            goal = _offset(*ANCHOR, size, angle)
            check = _spawn(
                repo_root,
                [
                    "--variant", "check", "--parquet", parquet,
                    "--start-lat", str(ANCHOR[0]), "--start-lon", str(ANCHOR[1]),
                    "--goal-lat", f"{goal[0]:.6f}", "--goal-lon", f"{goal[1]:.6f}",
                ],
            )
            if check["accepted"]:
                mission = (goal, angle, check)
                break
            if mission is None:
                mission = (goal, angle, check)  # remember the first tried
        goal, angle, check = mission
        print(
            f"  size {size:>6} m  bearing {angle:>4.0f} deg  "
            f"direct={ 'ACCEPTED' if check['accepted'] else 'rejected' } "
            f"(check {check['check_time_s']:.3f} s)",
            flush=True,
        )

        # 2) run both variants on the identical mission
        common = [
            "--parquet", parquet,
            "--start-lat", str(ANCHOR[0]), "--start-lon", str(ANCHOR[1]),
            "--goal-lat", f"{goal[0]:.6f}", "--goal-lon", f"{goal[1]:.6f}",
        ]
        grid = _spawn(repo_root, ["--variant", "grid", *common], timeout_s=600)
        fast = _spawn(repo_root, ["--variant", "fastpath", *common], timeout_s=600)
        # a rejected direct line whose grid also fails is a dead end for the
        # comparison (e.g. 20 km across dense terrain at 10 m cells): search
        # on for a mission both variants can actually plan
        tries = 0
        while not grid["path_found"] and tries < len(ANGLES):
            angle = (angle + 30.0) % 360.0
            goal = _offset(*ANCHOR, size, angle)
            common = [
                "--parquet", parquet,
                "--start-lat", str(ANCHOR[0]), "--start-lon", str(ANCHOR[1]),
                "--goal-lat", f"{goal[0]:.6f}", "--goal-lon", f"{goal[1]:.6f}",
            ]
            check = _spawn(
                repo_root,
                ["--variant", "check", *common],
            )
            grid = _spawn(repo_root, ["--variant", "grid", *common], timeout_s=600)
            fast = _spawn(repo_root, ["--variant", "fastpath", *common], timeout_s=600)
            tries += 1
            print(
                f"    -> retry bearing {angle:>4.0f} deg  "
                f"direct={'ACCEPTED' if check['accepted'] else 'rejected'} "
                f"grid_path={'yes' if grid['path_found'] else 'no'}",
                flush=True,
            )
        results.append(
            {
                "size_m": size,
                "bearing_deg": angle,
                "direct_accepted": check["accepted"],
                "check_time_s": check["check_time_s"],
                "grid": grid,
                "fastpath": fast,
            }
        )

    _emit(results, repo_root / "benchmarks" / "results")


def _emit(results: list[dict], out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "direct_path_bench.json").write_text(json.dumps(results, indent=2))

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
        g, f = r["grid"], r["fastpath"]
        speedup = (g["wall_s"] / f["wall_s"]) if f["wall_s"] else float("nan")
        rows.append(
            f"| {r['size_m'] / 1000:g} km | "
            f"{'yes' if r['direct_accepted'] else 'no'} | "
            f"{g['wall_s']:.2f} s | {f['wall_s']:.2f} s | "
            f"{speedup:.2f}x | "
            f"{g['cpu_s']:.2f} s | {f['cpu_s']:.2f} s | "
            f"{g['peak_rss_mb']:.0f} MB | {f['peak_rss_mb']:.0f} MB | "
            f"{_cell(g, 'waypoint_count')} | {_cell(f, 'waypoint_count')} | "
            f"{_dist(g)} | {_dist(f)} | "
            f"{g.get('buildings_queried', '-')} | "
            f"{f.get('buildings_queried', '-')}\n"
        )
    header = (
        "| box | direct | grid t | fast t | speedup | grid CPU | fast CPU | "
        "grid RSS | fast RSS | grid wps | fast wps | grid dist | fast dist | "
        "grid bldg | fast bldg |\n"
        "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n"
    )
    md = (
        "# Direct-line fast path benchmark (real Punjab data)\n\n"
        "One mission per box size (anchor 30.7500, 75.6000, bearings every "
        "30 deg until a planable one is found). `direct=yes` means the fast "
        "path accepted the straight line. `grid` = the pre-fast-path pipeline "
        "recreated via planner internals; `fast` = `RoutePlanner.plan()` with "
        "the fast path integrated. Peak RSS is `ru_maxrss` per isolated "
        "subprocess. water_parquet not configured.\n\n"
        + header
        + "".join(rows)
    )
    (out_dir / "direct_path_bench.md").write_text(md)
    print("\n" + md)
    print(f"saved -> {out_dir / 'direct_path_bench.md'}")


def main() -> None:
    ap = argparse.ArgumentParser(description="Direct-line fast path benchmark")
    ap.add_argument("--variant", choices=["grid", "fastpath", "check"])
    ap.add_argument("--parquet", default="punjab_buildings.parquet")
    ap.add_argument("--start-lat", type=float)
    ap.add_argument("--start-lon", type=float)
    ap.add_argument("--goal-lat", type=float)
    ap.add_argument("--goal-lon", type=float)
    ap.add_argument("--all", action="store_true", help="driver: all box sizes")
    args = ap.parse_args()

    if args.all:
        run_driver(args.parquet)
        return
    if args.variant is None or any(
        v is None for v in (args.start_lat, args.start_lon, args.goal_lat, args.goal_lon)
    ):
        ap.error("need --variant plus start/goal, or --all")
    print(json.dumps(run_scenario(args)))


if __name__ == "__main__":
    main()
