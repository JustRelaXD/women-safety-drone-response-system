"""RoutePlanner - the orchestrator (facade) for the whole pipeline.

Pipeline (all steps below 1 GB RAM, verified in the research phase):

    mission bbox -> DuckDB region (bbox pushdown + RTREE index)
                 -> obstacle sources (buildings / water / no-fly / future)
                 -> planner algorithm -> smoothing -> GPS waypoints

The pathfinding algorithm is configurable (``config.planner_algorithm``):

- ``astar``      - uniform-grid A* (default when the benchmark said so)
- ``theta_star`` - any-angle grid search, shorter paths than A*
- ``visibility`` - exact shortest path over convexified obstacle polygons;
                   construction is O(V^2), so it is capped and only suited to
                   small working regions (see the algorithm-comparison report)

The planner is independent of any drone stack: it ingests plain (lat, lon)
points and emits GPS waypoints.  Each instance is cheap and per-request; the
API layer constructs one per planning call.

The grid branch ends with two smoothing stages: cell-level LOS smoothing
followed by a geometry-exact shortcut pass (``smooth_waypoints_geometry``)
over the final waypoint polyline that straightens the route against the
actual obstacle polygons + safety margin, eliminating the staircase/detour
artefacts of envelope rasterization.
"""

from __future__ import annotations

import dataclasses
import logging
import time
import uuid
from dataclasses import dataclass
from typing import Callable, Sequence

import duckdb
import numpy as np
import shapely

logger = logging.getLogger(__name__)

from ..core.config import NoFlyRing, Settings, ZoneRecord
from ..core.exceptions import InfeasibleError, NoPathError, RegionLoadError
from ..core.geometry import (
    BBox,
    LocalProjection,
    M_PER_DEG_LAT,
    Point,
    bbox_of_points,
    meters_per_degree_lon,
    path_length_m,
)
from ..overture import region as region_store
from ..overture.region import REGION_TABLE, WATER_TABLE
from . import direct_path
from .astar import AStar, closest_reachable_cell
from .grid import GeoGrid, Rasterizer, _to_local_affine
from .obstacles import (
    BuildingsSource,
    NoFlySource,
    ObstacleSource,
    WaterSource,
)
from .smoothing import smooth_path as _smooth
from .smoothing import smooth_path_geometry as _smooth_geometry
from .theta_star import ThetaStar
from .visibility import VisibilityPath, VisibilityPlanner
from .waypoints import Waypoint, path_to_waypoints, points_to_waypoints

Cell = tuple[int, int]

#: progress callback: ``(event, payload)``.  ``event`` is one of
#: ``"region"``, ``"grid"``, ``"path"``, ``"smooth"``, ``"geometry"``,
#: ``"direct"`` or ``"degraded"``; the payload carries stage detail and,
#: for the waypoint events (path/smooth/geometry), the current best
#: ``waypoints`` so a streaming client can draw the route as it is refined.
ProgressFn = Callable[[str, dict], None]


def _crossed_zones(
    waypoints: list[Waypoint], records: Sequence[ZoneRecord]
) -> tuple[ZoneRecord, ...]:
    """Zones whose polygon the route polyline intersects, kind preserved.

    Runs against the FINAL waypoints (after smoothing / thinning), so it
    reflects exactly what the drone will fly.  Both red and amber crossings
    are reported: red ones should never happen on a normal route (they are
    obstacles) but can appear on a degraded fallback route - where the
    operator must see them; amber ones are the passable-with-permission
    crossings the operator needs to request permission for.
    """
    if not records or len(waypoints) < 2:
        return ()
    line = shapely.LineString([(lon, lat) for lat, lon, _ in waypoints])
    line_bounds = line.bounds
    crossed: list[ZoneRecord] = []
    for z in records:
        poly = shapely.geometry.Polygon([(lon, lat) for lat, lon in z.ring])
        # ``bounds`` on an empty geometry is (), so guard before indexing
        pb = poly.bounds
        if not pb or poly.is_empty:
            continue
        # cheap bounding-box reject before the (expensive) precise test
        if (
            pb[0] > line_bounds[2]
            or pb[2] < line_bounds[0]
            or pb[1] > line_bounds[3]
            or pb[3] < line_bounds[1]
        ):
            continue
        try:
            if poly.intersects(line):
                crossed.append(z)
        except Exception as exc:  # noqa: BLE001 - one bad ring must not kill the route
            logger.warning(
                "zone %r skipped during crossing check: %s", z.name, exc
            )
    return tuple(crossed)


def effective_polygon_buffer(cfg: Settings) -> float:
    """The grid corridor width used by exact-polygon rasterization.

    The API exposes ``safety_margin_m`` as THE clearance knob; the grid
    never widens beyond ``polygon_buffer_m`` (the config default), but
    lowering the margin below it tightens the corridor all the way down to
    0 m.  Legacy envelope mode expands the bounding box by
    ``safety_margin_m`` directly, so the cap does not apply there.
    """
    if not cfg.rasterize_exact_polygons:
        return cfg.polygon_buffer_m
    return min(cfg.polygon_buffer_m, cfg.safety_margin_m)


@dataclass(frozen=True)
class RegionStats:
    buildings: int
    water: int


@dataclass(frozen=True)
class PlanningStats:
    buildings_queried: int
    water_queried: int
    grid_width: int
    grid_height: int
    cell_size_m: float
    nodes_explored: int
    path_cells: int
    planning_time_s: float
    #: visibility-graph statistics (0 when a grid algorithm ran)
    graph_vertices: int = 0
    graph_edges: int = 0
    vis_build_time_s: float = 0.0
    vis_search_time_s: float = 0.0
    #: the direct-line fast path returned exactly [start, goal] and no grid
    #: was built (all grid fields are 0, nothing was materialised)
    direct_path: bool = False


