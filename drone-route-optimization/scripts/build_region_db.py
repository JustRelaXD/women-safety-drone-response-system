"""One-time: build a persistent region DuckDB database with an R-tree index.

    uv run python scripts/build_region_db.py \
        --parquet punjab_buildings.parquet \
        --db region.duckdb \
        --bbox 75.80,30.85,75.95,30.98

The resulting ``region.duckdb`` file is self-contained: table + R-tree index
persisted on disk, so at runtime only working pages sit in RAM.  Re-run with
a new bbox to move the working region (e.g. when the drone passes a
threshold distance from the current region centre).

To index the entire province instead (one-time, ~2 min, 765 MB peak with
memory_limit=512MB, ~2.7 GB on disk), omit --bbox.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from planner.overture import region  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--parquet", default="punjab_buildings.parquet")
    ap.add_argument("--db", default="region.duckdb")
    ap.add_argument("--bbox", default=None, help="xmin,ymin,xmax,ymax (EPSG:4326); omit for full file")
    ap.add_argument("--memory-limit", default="512MB", help="DuckDB memory cap (VM-friendly)")
    args = ap.parse_args()

    if os.path.exists(args.db):
        os.remove(args.db)

    con = region.connect_region_db(args.db, memory_limit=args.memory_limit)
    if args.bbox:
        xmin, ymin, xmax, ymax = (float(v) for v in args.bbox.split(","))
    else:
        # Whole province: use the parquet file's own geo metadata bbox
        row = con.execute(
            "SELECT geo_bbox FROM parquet_file_metadata(?)", [args.parquet]
        ).fetchone()
        b = row[0]
        xmin, ymin, xmax, ymax = b["xmin"], b["ymin"], b["xmax"], b["ymax"]

    n = region.load_region(con, args.parquet, xmin, ymin, xmax, ymax, build_index=True)
    print(f"region rows: {n}")
    print(f"db size on disk: {os.path.getsize(args.db) / 1024.0**3:.2f} GB")
    print(f"db file: {args.db}")
    con.close()


if __name__ == "__main__":
    main()
