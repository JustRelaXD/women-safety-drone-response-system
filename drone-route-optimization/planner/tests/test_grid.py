"""Grid + rasterizer tests.

Covers both painting modes: the legacy buffered-bounding-box path
(``rasterize_exact_polygons=False``) and the default exact-polygon path.
The core invariant (acceptance criterion): exact rasterization NEVER blocks
more cells than the envelope rasterizer for the same margin - proven as a
set-inclusion test over a mixed scene.
"""

import math

import numpy as np
import shapely

from planner.core.config import Settings
from planner.core.geometry import bbox_of_points
from planner.routing.grid import GeoGrid, Rasterizer
from planner.routing.obstacles import NoFlySource

from planner.tests.conftest import GOAL, START


def _settings(**kw) -> Settings:
    base = dict(
        grid_resolution_m=10.0,
        safety_margin_m=2.0,
        bbox_expansion_m=30.0,
        max_grid_cells=200_000,
    )
    base.update(kw)
    return Settings(**base)


def _rect(lat: float, lon: float, w_m: float, h_m: float):
    """Axis-aligned lon/lat rectangle (w_m east-west, h_m north-south)."""
    dlat = (h_m / 2.0) / 111_320.0
    dlon = (w_m / 2.0) / (111_320.0 * math.cos(math.radians(lat)))
    return shapely.geometry.box(lon - dlon, lat - dlat, lon + dlon, lat + dlat)


def _rotated(lat: float, lon: float, w_m: float, h_m: float, angle_deg: float):
    """Rectangle rotated by ``angle_deg`` (counter-clockwise) in lon/lat."""
    a = math.radians(angle_deg)
    ca, sa = math.cos(a), math.sin(a)
    scale_lon = 111_320.0 * math.cos(math.radians(lat))
    pts = []
    for dx, dy in (
        (-w_m / 2, -h_m / 2), (w_m / 2, -h_m / 2),
        (w_m / 2, h_m / 2), (-w_m / 2, h_m / 2), (-w_m / 2, -h_m / 2),
    ):
        rx = dx * ca - dy * sa
        ry = dx * sa + dy * ca
        pts.append((lon + rx / scale_lon, lat + ry / 111_320.0))
    return shapely.geometry.Polygon(pts)


class _PolySource:
    """In-memory obstacle source (like NoFlySource) for rasterizer tests."""

    name = "poly"

    def __init__(self, geoms):
        self._geoms = np.asarray(list(geoms), dtype=object)

    def bounds(self) -> np.ndarray:
        if len(self._geoms) == 0:
            return np.empty((0, 4), dtype=np.float64)
        return np.asarray(shapely.bounds(self._geoms), dtype=np.float64).reshape(-1, 4)

    def fetch(self, indices: np.ndarray) -> np.ndarray:
        return self._geoms[indices]


def _both_modes(
    geoms,
    *,
    grid_m: float = 10.0,
    margin: float = 2.0,
    buffer: float | None = None,
    bbox=(75.8485, 30.8985, 75.8515, 30.9015),
) -> tuple[set, set]:
    """(exact, envelope) blocked-cell index sets for the same scene."""
    buffer = margin if buffer is None else buffer
    env = _settings(safety_margin_m=margin, rasterize_exact_polygons=False,
                    grid_resolution_m=grid_m)
    exact = _settings(safety_margin_m=margin, polygon_buffer_m=buffer,
                      rasterize_exact_polygons=True, grid_resolution_m=grid_m)

    def _cells(cfg: Settings) -> set:
        grid = Rasterizer(cfg).build_grid(bbox, grid_m)
        Rasterizer(cfg).rasterize(grid, [_PolySource(geoms)])
        js, is_ = np.nonzero(grid.blocked)
        return {(int(j), int(i)) for j, i in zip(js, is_)}

    return _cells(exact), _cells(env)


def test_build_grid_dimensions():
    cfg = _settings()
    bbox = bbox_of_points([START, GOAL], 30.0)
    grid = Rasterizer(cfg).build_grid(bbox, 10.0)
    assert grid.width >= 10 and grid.height >= 10
    assert grid.blocked.shape == (grid.height, grid.width)


