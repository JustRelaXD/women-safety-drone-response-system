"""Shared fixtures.

Builds tiny synthetic Overture-style GeoParquet files (buildings + water)
around a test scene:

- a solid wall of buildings with one gap (forces an A* detour)
- a field of scattered buildings
- a lake near the goal (tests water avoidance)
- extra buildings/lakes far outside the mission bbox (proves we never load
  the whole file: queried counts < total rows)
"""

from __future__ import annotations

import math

import duckdb
import pytest

START = (30.8990, 75.8450)  # (lat, lon)
GOAL = (30.9030, 75.8550)


def _dlon_m(m: float, lat: float) -> float:
    return m / (111_320.0 * math.cos(math.radians(lat)))


def _rect_wkt(lat: float, lon: float, w_m: float, h_m: float) -> str:
    dlat = (h_m / 2.0) / 111_320.0
    dlon = _dlon_m(w_m / 2.0, lat)
    return (
        f"POLYGON(({lon - dlon} {lat - dlat}, {lon + dlon} {lat - dlat}, "
        f"{lon + dlon} {lat + dlat}, {lon - dlon} {lat + dlat}, "
        f"{lon - dlon} {lat - dlat}))"
    )


def build_building_rows() -> list[tuple[str, float, str]]:
    """(id, height, wkt) rows for the buildings fixture."""
    rows: list[tuple[str, float, str]] = []

    # solid wall along lat 30.9010, 22 m blocks every ~23 m; gap at the east
    wall_lat = 30.9010
    lon = 75.8455
    while lon <= 75.8535:
        if not (75.8524 <= lon <= 75.8536):  # the gap
            rows.append((f"w{lon:.4f}", 12.0, _rect_wkt(wall_lat, lon, 22, 22)))
        lon += 0.00024

    # scattered urban field (kept clear of the wall band)
    n = 0
    lat = 30.8992
    while lat <= 30.9028:
        lon = 75.8460
        while lon <= 75.8540:
            if abs(lat - wall_lat) >= 0.00022:
                rows.append((f"s{n}", 8.0, _rect_wkt(lat, lon, 15, 15)))
                n += 1
            lon += 0.00042
        lat += 0.00036

    # far away - outside the mission bbox, proves subsetting
    for k in range(25):
        rows.append(
            (f"f{k}", 6.0, _rect_wkt(30.9120 + 0.0001 * k, 75.8700 + 0.0001 * k, 12, 12))
        )
    return rows


def build_water_rows() -> list[tuple[str, str]]:
    """(id, wkt) rows for the water fixture."""
    return [
        ("lake_near_goal", _rect_wkt(30.9025, 75.8538, 100, 70)),
        ("lake_far", _rect_wkt(30.9100, 75.8680, 150, 100)),
    ]


def _write_parquet(path, rows, columns: tuple[str, ...]) -> None:
    """Write an Overture-style GeoParquet with the lean schema + geometry.

    Buildings carry the same lean columns the planner projects (id, height,
    level, class, subtype, num_floors); water only id + geometry.
    """
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    if "height" in columns:
        con.execute(
            "CREATE TABLE tmp (id VARCHAR, height DOUBLE, level INTEGER, class VARCHAR, "
            "subtype VARCHAR, num_floors INTEGER, "
            "bbox STRUCT(xmin DOUBLE, xmax DOUBLE, ymin DOUBLE, ymax DOUBLE), geometry GEOMETRY)"
        )
        for r in rows:
            con.execute(
                f"INSERT INTO tmp SELECT ?, CAST(? AS DOUBLE), CAST(1 AS INTEGER), "
                f"'building', 'yes', CAST(1 AS INTEGER), "
                f"{{'xmin': ST_XMin(g), 'xmax': ST_XMax(g), 'ymin': ST_YMin(g), 'ymax': ST_YMax(g)}}, g "
                f"FROM (SELECT ST_GeomFromText(?) AS g) q",
                [r[0], r[1], r[2]],
            )
    else:
        con.execute(
            "CREATE TABLE tmp (id VARCHAR, bbox STRUCT(xmin DOUBLE, xmax DOUBLE, ymin DOUBLE, ymax DOUBLE), geometry GEOMETRY)"
        )
        for r in rows:
            con.execute(
                f"INSERT INTO tmp SELECT ?, "
                f"{{'xmin': ST_XMin(g), 'xmax': ST_XMax(g), 'ymin': ST_YMin(g), 'ymax': ST_YMax(g)}}, g "
                f"FROM (SELECT ST_GeomFromText(?) AS g) q",
                [r[0], r[1]],
            )
    con.execute(f"COPY tmp TO '{path}' (FORMAT PARQUET)")
    con.close()


@pytest.fixture(scope="session")
def buildings_parquet(tmp_path_factory) -> str:
    path = tmp_path_factory.mktemp("data") / "buildings.parquet"
    _write_parquet(str(path), build_building_rows(), ("id", "height", "geometry"))
    return str(path)


@pytest.fixture(scope="session")
def water_parquet(tmp_path_factory) -> str:
    path = tmp_path_factory.mktemp("data") / "water.parquet"
    _write_parquet(str(path), build_water_rows(), ("id", "geometry"))
    return str(path)


@pytest.fixture(scope="session")
def planner_settings(buildings_parquet: str, water_parquet: str):
    from planner.core.config import Settings

    return Settings(
        grid_resolution_m=10.0,
        max_grid_cells=200_000,
        safety_margin_m=2.0,
        # exact-polygon rasterization buffer, kept EQUAL to the safety margin
        # so the grid's clearance and the geometry smoothing's clearance agree
        # (a tighter grid buffer would make the smoothing's forced-progress
        # warnings fire everywhere in this dense scene)
        polygon_buffer_m=2.0,
        default_altitude_m=50.0,
        min_waypoint_spacing_m=5.0,
        bbox_expansion_m=30.0,
        memory_limit="256MB",
        threads=1,
        buildings_parquet=buildings_parquet,
        water_parquet=water_parquet,
        build_rtree=True,
    )


@pytest.fixture(scope="session")
def buildings_parquet_count(buildings_parquet: str) -> int:
    import duckdb

    con = duckdb.connect()
    n = int(con.execute(
        f"SELECT count(*) FROM read_parquet('{buildings_parquet}')"
    ).fetchone()[0])
    con.close()
    return n
