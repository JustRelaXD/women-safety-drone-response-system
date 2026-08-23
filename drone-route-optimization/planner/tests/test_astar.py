"""A* search tests on synthetic grids."""

import numpy as np

from planner.routing.astar import AStar
from planner.routing.grid import GeoGrid
from planner.core.geometry import LocalProjection


def _grid(w: int, h: int, blocked_cells=()) -> GeoGrid:
    blocked = np.zeros((h, w), dtype=np.bool_)
    for i, j in blocked_cells:
        blocked[j, i] = True
    return GeoGrid(
        origin_lat=30.9, origin_lon=75.85, width=w, height=h,
        cell_size_m=10.0, blocked=blocked, proj=LocalProjection(30.9, 75.85),
    )


def test_straight_line():
    g = _grid(20, 20)
    res = AStar(g).find_path((0, 0), (19, 19))
    assert res is not None
    assert res.cells[0] == (0, 0)
    assert res.cells[-1] == (19, 19)
    # 8-connected diagonal line: 20 cells
    assert len(res.cells) == 20


def test_detour_around_wall():
    # vertical wall (column 10, rows 2..17) with passage only at the bottom
    wall = [(10, j) for j in range(2, 18)]
    g = _grid(21, 21, wall)
    res = AStar(g).find_path((0, 10), (20, 10))
    assert res is not None
    assert all(not g.blocked[j, i] for i, j in res.cells)
    # the path must have dipped below the wall (row >= 18) to cross column 10
    assert max(j for _, j in res.cells) >= 18


def test_enclosed_goal_returns_none():
    # goal fully surrounded by blocked cells
    g = _grid(10, 10)
    for i, j in [(4, 3), (5, 3), (6, 3), (4, 4), (6, 4), (4, 5), (5, 5), (6, 5)]:
        g.blocked[j, i] = True
    res = AStar(g).find_path((0, 0), (5, 4))
    assert res is None


def test_blocked_start_or_goal_returns_none():
    g = _grid(10, 10)
    g.blocked[0, 0] = True
    assert AStar(g).find_path((0, 0), (9, 9)) is None
    g.blocked[0, 0] = False
    g.blocked[9, 9] = True
    assert AStar(g).find_path((0, 0), (9, 9)) is None