def test_build_grid_caps_cells():
    cfg = _settings(max_grid_cells=100)
    bbox = bbox_of_points([START, GOAL], 30.0)
    grid = Rasterizer(cfg).build_grid(bbox, 10.0)
    assert grid.n_cells <= 100
    assert grid.cell_size_m > 10.0


def test_exact_mode_is_default():
    s = Settings()
    assert s.rasterize_exact_polygons is True
    assert s.polygon_buffer_m == 1.0


def test_rasterize_blocks_envelope():
    # legacy fallback path pinned explicitly: small obstacles block their
    # whole buffered bounding box as a rectangle
    cfg = _settings(rasterize_exact_polygons=False)
    bbox = bbox_of_points([START, GOAL], 30.0)
    raster = Rasterizer(cfg)
    grid = raster.build_grid(bbox, 10.0)
    source = NoFlySource([((30.9000, 75.8505), (30.9000, 75.8510),
                           (30.9005, 75.8510), (30.9005, 75.8505),
                           (30.9000, 75.8505))])
    raster.rasterize(grid, [source])
    i, j = grid.geo_to_cell(30.90025, 75.85075)
    assert grid.blocked[j, i]
    # a cell far from the polygon stays free
    i2, j2 = grid.geo_to_cell(30.8995, 75.8460)
    assert not grid.blocked[j2, i2]


def test_rasterize_large_polygon_exact():
    # legacy path: only LARGE obstacles get exact painting (threshold)
    cfg = _settings(raster_envelope_max_cells=64, rasterize_exact_polygons=False)
    bbox = bbox_of_points([START, GOAL], 30.0)
    raster = Rasterizer(cfg)
    grid = raster.build_grid(bbox, 10.0)
    # a big L-shaped polygon: envelope ~ 400 cells > threshold -> exact path
    ring = [
        (30.8995, 75.8470), (30.9015, 75.8470), (30.9015, 75.8490),
        (30.9005, 75.8490), (30.9005, 75.8480), (30.8995, 75.8480),
        (30.8995, 75.8470),
    ]
    source = NoFlySource([tuple(ring)])
    raster.rasterize(grid, [source])
    # inside the L (left column) -> blocked
    i, j = grid.geo_to_cell(30.9000, 75.8475)
    assert grid.blocked[j, i]
    # inside the envelope but in the missing bottom-right quadrant -> free
    # (only exact rasterization keeps this free; envelope-blocking would not)
    i2, j2 = grid.geo_to_cell(30.9000, 75.8485)
    assert not grid.blocked[j2, i2]


# ---------------------------------------------------------------------------
# exact polygon rasterization (default mode)
# ---------------------------------------------------------------------------


def test_exact_rotated_building_blocks_fewer_cells():
    """A 45-degree building: exact mode frees the bbox corner triangles."""
    geoms = [_rotated(30.9000, 75.8500, 40.0, 20.0, 45.0)]
    for margin in (0.0, 2.0, 5.0):
        exact, env = _both_modes(geoms, margin=margin)
        assert exact <= env, "exact must never block more cells than envelope"
        assert len(exact) < len(env), (
            f"margin {margin}: exact should free the bbox corners "
            f"(exact {len(exact)} vs envelope {len(env)})"
        )


def test_exact_l_shape_frees_concave_quadrant():
    """The L-shape's missing quadrant is free under exact painting only."""
    ring = [
        (30.8995, 75.8470), (30.9015, 75.8470), (30.9015, 75.8490),
        (30.9005, 75.8490), (30.9005, 75.8480), (30.8995, 75.8480),
        (30.8995, 75.8470),
    ]
    # ring tuples are (lat, lon); the rasterizer expects (lon, lat)
    geoms = [shapely.geometry.Polygon([(lon, lat) for lat, lon in ring])]
    exact, env = _both_modes(geoms, bbox=(75.8460, 30.8988, 75.8500, 30.9022))
    # the concave quadrant centre: free under exact, blocked by the envelope
    i, j = _cell_at(30.9000, 75.8485, bbox=(75.8460, 30.8988, 75.8500, 30.9022))
    assert (j, i) in env
    assert (j, i) not in exact


