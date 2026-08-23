"""Direct-line fast path: skip the grid when the straight line is clear.

The diagnostic tool proved that open-field missions routinely detour ~5 %
even with *zero* obstacles on the line - a pure grid/smoothing artefact
(A* walks cell centres, and the conservative LOS smoother only jumps to
cells that lie on the A* path).  The fast path eliminates that class of
detour entirely: before any region materialisation / rasterization / search,
it tests the true straight start->goal segment against the ACTUAL obstacle
geometries and, if nothing intersects, returns exactly two waypoints.

Design rules (from the requirement spec):

- The test uses ONLY real geometries: building polygons, water polygons and
  no-fly polygons.  NO buffered envelopes, NO safety margins, NO rasterized
  cells.  Those stay in the fallback grid planner, where the drone actually
  needs a clearance corridor.
- The bbox predicate is used *only* for row-group pruning (it is a candidate
  filter, never the clearance decision - ST_Intersects decides).
- Any failure here (missing file, unsupported schema, connection error)
  falls back to the existing planner unchanged: the fast path is an
  optimisation, never a correctness gate.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Sequence

import duckdb
import shapely

from ..core.config import NoFlyRing, Settings
from ..core.geometry import BBox, Point, haversine_m
from ..overture.query import bbox_predicate
from .waypoints import Waypoint, points_to_waypoints


@dataclass(frozen=True)
class DirectPathResult:
    """Outcome of the straight-line clearance test."""

    #: True when the straight segment is collision-free against the real
    #: obstacle geometries and the planner can return [start, goal].
    clear: bool
    building_hit: bool = False
    water_hit: bool = False
    no_fly_hit: bool = False
    #: wall time of the check itself (for diagnostics / benchmarks)
    check_time_s: float = 0.0

    @property
    def reasons(self) -> list[str]:
        """Human-readable list of obstacle kinds that blocked the line."""
        out: list[str] = []
        if self.building_hit:
            out.append("building polygon")
        if self.water_hit:
            out.append("water polygon")
        if self.no_fly_hit:
            out.append("no-fly zone")
        return out


def _line_bbox(start: Point, goal: Point) -> BBox:
    """Tight (xmin, ymin, xmax, ymax) bbox of the segment, EPSG:4326.

    A building whose polygon intersects the segment necessarily has a bbox
    that overlaps the segment's bbox, so this pruning is sound - it only
    narrows the candidate set, never the decision.
    """
    lon0, lon1 = sorted((start[1], goal[1]))
    lat0, lat1 = sorted((start[0], goal[0]))
    return (lon0, lat0, lon1, lat1)


def _parquet_intersects_line(
    con: duckdb.DuckDBPyConnection,
    parquet_path: str,
    bbox: BBox,
    line_wkt: str,
) -> bool:
    """True when any geometry in ``parquet_path`` intersects the segment.

    bbox predicate first (row-group pruning), then an exact ST_Intersects
    against the real geometry; ``LIMIT 1`` stops at the first hit.  Files
    without the Overture ``bbox`` struct column fall back to a plain
    (unpruned) ST_Intersects scan - mirroring ``load_water_region``.
    """
    try:
        sql = (
            f"SELECT 1 FROM read_parquet(?) "
            f"WHERE {bbox_predicate(*bbox)} "
            f"AND ST_Intersects(geometry, ST_GeomFromText(?)) LIMIT 1"
        )
        return con.execute(sql, [str(parquet_path), line_wkt]).fetchone() is not None
    except duckdb.BinderException:
        sql = (
            "SELECT 1 FROM read_parquet(?) "
            "WHERE ST_Intersects(geometry, ST_GeomFromText(?)) LIMIT 1"
        )
        return con.execute(sql, [str(parquet_path), line_wkt]).fetchone() is not None


def _no_fly_intersects(
    zones: Sequence[NoFlyRing], start: Point, goal: Point
) -> bool:
    """True when any no-fly ring polygon intersects the segment (shapely)."""
    if not zones:
        return False
    line = shapely.LineString([(start[1], start[0]), (goal[1], goal[0])])
    for ring in zones:
        poly = shapely.geometry.Polygon([(lon, lat) for lat, lon in ring])
        if poly.intersects(line):
            return True
    return False


def is_direct_path_clear(
    con: duckdb.DuckDBPyConnection,
    config: Settings,
    start: Point,
    goal: Point,
    no_fly_zones: Sequence[NoFlyRing] | None = None,
) -> DirectPathResult:
    """Test the straight start->goal segment against real obstacle geometries.

    Args:
        con: DuckDB connection (spatial loaded).
        config: planner settings (buildings/water parquet paths).
        start: (lat, lon).
        goal: (lat, lon).
        no_fly_zones: ring polygons to test in Python (they are not in the
            parquet).

    Returns:
        A :class:`DirectPathResult`.  ``clear=True`` means the planner may
        return exactly the two waypoints [start, goal] and skip the grid
        pipeline entirely.  A zero-length mission is never "clear" (it falls
        back to the grid, which handles it as a degenerate search).

    Note:
        This is deliberately geometry-exact: ST_Intersects counts boundary
        touches as intersections, so a line grazing a building edge falls
        back to the grid planner (which then applies the safety margin).
    """
    t0 = time.perf_counter()
    if haversine_m(*start, *goal) < 1e-9:
        return DirectPathResult(
            clear=False, check_time_s=time.perf_counter() - t0
        )
    bbox = _line_bbox(start, goal)
    line_wkt = f"LINESTRING({start[1]} {start[0]}, {goal[1]} {goal[0]})"

    building_hit = _parquet_intersects_line(
        con, config.buildings_parquet, bbox, line_wkt
    )
    water_hit = False
    if config.water_parquet:
        water_hit = _parquet_intersects_line(
            con, config.water_parquet, bbox, line_wkt
        )
    no_fly_hit = _no_fly_intersects(list(no_fly_zones or []), start, goal)

    return DirectPathResult(
        clear=not (building_hit or water_hit or no_fly_hit),
        building_hit=building_hit,
        water_hit=water_hit,
        no_fly_hit=no_fly_hit,
        check_time_s=time.perf_counter() - t0,
    )


def generate_direct_waypoints(
    start: Point,
    goal: Point,
    altitude_m: float,
    min_spacing_m: float,
) -> list[Waypoint]:
    """Exactly two waypoints: (start, alt) then (goal, alt).

    Reuses the same thinning logic as the grid path (:func:`points_to_waypoints`)
    so waypoint semantics (constant altitude, endpoints always kept) stay
    identical across both planners.
    """
    return points_to_waypoints([start, goal], altitude_m, min_spacing_m)
