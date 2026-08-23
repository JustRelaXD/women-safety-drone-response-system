"""Unit tests for the debug/diagnose pure geometry helpers (no DuckDB)."""

from __future__ import annotations

import numpy as np

from planner.core.config import Settings
from planner.core.geometry import LocalProjection
from planner.debug.diagnose import (
    classify_blockers,
    distance_along_line,
    envelope_hit_mask,
    first_blocked_cell_on_line,
    sample_line,
)
from planner.routing.grid import GeoGrid, Rasterizer
from planner.routing.obstacles import NoFlySource
from planner.tests.conftest import GOAL, START


def _proj() -> LocalProjection:
    return LocalProjection(START[0], START[1])


def test_distance_along_line_midpoint():
    a = np.asarray([0.0, 0.0])
    b = np.asarray([100.0, 0.0])
    assert distance_along_line(np.asarray([50.0, 10.0]), a, b) == 50.0
    # beyond either end clamps to the segment
    assert distance_along_line(np.asarray([200.0, 0.0]), a, b) == 100.0
    assert distance_along_line(np.asarray([-5.0, 0.0]), a, b) == 0.0


def test_sample_line_inclusive():
    pts = sample_line((0.0, 0.0), (1.0, 1.0), 4)
    assert len(pts) == 5
    assert pts[0] == (0.0, 0.0)
    assert pts[-1] == (1.0, 1.0)
    assert pts[2] == (0.5, 0.5)


def test_envelope_hit_mask_clear_and_hit():
    proj = _proj()
    # the straight line runs from (75.8450, 30.8990) to (75.8550, 30.9030)
    # so at lon 75.8500 the line is at lat ~30.9010
    line = np.asarray([proj.to_local(*START), proj.to_local(*GOAL)])
    # building clearly off the segment -> no hit
    far = np.asarray([[75.8480, 30.8990, 75.8481, 30.8991]])
    assert not envelope_hit_mask(far, 5.0, line, proj).any()
    # building straddling the segment -> hit
    mid = np.asarray([[75.8500, 30.9009, 75.8501, 30.9011]])
    assert envelope_hit_mask(mid, 5.0, line, proj).any()


def test_classify_blockers_real_vs_envelope():
    proj = _proj()
    line = np.asarray([proj.to_local(*START), proj.to_local(*GOAL)])
    # two envelopes straddling the line: row 0 "real", row 1 envelope-only
    bounds = np.asarray([[75.8500, 30.9009, 75.8501, 30.9011],
                         [75.8502, 30.9009, 75.8503, 30.9011]])
    rowids = np.asarray([10, 11])
    ids = np.asarray(["real_b", "env_b"], dtype=object)
    heights = np.asarray([12.0, 5.0])
    blockers = classify_blockers(
        bounds, rowids, ids, heights, 5.0, line, proj, real_hit_rowids={10}
    )
    assert len(blockers) == 2
    by_id = {b.building_id: b for b in blockers}
    assert by_id["real_b"].real_geometry_hit
    assert not by_id["real_b"].envelope_only_hit
    assert by_id["env_b"].envelope_only_hit
    assert not by_id["env_b"].real_geometry_hit
    # sorted nearest-first
    assert blockers[0].dist_along_line_m <= blockers[1].dist_along_line_m


def test_first_blocked_cell_on_line_clear():
    cfg = Settings(grid_resolution_m=10.0, safety_margin_m=0.0,
                   bbox_expansion_m=20.0, max_grid_cells=100_000)
    bbox = _bbox(cfg)
    grid = Rasterizer(cfg).build_grid(bbox, 10.0)  # empty -> nothing blocked
    cell, dist = first_blocked_cell_on_line(grid, START, GOAL)
    assert cell is None
    assert dist is None


def test_first_blocked_cell_on_line_hit():
    cfg = Settings(grid_resolution_m=10.0, safety_margin_m=2.0,
                   bbox_expansion_m=20.0, max_grid_cells=100_000)
    bbox = _bbox(cfg)
    raster = Rasterizer(cfg)
    grid = raster.build_grid(bbox, 10.0)
    # a no-fly polygon straddling the straight start-goal line
    # (line passes through lat ~30.9008-30.9012 at lon 75.8495-75.8505)
    zone = NoFlySource([((30.9005, 75.8495), (30.9005, 75.8505),
                         (30.9015, 75.8505), (30.9015, 75.8495),
                         (30.9005, 75.8495))])
    raster.rasterize(grid, [zone])
    cell, dist = first_blocked_cell_on_line(grid, START, GOAL)
    assert cell is not None
    assert dist is not None
    assert dist > 0.0


def test_blocked_cells_near_line_only_band():
    cfg = Settings(grid_resolution_m=10.0, safety_margin_m=2.0,
                   bbox_expansion_m=20.0, max_grid_cells=100_000)
    bbox = _bbox(cfg)
    grid = Rasterizer(cfg).build_grid(bbox, 10.0)
    # block a cell far from the line: it must NOT be reported by the band filter
    far = NoFlySource([((30.9020, 75.8455), (30.9020, 75.8460),
                        (30.9025, 75.8460), (30.9025, 75.8455),
                        (30.9020, 75.8455))])
    Rasterizer(cfg).rasterize(grid, [far])
    from planner.debug.diagnose import Diagnoser

    # private band helper exercised through a tiny fake instance
    d = Diagnoser.__new__(Diagnoser)
    line = np.asarray([grid.proj.to_local(*START), grid.proj.to_local(*GOAL)])
    cells = d._blocked_cells_near_line(grid, line, band_m=30.0)
    assert cells == []


def _bbox(cfg: Settings):
    from planner.core.geometry import bbox_of_points

    return bbox_of_points([START, GOAL], cfg.bbox_expansion_m + cfg.safety_margin_m)


def test_geojson_layers_roundtrip():
    """The GeoJSON builders emit valid, serialisable structures."""
    import json

    from planner.debug.diagnose import (
        _cells_geojson,
        _line_geojson,
        _polygons_geojson,
    )
    from shapely import box as sbox

    g = _line_geojson([(75.6, 30.7), (75.7, 30.8)], "#22c55e")
    json.dumps(g)  # serialisable
    p = _polygons_geojson([sbox(75.6, 30.7, 75.61, 30.71)], ["b1"], [10.0], "#fff", "#000")
    assert p["features"][0]["properties"]["height"] == 10.0
    assert len(_cells_geojson([(1, 2)], _empty_grid(), "#ef4444")["features"]) == 1


def _empty_grid() -> GeoGrid:
    cfg = Settings(grid_resolution_m=10.0, safety_margin_m=0.0,
                   bbox_expansion_m=20.0, max_grid_cells=100_000)
    return Rasterizer(cfg).build_grid(_bbox(cfg), 10.0)
