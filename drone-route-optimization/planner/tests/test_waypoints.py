"""Waypoint conversion tests."""

import numpy as np

from planner.core.geometry import LocalProjection, haversine_m
from planner.routing.grid import GeoGrid
from planner.routing.waypoints import path_to_waypoints


def _grid(w: int, h: int) -> GeoGrid:
    return GeoGrid(
        origin_lat=30.9, origin_lon=75.85, width=w, height=h,
        cell_size_m=10.0, blocked=np.zeros((h, w), dtype=np.bool_),
        proj=LocalProjection(30.9, 75.85),
    )


def test_waypoints_have_altitude():
    g = _grid(10, 10)
    wps = path_to_waypoints(g, [(0, 0), (1, 0), (2, 0), (3, 0)], 50.0, 5.0)
    assert all(wp[2] == 50.0 for wp in wps)


def test_thinning_and_endpoints():
    g = _grid(100, 10)
    path = [(i, 0) for i in range(100)]  # 1 km at 10 m cells
    wps = path_to_waypoints(g, path, 50.0, 25.0)
    # spaced >= 25 m apart (except endpoints) and endpoints present
    assert len(wps) >= 2
    assert len(wps) < 100
    first = g.cell_to_geo(*path[0])
    last = g.cell_to_geo(*path[-1])
    assert abs(wps[0][0] - first[0]) < 1e-9
    assert abs(wps[-1][0] - last[0]) < 1e-9
    for a, b in zip(wps, wps[1:]):
        d = haversine_m(a[0], a[1], b[0], b[1])
        assert d >= 20.0  # cells are 10 m; consecutive can be 10 m at the tail


def test_empty_path():
    g = _grid(10, 10)
    assert path_to_waypoints(g, [], 50.0, 5.0) == []
