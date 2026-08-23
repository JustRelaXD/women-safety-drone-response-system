"""Theta* (any-angle) search tests on synthetic grids."""

import math

import numpy as np

from planner.routing.grid import GeoGrid
from planner.core.geometry import LocalProjection
from planner.routing.astar import AStar
from planner.routing.smoothing import has_line_of_sight
from planner.routing.theta_star import ThetaStar


def _grid(w: int, h: int, blocked_cells=()) -> GeoGrid:
    blocked = np.zeros((h, w), dtype=np.bool_)
    for i, j in blocked_cells:
        blocked[j, i] = True
    return GeoGrid(
        origin_lat=30.9, origin_lon=75.85, width=w, height=h,
        cell_size_m=10.0, blocked=blocked, proj=LocalProjection(30.9, 75.85),
    )


def _leg_length(a, b) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


def test_straight_line() -> None:
    g = _grid(20, 20)
    res = ThetaStar(g).find_path((0, 0), (19, 19))
    assert res is not None
    assert res.cells[0] == (0, 0)
    assert res.cells[-1] == (19, 19)
    # any-angle: a single diagonal leg is enough
    assert len(res.cells) == 2


def test_detour_around_wall() -> None:
    wall = [(10, j) for j in range(2, 18)]
    g = _grid(21, 21, wall)
    res = ThetaStar(g).find_path((0, 10), (20, 10))
    assert res is not None
    assert all(not g.blocked[j, i] for i, j in res.cells)
    assert max(j for _, j in res.cells) >= 18


def test_path_legs_have_line_of_sight() -> None:
    """Every Theta* leg must be a clear straight segment (conservative LOS)."""
    wall = [(10, j) for j in range(2, 18)]
    g = _grid(21, 21, wall)
    res = ThetaStar(g).find_path((0, 10), (20, 10))
    assert res is not None
    for a, b in zip(res.cells, res.cells[1:]):
        assert has_line_of_sight(g, a, b), f"leg {a}->{b} crosses an obstacle"


def test_no_path_when_enclosed() -> None:
    g = _grid(10, 10)
    for i, j in [(4, 3), (5, 3), (6, 3), (4, 4), (6, 4), (4, 5), (5, 5), (6, 5)]:
        g.blocked[j, i] = True
    assert ThetaStar(g).find_path((0, 0), (5, 4)) is None


def test_blocked_start_returns_none() -> None:
    g = _grid(10, 10)
    g.blocked[0, 0] = True
    assert ThetaStar(g).find_path((0, 0), (9, 9)) is None


def test_theta_star_path_is_no_longer_than_astar() -> None:
    """On a detour scene Theta* should match or beat A* path length."""
    wall = [(10, j) for j in range(2, 18)]
    g = _grid(21, 21, wall)
    a = AStar(g).find_path((0, 10), (20, 10))
    t = ThetaStar(g).find_path((0, 10), (20, 10))
    assert a is not None and t is not None

    def length(cells) -> float:
        return sum(_leg_length(x, y) for x, y in zip(cells, cells[1:]))

    assert length(t.cells) <= length(a.cells) + 1e-9
