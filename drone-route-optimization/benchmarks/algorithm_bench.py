"""Pathfinding-algorithm comparison (the "which planner?" study).

    uv run python -m benchmarks.algorithm_bench \
        --parquet punjab_buildings.parquet --center 30.7500,75.6000

Runs grid A*, Theta* and the visibility graph across mission box sizes in
fresh subprocesses (isolated peak RSS).  Reports per (size, algorithm):

- planning wall / CPU time and peak RSS
- buildings queried and waypoint count
- path quality: distance vs the straight line (detour %)
- search work: nodes explored; visibility graph vertices / edges

The visibility graph is expected to be infeasible (InfeasibleError) beyond
small boxes - its O(V^2) construction is the point of the comparison, not a
bug.  Results go to benchmarks/results/algorithm_bench_<center>.csv
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
RESULTS_DIR = ROOT / "benchmarks" / "results"
SIZES = [500, 1000, 2000, 5000, 10_000, 20_000]
ALGORITHMS = ["astar", "theta_star", "visibility"]


def run_scenario(parquet: str, lat: float, lon: float, size: int, algo: str) -> dict:
    cmd = [
        sys.executable,
        "-m",
        "benchmarks.planner_scenario",
        "--parquet", parquet,
        "--lat", str(lat),
        "--lon", str(lon),
        "--size", str(size),
        "--algorithm", algo,
    ]
    t0 = time.perf_counter()
    proc = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
    wall = time.perf_counter() - t0
    if proc.returncode != 0:
        print(proc.stderr[-3000:], file=sys.stderr)
        raise RuntimeError(f"scenario {size}m/{algo} failed rc={proc.returncode}")
    data = json.loads(proc.stdout.strip().splitlines()[-1])
    data["total_wall_s"] = round(wall, 1)
    return data


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--parquet", default="punjab_buildings.parquet")
    ap.add_argument("--center", default="30.7500,75.6000")
    ap.add_argument("--sizes", default=",".join(str(s) for s in SIZES))
    ap.add_argument("--algorithms", default=",".join(ALGORITHMS))
    ap.add_argument(
        "--visibility-max-size", type=int, default=1000,
        help="visibility graph is O(V^2); run it only up to this box size "
        "(2 km measured separately: ~323 s, 483 MB)",
    )
    args = ap.parse_args()
    lat, lon = (float(v) for v in args.center.split(","))
    sizes = [int(v) for v in args.sizes.split(",")]
    algos = [a.strip() for a in args.algorithms.split(",")]

    RESULTS_DIR.mkdir(exist_ok=True)
    rows: list[dict] = []
    for size in sizes:
        for algo in algos:
            if algo == "visibility" and size > args.visibility_max_size:
                rows.append(
                    {"size_m": size, "algorithm": algo,
                     "status": "skipped (O(V^2); 2 km = 323 s, 5 km+ = hours)"}
                )
                continue
            print(f"== benchmark {size:>6} m box / {algo:>10} ...", flush=True)
            data = run_scenario(args.parquet, lat, lon, size, algo)
            if "error" in data:
                data["status"] = data["error"]
            elif "infeasible" in data:
                data["status"] = "infeasible"
            rows.append(data)

    df = pd.DataFrame(rows)
    # detour % as a path-quality metric (pd.notna: NaN is truthy in Python)
    df["detour_pct"] = df.apply(
        lambda r: round((r["distance_m"] / r["straight_line_m"] - 1.0) * 100, 1)
        if pd.notna(r.get("distance_m")) and pd.notna(r.get("straight_line_m"))
        else None,
        axis=1,
    )
    cols = [
        "size_m", "algorithm", "status", "planning_wall_s", "planning_cpu_s",
        "peak_rss_mb", "buildings_queried", "waypoints", "distance_m",
        "straight_line_m", "detour_pct", "nodes_explored", "path_cells",
        "graph_vertices", "graph_edges", "vis_build_s", "vis_search_s",
        "total_wall_s",
    ]
    show = df[[c for c in cols if c in df.columns]]
    pd.set_option("display.max_columns", None)
    pd.set_option("display.width", 200)
    print("\n" + "=" * 120)
    print("ALGORITHM COMPARISON (center", args.center, ")")
    print("=" * 120)
    print(show.to_string(index=False))
    print("=" * 120)

    out_path = RESULTS_DIR / f"algorithm_bench_{args.center.replace(',', '_')}.csv"
    df.to_csv(out_path, index=False)
    print(f"saved raw results to {out_path}")


if __name__ == "__main__":
    main()
