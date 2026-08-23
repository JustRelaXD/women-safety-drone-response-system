"""Benchmark driver: run Option A and B across box sizes, print comparison.

    uv run python -m benchmarks --parquet punjab_buildings.parquet \
        --center 30.9010,75.8573 --sizes 500,1000,2000,5000

Each (option, size) scenario runs in a fresh subprocess so peak RSS values
are comparable and isolated. Results are saved to benchmarks/results/.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RESULTS_DIR = ROOT / "benchmarks" / "results"

import pandas as pd


def run_scenario(parquet: str, option: str, size: int, lat: float, lon: float, queries: int) -> dict:
    cmd = [
        sys.executable,
        "-m",
        "benchmarks.scenario",
        "--parquet",
        parquet,
        "--option",
        option,
        "--size",
        str(size),
        "--lat",
        str(lat),
        "--lon",
        str(lon),
        "--queries",
        str(queries),
    ]
    t0 = time.perf_counter()
    proc = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
    wall = time.perf_counter() - t0
    if proc.returncode != 0:
        print(proc.stderr[-3000:], file=sys.stderr)
        raise RuntimeError(f"scenario {option}/{size}m failed with rc={proc.returncode}")
    data = json.loads(proc.stdout.strip().splitlines()[-1])
    data["wall_s"] = round(wall, 1)
    return data


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--parquet", default="punjab_buildings.parquet")
    ap.add_argument("--center", default="30.9010,75.8573", help="lat,lon")
    ap.add_argument("--sizes", default="500,1000,2000,5000")
    ap.add_argument("--options", default="A,B")
    ap.add_argument("--queries", type=int, default=200)
    args = ap.parse_args()

    lat, lon = (float(v) for v in args.center.split(","))
    sizes = [int(v) for v in args.sizes.split(",")]
    options = [v.upper() for v in args.options.split(",")]

    RESULTS_DIR.mkdir(exist_ok=True)
    rows = []
    for size in sizes:
        for option in options:
            print(f"== running Option {option}, {size} m box ...", flush=True)
            rows.append(run_scenario(args.parquet, option, size, lat, lon, args.queries))

    df = pd.DataFrame(rows)
    df["option_size"] = df["option"] + " / " + df["size_m"].astype(str) + " m"

    # Build one unified table; A and B fill different columns.
    unified = pd.DataFrame(index=df["option_size"])
    unified["cand_count"] = df["count_bbox"].fillna(df["count_region"]).values
    unified["exact_count"] = df["count_exact"].fillna(df["count_region"]).values
    unified["gdf_count"] = df["count_gdf"].fillna(df["count_region"]).values
    unified["count_or_load_s"] = df["t_count_bbox_s"].fillna(df["t_load_region_s"]).values
    unified["gdf_s"] = df["t_gdf_s"].values
    unified["idx_queries_s"] = df["t_strtree_build_s"].fillna(df["t_rtree_queries_s"]).values
    unified["avg_q_ms"] = df["avg_strtree_query_ms"].fillna(df["avg_rtree_query_ms"]).values
    unified["duckdb_mem"] = df["duckdb_mem"]
    unified["peak_rss_MB"] = df["peak_rss_mb"].values
    unified["rss_delta_MB"] = df["rss_delta_mb"].values

    print("\n" + "=" * 100)
    print("BENCHMARK SUMMARY  (center", args.center, "- queries per scenario:", args.queries, ")")
    print("=" * 100)
    print(unified.to_string())
    print("=" * 100)

    out_path = RESULTS_DIR / f"benchmark_{args.center.replace(',', '_')}.csv"
    df.to_csv(out_path, index=False)
    print(f"\nsaved raw results to {out_path}")


if __name__ == "__main__":
    main()
