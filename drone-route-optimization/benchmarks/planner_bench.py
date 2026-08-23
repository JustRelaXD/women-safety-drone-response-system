"""Phase 6: benchmark the full route planner across mission box sizes.

    uv run python -m benchmarks.planner_bench \
        --parquet punjab_buildings.parquet --center 30.9010,75.8573

Each size runs in a fresh subprocess (isolated peak RSS).  Reports per size:
planning wall/CPU time, peak RSS, buildings queried, waypoint count, grid
dims, nodes explored, path length.  Results go to benchmarks/results/.
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


def run_size(parquet: str, lat: float, lon: float, size: int) -> dict:
    cmd = [
        sys.executable,
        "-m",
        "benchmarks.planner_scenario",
        "--parquet",
        parquet,
        "--lat",
        str(lat),
        "--lon",
        str(lon),
        "--size",
        str(size),
    ]
    t0 = time.perf_counter()
    proc = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
    wall = time.perf_counter() - t0
    if proc.returncode != 0:
        print(proc.stderr[-3000:], file=sys.stderr)
        raise RuntimeError(f"scenario {size}m failed rc={proc.returncode}")
    data = json.loads(proc.stdout.strip().splitlines()[-1])
    if "error" in data:
        raise RuntimeError(f"scenario {size}m: {data['error']}")
    data["total_wall_s"] = round(wall, 1)
    return data


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--parquet", default="punjab_buildings.parquet")
    ap.add_argument("--center", default="30.9010,75.8573")
    ap.add_argument("--sizes", default=",".join(str(s) for s in SIZES))
    args = ap.parse_args()
    lat, lon = (float(v) for v in args.center.split(","))
    sizes = [int(v) for v in args.sizes.split(",")]

    RESULTS_DIR.mkdir(exist_ok=True)
    rows = []
    for size in sizes:
        print(f"== benchmark {size} m box ...", flush=True)
        rows.append(run_size(args.parquet, lat, lon, size))

    df = pd.DataFrame(rows)
    show = df[
        [
            "size_m",
            "planning_wall_s",
            "planning_cpu_s",
            "peak_rss_mb",
            "buildings_queried",
            "water_queried",
            "waypoints",
            "distance_m",
            "straight_line_m",
            "grid_dims",
            "cell_size_m",
            "nodes_explored",
            "path_cells",
            "total_wall_s",
        ]
    ]
    print("\n" + "=" * 110)
    print("PHASE 6: ROUTE PLANNER BENCHMARK (center", args.center, ")")
    print("=" * 110)
    print(show.to_string(index=False))
    print("=" * 110)

    out_path = RESULTS_DIR / f"planner_bench_{args.center.replace(',', '_')}.csv"
    df.to_csv(out_path, index=False)
    print(f"saved raw results to {out_path}")


if __name__ == "__main__":
    main()
