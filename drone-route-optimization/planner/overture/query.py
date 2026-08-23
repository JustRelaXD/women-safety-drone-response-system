"""Direct GeoParquet queries (Option A in the research report).

How this stays memory-safe on a 1 GB VM
----------------------------------------
* The Overture `bbox` struct column (xmin/xmax/ymin/ymax) carries exact
  per-row-group min/max statistics in the Parquet footer.
* DuckDB pushes ``WHERE bbox.xmin <= ... AND bbox.xmax >= ...`` into the
  Parquet scan and prunes row groups from those statistics, so only the row
  groups whose stats overlap the query box are decompressed.
* We project only the columns the planner needs, never ``SELECT *``.
* ``exact=True`` refines with ``ST_Intersects`` against the box polygon,
  which only runs on the pruned candidate set.
"""

from __future__ import annotations

import math
from typing import TYPE_CHECKING, Sequence

import duckdb

if TYPE_CHECKING:
    import geopandas as gpd

CRS = "EPSG:4326"

# Lean projection: the columns the planner actually uses. Overture's nested
# blobs (names, sources, facade_*, roof_*) are huge and cost RAM.
LEAN_COLUMNS: tuple[str, ...] = (
    "id",
    "height",
    "level",
    "class",
    "subtype",
    "num_floors",
    "geometry",
)


def new_connection(
    memory_limit: str = "1GB",
    threads: int = 2,
    temp_directory: str | None = None,
) -> duckdb.DuckDBPyConnection:
    """A DuckDB connection with spatial loaded and RAM-constrained settings.

    On the 1 GB VM set ``memory_limit="512MB"`` and pass a disk
    ``temp_directory``: DuckDB spills instead of exceeding the limit.
    """
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    con.execute(f"SET memory_limit='{memory_limit}'")
    con.execute(f"SET threads={threads}")
    if temp_directory:
        con.execute(f"SET temp_directory='{temp_directory}'")
    return con


def bbox_from_meters_center(
    center_lat: float, center_lon: float, size_m: float
) -> tuple[float, float, float, float]:
    """(xmin, ymin, xmax, ymax) for a square of side ``size_m`` around a point."""
    dlat = size_m / 2.0 / 111_320.0
    dlon = size_m / 2.0 / (111_320.0 * math.cos(math.radians(center_lat)))
    return (
        center_lon - dlon,
        center_lat - dlat,
        center_lon + dlon,
        center_lat + dlat,
    )


def bbox_predicate(xmin: float, ymin: float, xmax: float, ymax: float) -> str:
    """Pushable, prunable predicate on the Overture bbox struct."""
    return (
        f"(bbox.xmin <= {xmax} AND bbox.xmax >= {xmin} "
        f"AND bbox.ymin <= {ymax} AND bbox.ymax >= {ymin})"
    )


def wkt_box(xmin: float, ymin: float, xmax: float, ymax: float) -> str:
    return (
        f"POLYGON(({xmin} {ymin}, {xmax} {ymin}, "
        f"{xmax} {ymax}, {xmin} {ymax}, {xmin} {ymin}))"
    )


def _to_gdf(df) -> "gpd.GeoDataFrame":
    """Attach a geometry column to a DuckDB result DataFrame.

    DuckDB returns GEOMETRY columns as ``bytearray``; Shapely wants ``bytes``.
    geopandas/pandas are imported lazily so DuckDB-only paths never pay for
    them.
    """
    import geopandas as gpd

    wkb = df.pop("geometry").map(bytes)
    return gpd.GeoDataFrame(
        df, geometry=gpd.GeoSeries.from_wkb(wkb, crs=CRS), crs=CRS
    )


def query_buildings_bbox(
    parquet_path: str,
    xmin: float,
    ymin: float,
    xmax: float,
    ymax: float,
    *,
    columns: Sequence[str] = LEAN_COLUMNS,
    exact: bool = False,
    con: duckdb.DuckDBPyConnection | None = None,
) -> "gpd.GeoDataFrame":
    """Buildings whose bbox overlaps the query box, as a GeoDataFrame.

    Never loads the full dataset: only pruned row groups are read.
    ``columns`` is interpolated into SQL: pass trusted internal names only.

    Args:
        parquet_path: Path or glob to the GeoParquet file(s).
        xmin/ymin/xmax/ymax: Query box in EPSG:4326 (lon/lat).
        exact: Also apply ST_Intersects against the box polygon.
    """
    columns = list(columns)
    assert "geometry" in columns, "columns must include 'geometry'"
    con = con if con is not None else new_connection()

    sql = (
        f"SELECT {', '.join(columns)} FROM read_parquet(?) "
        f"WHERE {bbox_predicate(xmin, ymin, xmax, ymax)}"
    )
    if exact:
        sql += f" AND ST_Intersects(geometry, ST_GeomFromText('{wkt_box(xmin, ymin, xmax, ymax)}'))"
    return _to_gdf(con.execute(sql, [str(parquet_path)]).df())


def count_buildings_bbox(
    parquet_path: str,
    xmin: float,
    ymin: float,
    xmax: float,
    ymax: float,
    *,
    exact: bool = False,
    con: duckdb.DuckDBPyConnection | None = None,
) -> int:
    """Count matching buildings without materialising rows in Python."""
    con = con if con is not None else new_connection()
    sql = (
        f"SELECT count(*) FROM read_parquet(?) "
        f"WHERE {bbox_predicate(xmin, ymin, xmax, ymax)}"
    )
    if exact:
        sql += f" AND ST_Intersects(geometry, ST_GeomFromText('{wkt_box(xmin, ymin, xmax, ymax)}'))"
    return int(con.execute(sql, [str(parquet_path)]).fetchone()[0])
