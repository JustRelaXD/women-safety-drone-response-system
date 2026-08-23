"""DuckDB Spatial working-region databases (Option B in the research report).

Materialise the buildings (and optionally water) inside a working region into
DuckDB tables with R-tree indexes on the geometry column. Route-planning
queries (ST_Intersects, ST_DWithin, ...) are then index-served and, because
the database can be file-backed, only working pages sit in RAM.

Query flow (per verified research):

1. ``bbox`` struct predicate -> pushed into the parquet scan + row-group
   pruning (only overlapping row groups are decompressed).
2. ``ST_Intersects`` on the geometry column -> exact refinement, served by
   the R-tree index once the region is materialised.

For rasterization we avoid decoding full geometries where possible:
``region_bounds`` streams just the four envelope coordinates (ST_XMin, ...)
per building - a few bytes per row instead of WKB blobs.  Full WKB is fetched
only for the few obstacles whose envelope spans many grid cells.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

import duckdb
import numpy as np

from .query import LEAN_COLUMNS, bbox_predicate, wkt_box

if TYPE_CHECKING:
    import geopandas as gpd

REGION_TABLE = "region_buildings"
WATER_TABLE = "region_water"


def connect_region_db(
    path: str | None = None,
    memory_limit: str = "512MB",
    threads: int = 1,
) -> duckdb.DuckDBPyConnection:
    """Open (or create) a DuckDB database, optionally file-backed."""
    con = duckdb.connect(path) if path else duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    con.execute(f"SET memory_limit='{memory_limit}'")
    con.execute(f"SET threads={threads}")
    return con


def load_region(
    con: duckdb.DuckDBPyConnection,
    parquet_path: str,
    xmin: float,
    ymin: float,
    xmax: float,
    ymax: float,
    *,
    columns: tuple[str, ...] = LEAN_COLUMNS,
    table: str = REGION_TABLE,
    build_index: bool = True,
) -> int:
    """Fill ``table`` with buildings whose bbox overlaps the box.

    Returns the number of rows materialised.  Uses the bbox predicate
    (row-group pruning) so only overlapping row groups are read.
    """
    cols = ", ".join(c for c in columns if c != "geometry") + ", geometry"
    con.execute(
        f"CREATE OR REPLACE TABLE {table} AS "
        f"SELECT {cols} FROM read_parquet(?) "
        f"WHERE {bbox_predicate(xmin, ymin, xmax, ymax)}",
        [str(parquet_path)],
    )
    if build_index:
        con.execute(
            f"CREATE INDEX IF NOT EXISTS {table}_rtree ON {table} USING RTREE (geometry)"
        )
    return int(con.execute(f"SELECT count(*) FROM {table}").fetchone()[0])


def load_water_region(
    con: duckdb.DuckDBPyConnection,
    parquet_path: str,
    xmin: float,
    ymin: float,
    xmax: float,
    ymax: float,
    *,
    table: str = WATER_TABLE,
    build_index: bool = True,
) -> int:
    """Like :func:`load_region` but tolerant of water files without a bbox column.

    If the ``bbox`` struct is missing, falls back to a plain ST_Intersects
    scan of the (usually much smaller) water file.
    """
    try:
        con.execute(
            f"CREATE OR REPLACE TABLE {table} AS "
            f"SELECT geometry FROM read_parquet(?) "
            f"WHERE {bbox_predicate(xmin, ymin, xmax, ymax)}",
            [str(parquet_path)],
        )
    except duckdb.BinderException:
        con.execute(
            f"CREATE OR REPLACE TABLE {table} AS "
            f"SELECT geometry FROM read_parquet(?)",
            [str(parquet_path)],
        )
    if build_index:
        con.execute(f"CREATE INDEX IF NOT EXISTS {table}_rtree ON {table} USING RTREE (geometry)")
    return int(con.execute(f"SELECT count(*) FROM {table}").fetchone()[0])


def region_bounds(
    con: duckdb.DuckDBPyConnection,
    table: str,
    xmin: float,
    ymin: float,
    xmax: float,
    ymax: float,
) -> tuple[np.ndarray, np.ndarray]:
    """Envelopes of every geometry intersecting the box, R-tree served.

    Returns ``(bounds, rowids)``:

    - ``bounds``: (N, 4) array of [xmin, ymin, xmax, ymax] in EPSG:4326
      degrees - a few floats per obstacle, no geometry decoding.
    - ``rowids``: (N,) DuckDB row ids aligned with ``bounds``, used to fetch
      full WKB only for the few polygons that need exact rasterization.
    """
    df = con.execute(
        f"SELECT rowid, ST_XMin(geometry) AS xmin, ST_YMin(geometry) AS ymin, "
        f"ST_XMax(geometry) AS xmax, ST_YMax(geometry) AS ymax "
        f"FROM {table} WHERE ST_Intersects(geometry, ST_GeomFromText(?))",
        [wkt_box(xmin, ymin, xmax, ymax)],
    ).df()
    bounds = df[["xmin", "ymin", "xmax", "ymax"]].to_numpy(dtype=np.float64)
    rowids = df["rowid"].to_numpy(dtype=np.int64)
    return bounds, rowids


def region_wkb_for_ids(
    con: duckdb.DuckDBPyConnection,
    table: str,
    rowids: np.ndarray,
) -> list[bytes]:
    """WKB blobs for the given DuckDB row ids (chunked IN queries).

    Used only for the small subset of obstacles large enough to need exact
    rasterization, so we never decode the whole region into Python.
    """
    out: list[bytes] = []
    for chunk in np.array_split(rowids, max(1, int(np.ceil(len(rowids) / 500)))):
        ids = ", ".join(str(int(v)) for v in chunk)
        rows = con.execute(
            f"SELECT ST_AsWKB(geometry) FROM {table} WHERE rowid IN ({ids})"
        ).fetchall()
        out.extend(bytes(r[0]) for r in rows)
    return out


def region_geom_by_rowid(
    con: duckdb.DuckDBPyConnection,
    table: str,
    rowids: np.ndarray,
) -> dict[int, shapely.Geometry | None]:
    """Full geometries keyed by rowid (chunked IN queries).

    Unlike :func:`region_wkb_for_ids` (positional), the result is keyed by
    rowid so callers can never misalign geometries with their metadata -
    ``WHERE rowid IN`` does not guarantee result order.
    """
    import shapely

    out: dict[int, shapely.Geometry | None] = {}
    for chunk in np.array_split(rowids, max(1, int(np.ceil(len(rowids) / 500)))):
        if chunk.size == 0:
            continue
        ids = ", ".join(str(int(v)) for v in chunk)
        for rid, wkb in con.execute(
            f"SELECT rowid, ST_AsWKB(geometry) FROM {table} WHERE rowid IN ({ids})"
        ).fetchall():
            geom = shapely.from_wkb(bytes(wkb)) if wkb is not None else None
            out[int(rid)] = geom
    return out


def query_region_intersects(
    con: duckdb.DuckDBPyConnection,
    xmin: float,
    ymin: float,
    xmax: float,
    ymax: float,
    *,
    table: str = REGION_TABLE,
) -> "gpd.GeoDataFrame":
    """Full rows intersecting the box polygon as a GeoDataFrame (index-served)."""
    sql = (
        f"SELECT * FROM {table} "
        f"WHERE ST_Intersects(geometry, ST_GeomFromText(?))"
    )
    df = con.execute(sql, [wkt_box(xmin, ymin, xmax, ymax)]).df()
    from .query import _to_gdf

    return _to_gdf(df)
