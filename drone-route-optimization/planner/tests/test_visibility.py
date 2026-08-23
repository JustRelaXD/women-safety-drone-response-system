"""Visibility-graph planner tests (unit level, NoFlySource obstacles)."""

import dataclasses

import numpy as np
import pytest
import shapely

from planner.core.config import Settings
from planner.core.exceptions import InfeasibleError
from planner.core.geometry import LocalProjection, haversine_m
from planner.routing.obstacles import NoFlySource
from planner.routing.visibility import VisibilityPlanner

PROJ = LocalProjection(30.9, 75.85)


def _ring(cx: float, cy: float, half: float):
    """Ring of (lat, lon) for a square centred at (cx, cy) in local metres."""
    xs = [cx - half, cx + half, cx + half, cx - half]
    ys = [cy - half, cy - half, cy + half, cy + half]
    return tuple(PROJ.to_geo(x, y) for x, y in zip(xs, ys))


def _rect_ring(cx: float, cy: float, hx: float, hy: float):
    """Ring of (lat, lon) for a rectangle in local metres."""
    xs = [cx - hx, cx + hx, cx + hx, cx - hx]
    ys = [cy - hy, cy - hy, cy + hy, cy + hy]
    return tuple(PROJ.to_geo(x, y) for x, y in zip(xs, ys))


def _cfg(**kw) -> Settings:
    base = dict(
        safety_margin_m=0.0, visibility_max_buildings=10_000,
        visibility_max_vertices=50_000,
    )
    base.update(kw)
    return dataclasses.replace(Settings(), **base)


def _plan(rings, start, goal, snap=False, **cfg_kw):
    src = NoFlySource(rings) if rings else None
    planner = VisibilityPlanner(_cfg(**cfg_kw))
    return planner.find_path([src] if src else [], PROJ, start, goal, snap=snap)


def test_no_obstacles_straight_line() -> None:
    start, goal = (30.9000, 75.8500), (30.9010, 75.8520)
    path = _plan([], start, goal)
    assert path is not None
    assert path.points == (start, goal)


def test_detour_around_single_square() -> None:
    # 100 m square obstacle between start and goal (200 m apart)
    start = PROJ.to_geo(-100, 0)
    goal = PROJ.to_geo(100, 0)
    path = _plan([_ring(0, 0, 50)], start, goal)
    assert path is not None
    direct = haversine_m(*start, *goal)
    d = sum(
        haversine_m(*a, *b) for a, b in zip(path.points, path.points[1:])
    )
    # near-optimal: shortest route hugs the two top corners
    #   sqrt(50^2+50^2) + 100 + sqrt(50^2+50^2) = 241.4 vs direct 200
    assert d > direct * 1.05
    assert d < direct * 1.30


def test_path_through_wall_gap() -> None:
    """Two tall wall segments at x=0 leaving a 40 m gap; path must thread it.

    The walls are 280 m tall, so going around either end costs far more
    than threading the gap - the planner must cross x=0 inside the gap.
    """
    gap_top, gap_bot = 20.0, -20.0
    # vertical walls at x in [-20, 20] spanning y in [-300, -20] and [20, 300]
    rings = [
        _rect_ring(0, -160, 20, 140),
        _rect_ring(0, 160, 20, 140),
    ]
    start, goal = PROJ.to_geo(-95.5, 100), PROJ.to_geo(95.5, 100)
    path = _plan(rings, start, goal)
    assert path is not None

    # find where the polyline crosses x = 0 m and assert it is the gap
    crossings = []
    for a, b in zip(path.points, path.points[1:]):
        ax, ay = PROJ.to_local(*a)
        bx, by = PROJ.to_local(*b)
        if (ax <= 0 <= bx) or (bx <= 0 <= ax):
            t = (0 - ax) / (bx - ax) if bx != ax else 0.5
            crossings.append(ay + t * (by - ay))
    assert crossings, "path never crossed the wall line"
    # crossing may graze the gap edge (y ~= +/-20, exactly the safety
    # margin from the wall) but must never enter either wall's interior;
    # allow 1 mm for geo->local float round-trip error
    assert all(gap_bot - 1e-3 <= y <= gap_top + 1e-3 for y in crossings)


def test_path_legs_never_cross_buffered_obstacles() -> None:
    """Every leg of the returned path is a clear segment (safety contract)."""
    rings = [_ring(0, 0, 30), _ring(150, -40, 40)]
    start, goal = (30.8995, 75.8480), (30.9005, 75.8520)
    path = _plan(rings, start, goal)
    assert path is not None
    local_obs = [
        shapely.geometry.box(x - 30, y - 30, x + 30, y + 30) for x, y in [(0, 0), (150, -40)]
    ]
    for a, b in zip(path.points, path.points[1:]):
        (x0, y0), (x1, y1) = PROJ.to_local(*a), PROJ.to_local(*b)
        seg = shapely.geometry.LineString([(x0, y0), (x1, y1)])
        # tolerance-aware: entering the interior by more than 1 cm fails
        assert not any(seg.intersects(obs.buffer(-0.01)) for obs in local_obs), \
            f"leg {a}->{b} crosses an obstacle"


def test_start_inside_obstacle() -> None:
    start, goal = (30.9000, 75.8500), (30.9010, 75.8530)
    ring = _ring(0, 0, 50)  # start is inside this square
    assert _plan([ring], start, goal, snap=False) is None
    path = _plan([ring], start, goal, snap=True)
    assert path is not None
    assert len(path.points) >= 2


def test_disconnected_goal_returns_none() -> None:
    # goal fully enclosed by a square obstacle
    start = (30.9000, 75.8500)
    goal = (30.9000, 75.8502)  # inside the square
    assert _plan([_ring(0, 0, 50)], start, goal, snap=False) is None


def test_too_many_buildings_infeasible() -> None:
    rings = [_ring(10 * k, 0, 2) for k in range(10)]
    with pytest.raises(InfeasibleError):
        _plan(rings, (30.9000, 75.8490), (30.9000, 75.8510),
              visibility_max_buildings=5)


def test_too_many_vertices_infeasible() -> None:
    rings = [_ring(10 * k, 0, 2) for k in range(10)]  # 40 hull vertices
    with pytest.raises(InfeasibleError):
        _plan(rings, (30.9000, 75.8490), (30.9000, 75.8510),
              visibility_max_vertices=10)