def _cell_at(lat: float, lon: float, bbox, grid_m: float = 10.0) -> tuple[int, int]:
    grid = Rasterizer(_settings(grid_resolution_m=grid_m)).build_grid(bbox, grid_m)
    return grid.geo_to_cell(lat, lon)


def test_exact_narrow_street_keeps_corridor():
    """Two buildings facing each other: exact mode keeps the street cell.

    Buildings 14 m wide, 9.9 m apart, 5 m cells.  The legacy path (margin
    5 m) blocks every cell between them; exact painting (buffer 1 m) leaves
    the corridor cell free - the mechanism that opens up city blocks.
    """
    bbox = (75.8490, 30.8990, 75.8510, 30.9010)
    a = _rect(30.9000, 75.8500, 14.0, 20.0)
    b = _rect(30.9000, 75.85025, 14.0, 20.0)
    exact, env = _both_modes(
        [a, b], grid_m=5.0, margin=5.0, buffer=1.0, bbox=bbox
    )
    # gap centre between the two inner faces
    gap_lon = (75.8500 + 7.0 / (111_320.0 * math.cos(math.radians(30.9)))
               + 75.85025 - 7.0 / (111_320.0 * math.cos(math.radians(30.9)))) / 2.0
    i, j = _cell_at(30.9000, gap_lon, bbox, grid_m=5.0)
    assert (j, i) in env, "envelope path should block the street cell"
    assert (j, i) not in exact, "exact path should keep the street cell"


def test_exact_two_close_buildings_corridor():
    """Close buildings: the 6 m-margin envelope blocks the corridor; exact
    painting with NO buffer keeps the corridor cell between the footprints."""
    bbox = (75.8490, 30.8990, 75.8510, 30.9010)
    a = _rect(30.9000, 75.8500, 12.0, 20.0)
    b = _rect(30.9000, 75.85025, 12.0, 20.0)
    exact, env = _both_modes([a, b], grid_m=5.0, margin=6.0, buffer=0.0, bbox=bbox)
    gap_lon = (75.8500 + 6.0 / (111_320.0 * math.cos(math.radians(30.9)))
               + 75.85025 - 6.0 / (111_320.0 * math.cos(math.radians(30.9)))) / 2.0
    i, j = _cell_at(30.9000, gap_lon, bbox, grid_m=5.0)
    assert (j, i) in env, "envelope margin 6 should block the corridor"
    assert (j, i) not in exact, "exact with no buffer should keep it"


def _placed_rect(
    cx_lat: float, cx_lon: float, dx_m: float, dy_m: float, w_m: float, h_m: float
):
    """Axis-aligned rect at a local-metre offset (x east, y north)."""
    dlon = dx_m / (111_320.0 * math.cos(math.radians(cx_lat)))
    dlat = dy_m / 111_320.0
    return _rect(cx_lat + dlat, cx_lon + dlon, w_m, h_m)


def test_exact_city_block_courtyard():
    """A ring of buildings around a 20 m courtyard: the legacy envelope path
    (margin 12) seals the courtyard; exact painting (buffer 1) keeps it open.
    """
    bbox = (75.8490, 30.8990, 75.8510, 30.9010)
    ring = [
        _placed_rect(30.9000, 75.8500, 0.0, 15.0, 30.0, 10.0),   # north
        _placed_rect(30.9000, 75.8500, 0.0, -15.0, 30.0, 10.0),  # south
        _placed_rect(30.9000, 75.8500, -15.0, 0.0, 10.0, 30.0),  # west
        _placed_rect(30.9000, 75.8500, 15.0, 0.0, 10.0, 30.0),   # east
    ]

    def _free_in_courtyard(exact_mode: bool, margin: float, buffer: float) -> int:
        cfg = _settings(safety_margin_m=margin, polygon_buffer_m=buffer,
                        rasterize_exact_polygons=exact_mode, grid_resolution_m=5.0)
        grid = Rasterizer(cfg).build_grid(bbox, 5.0)
        Rasterizer(cfg).rasterize(grid, [_PolySource(ring)])
        cx, cy = grid.proj.to_local(30.9000, 75.8500)
        free = 0
        for j in range(grid.height):
            for i in range(grid.width):
                if grid.blocked[j, i]:
                    continue
                x, y = grid.proj.to_local(*grid.cell_to_geo(i, j))
                if abs(x - cx) <= 12.0 and abs(y - cy) <= 12.0:
                    free += 1
        return free

    assert _free_in_courtyard(False, margin=12.0, buffer=0.0) == 0
    assert _free_in_courtyard(True, margin=12.0, buffer=1.0) >= 1


