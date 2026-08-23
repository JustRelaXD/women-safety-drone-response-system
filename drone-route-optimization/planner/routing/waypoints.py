"""Convert a path into GPS waypoints.

Both planner families end with the same step: thin a polyline of (lat, lon)
points to a minimum spacing (so the drone controller does not receive a
waypoint every 10 m) and always keep the mission endpoint.  Altitude is
constant per mission (config or request override).  Grid-based planners feed
cell centres in; the visibility-graph planner feeds its exact path vertices
in; both go through :func:`points_to_waypoints`.
"""

from __future__ import annotations

from typing import Sequence

from ..core.geometry import Point, haversine_m
from .grid import GeoGrid

Cell = tuple[int, int]
Waypoint = tuple[float, float, float]  # (lat, lon, alt)


def points_to_waypoints(
    points: Sequence[Point],
    altitude_m: float,
    min_spacing_m: float,
) -> list[Waypoint]:
    """Thinned waypoints along a (lat, lon) polyline, endpoints always kept."""
    if not points:
        return []
    wps: list[Waypoint] = [(*points[0], altitude_m)]
    last: Point = points[0]
    for p in points[1:]:
        if haversine_m(*last, *p) >= min_spacing_m:
            wps.append((*p, altitude_m))
            last = p
    if wps[-1][:2] != points[-1]:
        wps.append((*points[-1], altitude_m))
    return wps


def path_to_waypoints(
    grid: GeoGrid,
    path: list[Cell],
    altitude_m: float,
    min_spacing_m: float,
) -> list[Waypoint]:
    """Thinned waypoints along a cell path (cell centres as the polyline)."""
    return points_to_waypoints(
        [grid.cell_to_geo(*cell) for cell in path], altitude_m, min_spacing_m
    )
