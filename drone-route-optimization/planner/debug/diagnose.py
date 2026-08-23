"""Diagnose WHY a planned route deviates from the straight start-goal line.

Runs the real planning pipeline (DuckDB region -> rasterizer -> A*/Theta* ->
smoothing) and then overlays every layer that decides the outcome:

- the straight start->goal line
- the planned route (waypoints the API would return)
- building polygons and their buffered (safety-margin) envelopes
- the rasterized blocked cells
- the EXACT obstacles that block the straight line, classified as
  ``real geometry hit`` (the building polygon itself crosses the line) or
  ``envelope-only hit`` (only the buffered envelope does - i.e. the detour is
  a rasterization artefact, not a physical obstacle)

Outputs (into ``--out``):
- ``report.json`` / ``report.txt``  machine- and human-readable findings
- ``viewer.html``                  self-contained Leaflet map (satellite +
                                    OSM basemaps) with every layer
- ``layers/*.geojson``             the individual layers for other tooling

Usage::

    python -m planner.debug.diagnose --start-lat 30.7560 --start-lon 75.6000 \
        --goal-lat 30.7580 --goal-lon 75.6030 --out planner/data/diag
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import math
import time
from dataclasses import dataclass, field
from pathlib import Path

import duckdb
import numpy as np
import shapely

from ..core.config import Settings
from ..core.exceptions import NoPathError
from ..core.geometry import BBox, LocalProjection, Point, bbox_of_points, path_length_m
from ..overture import region as region_store
from ..overture.region import REGION_TABLE, WATER_TABLE
from ..routing.direct_path import is_direct_path_clear
from ..routing.grid import GeoGrid, Rasterizer
from ..routing.obstacles import (
    BuildingsSource,
    NoFlySource,
    ObstacleSource,
    WaterSource,
)
from ..routing.planner import RoutePlanner, effective_polygon_buffer
from .viewer import render_viewer

#: buildings fetched as polygons for the map view (cap keeps GeoJSON small)
MAX_BUILDING_POLYGONS = 2_000
#: blocked cells emitted as polygons (cap keeps Leaflet responsive)
MAX_BLOCKED_CELLS = 30_000
#: sample density for walking the straight line through the grid
LINE_SAMPLES_PER_CELL = 4

LonLat = tuple[float, float]  # (lon, lat) - the GeoJSON order


@dataclass(frozen=True)
class Blocker:
    """One obstacle that intersects the straight start-goal line."""

    building_id: str
    height_m: float | None
    rowid: int
    #: distance along the straight line (metres from start) to the envelope
    dist_along_line_m: float
    #: the building polygon itself crosses the straight line
    real_geometry_hit: bool
    #: only the buffered (margin-expanded) envelope crosses the line
    envelope_only_hit: bool


@dataclass
class DiagnosisResult:
    start: Point
    goal: Point
    mission_id: str
    straight_distance_m: float
    route_distance_m: float | None
    detour_ratio: float | None
    path_found: bool
    algorithm: str
    grid: GeoGrid | None
    region_stats: tuple[int, int]
    planning_time_s: float
    blockers: list[Blocker] = field(default_factory=list)
    n_real_geometry_hits: int = 0
    n_envelope_only_hits: int = 0
    #: how many region buildings carry a usable height (for altitude-aware
    #: obstacle filtering); the Punjab dataset is almost entirely NULL
    height_coverage: int = 0
    first_blocked_cell: tuple[int, int] | None = None
    first_blocked_cell_dist_m: float | None = None
    first_blocked_cell_owner: Blocker | None = None
    #: the direct-line fast path decision (what plan() would do first)
    direct_path_clear: bool | None = None
    direct_path_check_s: float = 0.0
    direct_path_building_hit: bool = False
    direct_path_water_hit: bool = False
    direct_path_no_fly_hit: bool = False
    straight_line_geojson: dict | None = None
    route_geojson: dict | None = None
    raw_path_geojson: dict | None = None
    buildings_geojson: dict | None = None
    buffered_geojson: dict | None = None
    blocked_cells_geojson: dict | None = None
    blockers_geojson: dict | None = None
    #: red layer: the ACTUAL polygons that intersect the straight line
    hit_polygons_geojson: dict | None = None
    #: raw (unbuffered) axis-aligned bounding boxes of the buildings
    bbox_geojson: dict | None = None
    #: exact-mode footprint: buildings buffered by ``polygon_buffer_m``
    buffered_polygons_geojson: dict | None = None
    #: legacy-mode blocked cells (buffered bounding box) - same scene painted
    #: with ``rasterize_exact_polygons=False``, for old-vs-new comparison
    old_blocked_cells_geojson: dict | None = None
    blocked_cells_exact_count: int = 0
    blocked_cells_envelope_count: int = 0
    #: blocked cells freed by exact rasterization (envelope - exact)
    recovered_cells: int = 0
    rasterization_mode: str = "exact_polygon"
    polygon_buffer_m: float = 1.0
    region_bbox: BBox | None = None


# --------------------------------------------------------------------------
# pure geometry helpers (unit-testable without DuckDB)
# --------------------------------------------------------------------------


def sample_line(start: Point, goal: Point, n: int) -> list[Point]:
    """``n+1`` points along the lat/lon segment start->goal (linear)."""
    if n < 1:
        n = 1
    return [
        (
            start[0] + (goal[0] - start[0]) * k / n,
            start[1] + (goal[1] - start[1]) * k / n,
        )
        for k in range(n + 1)
    ]


def distance_along_line(point_xy, a_xy, b_xy) -> float:
    """Projection of a point (x, y) onto segment a->b; distance from a."""
    ax, ay = a_xy
    bx, by = b_xy
    px, py = point_xy
    dx, dy = bx - ax, by - ay
    length_sq = dx * dx + dy * dy
    if length_sq == 0.0:
        return 0.0
    t = ((px - ax) * dx + (py - ay) * dy) / length_sq
    t = min(max(t, 0.0), 1.0)
    return t * math.sqrt(length_sq)


def envelope_hit_mask(
    bounds: np.ndarray,
    margin_m: float,
    line_xy: np.ndarray,
    proj: LocalProjection,
) -> np.ndarray:
    """bool array: buffered envelope intersects the straight segment.

    ``bounds`` is (N, 4) of [xmin, ymin, xmax, ymax] in EPSG:4326.  The
    envelopes are transformed to the local metre frame, expanded by
    ``margin_m`` (exactly what the rasterizer blocks) and tested against the
    segment, mirroring the grid logic but in continuous space.
    """
    if bounds.shape[0] == 0:
        return np.zeros(0, dtype=bool)
    xs0, ys0 = proj.to_local_arr(bounds[:, 1], bounds[:, 0])
    xs1, ys1 = proj.to_local_arr(bounds[:, 3], bounds[:, 2])
    xs0 -= margin_m
    ys0 -= margin_m
    xs1 += margin_m
    ys1 += margin_m
    boxes = shapely.box(xs0, ys0, xs1, ys1)
    line = shapely.LineString(line_xy)
    return shapely.intersects(boxes, line)


def first_blocked_cell_on_line(
    grid: GeoGrid,
    start: Point,
    goal: Point,
) -> tuple[tuple[int, int] | None, float | None]:
    """First blocked cell crossed by the straight line (or None if clear).

    Returns ``((i, j), dist_m_along_line)`` where the distance is measured
    from the start cell centre along the line.
    """
    samples = LINE_SAMPLES_PER_CELL * max(grid.width, grid.height)
    pts = sample_line(start, goal, samples)
    start_xy = np.asarray(grid.proj.to_local(*start), dtype=float)
    goal_xy = np.asarray(grid.proj.to_local(*goal), dtype=float)
    for p in pts:
        cell = grid.geo_to_cell(*p)
        if grid.blocked[cell[1], cell[0]]:
            centre = grid.proj.to_local(*grid.cell_to_geo(*cell))
            dist = distance_along_line(np.asarray(centre), start_xy, goal_xy)
            return cell, dist
    return None, None


def classify_blockers(
    bounds: np.ndarray,
    rowids: np.ndarray,
    building_ids: np.ndarray,
    heights: np.ndarray,
    margin_m: float,
    line_xy: np.ndarray,
    proj: LocalProjection,
    real_hit_rowids: set[int],
) -> list[Blocker]:
    """Classify every obstacle whose buffered envelope crosses the line.

    ``real_hit_rowids`` are the buildings whose *actual polygon* intersects
    the straight segment (from DuckDB ST_Intersects).  Everything else in
    ``bounds`` that hits is an envelope-only rasterization artefact.
    """
    if bounds.shape[0] == 0:
        return []
    mask = envelope_hit_mask(bounds, margin_m, line_xy, proj)
    if not mask.any():
        return []
    idx = np.nonzero(mask)[0]
    xs0, ys0 = proj.to_local_arr(bounds[:, 1], bounds[:, 0])
    xs1, ys1 = proj.to_local_arr(bounds[:, 3], bounds[:, 2])
    a = np.asarray(line_xy[0])
    b = np.asarray(line_xy[-1])
    blockers: list[Blocker] = []
    for k in idx:
        centre = np.asarray([(xs0[k] + xs1[k]) / 2.0, (ys0[k] + ys1[k]) / 2.0])
        dist = distance_along_line(centre, a, b)
        real = int(rowids[k]) in real_hit_rowids
        blockers.append(
            Blocker(
                building_id=str(building_ids[k]),
                height_m=float(heights[k]) if not np.isnan(heights[k]) else None,
                rowid=int(rowids[k]),
                dist_along_line_m=round(dist, 1),
                real_geometry_hit=real,
                envelope_only_hit=not real,
            )
        )
    blockers.sort(key=lambda bl: bl.dist_along_line_m)
    return blockers


# --------------------------------------------------------------------------
# layer builders (GeoJSON FeatureCollections)
# --------------------------------------------------------------------------


def _line_geojson(points_lonlat: list[LonLat], color: str, weight: int = 4) -> dict:
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {"color": color, "weight": weight},
                "geometry": {"type": "LineString", "coordinates": points_lonlat},
            }
        ],
    }


def _polygons_geojson(
    geometries: list,
    ids: list[str],
    heights: list[float | None],
    fill: str,
    stroke: str,
) -> dict:
    feats = []
    for geom, bid, h in zip(geometries, ids, heights):
        if geom is None or geom.is_empty:
            continue
        feats.append(
            {
                "type": "Feature",
                "properties": {
                    "id": bid,
                    "height": h,
                    "fill": fill,
                    "stroke": stroke,
                },
                "geometry": shapely.geometry.mapping(geom),
            }
        )
    return {"type": "FeatureCollection", "features": feats}


def _cells_geojson(cells: list[tuple[int, int]], grid: GeoGrid, color: str) -> dict:
    feats = []
    for i, j in cells:
        x0 = i * grid.cell_size_m
        y0 = j * grid.cell_size_m
        x1 = x0 + grid.cell_size_m
        y1 = y0 + grid.cell_size_m
        lat0, lon0 = grid.proj.to_geo(x0, y0)
        lat1, lon1 = grid.proj.to_geo(x1, y1)
        feats.append(
            {
                "type": "Feature",
                "properties": {"color": color},
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [
                        [
                            [lon0, lat0], [lon1, lat0],
                            [lon1, lat1], [lon0, lat1], [lon0, lat0],
                        ]
                    ],
                },
            }
        )
    return {"type": "FeatureCollection", "features": feats}





# --------------------------------------------------------------------------
# orchestrator
# --------------------------------------------------------------------------


class Diagnoser:
    """Runs the real pipeline and gathers every diagnostic layer."""

    def __init__(self, config: Settings) -> None:
        self.config = config
        self._planner = RoutePlanner(config)
        self._raw_path: list | None = None

    def close(self) -> None:
        self._planner.close()

    # -- DuckDB geometry helpers -----------------------------------------
    def _real_geometry_hit_rowids(
        self, start: Point, goal: Point
    ) -> set[int]:
        """Buildings whose actual polygon intersects the straight segment.

        Uses the R-tree index on the region table; this is exactly the test a
        geometry-based direct-line fast path would perform.
        """
        con = self._planner.con
        wkt = f"LINESTRING({start[1]} {start[0]}, {goal[1]} {goal[0]})"
        rows = con.execute(
            f"SELECT rowid FROM {REGION_TABLE} "
            f"WHERE ST_Intersects(geometry, ST_GeomFromText(?))",
            [wkt],
        ).fetchall()
        return {int(r[0]) for r in rows}

    def _building_metadata(
        self, rowids: np.ndarray
    ) -> tuple[np.ndarray, np.ndarray]:
        """(ids, heights) aligned with ``rowids`` (keyed by rowid, so the
        ``WHERE rowid IN`` result order can never misalign the arrays)."""
        con = self._planner.con
        id_by_row: dict[int, str] = {}
        height_by_row: dict[int, float] = {}
        for chunk in np.array_split(rowids, max(1, int(np.ceil(len(rowids) / 500)))):
            if chunk.size == 0:
                continue
            in_list = ", ".join(str(int(v)) for v in chunk)
            for rid, hid, h in con.execute(
                f"SELECT rowid, id, height FROM {REGION_TABLE} "
                f"WHERE rowid IN ({in_list})"
            ).fetchall():
                id_by_row[int(rid)] = str(hid)
                height_by_row[int(rid)] = float(h) if h is not None else math.nan
        ids = np.asarray([id_by_row.get(int(r), "?") for r in rowids], dtype=object)
        heights = np.asarray([height_by_row.get(int(r), math.nan) for r in rowids], dtype=float)
        return ids, heights

    # -- main entry -------------------------------------------------------
    def run(
        self,
        start: Point,
        goal: Point,
        *,
        algorithm: str | None = None,
        out_dir: Path,
        snap: bool = False,
    ) -> DiagnosisResult:
        cfg = self.config
        if algorithm:
            cfg = dataclasses.replace(cfg, planner_algorithm=algorithm)
        self._planner.config = cfg

        # direct-line fast path decision - exactly the check plan() performs
        # before any region materialisation (real geometries only)
        dcheck = is_direct_path_clear(
            self._planner.con, cfg, start, goal, list(cfg.obstacle_rings)
        )

        t0 = time.perf_counter()
        bbox = bbox_of_points(
            [start, goal],
            cfg.bbox_expansion_m + cfg.safety_margin_m + cfg.grid_resolution_m,
        )
        stats = self._planner.load_region(bbox)

        sources: list[ObstacleSource] = [
            BuildingsSource(self._planner.con, REGION_TABLE, bbox)
        ]
        if cfg.water_parquet:
            sources.append(WaterSource(self._planner.con, WATER_TABLE, bbox))
        if cfg.obstacle_rings:
            sources.append(NoFlySource(list(cfg.obstacle_rings)))

        grid = self._planner.generate_grid(bbox, sources)
        path_found = True
        route_pts: list[Point] = []
        try:
            raw_path = self._planner.find_path(start, goal, snap=snap)
            self._planner.smooth_path()
            wps = self._planner.generate_waypoints()
            # same geometry-exact shortcut pass plan() applies, so the viewer
            # shows the route the API would actually return
            try:
                wps = self._planner.smooth_waypoints_geometry(list(wps), sources)
            except Exception:  # noqa: BLE001 - keep the grid-smoothed path
                pass
            route_pts = [(lat, lon) for lat, lon, _ in wps]
        except NoPathError:
            raw_path = None
            path_found = False
        self._raw_path: list | None = raw_path

        planning_time = time.perf_counter() - t0
        mission_id = f"diag-{int(t0 * 1000) % 10_000_000}"

        result = DiagnosisResult(
            start=start,
            goal=goal,
            mission_id=mission_id,
            straight_distance_m=round(path_length_m([start, goal]), 2),
            route_distance_m=round(path_length_m(route_pts), 2) if route_pts else None,
            detour_ratio=(
                round(path_length_m(route_pts) / path_length_m([start, goal]) - 1.0, 4)
                if route_pts
                else None
            ),
            path_found=path_found,
            algorithm=cfg.planner_algorithm,
            grid=grid,
            region_stats=(stats.buildings, stats.water),
            planning_time_s=round(planning_time, 3),
            direct_path_clear=dcheck.clear,
            direct_path_check_s=round(dcheck.check_time_s, 4),
            direct_path_building_hit=dcheck.building_hit,
            direct_path_water_hit=dcheck.water_hit,
            direct_path_no_fly_hit=dcheck.no_fly_hit,
            region_bbox=bbox,
        )

        # ---- straight-line blocker analysis ----
        bounds, rowids = region_store.region_bounds(
            self._planner.con, REGION_TABLE, *bbox
        )
        real_hits = self._real_geometry_hit_rowids(start, goal)
        ids, heights = self._building_metadata(rowids)
        line_local = np.asarray(
            [
                grid.proj.to_local(*start),
                grid.proj.to_local(*goal),
            ],
            dtype=float,
        )
        blockers = classify_blockers(
            bounds, rowids, ids, heights,
            cfg.safety_margin_m, line_local, grid.proj, real_hits,
        )
        result.blockers = blockers
        result.n_real_geometry_hits = sum(1 for b in blockers if b.real_geometry_hit)
        result.n_envelope_only_hits = sum(1 for b in blockers if b.envelope_only_hit)
        result.height_coverage = int(np.isfinite(heights).sum())

        # ---- first blocked cell + its owner ----
        cell, dist = first_blocked_cell_on_line(grid, start, goal)
        result.first_blocked_cell = cell
        result.first_blocked_cell_dist_m = dist
        if cell is not None and blockers:
            cell_centre = grid.proj.to_local(*grid.cell_to_geo(*cell))
            xs0, ys0 = grid.proj.to_local_arr(bounds[:, 1], bounds[:, 0])
            xs1, ys1 = grid.proj.to_local_arr(bounds[:, 3], bounds[:, 2])
            cx, cy = cell_centre
            containing = (
                (xs0 - cfg.safety_margin_m <= cx) & (cx <= xs1 + cfg.safety_margin_m)
                & (ys0 - cfg.safety_margin_m <= cy) & (cy <= ys1 + cfg.safety_margin_m)
            )
            if containing.any():
                k = int(np.nonzero(containing)[0][0])
                result.first_blocked_cell_owner = classify_blockers(
                    bounds[k : k + 1], rowids[k : k + 1], ids[k : k + 1],
                    heights[k : k + 1], cfg.safety_margin_m, line_local,
                    grid.proj, real_hits,
                )[0]

        # ---- GeoJSON layers ----
        result.hit_polygons_geojson = self._hit_polygons_layer(
            start, goal, real_hits, list(cfg.obstacle_rings)
        )
        result.rasterization_mode = (
            "exact_polygon" if cfg.rasterize_exact_polygons else "envelope"
        )
        result.polygon_buffer_m = cfg.polygon_buffer_m

        # ---- legacy-vs-exact rasterization comparison ----------------------
        # Re-paint the SAME scene with the buffered-bounding-box rasterizer
        # so the viewer and report show exactly what changed.
        old_cfg = dataclasses.replace(cfg, rasterize_exact_polygons=False)
        old_grid = Rasterizer(old_cfg).build_grid(bbox, cfg.grid_resolution_m)
        Rasterizer(old_cfg).rasterize(old_grid, sources)
        result.blocked_cells_exact_count = int(grid.blocked.sum())
        result.blocked_cells_envelope_count = int(old_grid.blocked.sum())
        result.recovered_cells = max(
            0, result.blocked_cells_envelope_count - result.blocked_cells_exact_count
        )
        band_cells = cfg.safety_margin_m + 3 * grid.cell_size_m
        old_cells = self._blocked_cells_near_line(old_grid, line_local, band_cells)
        if old_cells:
            if len(old_cells) > MAX_BLOCKED_CELLS:
                step = int(np.ceil(len(old_cells) / MAX_BLOCKED_CELLS))
                old_cells = old_cells[::step]
            result.old_blocked_cells_geojson = _cells_geojson(
                old_cells, old_grid, "#a855f7"
            )

        result.straight_line_geojson = _line_geojson(
            [(start[1], start[0]), (goal[1], goal[0])], "#22c55e"
        )
        if route_pts:
            result.route_geojson = _line_geojson(
                [(lon, lat) for lat, lon in route_pts], "#3b82f6"
            )
        if getattr(self, "_raw_path", None):
            result.raw_path_geojson = _line_geojson(
                [grid.cell_to_geo(*c) for c in self._raw_path], "#94a3b8"
            )
        self._build_visual_layers(result, bounds, rowids, ids, heights, grid)
        return result

    def _build_visual_layers(
        self,
        result: DiagnosisResult,
        bounds: np.ndarray,
        rowids: np.ndarray,
        ids: np.ndarray,
        heights: np.ndarray,
        grid: GeoGrid,
    ) -> None:
        """Fetch polygons (capped) and paint the blocked cells near the line."""
        cfg = self.config
        # buildings to show: those intersecting the straight line + a band
        line_local = np.asarray(
            [grid.proj.to_local(*result.start), grid.proj.to_local(*result.goal)]
        )
        band = cfg.safety_margin_m + 3 * grid.cell_size_m
        mask = (
            envelope_hit_mask(bounds, band, line_local, grid.proj)
            if bounds.shape[0]
            else np.zeros(0, dtype=bool)
        )
        show = mask
        if show.any():
            idx = np.nonzero(show)[0]
            if idx.size > MAX_BUILDING_POLYGONS:
                idx = idx[:: int(np.ceil(idx.size / MAX_BUILDING_POLYGONS))]
            sel_rowids = rowids[idx]
            geom_by_row = region_store.region_geom_by_rowid(
                self._planner.con, REGION_TABLE, sel_rowids
            )
            shp: list = []
            sel_ids: list[str] = []
            sel_heights: list[float | None] = []
            for k in idx:
                geom = geom_by_row.get(int(rowids[k]))
                if geom is None:
                    continue
                shp.append(geom)
                sel_ids.append(str(ids[k]))
                sel_heights.append(
                    float(heights[k]) if not np.isnan(heights[k]) else None
                )
            result.buildings_geojson = _polygons_geojson(
                shp, sel_ids, sel_heights, "#facc15", "#ca8a04"
            )
            # buffered envelopes (what the legacy grid blocks)
            xs0, ys0 = grid.proj.to_local_arr(bounds[idx, 1], bounds[idx, 0])
            xs1, ys1 = grid.proj.to_local_arr(bounds[idx, 3], bounds[idx, 2])
            buffers = []
            for k in range(len(idx)):
                buffers.append(
                    shapely.box(
                        xs0[k] - cfg.safety_margin_m,
                        ys0[k] - cfg.safety_margin_m,
                        xs1[k] + cfg.safety_margin_m,
                        ys1[k] + cfg.safety_margin_m,
                    )
                )
            buf_geo = []
            for b in buffers:
                buf_geo.append(_local_box_to_geo(b, grid.proj))
            result.buffered_geojson = _polygons_geojson(
                buf_geo, sel_ids, sel_heights, "#f97316", "#ea580c"
            )
            # raw bounding boxes (the legacy envelope WITHOUT the margin)
            raw_geo = []
            for k in range(len(idx)):
                raw_geo.append(
                    _local_box_to_geo(
                        shapely.box(xs0[k], ys0[k], xs1[k], ys1[k]), grid.proj
                    )
                )
            result.bbox_geojson = _polygons_geojson(
                raw_geo, sel_ids, sel_heights, "#fde68a", "#f59e0b"
            )
            # buffered polygons (what exact rasterization paints)
            buf_polys = []
            for geom in shp:
                local = shapely.affinity.affine_transform(
                    geom, grid.proj.affine_transform()
                )
                buf_polys.append(
                    _local_geom_to_geo(local.buffer(cfg.polygon_buffer_m), grid.proj)
                )
            result.buffered_polygons_geojson = _polygons_geojson(
                buf_polys, sel_ids, sel_heights, "#ec4899", "#db2777"
            )

        # blocked cells near the straight line (capped)
        cells = self._blocked_cells_near_line(grid, line_local, band)
        if cells:
            if len(cells) > MAX_BLOCKED_CELLS:
                step = int(np.ceil(len(cells) / MAX_BLOCKED_CELLS))
                cells = cells[::step]
            result.blocked_cells_geojson = _cells_geojson(cells, grid, "#ef4444")

        # blocker highlights (markers at envelope centres)
        if result.blockers:
            feats = []
            xs0, ys0 = grid.proj.to_local_arr(bounds[:, 1], bounds[:, 0])
            xs1, ys1 = grid.proj.to_local_arr(bounds[:, 3], bounds[:, 2])
            for bl in result.blockers:
                k = int(np.nonzero(rowids == bl.rowid)[0][0])
                lon, lat = grid.proj.to_geo(
                    (xs0[k] + xs1[k]) / 2.0, (ys0[k] + ys1[k]) / 2.0
                )
                kind = "real geometry" if bl.real_geometry_hit else "envelope-only"
                feats.append(
                    {
                        "type": "Feature",
                        "properties": {
                            "id": bl.building_id,
                            "height": bl.height_m,
                            "dist_m": bl.dist_along_line_m,
                            "kind": kind,
                            "marker-color": "#dc2626",
                        },
                        "geometry": {"type": "Point", "coordinates": [lon, lat]},
                    }
                )
            result.blockers_geojson = {"type": "FeatureCollection", "features": feats}

    def _hit_polygons_layer(
        self,
        start: Point,
        goal: Point,
        building_rowids: set[int],
        no_fly_zones: list,
    ) -> dict | None:
        """Red layer: the ACTUAL obstacle polygons crossing the straight line.

        This is the ground truth the direct-line fast path tests - buildings,
        water and no-fly polygons whose geometry really intersects the
        segment (no buffered envelopes, no margins).  Missing/None geometries
        are skipped.
        """
        con = self._planner.con
        line_wkt = f"LINESTRING({start[1]} {start[0]}, {goal[1]} {goal[0]})"
        line = shapely.LineString([(start[1], start[0]), (goal[1], goal[0])])
        feats: list[dict] = []

        def _add(kind: str, geom, ident: str) -> None:
            if geom is None or geom.is_empty:
                return
            feats.append(
                {
                    "type": "Feature",
                    "properties": {
                        "kind": kind,
                        "id": ident,
                        "fill": "#dc2626",
                        "stroke": "#7f1d1d",
                    },
                    "geometry": shapely.geometry.mapping(geom),
                }
            )

        if building_rowids:
            arr = np.fromiter(building_rowids, dtype=np.int64)
            if arr.size > MAX_BUILDING_POLYGONS:
                step = int(np.ceil(arr.size / MAX_BUILDING_POLYGONS))
                arr = arr[::step]
            geom_by_row = region_store.region_geom_by_rowid(con, REGION_TABLE, arr)
            for rid, geom in geom_by_row.items():
                _add("building", geom, str(rid))

        if self.config.water_parquet:
            try:
                rows = con.execute(
                    f"SELECT rowid, ST_AsWKB(geometry) FROM {WATER_TABLE} "
                    f"WHERE ST_Intersects(geometry, ST_GeomFromText(?))",
                    [line_wkt],
                ).fetchall()
            except duckdb.Error:
                rows = []
            for rid, wkb in rows:
                _add("water", shapely.from_wkb(bytes(wkb)), str(rid))

        for ring in no_fly_zones:
            poly = shapely.geometry.Polygon([(lon, lat) for lat, lon in ring])
            if poly.intersects(line):
                _add("no-fly", poly, "no-fly-zone")

        if not feats:
            return None
        return {"type": "FeatureCollection", "features": feats}

    @staticmethod
    def _blocked_cells_near_line(
        grid: GeoGrid, line_local: np.ndarray, band_m: float
    ) -> list[tuple[int, int]]:
        """Blocked cells within ``band_m`` of the straight segment (sampled)."""
        a = line_local[0]
        b = line_local[1]
        x0, y0 = min(a[0], b[0]) - band_m, min(a[1], b[1]) - band_m
        x1, y1 = max(a[0], b[0]) + band_m, max(a[1], b[1]) + band_m
        i0 = max(int(x0 // grid.cell_size_m), 0)
        i1 = min(int(x1 // grid.cell_size_m), grid.width - 1)
        j0 = max(int(y0 // grid.cell_size_m), 0)
        j1 = min(int(y1 // grid.cell_size_m), grid.height - 1)
        out: list[tuple[int, int]] = []
        # distance from cell centre to segment (cheap threshold test)
        dx, dy = b[0] - a[0], b[1] - a[1]
        length_sq = dx * dx + dy * dy
        for j in range(j0, j1 + 1):
            row = grid.blocked[j]
            for i in range(i0, i1 + 1):
                if not row[i]:
                    continue
                cx = (i + 0.5) * grid.cell_size_m
                cy = (j + 0.5) * grid.cell_size_m
                if length_sq == 0:
                    d = math.hypot(cx - a[0], cy - a[1])
                else:
                    t = ((cx - a[0]) * dx + (cy - a[1]) * dy) / length_sq
                    t = min(max(t, 0.0), 1.0)
                    px, py = a[0] + t * dx, a[1] + t * dy
                    d = math.hypot(cx - px, cy - py)
                if d <= band_m:
                    out.append((i, j))
        return out


def _local_box_to_geo(box, proj: LocalProjection):
    """Reproject a local-metre shapely box back to EPSG:4326 lon/lat."""
    x0, y0, x1, y1 = box.bounds
    lat0, lon0 = proj.to_geo(x0, y0)
    lat1, lon1 = proj.to_geo(x1, y1)
    return shapely.geometry.box(lon0, lat0, lon1, lat1)


def _local_geom_to_geo(geom, proj: LocalProjection):
    """Reproject a local-metre shapely geometry back to EPSG:4326 lon/lat."""
    ox, oy = proj.origin_lon, proj.origin_lat
    sx, sy = proj.scale_x, proj.scale_y

    def _back(coords):
        out = coords.copy()
        out[:, 0] = ox + out[:, 0] / sx
        out[:, 1] = oy + out[:, 1] / sy
        return out

    return shapely.transform(geom, _back)





# --------------------------------------------------------------------------
# reporting
# --------------------------------------------------------------------------


def report_dict(result: DiagnosisResult) -> dict:
    """Machine-readable findings."""
    return {
        "mission_id": result.mission_id,
        "start": result.start,
        "goal": result.goal,
        "algorithm": result.algorithm,
        "path_found": result.path_found,
        "straight_distance_m": result.straight_distance_m,
        "route_distance_m": result.route_distance_m,
        "detour_ratio": result.detour_ratio,
        "planning_time_s": result.planning_time_s,
        "region": {
            "buildings": result.region_stats[0],
            "water": result.region_stats[1],
            "buildings_with_height": result.height_coverage,
        },
        "grid": (
            {
                "width": result.grid.width,
                "height": result.grid.height,
                "cell_size_m": result.grid.cell_size_m,
                "blocked_cells": int(result.grid.blocked.sum()),
            }
            if result.grid
            else None
        ),
        "straight_line": {
            "blocked_by_real_geometry": result.n_real_geometry_hits,
            "blocked_by_envelope_only": result.n_envelope_only_hits,
            "first_blocked_cell": result.first_blocked_cell,
            "first_blocked_cell_dist_m": result.first_blocked_cell_dist_m,
        },
        "rasterization": {
            "mode": result.rasterization_mode,
            "polygon_buffer_m": result.polygon_buffer_m,
            "blocked_cells_exact": result.blocked_cells_exact_count,
            "blocked_cells_envelope": result.blocked_cells_envelope_count,
            "recovered_cells": result.recovered_cells,
        },
        "direct_path": {
            "accepted": result.direct_path_clear,
            "check_time_s": result.direct_path_check_s,
            "building_hit": result.direct_path_building_hit,
            "water_hit": result.direct_path_water_hit,
            "no_fly_hit": result.direct_path_no_fly_hit,
        },
        "blockers": [
            {
                "id": b.building_id,
                "height_m": b.height_m,
                "dist_along_line_m": b.dist_along_line_m,
                "real_geometry_hit": b.real_geometry_hit,
                "envelope_only_hit": b.envelope_only_hit,
            }
            for b in result.blockers
        ],
    }


def report_text(result: DiagnosisResult) -> str:
    lines: list[str] = []
    lines.append(f"Diagnosis: {result.mission_id}")
    lines.append(f"  start      : {result.start[0]:.6f}, {result.start[1]:.6f}")
    lines.append(f"  goal       : {result.goal[0]:.6f}, {result.goal[1]:.6f}")
    lines.append(f"  algorithm  : {result.algorithm}")
    lines.append(f"  straight   : {result.straight_distance_m:,.0f} m")
    if result.route_distance_m is not None:
        lines.append(f"  route      : {result.route_distance_m:,.0f} m")
        lines.append(f"  detour     : +{result.detour_ratio * 100:.1f} %")
    lines.append(f"  path found : {'yes' if result.path_found else 'NO'}")
    if result.grid:
        g = result.grid
        lines.append(
            f"  grid       : {g.width}x{g.height} cells @ {g.cell_size_m:.0f} m "
            f"({int(g.blocked.sum()):,} blocked)"
        )
    lines.append(f"  planning   : {result.planning_time_s:.2f} s")
    lines.append(
        "  note       : diagnosis runs with snap_start_goal=false (strict line); "
        "the API may snap blocked endpoints when the client asks for it"
    )
    lines.append("")
    lines.append("Direct-line fast path")
    if result.direct_path_clear is None:
        lines.append(
            "  check      : skipped/errored - grid planner used "
            f"({result.direct_path_check_s:.4f} s)"
        )
    elif result.direct_path_clear:
        lines.append(
            "  ACCEPTED - the straight line is clear of actual obstacle polygons;"
            " plan() would return exactly 2 waypoints (start, goal)"
        )
    else:
        why = ", ".join(
            [
                name
                for hit, name in (
                    (result.direct_path_building_hit, "buildings"),
                    (result.direct_path_water_hit, "water"),
                    (result.direct_path_no_fly_hit, "no-fly zones"),
                )
                if hit
            ]
        )
        lines.append(
            f"  REJECTED - the straight line crosses {why or 'obstacles'};"
            " plan() falls back to the full grid pipeline"
        )
    lines.append(f"  check      : {result.direct_path_check_s:.4f} s (real-geometry"
                 " ST_Intersects, no envelopes/margins)")
    lines.append("")
    lines.append(
        f"  height data : {result.height_coverage} of {result.region_stats[0]} "
        f"buildings have a height value"
    )
    if result.height_coverage < result.region_stats[0] * 0.5:
        lines.append(
            "    NOTE: sparse height data - altitude-aware obstacle filtering"
            " would have little to work with on this dataset"
        )
    lines.append("Straight-line clearance")
    lines.append(
        f"  real geometry hits : {result.n_real_geometry_hits} "
        f"(buildings that physically cross the line)"
    )
    lines.append(
        f"  envelope-only hits : {result.n_envelope_only_hits} "
        f"(only the buffered envelope does - rasterization artefact)"
    )
    lines.append("Rasterization")
    lines.append(
        f"  mode           : {result.rasterization_mode} "
        f"(polygon buffer {result.polygon_buffer_m:.1f} m)"
    )
    lines.append(
        f"  blocked cells  : exact {result.blocked_cells_exact_count:,} vs "
        f"envelope {result.blocked_cells_envelope_count:,} "
        f"-> {result.recovered_cells:,} cells freed by exact painting"
    )
    if result.first_blocked_cell:
        lines.append(
            f"  first blocked cell: {result.first_blocked_cell} "
            f"at {result.first_blocked_cell_dist_m:,.0f} m along the line"
        )
        if result.first_blocked_cell_owner:
            o = result.first_blocked_cell_owner
            lines.append(
                f"  -> caused by building {o.building_id} "
                f"(height {o.height_m} m, {'real' if o.real_geometry_hit else 'envelope-only'})"
            )
    else:
        lines.append("  straight line is clear of blocked cells")
        if (result.route_distance_m is not None and result.detour_ratio
                and result.detour_ratio > 0.001):
            lines.append(
                "  -> but the route still detours: the deviation is a GRID/SMOOTHING"
                " artefact (A* cell-centre path + conservative corner-safe LOS),"
                " not an obstacle.  A direct-line fast path that tests the real"
                " geometries (ST_Intersects) would return a straight route."
            )
    if result.blockers:
        lines.append("")
        lines.append("Obstacles crossing the straight line (nearest first):")
        for b in result.blockers[:15]:
            kind = "REAL" if b.real_geometry_hit else "envelope"
            h = f"{b.height_m:.1f} m" if b.height_m is not None else "n/a"
            lines.append(
                f"  {b.dist_along_line_m:>9,.0f} m  {b.building_id:<12} "
                f"height {h:<8} {kind}"
            )
        if len(result.blockers) > 15:
            lines.append(f"  ... and {len(result.blockers) - 15} more")
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------


def main() -> None:
    ap = argparse.ArgumentParser(description="Diagnose route deviation from the straight line")
    ap.add_argument("--start-lat", type=float, required=True)
    ap.add_argument("--start-lon", type=float, required=True)
    ap.add_argument("--goal-lat", type=float, required=True)
    ap.add_argument("--goal-lon", type=float, required=True)
    ap.add_argument("--out", default="planner/data/diag", type=Path)
    ap.add_argument("--algorithm", choices=["astar", "theta_star"], default=None)
    ap.add_argument("--grid", type=float, default=None, help="grid resolution (m)")
    ap.add_argument("--margin", type=float, default=None, help="safety margin (m)")
    ap.add_argument("--alt", type=float, default=None, help="altitude (m)")
    ap.add_argument("--parquet", default=None, help="buildings GeoParquet path")
    ap.add_argument("--raster-mode", choices=["exact", "envelope"], default="exact",
                    help="rasterization mode for the planned route (the viewer "
                    "always shows BOTH blocked-cell layers for comparison)")
    ap.add_argument("--snap", action="store_true",
                    help="snap a blocked start/goal to the nearest free cell "
                    "(mirrors plan(snap_start_goal=True))")
    args = ap.parse_args()

    cfg = Settings.from_env()
    if args.grid:
        cfg = dataclasses.replace(cfg, grid_resolution_m=args.grid)
    if args.margin is not None:
        cfg = dataclasses.replace(cfg, safety_margin_m=args.margin)
    if args.alt:
        cfg = dataclasses.replace(cfg, default_altitude_m=args.alt)
    if args.parquet:
        cfg = dataclasses.replace(cfg, buildings_parquet=args.parquet)
    if args.raster_mode == "envelope":
        cfg = dataclasses.replace(cfg, rasterize_exact_polygons=False)
    # mirror plan(): the grid corridor is capped at the safety margin so a
    # diagnosis with --margin 0 paints the same grid the API would
    buf = effective_polygon_buffer(cfg)
    if buf != cfg.polygon_buffer_m:
        cfg = dataclasses.replace(cfg, polygon_buffer_m=buf)

    start = (args.start_lat, args.start_lon)
    goal = (args.goal_lat, args.goal_lon)

    diagnoser = Diagnoser(cfg)
    try:
        result = diagnoser.run(
            start, goal, algorithm=args.algorithm, out_dir=args.out, snap=args.snap
        )
    finally:
        diagnoser.close()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    layers = out / "layers"
    layers.mkdir(parents=True, exist_ok=True)

    (out / "report.json").write_text(json.dumps(report_dict(result), indent=2))
    (out / "report.txt").write_text(report_text(result))

    named = {
        "straight_line": result.straight_line_geojson,
        "route": result.route_geojson,
        "raw_path": result.raw_path_geojson,
        "buildings": result.buildings_geojson,
        "bbox": result.bbox_geojson,
        "buffered": result.buffered_geojson,
        "buffered_polygons": result.buffered_polygons_geojson,
        "blocked_cells": result.blocked_cells_geojson,
        "old_blocked_cells": result.old_blocked_cells_geojson,
        "blockers": result.blockers_geojson,
        "hit_polygons": result.hit_polygons_geojson,
    }
    for name, geojson in named.items():
        if geojson is not None:
            (layers / f"{name}.geojson").write_text(json.dumps(geojson))

    (out / "viewer.html").write_text(render_viewer(named, report_dict(result)))

    print(report_text(result))
    print(f"layers -> {layers}/")
    print(f"report -> {out / 'report.txt'}")
    print(f"viewer -> {out / 'viewer.html'}  (open in a browser)")


if __name__ == "__main__":
    main()
