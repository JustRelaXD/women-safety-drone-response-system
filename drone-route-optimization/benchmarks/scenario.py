"""Run one benchmark scenario in a fresh subprocess and emit a JSON result.

Usage:
    python -m benchmarks.scenario --parquet punjab_buildings.parquet \
        --option A --size 500 --lat 30.9010 --lon 75.8573 --queries 200

Each scenario runs in its own process so ``ru_maxrss`` is the honest peak
RSS of that scenario alone (subprocess isolation is what makes the RAM
numbers comparable).

Option A: bbox pushdown count -> exact count -> GeoDataFrame -> STRtree
Option B: load region table + RTREE index -> indexed ST_Intersects queries
"""

from __future__ import annotations

import argparse
import json
import random
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from planner.overture import query as geoquery
from planner.overture import region as region_mod
from planner.overture.memory import peak_rss_kb


def timed(fn):
    t0 = time.perf_counter()
    result = fn()
    return result, time.perf_counter() - t0


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--parquet", required=True)
    ap.add_argument("--option", choices=["A", "B"], required=True)
    ap.add_argument("--size", type=int, required=True, help="box side in meters")
    ap.add_argument("--lat", type=float, required=True)
    ap.add_argument("--lon", type=float, required=True)
    ap.add_argument("--queries", type=int, default=200)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--skip-gdf", action="store_true", help="skip the final full-result GeoDataFrame fetch")
    args = ap.parse_args()

    con = geoquery.new_connection(memory_limit="1GB", threads=2, temp_directory=None)
    xmin, ymin, xmax, ymax = geoquery.bbox_from_meters_center(args.lat, args.lon, args.size)
    base_rss = peak_rss_kb()
    out: dict = {"option": args.option, "size_m": args.size, "bbox": [xmin, ymin, xmax, ymax]}

    if args.option == "A":
        (n_bbox, t_bbox) = timed(
            lambda: geoquery.count_buildings_bbox(args.parquet, xmin, ymin, xmax, ymax, con=con)
        )
        out["count_bbox"] = n_bbox
        out["t_count_bbox_s"] = round(t_bbox, 4)

        (n_exact, t_exact) = timed(
            lambda: geoquery.count_buildings_bbox(args.parquet, xmin, ymin, xmax, ymax, exact=True, con=con)
        )
        out["count_exact"] = n_exact
        out["t_count_exact_s"] = round(t_exact, 4)

        (gdf, t_gdf) = timed(
            lambda: geoquery.query_buildings_bbox(args.parquet, xmin, ymin, xmax, ymax, con=con)
        )
        out["count_gdf"] = len(gdf)
        out["t_gdf_s"] = round(t_gdf, 4)

        # STRtree over the subset: the classic Option A route-planning cache
        from shapely.geometry import box
        from shapely.strtree import STRtree

        (tree, t_tree) = timed(lambda: STRtree(gdf.geometry.values))
        out["t_strtree_build_s"] = round(t_tree, 4)

        rng = random.Random(args.seed)
        qs = [
            geoquery.bbox_from_meters_center(
                args.lat + rng.uniform(-0.02, 0.02),
                args.lon + rng.uniform(-0.02, 0.02),
                150.0,
            )
            for _ in range(args.queries)
        ]
        boxes = [box(*b) for b in qs]
        hits = []
        t0 = time.perf_counter()
        for b in boxes:
            hits.append(len(tree.query(b)))
        t_queries = time.perf_counter() - t0
        out["t_strtree_queries_s"] = round(t_queries, 4)
        out["avg_strtree_query_ms"] = round(t_queries / len(boxes) * 1000, 3)
        out["avg_hits_per_query"] = round(sum(hits) / len(hits), 1)

    else:  # Option B
        (n_rows, t_load) = timed(
            lambda: region_mod.load_region(con, args.parquet, xmin, ymin, xmax, ymax)
        )
        out["count_region"] = n_rows
        out["t_load_region_s"] = round(t_load, 4)
        # DuckDB's own memory accounting for the region table + R-tree index
        out["duckdb_mem"] = con.execute("PRAGMA database_size").fetchdf()["memory_usage"][0]

        rng = random.Random(args.seed)
        qs = [
            geoquery.bbox_from_meters_center(
                args.lat + rng.uniform(-0.02, 0.02),
                args.lon + rng.uniform(-0.02, 0.02),
                150.0,
            )
            for _ in range(args.queries)
        ]
        hits = []
        t0 = time.perf_counter()
        for b in qs:
            hits.append(
                con.execute(
                    "SELECT count(*) FROM region "
                    "WHERE ST_Intersects(geometry, ST_GeomFromText(?))",
                    [geoquery.wkt_box(*b)],
                ).fetchone()[0]
            )
        t_queries = time.perf_counter() - t0
        out["t_rtree_queries_s"] = round(t_queries, 4)
        out["avg_rtree_query_ms"] = round(t_queries / len(qs) * 1000, 3)
        out["avg_hits_per_query"] = round(sum(hits) / len(hits), 1)

        if not args.skip_gdf:
            (gdf, t_gdf) = timed(
                lambda: region_mod.query_region_intersects(con, xmin, ymin, xmax, ymax)
            )
            out["count_gdf"] = len(gdf)
            out["t_gdf_s"] = round(t_gdf, 4)

    out["peak_rss_mb"] = round(peak_rss_kb() / 1024.0, 1)
    out["rss_delta_mb"] = round((peak_rss_kb() - base_rss) / 1024.0, 1)
    out["base_rss_mb"] = round(base_rss / 1024.0, 1)
    print(json.dumps(out))


if __name__ == "__main__":
    main()