@dataclass(frozen=True)
class RouteResult:
    mission_id: str
    distance: float
    estimated_time: float
    waypoints: tuple[Waypoint, ...]
    stats: PlanningStats
    #: null on a normal route; a human-readable warning when ``waypoints``
    #: are degraded (see ``RoutePlanner.plan`` docstring)
    warning: str | None = None
    #: the direct start->goal line, always available as an operator backup
    backup_waypoints: tuple[Waypoint, ...] | None = None
    #: every airspace zone the route crosses (kind preserved).  Amber =
    #: passable-with-permission (the operator must request permission and
    #: notify the airport authority); red should not appear on a normal
    #: route (it is an obstacle) but can on a degraded one.
    zones_crossed: tuple[ZoneRecord, ...] = ()


class RoutePlanner:
    """Composes the data layer, rasterizer, A*, smoother and waypoint
    converter.  Single-responsibility: it only orchestrates."""

    def __init__(self, config: Settings) -> None:
        self.config = config
        self._con: duckdb.DuckDBPyConnection | None = None
        self._region_bbox: BBox | None = None
        self._region_stats: RegionStats | None = None
        self._grid: GeoGrid | None = None
        self._last_path: list[Cell] | None = None
        self._last_smoothed: list[Cell] | None = None
        self._last_nodes_explored: int = 0
        self._last_geo_path: list[Point] | None = None
        self._last_visibility: VisibilityPath | None = None
        #: increments per search attempt so streaming clients can tell the
        #: growing line of ONE search from the restart of a NEW one (the
        #: degraded fallback can run several searches back to back)
        self._search_epoch = 0
        #: progress callback set per ``plan()`` call (None = silent, the
        #: default for benchmarks and plain library use)
        self._progress: ProgressFn | None = None

    def _emit(self, event: str, payload: dict) -> None:
        """Forward a progress event to the callback set by ``plan()``."""
        if self._progress is not None:
            try:
                self._progress(event, payload)
            except Exception:  # noqa: BLE001 - a listener must never break planning
                logger.warning("progress listener failed on %r", event, exc_info=True)

    # -- DuckDB connection (lazy, RAM-constrained) -------------------------
    @property
    def con(self) -> duckdb.DuckDBPyConnection:
        if self._con is None:
            self._con = region_store.connect_region_db(
                self.config.region_db_path,
                self.config.memory_limit,
                self.config.threads,
            )
        return self._con

    def close(self) -> None:
        if self._con is not None:
            self._con.close()
            self._con = None

    @property
    def grid(self) -> GeoGrid | None:
        """The last generated grid (None in visibility-graph mode)."""
        return self._grid

    @property
    def last_visibility(self) -> VisibilityPath | None:
        """The last visibility-graph result (stats for benchmarks)."""
        return self._last_visibility

    # -- Phase 2: the required public methods ------------------------------
    def load_region(self, bbox: BBox) -> RegionStats:
        """Materialise the buildings (and water) inside ``bbox`` into
        DuckDB tables with R-tree indexes.  Only pruned parquet row groups
        are read.  Returns row counts."""
        xmin, ymin, xmax, ymax = bbox
        try:
            n_buildings = region_store.load_region(
                self.con,
                self.config.buildings_parquet,
                xmin, ymin, xmax, ymax,
                build_index=self.config.build_rtree,
            )
        except duckdb.Error as exc:  # noqa: BLE001
            raise RegionLoadError(f"buildings region load failed: {exc}") from exc

        n_water = 0
        if self.config.water_parquet:
            try:
                n_water = region_store.load_water_region(
                    self.con,
                    self.config.water_parquet,
                    xmin, ymin, xmax, ymax,
                    build_index=self.config.build_rtree,
                )
            except duckdb.Error as exc:  # noqa: BLE001
                raise RegionLoadError(f"water region load failed: {exc}") from exc

        self._region_bbox = bbox
        self._region_stats = RegionStats(n_buildings, n_water)
        self._emit("region", {"buildings": n_buildings, "water": n_water})
        return self._region_stats

    def query_buildings(self, bbox: BBox) -> np.ndarray:
        """Envelope bounds (N, 4) of buildings intersecting ``bbox``,
        served by the R-tree index (no geometry decoding)."""
        return region_store.region_bounds(self.con, REGION_TABLE, *bbox)[0]

    def query_water(self, bbox: BBox) -> np.ndarray:
        """Envelope bounds of water intersecting ``bbox`` (empty if no
        water parquet is configured)."""
        if not self.config.water_parquet:
            return np.empty((0, 4), dtype=np.float64)
        return region_store.region_bounds(self.con, WATER_TABLE, *bbox)[0]

    def generate_grid(
        self,
        bbox: BBox | None = None,
        sources: list[ObstacleSource] | None = None,
    ) -> GeoGrid:
        """Build the grid over ``bbox`` (defaults to the loaded region) and
        rasterize the given obstacle sources onto it."""
        bbox = bbox if bbox is not None else self._region_bbox
        if bbox is None:
            raise RegionLoadError("call load_region() before generate_grid()")
        raster = Rasterizer(self.config)
        grid = raster.build_grid(bbox, self.config.grid_resolution_m)
        if sources:
            raster.rasterize(grid, sources)
        self._grid = grid
        self._emit(
            "grid",
            {
                "width": grid.width,
                "height": grid.height,
                "cell_size_m": grid.cell_size_m,
            },
        )
        return grid

    def find_path(self, start: Point, goal: Point, snap: bool = False) -> list[Cell]:
        """Grid search from ``start`` to ``goal`` (lat, lon) over the grid.

        Runs A* or Theta* per ``config.planner_algorithm``.  With
        ``snap=True`` a start/goal that lands on a blocked cell is shifted to
        the nearest free cell first (useful for imprecise GPS from a
        controller; off by default so planning stays strict).
        """
        if self._grid is None:
            raise RegionLoadError("call generate_grid() before find_path()")
        solver: AStar | ThetaStar
        if self.config.planner_algorithm == "theta_star":
            solver = ThetaStar(self._grid)
        else:
            solver = AStar(self._grid)
        start_cell = self._grid.geo_to_cell(*start)
        goal_cell = self._grid.geo_to_cell(*goal)
        if snap:
            start_cell = self._grid.snap_to_free_cell(*start_cell)
            goal_cell = self._grid.snap_to_free_cell(*goal_cell)
        self._search_epoch += 1
        epoch = self._search_epoch
        result = solver.find_path(
            start_cell,
            goal_cell,
            # stream the search itself: the route grows from start towards
            # the goal as the search finds cells ever closer to it (never
            # the sideways 360-degree frontier), throttled to a few frames/s
            progress=lambda cells: self._emit(
                "search",
                {
                    # epoch lets a client reset its line when a NEW search
                    # attempt begins (degraded fallback runs several)
                    "epoch": epoch,
                    "waypoints": path_to_waypoints(
                        self._grid,
                        cells,
                        self.config.default_altitude_m,
                        self.config.min_waypoint_spacing_m,
                    ),
                },
            ),
        )
        if result is None:
            raise NoPathError(
                f"no collision-free path from {start} to {goal} "
                f"(start or goal blocked, or no route)"
            )
        self._last_nodes_explored = result.nodes_explored
        self._last_path = list(result.cells)
        # live partial: the raw (un-smoothed) A*/Theta* path as waypoints,
        # so a streaming client can start drawing before smoothing finishes
        self._emit(
            "path",
            {
                "waypoints": path_to_waypoints(
                    self._grid,
                    self._last_path,
                    self.config.default_altitude_m,
                    self.config.min_waypoint_spacing_m,
                )
            },
        )
        return self._last_path

    def _plan_visibility(
        self,
        bbox: BBox,
        sources: list[ObstacleSource],
        start: Point,
        goal: Point,
        snap: bool,
    ) -> None:
        """Visibility-graph branch of :meth:`plan` (no grid is built)."""
        proj = LocalProjection(bbox[1], bbox[0])
        vp = VisibilityPlanner(self.config)
        self._last_visibility = vp.find_path(sources, proj, start, goal, snap=snap)
        if self._last_visibility is None:
            raise NoPathError(
                f"visibility graph: no collision-free path from {start} to {goal} "
                f"(start or goal inside an obstacle, or no route)"
            )
        self._last_geo_path = list(self._last_visibility.points)

    def smooth_path(self, path: list[Cell] | None = None) -> list[Cell]:
        """Greedy line-of-sight smoothing of a cell path."""
        path = path if path is not None else self._last_path
        if path is None:
            raise RegionLoadError("call find_path() before smooth_path()")
        self._last_smoothed = _smooth(self._grid, path)
        self._emit(
            "smooth",
            {
                "waypoints": path_to_waypoints(
                    self._grid,
                    self._last_smoothed,
                    self.config.default_altitude_m,
                    self.config.min_waypoint_spacing_m,
                )
            },
        )
        return self._last_smoothed

    def smooth_waypoints_geometry(
        self,
        waypoints: list[Waypoint],
        sources: list[ObstacleSource] | None = None,
    ) -> list[Waypoint]:
        """Geometry-exact shortcut over a final waypoint polyline.

        Tests straight shortcuts between the waypoints against the ACTUAL
        obstacle polygons near the route (buffered by the safety margin)
        instead of the rasterized cells, so the route can straighten through
        cells the envelope-rasterization over-blocks while never approaching
        a real obstacle closer than the margin.  Every segment in the result
        is guaranteed >= margin from every obstacle; endpoints and constant
        altitude are preserved, and waypoint spacing never shrinks (the pass
        only removes points).

        Note: only the obstacles near the route are fetched (bbox filter + a
        few chunked WKB queries), never the whole region.
        """
        if self._grid is None or len(waypoints) <= 2:
            return waypoints
        proj = self._grid.proj
        local_pts = [proj.to_local(lat, lon) for lat, lon, _ in waypoints]
        geoms = self._route_obstacle_geoms(
            sources or [], local_pts, self.config.safety_margin_m
        )
        kept = _smooth_geometry(
            local_pts, geoms, self.config.safety_margin_m
        )
        alt = waypoints[0][2]
        self._last_geo_path = [proj.to_geo(x, y) for x, y in kept]
        return [(*proj.to_geo(x, y), alt) for x, y in kept]

    def _route_obstacle_geoms(
        self,
        sources: list[ObstacleSource],
        local_pts: list[tuple[float, float]],
        margin_m: float,
    ) -> list:
        """Obstacle polygons near the route, transformed to the local frame.

        Filters each source's envelopes by the route corridor (expanded by
        the safety margin) and fetches only those polygons - the region can
        hold tens of thousands of buildings but only those near the route
        are decoded.  The lon/lat -> local-metre affine is applied with the
        vectorised ``shapely.transform`` (a Python loop over 38k geometries
        costs ~1.5 s; this is ~50x faster).
        """
        if self._grid is None:
            return []
        proj = self._grid.proj
        xs = [p[0] for p in local_pts]
        ys = [p[1] for p in local_pts]
        x0, x1 = min(xs) - margin_m, max(xs) + margin_m
        y0, y1 = min(ys) - margin_m, max(ys) + margin_m
        lat0, lon0 = proj.to_geo(x0, y0)
        lat1, lon1 = proj.to_geo(x1, y1)

        geoms: list = []
        for source in sources:
            bounds = source.bounds()
            if bounds.shape[0] == 0:
                continue
            mask = (
                (bounds[:, 0] <= lon1) & (bounds[:, 2] >= lon0)
                & (bounds[:, 1] <= lat1) & (bounds[:, 3] >= lat0)
            )
            idx = np.nonzero(mask)[0]
            if idx.size == 0:
                continue
            fetched = source.fetch(idx)
            # drop None / empty rows (defensive: ``shapely.transform`` would
            # crash on them; the rasterizer iterates and tolerates them, but
            # here they are never real obstacles anyway)
            good = [g for g in fetched if g is not None and not g.is_empty]
            if not good:
                continue
            local = shapely.transform(np.asarray(good, dtype=object), _to_local_affine(proj))
            geoms.extend(g for g in local if g is not None and not g.is_empty)
        return geoms

    def generate_waypoints(
        self,
        path: list[Cell] | None = None,
        altitude_m: float | None = None,
    ) -> list[Waypoint]:
        """Convert the last (smoothed) path into thinned GPS waypoints.

        Works for both grid-cell paths and visibility-graph geo paths.
        """
        alt = altitude_m if altitude_m is not None else self.config.default_altitude_m
        if path is None and self._last_geo_path is not None:
            # visibility-graph mode: the path is already a (lat, lon) polyline
            return points_to_waypoints(
                self._last_geo_path, alt, self.config.min_waypoint_spacing_m
            )
        path = path if path is not None else (self._last_smoothed or self._last_path)
        if path is None:
            raise RegionLoadError("call find_path() before generate_waypoints()")
        return path_to_waypoints(self._grid, path, alt, self.config.min_waypoint_spacing_m)

    # -- end-to-end ---------------------------------------------------------
    def plan(
        self,
        *,
        start: Point,
        goal: Point,
        mission_id: str | None = None,
        altitude_m: float | None = None,
        grid_resolution_m: float | None = None,
        safety_margin_m: float | None = None,
        speed_mps: float | None = None,
        bbox_expansion_m: float | None = None,
        no_fly_zones: list[tuple[tuple[float, float], ...]] | None = None,
        snap_start_goal: bool = False,
        algorithm: str | None = None,
        progress: ProgressFn | None = None,
    ) -> RouteResult:
        """Full pipeline: region -> obstacles -> planner -> waypoints.

        Keyword args mirror the API request; None means "use config".
        ``snap_start_goal`` shifts a start/goal that lands on a blocked cell
        to the nearest free cell (for imprecise controller GPS).
        ``algorithm`` overrides ``config.planner_algorithm`` for this call
        ("astar" / "theta_star" / "visibility").
        ``progress`` receives ``(event, payload)`` callbacks at every
        pipeline stage so a caller can stream partial results: ``region``
        and ``grid`` carry counts/dimensions, ``path``/``smooth``/``geometry``
        carry the current best ``waypoints`` (the raw path first, then the
        LOS-smoothed path, then the geometry-refined one - each closer to
        the final answer), ``direct`` fires when the straight line is
        accepted, and ``degraded`` explains each fallback step.

        Note: per-call overrides are applied to ``self.config`` via
        dataclasses.replace - instances are intended to be short-lived and
        per-request, so this is safe.
        """
        self._progress = progress
        overrides = {
            "grid_resolution_m": grid_resolution_m,
            "safety_margin_m": safety_margin_m,
            "bbox_expansion_m": bbox_expansion_m,
            "default_altitude_m": altitude_m,
            "drone_speed_mps": speed_mps,
            "planner_algorithm": algorithm,
        }
        self.config = dataclasses.replace(
            self.config, **{k: v for k, v in overrides.items() if v is not None}
        )
        cfg = self.config
        # Obstacles are RED zones only (amber is passable with permission).
        # Request-supplied zones have no kind and are therefore red by
        # definition (the client explicitly said "no fly here").  All zones
        # (red + amber) are kept for route-crossing reporting.
        red_rings = list(cfg.obstacle_rings) + list(no_fly_zones or [])
        zone_records = list(cfg.no_fly_zones) + [
            ZoneRecord(kind="red", ring=r, name="mission no-fly zone")
            for r in (no_fly_zones or [])
        ]

        # The safety margin is the user-facing clearance knob: in exact-
        # polygon mode cap the grid corridor at it (down to 0 m) so lowering
        # the margin actually opens corridors, while never widening beyond
        # the config polygon_buffer_m default.
        buf = effective_polygon_buffer(cfg)
        if buf != cfg.polygon_buffer_m:
            cfg = dataclasses.replace(cfg, polygon_buffer_m=buf)
            self.config = cfg

        t0 = time.perf_counter()

        # -- direct-line fast path -----------------------------------------
        # If the true straight start->goal segment is collision-free against
        # the ACTUAL obstacle geometries (no envelopes, no margins, no grid),
        # return exactly two waypoints and skip region load / rasterization /
        # search entirely.  Any failure here falls back to the normal pipeline
        # unchanged - this is an optimisation, never a correctness gate.
        check: direct_path.DirectPathResult | None = None
        try:
            check = direct_path.is_direct_path_clear(
                self.con, cfg, start, goal, red_rings
            )
        except Exception as exc:  # noqa: BLE001 - optimisation must never break planning
            logger.warning(
                "direct-line fast path check failed, falling back to grid: %s",
                exc,
            )
        if check is not None and check.clear:
            # no grid was built: clear stale state from any previous plan on
            # this (short-lived) instance so ``planner.grid`` agrees with the
            # reported stats (grid_width == 0)
            self._emit("direct", {})
            self._grid = None
            self._last_path = None
            self._last_smoothed = None
            self._last_geo_path = None
            self._last_visibility = None
            wps = direct_path.generate_direct_waypoints(
                start, goal, cfg.default_altitude_m, cfg.min_waypoint_spacing_m
            )
            distance = path_length_m([start, goal])
            estimated_time = distance / cfg.drone_speed_mps
            planning_time = time.perf_counter() - t0
            stats = PlanningStats(
                buildings_queried=0,
                water_queried=0,
                grid_width=0,
                grid_height=0,
                cell_size_m=0.0,
                nodes_explored=0,
                path_cells=len(wps),
                planning_time_s=round(planning_time, 4),
                direct_path=True,
            )
            mid = mission_id or f"mission-{uuid.uuid4().hex[:12]}"
            return RouteResult(
                mission_id=mid,
                distance=round(distance, 2),
                estimated_time=round(estimated_time, 2),
                waypoints=tuple(wps),
                stats=stats,
                # the returned route IS the direct line: nothing to back up
                backup_waypoints=None,
                zones_crossed=_crossed_zones(wps, zone_records),
            )

        bbox = bbox_of_points(
            [start, goal],
            cfg.bbox_expansion_m + cfg.safety_margin_m + cfg.grid_resolution_m,
        )
        self.load_region(bbox)

        sources: list[ObstacleSource] = [
            BuildingsSource(self.con, REGION_TABLE, bbox)
        ]
        if cfg.water_parquet:
            sources.append(WaterSource(self.con, WATER_TABLE, bbox))
        if red_rings:
            sources.append(NoFlySource(red_rings))

        # The direct start->goal line is always returned as an operator
        # backup (``backup_waypoints``) unless the returned route IS that
        # line already (the fast-path return above).
        backup = direct_path.generate_direct_waypoints(
            start, goal, cfg.default_altitude_m, cfg.min_waypoint_spacing_m
        )

        try:
            if cfg.planner_algorithm == "visibility":
                self._last_geo_path = None
                self._plan_visibility(bbox, sources, start, goal, snap_start_goal)
            else:
                self._last_geo_path = None
                self.generate_grid(bbox, sources)
                self.find_path(start, goal, snap=snap_start_goal)
                self.smooth_path()
            waypoints = self.generate_waypoints()
        except NoPathError:
            # No collision-free corridor: degrade instead of failing.  The
            # fallback never raises NoPathError and always returns a route.
            return self._plan_degraded(
                start, goal, bbox, sources, mission_id, t0, zone_records
            )

        # geometry-exact shortcut pass over the FINAL waypoint polyline:
        # straighten through over-blocked cells while respecting the
        # real-polygon safety margin.  Runs on the thinned waypoints so every
        # segment the drone actually flies is validated.  Any failure keeps
        # the grid-smoothed path (optimisation, not a gate).
        if cfg.planner_algorithm != "visibility":
            try:
                waypoints = self.smooth_waypoints_geometry(waypoints, sources)
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "geometry smoothing failed, keeping grid-smoothed path: %s",
                    exc,
                )
            self._emit("geometry", {"waypoints": list(waypoints)})

        distance = path_length_m([(lat, lon) for lat, lon, _ in waypoints])
        estimated_time = distance / cfg.drone_speed_mps
        planning_time = time.perf_counter() - t0

        if cfg.planner_algorithm == "visibility" and self._last_visibility is not None:
            vis = self._last_visibility
            stats = PlanningStats(
                buildings_queried=self._region_stats.buildings,
                water_queried=self._region_stats.water,
                grid_width=0,
                grid_height=0,
                cell_size_m=0.0,
                nodes_explored=vis.nodes_explored,
                path_cells=len(vis.points),
                planning_time_s=round(planning_time, 4),
                graph_vertices=vis.vertices_built,
                graph_edges=vis.edges_built,
                vis_build_time_s=vis.build_time_s,
                vis_search_time_s=vis.search_time_s,
            )
        else:
            stats = PlanningStats(
                buildings_queried=self._region_stats.buildings,
                water_queried=self._region_stats.water,
                grid_width=self._grid.width,
                grid_height=self._grid.height,
                cell_size_m=self._grid.cell_size_m,
                nodes_explored=self._last_nodes_explored,
                path_cells=len(self._last_path or []),
                planning_time_s=round(planning_time, 4),
            )
        mid = mission_id or f"mission-{uuid.uuid4().hex[:12]}"
        return RouteResult(
            mission_id=mid,
            distance=round(distance, 2),
            estimated_time=round(estimated_time, 2),
            waypoints=tuple(waypoints),
            stats=stats,
            backup_waypoints=tuple(backup),
            zones_crossed=_crossed_zones(waypoints, zone_records),
        )

    def _red_reroute_needed_m(
        self, rings: Sequence[NoFlyRing], bbox: BBox, cfg: Settings
    ) -> tuple[float, float, float, float] | None:
        """Per-side bbox expansion (m) so the grid can contain a route
        around the red rings that seal the corridor.

        Returns ``(north, south, east, west)`` metres to add on each side,
        or None when no red ring overlaps the corridor (expanding cannot
        help a buildings-only blockage - free space is still split into
        disconnected islands, and the flood-fill fallback already handles
        that).  The expansion is sized to fully contain each overlapping
        ring's bbox plus clearance, so a way around it fits inside the
        grid no matter which side is blocked by other obstacles.
        """
        xmin, ymin, xmax, ymax = bbox
        lat0 = (ymin + ymax) / 2.0
        mplon = meters_per_degree_lon(lat0)
        margin = cfg.safety_margin_m + cfg.grid_resolution_m + 100.0
        need_n = need_s = need_e = need_w = 0.0
        probe_deg = 0.01  # ~1 km: rings just outside still count
        for ring in rings:
            lats = [p[0] for p in ring]
            lons = [p[1] for p in ring]
            if not lats:
                continue
            rmin_lat, rmax_lat = min(lats), max(lats)
            rmin_lon, rmax_lon = min(lons), max(lons)
            if (
                rmax_lon < xmin - probe_deg
                or rmin_lon > xmax + probe_deg
                or rmax_lat < ymin - probe_deg
                or rmin_lat > ymax + probe_deg
            ):
                continue  # far away: cannot be the seal
            need_n = max(need_n, (rmax_lat - ymax) * M_PER_DEG_LAT)
            need_s = max(need_s, (ymin - rmin_lat) * M_PER_DEG_LAT)
            need_e = max(need_e, (rmax_lon - xmax) * mplon)
            need_w = max(need_w, (xmin - rmin_lon) * mplon)
        if need_n + need_s + need_e + need_w <= 0.0:
            return None
        return (need_n + margin, need_s + margin, need_e + margin, need_w + margin)

    def _plan_finer_grid(
        self,
        start: Point,
        goal: Point,
        bbox: BBox,
        sources: list[ObstacleSource],
        mission_id: str | None,
        t0: float,
        zone_records: list[ZoneRecord],
        backup: tuple[Waypoint, ...],
        cfg: Settings,
    ) -> RouteResult | None:
        """Retry the grid search at finer resolutions when the current grid
        could not resolve a corridor.

        The conservative paint rule blocks a cell whenever a building touches
        any part of it, so every building seals its footprint plus up to one
        grid cell - at 10 m that envelope swallows narrow streets and the
        free space fragments into islands.  Halving the cell size halves the
        envelope, so corridors the coarse grid cannot see reappear at 5 m /
        2.5 m.  This only runs after the initial search failed, keeping
        common routes on the fast coarse grid; returns None when every finer
        resolution also fails and the caller degrades further.
        """
        base_cell = cfg.grid_resolution_m
        for finer in (base_cell / 2.0, base_cell / 4.0):
            if finer < 2.0:
                break
            self._emit(
                "degraded",
                {
                    "reason": f"no corridor at the {base_cell:g} m grid - "
                    f"retrying at the finer {finer:g} m grid"
                },
            )
            fine = dataclasses.replace(cfg, grid_resolution_m=finer)
            self.config = fine
            try:
                self._last_geo_path = None
                self.generate_grid(bbox, sources)
                self.find_path(start, goal, snap=True)
                self.smooth_path()
                waypoints = self.generate_waypoints()
            except NoPathError:
                self.config = cfg
                continue
            warning = (
                f"No collision-free corridor at the {base_cell:g} m grid. "
                f"Returning the route found at the finer {finer:g} m grid - "
                "verify the route against buildings before flight."
            )
            planning_time = time.perf_counter() - t0
            distance = path_length_m([(lat, lon) for lat, lon, _ in waypoints])
            stats = PlanningStats(
                buildings_queried=self._region_stats.buildings if self._region_stats else 0,
                water_queried=self._region_stats.water if self._region_stats else 0,
                grid_width=self._grid.width if self._grid else 0,
                grid_height=self._grid.height if self._grid else 0,
                cell_size_m=self._grid.cell_size_m if self._grid else 0.0,
                nodes_explored=self._last_nodes_explored,
                path_cells=len(self._last_path or []),
                planning_time_s=round(planning_time, 4),
            )
            mid = mission_id or f"mission-{uuid.uuid4().hex[:12]}"
            return RouteResult(
                mission_id=mid,
                distance=round(distance, 2),
                estimated_time=round(distance / cfg.drone_speed_mps, 2),
                waypoints=tuple(waypoints),
                stats=stats,
                warning=warning,
                backup_waypoints=tuple(backup),
                zones_crossed=_crossed_zones(waypoints, zone_records),
            )
        self.config = cfg
        return None

    def _plan_red_reroute(
        self,
        start: Point,
        goal: Point,
        bbox: BBox,
        mission_id: str | None,
        t0: float,
        zone_records: list[ZoneRecord],
    ) -> RouteResult | None:
        """Retry the grid search on a larger box sized to contain the red
        ring(s) that sealed the corridor, so the planner can route AROUND a
        red zone and still reach the destination.

        Red zones are an absolute prohibition - the planner must never stop
        at their edge when a way around exists.  The        mission box only
        extends a few hundred metres past start/goal, so a giant red no-fly
        ring (an airport's no-drone circle can span 10+ km) can seal it
        entirely; this fallback grows the box until the ring is inside it
        and reruns the grid search (fast envelope rasterizer - the exact
        painter over 300k+ buildings costs ~34 s, the envelope path ~3 s,
        and the geometry smoothing afterwards validates the route against
        the real polygons).  Returns None when no red ring is near or the
        larger grid still has no corridor (the caller then flood-fills).
        """
        cfg = self.config
        rings = tuple(z.ring for z in zone_records if z.kind == "red")
        # If the start or the goal sits INSIDE a red polygon, no amount of
        # box expansion can reach it - red is prohibited under any
        # circumstances, and the flood-fill fallback already ends at the
        # closest reachable point with the right warning.  Skip the (slow)
        # reroute entirely.
        if self._point_in_red_ring(start, rings) or self._point_in_red_ring(
            goal, rings
        ):
            return None
        sides = self._red_reroute_needed_m(rings, bbox, cfg)
        if sides is None or cfg.red_reroute_max_expansion_m <= 0:
            return None
        n_m, s_m, e_m, w_m = sides
        cap = cfg.red_reroute_max_expansion_m
        xmin, ymin, xmax, ymax = bbox
        lat0 = (ymin + ymax) / 2.0
        mplon = meters_per_degree_lon(lat0)

        # The needed box contains the blocking ring(s) - but rings can be
        # hourglass funnels with other zones/buildings crowding their tips,
        # so the minimum box can still leave no free passage.  Try a ladder
        # of expansions (the minimum, then 2x, then the cap) and take the
        # first box that yields a corridor.  The envelope rasterizer makes
        # each attempt a few seconds even on 300k+ buildings.
        attempts: list[tuple[float, float, float, float]] = []
        for factor in (1.0, 2.0, 3.0):
            attempt = (
                min(n_m * factor, cap),
                min(s_m * factor, cap),
                min(e_m * factor, cap),
                min(w_m * factor, cap),
            )
            if attempt not in attempts:
                attempts.append(attempt)

        blocking_names = ", ".join(
            sorted(
                {
                    z.name
                    for z in zone_records
                    if z.kind == "red" and self._ring_near_corridor(z.ring, bbox)
                }
            )
        )
        fast = dataclasses.replace(cfg, rasterize_exact_polygons=False)
        for attempt_no, (n_m, s_m, e_m, w_m) in enumerate(attempts, start=1):
            self._emit(
                "degraded",
                {
                    "reason": "expanding search area to route around the "
                    f"red zone(s) (attempt {attempt_no}/{len(attempts)})"
                },
            )
            new_bbox = (
                xmin - w_m / mplon,
                ymin - s_m / M_PER_DEG_LAT,
                xmax + e_m / mplon,
                ymax + n_m / M_PER_DEG_LAT,
            )
            try:
                self.load_region(new_bbox)
            except RegionLoadError as exc:  # noqa: BLE001
                logger.warning("red-zone reroute: region load failed: %s", exc)
                continue
            new_sources: list[ObstacleSource] = [
                BuildingsSource(self.con, REGION_TABLE, new_bbox)
            ]
            if cfg.water_parquet:
                new_sources.append(WaterSource(self.con, WATER_TABLE, new_bbox))
            if rings:
                new_sources.append(NoFlySource(list(rings)))

            self.config = fast
            try:
                self._last_geo_path = None
                self.generate_grid(new_bbox, new_sources)
                self.find_path(start, goal, snap=True)
                self.smooth_path()
                waypoints = self.generate_waypoints()
            except NoPathError:
                continue
            except Exception as exc:  # noqa: BLE001
                logger.warning("red-zone reroute failed: %s", exc)
                continue

            # geometry-exact shortcut against the real polygons (restore
            # the original margin first so clearance semantics are
            # unchanged)
            self.config = cfg
            try:
                waypoints = self.smooth_waypoints_geometry(waypoints, new_sources)
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "red-zone reroute: geometry smoothing failed, "
                    "keeping grid path: %s",
                    exc,
                )

            warning = (
                "No corridor exists inside the mission box because the "
                "prohibited red no-fly zone(s)"
                + (f" ({blocking_names})" if blocking_names else "")
                + " block it. Rerouted AROUND the zone(s) on a larger "
                "search area - the route is longer than the direct line "
                "because red zones are never crossed. Verify the route "
                "before flight."
            )
            distance = path_length_m([(lat, lon) for lat, lon, _ in waypoints])
            stats = PlanningStats(
                buildings_queried=self._region_stats.buildings
                if self._region_stats
                else 0,
                water_queried=self._region_stats.water if self._region_stats else 0,
                grid_width=self._grid.width if self._grid else 0,
                grid_height=self._grid.height if self._grid else 0,
                cell_size_m=self._grid.cell_size_m if self._grid else 0.0,
                nodes_explored=self._last_nodes_explored,
                path_cells=len(self._last_path or []),
                planning_time_s=round(time.perf_counter() - t0, 4),
            )
            backup = direct_path.generate_direct_waypoints(
                start, goal, cfg.default_altitude_m, cfg.min_waypoint_spacing_m
            )
            mid = mission_id or f"mission-{uuid.uuid4().hex[:12]}"
            return RouteResult(
                mission_id=mid,
                distance=round(distance, 2),
                estimated_time=round(distance / cfg.drone_speed_mps, 2),
                waypoints=tuple(waypoints),
                stats=stats,
                warning=warning,
                backup_waypoints=tuple(backup),
                zones_crossed=_crossed_zones(waypoints, zone_records),
            )
        self.config = cfg
        return None

    @staticmethod
    def _point_in_red_ring(
        point: Point, rings: Sequence[NoFlyRing]
    ) -> bool:
        """True when ``(lat, lon)`` lies inside any red ring polygon."""
        for ring in rings:
            poly = shapely.geometry.Polygon([(lon, lat) for lat, lon in ring])
            if poly.is_empty:
                continue
            if poly.covers(shapely.geometry.Point(point[1], point[0])):
                return True
        return False

    @staticmethod
    def _ring_near_corridor(ring: NoFlyRing, bbox: BBox) -> bool:
        """True when the ring's bbox overlaps the corridor bbox (+ ~1 km)."""
        xmin, ymin, xmax, ymax = bbox
        probe = 0.01
        lats = [p[0] for p in ring]
        lons = [p[1] for p in ring]
        if not lats:
            return False
        return not (
            max(lons) < xmin - probe
            or min(lons) > xmax + probe
            or max(lats) < ymin - probe
            or min(lats) > ymax + probe
        )

    def _plan_degraded(
        self,
        start: Point,
        goal: Point,
        bbox: BBox,
        sources: list[ObstacleSource],
        mission_id: str | None,
        t0: float,
        zone_records: list[ZoneRecord],
    ) -> RouteResult:
        """Last-resort fallback when no collision-free corridor exists.

        Never raises :class:`NoPathError` - the API contract is that a route
        is always returned, and this is the emergency-drone behaviour the
        operator asked for:

        1. Retry the grid search at 0 m safety margin (the tightest corridor
           the grid can plan; this opens gaps the requested margin sealed).
        1b. Red-zone reroute: if a RED zone sealed the corridor (an
           airport's no-drone circle can span 10+ km - far beyond the
           mission box), retry the grid search on a larger box sized to
           contain the blocking ring(s), so the planner routes AROUND the
           zone and still reaches the goal instead of stopping at its edge.
        2. If still no corridor (free space split into disconnected islands),
           flood-fill from the start to the reachable free cell closest to
           the goal and append a straight segment from there to the goal.

        RED no-fly zones are an absolute prohibition: the straight final
        segment (and the 0 m retry / reroute, which still rasterise them)
        never crosses one.  If the straight line to the goal would cut
        through a red zone, the route ends at the closest reachable point
        instead and the warning says the destination is behind a red zone.
        Buildings / amber crossings on the final segment are allowed as
        best-effort emergency behaviour - the warning says so.  Degenerate
        corner: if the start cell itself is the only reachable free cell (a
        sealed red pocket) the truncated route is a single waypoint -
        truthful ("you cannot leave") and safe, but the map renders no
        polyline for it.

        ``warning`` explains what happened; ``backup_waypoints`` is always
        the direct start->goal line so the operator can pick it explicitly
        when they have permission / verified the airspace.
        """
        cfg = self.config
        backup = direct_path.generate_direct_waypoints(
            start, goal, cfg.default_altitude_m, cfg.min_waypoint_spacing_m
        )

        # (0) finer-grid retries: the coarse default grid may not resolve a
        # corridor (every building seals its footprint plus up to one cell,
        # so dense streets vanish at 10 m).  Re-run at 5 m / 2.5 m before
        # degrading further - dense routes pay for the finer rasterization
        # only when the fast coarse grid genuinely finds nothing.
        finer = self._plan_finer_grid(
            start, goal, bbox, sources, mission_id, t0, zone_records, backup, cfg
        )
        if finer is not None:
            return finer

        # (1) tightest-corridor retry: 0 m margin means the grid paints only
        # the real buffered footprints (exact-polygon mode) or the raw
        # envelopes (legacy mode)
        tight = dataclasses.replace(
            cfg, safety_margin_m=0.0, polygon_buffer_m=0.0
        )
        self._emit(
            "degraded",
            {
                "reason": "no corridor at the requested safety margin - "
                "retrying at 0 m clearance"
            },
        )
        self.config = tight
        try:
            self._last_geo_path = None
            self.generate_grid(bbox, sources)
            self.find_path(start, goal, snap=True)
            self.smooth_path()
            waypoints = self.generate_waypoints()
            warning = (
                "No collision-free route at the requested safety margin. "
                "Returning the tightest corridor at 0 m clearance - verify "
                "the route against buildings before flight."
            )
            planning_time = time.perf_counter() - t0
            distance = path_length_m([(lat, lon) for lat, lon, _ in waypoints])
            stats = PlanningStats(
                buildings_queried=self._region_stats.buildings if self._region_stats else 0,
                water_queried=self._region_stats.water if self._region_stats else 0,
                grid_width=self._grid.width if self._grid else 0,
                grid_height=self._grid.height if self._grid else 0,
                cell_size_m=self._grid.cell_size_m if self._grid else 0.0,
                nodes_explored=self._last_nodes_explored,
                path_cells=len(self._last_path or []),
                planning_time_s=round(planning_time, 4),
            )
        except NoPathError:
            # (1b) red-zone reroute: when a RED zone sealed the corridor (the
            # mission box is too small to contain a way around it), retry the
            # grid search on a larger box sized from the blocking ring(s) so
            # the planner routes AROUND the zone and still reaches the goal.
            # Uses the original margin (not the 0 m tight config above).
            self._emit(
                "degraded",
                {"reason": "red no-fly zone seals the corridor - expanding "
                 "the search area to route around it"},
            )
            self.config = cfg
            rerouted = self._plan_red_reroute(
                start, goal, bbox, mission_id, t0, zone_records
            )
            if rerouted is not None:
                return rerouted
            # (2) farthest-reachable fallback: flood fill from the (snapped)
            # start cell, take the path to the reachable free cell closest
            # to the goal, then a straight line from there to the real goal.
            self._emit(
                "degraded",
                {"reason": "no corridor at any expansion - returning the "
                 "reachable point closest to the destination"},
            )
            grid = self._grid
            if grid is None:
                self.generate_grid(bbox, sources)
                grid = self._grid
            start_cell = grid.snap_to_free_cell(*grid.geo_to_cell(*start))
            goal_cell = grid.geo_to_cell(*goal)
            path_cells, remaining_m, visited = closest_reachable_cell(
                grid, start_cell, goal_cell
            )
            pts = [grid.cell_to_geo(*c) for c in path_cells]
            # Candidate route: the flood-fill path plus a straight final
            # segment from the last reachable cell to the real goal.  That
            # final segment may cross buildings (degraded emergency
            # behaviour, warned) but must NEVER cross a RED no-fly zone -
            # red is prohibited under any circumstances.  If the straight
            # line to the goal would cut through one, the route ends at the
            # closest reachable point instead: red is always routed around,
            # never through.
            candidate = points_to_waypoints(
                pts + [goal],
                cfg.default_altitude_m,
                cfg.min_waypoint_spacing_m,
            )
            red_crossed = [
                z for z in _crossed_zones(candidate, zone_records) if z.kind == "red"
            ]
            if red_crossed:
                waypoints = points_to_waypoints(
                    pts,
                    cfg.default_altitude_m,
                    cfg.min_waypoint_spacing_m,
                )
                names = ", ".join(sorted({z.name for z in red_crossed}))
                warning = (
                    "No collision-free corridor exists and the destination "
                    f"cannot be reached without crossing the prohibited red "
                    f"no-fly zone(s): {names}. Red zones are never crossed - "
                    "the route ends at the closest reachable point, "
                    f"approximately {remaining_m:.0f} m short of the "
                    "destination. Choose a destination outside the red zone."
                )
            else:
                waypoints = candidate
                warning = (
                    "No continuous collision-free corridor exists between "
                    "the points (the free space is split into disconnected "
                    "islands at this grid resolution). Returning a "
                    "best-effort route to the reachable point closest to "
                    "the destination, then a straight line to it - the "
                    "final segment may pass through buildings or amber "
                    "no-fly zones. Verify before flight, or use "
                    "backup_waypoints (the direct line) when you have "
                    "permission to fly it."
                )
            planning_time = time.perf_counter() - t0
            distance = path_length_m([(lat, lon) for lat, lon, _ in waypoints])
            stats = PlanningStats(
                buildings_queried=self._region_stats.buildings if self._region_stats else 0,
                water_queried=self._region_stats.water if self._region_stats else 0,
                grid_width=grid.width,
                grid_height=grid.height,
                cell_size_m=grid.cell_size_m,
                nodes_explored=visited,
                path_cells=len(path_cells),
                planning_time_s=round(planning_time, 4),
            )

        mid = mission_id or f"mission-{uuid.uuid4().hex[:12]}"
        return RouteResult(
            mission_id=mid,
            distance=round(distance, 2),
            estimated_time=round(distance / cfg.drone_speed_mps, 2),
            waypoints=tuple(waypoints),
            stats=stats,
            warning=warning,
            backup_waypoints=tuple(backup),
            zones_crossed=_crossed_zones(waypoints, zone_records),
        )