def test_exact_never_blocks_more_than_envelope():
    """Acceptance invariant: exact blocking is a SUBSET of envelope blocking
    for the same margin, across a mixed urban scene (rotated + rect + L)."""
    geoms = [
        _rotated(30.9000, 75.8500, 40.0, 20.0, 45.0),
        _rect(30.9005, 75.8492, 25.0, 18.0),
        shapely.geometry.Polygon([(lon, lat) for lat, lon in [
            (30.8998, 75.8508), (30.9010, 75.8508), (30.9010, 75.8515),
            (30.9002, 75.8515), (30.9002, 75.8512), (30.8998, 75.8512),
            (30.8998, 75.8508),
        ]]),
    ]
    for margin in (0.0, 2.0, 5.0):
        exact, env = _both_modes(
            geoms, margin=margin, bbox=(75.8480, 30.8980, 75.8520, 30.9020)
        )
        assert exact <= env, f"margin {margin}: exact must never over-block"
        assert len(exact) <= len(env)


# ---------------------------------------------------------------------------
# fast paint path for large polygons (_paint_large)
# ---------------------------------------------------------------------------


def _local_grid(width: int = 200, height: int = 200, cell: float = 10.0) -> GeoGrid:
    """A grid in a synthetic local frame (origin at (0, 0) lon/lat)."""
    from planner.core.geometry import LocalProjection

    return GeoGrid(
        origin_lat=0.0,
        origin_lon=0.0,
        width=width,
        height=height,
        cell_size_m=cell,
        blocked=np.zeros((height, width), dtype=np.bool_),
        proj=LocalProjection(0.0, 0.0),
    )


def _assert_paint_equivalent(geom, grid_m, cell=10.0) -> None:
    """The fast painter must block EXACTLY the slice painter's cells.

    Paints ``geom`` once with :meth:`Rasterizer._paint_large` and once with
    :meth:`Rasterizer._paint_slice` on identical grids and asserts the
    blocked masks are bit-identical.  This directly tests the equivalence
    claim of the fast path (comparing two ``_paint_large`` runs - or one
    ``_paint_large`` against itself through the threshold - would prove
    nothing, since both sides would share the same potential bug).
    """
    grid_fast = _local_grid(*grid_m, cell)
    i0, i1, j0, j1 = grid_fast.local_to_cell_bounds(*geom.bounds)
    shapely.prepare(geom)
    Rasterizer._paint_large(grid_fast, geom, i0, i1, j0, j1)
    grid_slow = _local_grid(*grid_m, cell)
    Rasterizer._paint_slice(grid_slow, geom, i0, i1, j0, j1)
    assert np.array_equal(grid_fast.blocked, grid_slow.blocked), (
        "_paint_large and _paint_slice differ - masks must be bit-identical"
    )


def test_fast_paint_matches_slow_for_rotated_rect():
    # a rotated rectangle large enough to span > threshold cells
    geom = shapely.geometry.Polygon(
        [(100, 100), (900, 300), (700, 900), (100, 700), (100, 100)]
    )
    _assert_paint_equivalent(geom, (100, 100))


def test_fast_paint_matches_slow_for_l_shape():
    geom = shapely.geometry.Polygon(
        [(50, 50), (850, 50), (850, 250), (300, 250), (300, 850), (50, 850),
         (50, 50)]
    )
    _assert_paint_equivalent(geom, (100, 100))


