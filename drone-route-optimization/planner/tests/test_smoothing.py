"""Path smoothing tests."""

import logging

import numpy as np
from shapely.geometry import box as sbox

from planner.core.geometry import LocalProjection
from planner.routing.grid import GeoGrid
from planner.routing.smoothing import (
    has_line_of_sight,
    smooth_path,
    smooth_path_geometry,
)


def _grid(w: int, h: int, blocked_cells=()) -> GeoGrid:
    blocked = np.zeros((h, w), dtype=np.bool_)
    for i, j in blocked_cells:
        blocked[j, i] = True
    return GeoGrid(
        origin_lat=30.9, origin_lon=75.85, width=w, height=h,
        cell_size_m=10.0, blocked=blocked, proj=LocalProjection(30.9, 75.85),
    )


def test_los_clear_line():
    g = _grid(20, 20)
    assert has_line_of_sight(g, (0, 0), (19, 10))


def test_los_blocked():
    g = _grid(20, 20, [(5, 2)])
    assert not has_line_of_sight(g, (0, 0), (19, 10))


def test_los_diagonal_corner_cut_rejected():
    # two diagonal cells block the corner the straight line would cut
    g = _grid(20, 20)
    g.blocked[5, 6] = True
    g.blocked[6, 5] = True
    assert not has_line_of_sight(g, (0, 0), (10, 10))


def test_smooth_shortens_path():
    g = _grid(30, 30)
    # an L-shaped path that has LOS to the end -> collapses to 2 points
    path = [(i, 0) for i in range(20)] + [(20, j) for j in range(1, 15)]
    out = smooth_path(g, path)
    assert len(out) <= len(path)
    assert out[0] == path[0] and out[-1] == path[-1]


def test_smooth_preserves_endpoints_when_blocked():
    g = _grid(30, 30)
    # a corner cell just off the diagonal line blocks LOS (but is not on it)
    g.blocked[9, 10] = True
    path = [(0, 0), (5, 5), (10, 10), (15, 15), (20, 20)]
    out = smooth_path(g, path)
    assert out[0] == path[0] and out[-1] == path[-1]
    assert len(out) >= 2
    assert all(not g.blocked[j, i] for i, j in out)


def test_smooth_collapses_clear_path():
    g = _grid(30, 30)
    path = [(0, 0), (1, 1), (2, 2), (3, 3), (4, 4)]
    out = smooth_path(g, path)
    assert out == [(0, 0), (4, 4)]


def test_smooth_never_loops_on_blocked_nodes():
    g = _grid(30, 30)
    g.blocked[1, 1] = True  # pathological: a path node itself is blocked
    path = [(0, 0), (1, 1), (2, 2), (3, 3)]
    out = smooth_path(g, path)
    assert out[0] == path[0] and out[-1] == path[-1]
    assert len(out) <= len(path)


# ---------------------------------------------------------------------------
# geometry-exact smoothing (smooth_path_geometry)
# ---------------------------------------------------------------------------


def test_geometry_smooth_collapses_clear_path():
    pts = [(0.0, 0.0), (10.0, 0.0), (20.0, 0.0), (30.0, 0.0)]
    assert smooth_path_geometry(pts, [], 5.0) == [(0.0, 0.0), (30.0, 0.0)]


def test_geometry_smooth_keeps_blocked_midpoint():
    # building 3 m below the line over x=30..40: within the 5 m margin, so
    # neither the full line nor the first half is clear -> midpoint kept
    pts = [(0.0, 0.0), (50.0, 0.0), (100.0, 0.0)]
    geoms = [sbox(30.0, -4.0, 40.0, -3.0)]
    assert smooth_path_geometry(pts, geoms, 5.0) == [(0.0, 0.0), (50.0, 0.0), (100.0, 0.0)]


def test_geometry_smooth_allows_beyond_margin():
    # building 10 m below the line: beyond the margin -> full collapse
    pts = [(0.0, 0.0), (50.0, 0.0), (100.0, 0.0)]
    geoms = [sbox(30.0, -12.0, 40.0, -10.0)]
    assert smooth_path_geometry(pts, geoms, 5.0) == [(0.0, 0.0), (100.0, 0.0)]


def test_geometry_smooth_keeps_endpoints_when_stuck():
    # a building straddling the whole line: no shortcut is clear; the loop
    # must still make progress and keep both endpoints
    pts = [(0.0, 0.0), (10.0, 0.0), (20.0, 0.0), (30.0, 0.0)]
    geoms = [sbox(2.0, -1.0, 28.0, 1.0)]
    out = smooth_path_geometry(pts, geoms, 5.0)
    assert out[0] == pts[0] and out[-1] == pts[-1]
    assert len(out) <= len(pts)


def test_geometry_smooth_two_points_untouched():
    assert smooth_path_geometry([(1.0, 1.0), (2.0, 2.0)], [sbox(0, 0, 3, 3)], 5.0) \
        == [(1.0, 1.0), (2.0, 2.0)]


def test_geometry_smooth_forced_progress_warns(caplog):
    # pathological input: the polyline's own consecutive segment is inside
    # the margin, so the pass cannot shortcut it - it must keep the vertex
    # (progress) and flag the unsafe input instead of emitting a shortcut
    pts = [(0.0, 0.0), (10.0, 0.0), (20.0, 0.0), (30.0, 0.0)]
    geoms = [sbox(2.0, -1.0, 28.0, 1.0)]  # straddles the whole line
    with caplog.at_level(logging.WARNING):
        out = smooth_path_geometry(pts, geoms, 5.0)
    assert out == pts  # nothing can be shortcut; unchanged, endpoints kept
    assert any("forced progress" in m for m in caplog.messages)


def test_geometry_smooth_margin_exact_boundary_allowed():
    pts = [(0.0, 0.0), (50.0, 0.0), (100.0, 0.0)]
    # top edge 6 m from the line: beyond the margin -> full collapse
    assert smooth_path_geometry(pts, [sbox(40.0, -7.0, 60.0, -6.0)], 5.0) \
        == [(0.0, 0.0), (100.0, 0.0)]
    # top edge exactly 5 m from the line: the dwithin check is inclusive, so
    # zero-clearance counts as blocked (conservative) -> midpoint kept
    assert smooth_path_geometry(pts, [sbox(40.0, -6.0, 60.0, -5.0)], 5.0) == pts