def test_fast_paint_matches_slow_for_hole_polygon():
    outer = [(50, 50), (950, 50), (950, 950), (50, 950), (50, 50)]
    hole = [(300, 300), (700, 300), (700, 700), (300, 700), (300, 300)]
    geom = shapely.geometry.Polygon(outer, [hole])
    _assert_paint_equivalent(geom, (120, 120))


def test_fast_paint_matches_slow_for_full_grid_span():
    # polygon covering the ENTIRE grid (the giant no-fly ring case)
    geom = shapely.geometry.Polygon(
        [(-50, -50), (2050, -50), (2050, 2050), (-50, 2050), (-50, -50)]
    )
    _assert_paint_equivalent(geom, (200, 200))


def test_fast_paint_matches_slow_for_diagonal_band():
    # a thin diagonal band crossing the whole grid: exercises boundary cells
    geom = shapely.geometry.Polygon(
        [(0, 900), (900, 0), (1000, 0), (100, 1000), (0, 1000), (0, 900)]
    )
    _assert_paint_equivalent(geom, (100, 100))


def test_fast_paint_matches_slow_multipolygon():
    a = shapely.geometry.Polygon([(50, 50), (400, 50), (400, 400), (50, 400), (50, 50)])
    b = shapely.geometry.Polygon([(600, 600), (900, 600), (900, 900), (600, 900), (600, 600)])
    _assert_paint_equivalent(shapely.geometry.MultiPolygon([a, b]), (100, 100))


def test_fast_paint_matches_slow_for_negative_direction_diagonal():
    """Regression: an edge moving in negative x AND negative y must rasterize
    the same cells as the slice path (the walk used to drift off diagonal
    edges whose t-max signs pointed backwards)."""
    geom = shapely.geometry.Polygon(
        [(-4632.5, 14311.5), (3500.0, 1758.1), (4252.4, -449.5),
         (5488.0, -15352.3), (12836.9, -12848.1), (4726.2, -288.0),
         (3973.9, 1919.6), (2735.2, 16822.3), (-4632.5, 14311.5)]
    )
    _assert_paint_equivalent(geom, (200, 200))


def test_fast_paint_matches_slow_for_negative_direction_simple():
    """A simple diagonal band descending to the south-west (both deltas < 0)."""
    geom = shapely.geometry.Polygon(
        [(900, 100), (100, 900), (0, 900), (0, 0), (900, 0), (900, 100)]
    )
    _assert_paint_equivalent(geom, (100, 100))


def test_fast_paint_guard_scales_with_segment_not_grid():
    """Regression: the boundary walk used to truncate at a grid-size-based
    step cap, so an edge travelling far outside the grid before entering it
    stopped early and dropped boundary cells.  The cap must scale with the
    segment length (a ring can span far beyond the mission bbox)."""
    # ring 15's edge-0 shape: mostly travels outside a 432x533 grid, then
    # crosses it diagonally - the old cap (2*(w+h)) cut it off mid-flight
    geom = shapely.geometry.Polygon(
        [(-4632.5, 14311.5), (3500.0, 1758.1), (4252.4, -449.5),
         (5488.0, -15352.3), (12836.9, -12848.1), (4726.2, -288.0),
         (3973.9, 1919.6), (2735.2, 16822.3), (-4632.5, 14311.5)]
    )
    _assert_paint_equivalent(geom, (432, 533))


def test_fast_paint_takes_giant_rings_fast_path():
    """A giant ring spanning the grid goes through _paint_large (>= threshold)."""
    grid = _local_grid(484, 579)
    ring = shapely.geometry.Polygon(
        [(0, 0), (4840, 0), (4840, 5790), (0, 5790), (0, 0)]
    )
    # span cells = 484*579 = 280236 > FAST_PAINT_MIN_CELLS
    i0, i1, j0, j1 = grid.local_to_cell_bounds(*ring.bounds)
    assert (i1 - i0 + 1) * (j1 - j0 + 1) > Rasterizer.FAST_PAINT_MIN_CELLS
    Rasterizer._paint_local_polygons(grid, [ring])
    # the whole grid is inside the ring -> every cell blocked
    assert int(grid.blocked.sum()) == grid.n_cells
