"""End-to-end RoutePlanner tests against synthetic GeoParquet fixtures."""

import math

import pytest
import shapely
from shapely.strtree import STRtree

from planner.core.config import ZoneRecord
from planner.core.exceptions import RegionLoadError
from planner.core.geometry import haversine_m
from planner.overture.region import REGION_TABLE, WATER_TABLE
from planner.routing.planner import RoutePlanner

from planner.tests.conftest import GOAL, START


def _assert_route_clearance(planner, result, margin_m: float) -> None:
    """Every straight segment between consecutive waypoints keeps >= margin_m
    distance from every building and water polygon in the region.

    This is the actual safety guarantee the planner provides (the grid's
    free-cell property is only an approximation of it; the geometry
    smoothing makes it exact).
    """
    proj = planner.grid.proj
    geoms = []
    for table in (REGION_TABLE, WATER_TABLE):
        rows = planner.con.execute(
            f"SELECT ST_AsWKB(geometry) FROM {table}"
        ).fetchall()
        for r in rows:
            g = shapely.from_wkb(bytes(r[0]))
            if g is not None and not g.is_empty:
                geoms.append(
                    shapely.affinity.affine_transform(g, proj.affine_transform())
                )
    tree = STRtree(geoms)
    pts = [proj.to_local(lat, lon) for lat, lon, _ in result.waypoints]
    assert len(pts) >= 2
    for a, b in zip(pts, pts[1:]):
        line = shapely.LineString([a, b])
        for k in tree.query(line.buffer(margin_m)):
            d = shapely.distance(geoms[int(k)], line)
            assert d >= margin_m - 1e-6, (
                f"segment {a} -> {b} is {d:.2f} m from an obstacle "
                f"(margin {margin_m} m)"
            )


def test_load_region_counts(planner_settings, buildings_parquet_count):
    planner = RoutePlanner(planner_settings)
    try:
        stats = planner.load_region((75.84, 30.898, 75.86, 30.904))
        assert stats.buildings > 0
        assert stats.water > 0
        # never loads the whole file: far-away buildings excluded
        assert stats.buildings < buildings_parquet_count
    finally:
        planner.close()


def test_query_buildings_and_water(planner_settings):
    planner = RoutePlanner(planner_settings)
    try:
        bbox = (75.84, 30.898, 75.86, 30.904)
        planner.load_region(bbox)
        b = planner.query_buildings(bbox)
        assert b.ndim == 2 and b.shape[1] == 4 and b.shape[0] > 0
        w = planner.query_water(bbox)
        assert w.shape[0] > 0  # the lake near the goal is inside
    finally:
        planner.close()


def test_query_water_without_water_file(planner_settings, tmp_path):
    import dataclasses

    cfg = dataclasses.replace(planner_settings, water_parquet=None)
    planner = RoutePlanner(cfg)
    try:
        bbox = (75.84, 30.898, 75.86, 30.904)
        planner.load_region(bbox)
        assert planner.query_water(bbox).shape[0] == 0
    finally:
        planner.close()


def test_plan_finds_route_and_avoids_obstacles(planner_settings):
    planner = RoutePlanner(planner_settings)
    try:
        result = planner.plan(start=START, goal=GOAL, mission_id="test-1")
        assert result.mission_id == "test-1"
        assert result.distance > 0
        assert result.estimated_time > 0
        assert len(result.waypoints) >= 2

        # route must be a real detour (the wall blocks the direct line)
        straight = haversine_m(*START, *GOAL)
        assert result.distance > straight * 1.05

        # every segment the drone flies must respect the real-polygon margin
        _assert_route_clearance(planner, result, planner_settings.safety_margin_m)

        # stats
        assert result.stats.buildings_queried > 0
        assert result.stats.water_queried > 0
        assert result.stats.nodes_explored > 0
        assert result.stats.path_cells > 0
        assert result.stats.planning_time_s >= 0
    finally:
        planner.close()


def test_plan_never_loads_full_dataset(planner_settings, buildings_parquet_count):
    planner = RoutePlanner(planner_settings)
    try:
        result = planner.plan(start=START, goal=GOAL)
        assert result.stats.buildings_queried < buildings_parquet_count
    finally:
        planner.close()


def test_plan_no_fly_over_goal_degrades(planner_settings):
    """A no-fly zone sealing the goal no longer raises: the planner returns
    a best-effort route with a warning and the direct-line backup."""
    planner = RoutePlanner(planner_settings)
    try:
        zone = tuple(
            [
                (GOAL[0] - 0.0005, GOAL[1] - 0.0005),
                (GOAL[0] - 0.0005, GOAL[1] + 0.0005),
                (GOAL[0] + 0.0005, GOAL[1] + 0.0005),
                (GOAL[0] + 0.0005, GOAL[1] - 0.0005),
                (GOAL[0] - 0.0005, GOAL[1] - 0.0005),
            ]
        )
        result = planner.plan(start=START, goal=GOAL, no_fly_zones=[zone])
        assert result.warning is not None
        assert len(result.waypoints) >= 2
        # the direct line is always offered as an operator backup
        assert result.backup_waypoints is not None
        assert len(result.backup_waypoints) >= 2
        assert result.backup_waypoints[0][:2] == START
        assert result.backup_waypoints[-1][:2] == GOAL
    finally:
        planner.close()


def test_plan_routes_around_red_walls_and_reaches_goal(planner_settings):
    """Two RED walls splitting the corridor into disconnected bands: the
    planner must NEVER stop at the red edge - it retries the grid search on
    a larger box sized to contain the walls and routes AROUND them, so the
    route still reaches the goal (red is routed around, never through)."""
    planner = RoutePlanner(planner_settings)
    try:
        # two horizontal walls spanning the full corridor longitude, sitting
        # BETWEEN the start (30.899) and the goal (30.903): the mission box
        # cannot contain a way around them, so the first grid search fails
        # and the red-zone reroute must enlarge the box and go around the
        # wall ENDS.
        wall1 = tuple(
            [
                (30.9002, 75.8440),
                (30.9002, 75.8560),
                (30.9008, 75.8560),
                (30.9008, 75.8440),
                (30.9002, 75.8440),
            ]
        )
        wall2 = tuple(
            [
                (30.9020, 75.8440),
                (30.9020, 75.8560),
                (30.9026, 75.8560),
                (30.9026, 75.8440),
                (30.9020, 75.8440),
            ]
        )
        result = planner.plan(start=START, goal=GOAL, no_fly_zones=[wall1, wall2])
        assert result.warning is not None
        assert len(result.waypoints) >= 2
        assert result.backup_waypoints is not None
        # the reroute goes AROUND the walls: the route reaches the goal
        # (the last waypoint is the goal cell centre, within a cell of it)
        assert haversine_m(*result.waypoints[-1][:2], *GOAL) < 15.0
        assert "red" in result.warning.lower()
        # no red zone appears among the crossed zones (the route never
        # enters the walls)
        assert not any(z.kind == "red" for z in result.zones_crossed)
    finally:
        planner.close()


def test_plan_reroutes_around_airstrip_funnel(planner_settings):
    """An airstrip-style red funnel spanning beyond the corridor on both
    sides (like the DGCA approach funnels around a runway) seals the mission
    box entirely.  The red-zone reroute must enlarge the search box, route
    AROUND the funnel and reach the goal - never stopping at the red edge."""
    planner = RoutePlanner(planner_settings)
    try:
        # a funnel-shaped red polygon: wider than the corridor bbox on both
        # lon sides and sitting between START and GOAL in lat, so no route
        # around it fits inside the mission box
        funnel = tuple(
            [
                (30.9010, 75.8430),
                (30.9010, 75.8570),
                (30.9022, 75.8570),
                (30.9022, 75.8430),
                (30.9010, 75.8430),
            ]
        )
        result = planner.plan(start=START, goal=GOAL, no_fly_zones=[funnel])
        assert result.warning is not None
        assert "red" in result.warning.lower()
        # the route reaches the goal by routing around the funnel (within
        # one cell of it)
        assert haversine_m(*result.waypoints[-1][:2], *GOAL) < 15.0
        assert len(result.waypoints) >= 2
        assert result.backup_waypoints is not None
        # the funnel is never entered
        assert not any(z.kind == "red" for z in result.zones_crossed)
    finally:
        planner.close()


def test_plan_no_reroute_when_goal_inside_red(planner_settings):
    """When the goal is INSIDE a red polygon no box expansion can legally
    reach it, so the reroute is skipped entirely: the planner degrades fast
    (the 0 m retry snaps the goal just outside the zone) and never spends
    tens of seconds expanding boxes that cannot succeed.  (Regression guard
    for the inside-red gate.)"""
    import dataclasses

    zone = _zone_around(*GOAL, kind="red", name="Sealed Zone")
    cfg = dataclasses.replace(planner_settings, no_fly_zones=(zone,))
    planner = RoutePlanner(cfg)
    try:
        result = planner.plan(start=START, goal=GOAL)
        assert result.warning is not None
        assert len(result.waypoints) >= 1
        # red is never crossed and never entered
        assert not any(z.kind == "red" for z in result.zones_crossed)
        # the reroute was skipped: the mission-box region was used, not a
        # much larger expanded box (mission grid ~1 km wide; a reroute box
        # would be thousands of cells wide)
        assert result.stats.grid_width < 500
        assert result.backup_waypoints is not None
    finally:
        planner.close()


def test_plan_no_reroute_when_red_zone_far_away(planner_settings):
    """A red zone far from the corridor is not the cause of a failure:
    expanding the box cannot help (and would only waste time), so the
    planner goes straight to the flood-fill fallback.  (Regression guard for
    the reroute's proximity gate.)"""
    import dataclasses

    zone = _zone_around(30.8500, 75.8000, kind="red", name="far-zone")
    cfg = dataclasses.replace(planner_settings, no_fly_zones=(zone,))
    planner = RoutePlanner(cfg)
    try:
        result = planner.plan(start=START, goal=GOAL)
        # a normal route still works (the far zone is not an obstacle here)
        # and, because the reroute's proximity gate skips far rings, the
        # planning path is unchanged: no warning, no red crossing reported
        assert result.warning is None
        assert result.zones_crossed == ()
        assert haversine_m(*result.waypoints[-1][:2], *GOAL) < 15.0
    finally:
        planner.close()


def test_plan_degraded_building_walls_allow_straight_final_segment(planner_settings, tmp_path):
    """The straight final segment is still appended when the islands are
    created by BUILDINGS (not red zones): the route ends at the real goal
    with the emergency warning - red is the only hard prohibition."""
    import dataclasses

    from planner.tests.conftest import _rect_wkt, _write_parquet

    # two full-span building walls between START and GOAL split the region
    # into disconnected bands; no corridor exists at any margin or grid
    # resolution.  The walls extend past the mission bbox on BOTH sides so
    # the finer-grid retry cannot route around a wall tip (22 m blocks every
    # ~23 m along the longitude = a solid wall, same pattern as the conftest
    # wall, which provably forces a detour).
    rows = []
    for wall_lat in (30.9005, 30.9025):
        lon = 75.8435
        while lon <= 75.8565:
            rows.append((f"w{wall_lat:.4f}-{lon:.4f}", 12.0, _rect_wkt(wall_lat, lon, 22, 22)))
            lon += 0.00024
    bp = tmp_path / "island_buildings.parquet"
    _write_parquet(str(bp), rows, ("id", "height", "geometry"))
    cfg = dataclasses.replace(planner_settings, buildings_parquet=str(bp))

    planner = RoutePlanner(cfg)
    try:
        result = planner.plan(start=START, goal=GOAL)
        assert result.warning is not None
        assert len(result.waypoints) >= 2
        assert result.backup_waypoints is not None
        # buildings are not a hard prohibition: the route still reaches the
        # goal via the straight final segment (warned)
        assert result.waypoints[-1][:2] == GOAL
    finally:
        planner.close()


def test_plan_normal_route_carries_backup_line(planner_settings):
    """Even a successful route returns the direct line as backup_waypoints."""
    planner = RoutePlanner(planner_settings)
    try:
        result = planner.plan(start=START, goal=GOAL, mission_id="t-backup")
        assert result.warning is None
        assert result.backup_waypoints is not None
        assert len(result.backup_waypoints) >= 2
        assert result.backup_waypoints[0][:2] == START
        assert result.backup_waypoints[-1][:2] == GOAL
    finally:
        planner.close()


def _zone_around(center_lat: float, center_lon: float, kind: str, name: str, half_deg: float = 0.0005) -> ZoneRecord:
    """Square ZoneRecord centred on a point (lat, lon)."""
    return ZoneRecord(
        kind=kind,  # type: ignore[arg-type]
        name=name,
        ring=tuple(
            [
                (center_lat - half_deg, center_lon - half_deg),
                (center_lat - half_deg, center_lon + half_deg),
                (center_lat + half_deg, center_lon + half_deg),
                (center_lat + half_deg, center_lon - half_deg),
                (center_lat - half_deg, center_lon - half_deg),
            ]
        ),
    )


def test_plan_amber_zone_is_passable_and_reported(planner_settings):
    """An amber zone over the goal is NOT an obstacle: the route succeeds
    without a warning and the crossing is reported in ``zones_crossed``."""
    import dataclasses

    zone = _zone_around(*GOAL, kind="amber", name="Amritsar Ctrl")
    cfg = dataclasses.replace(planner_settings, no_fly_zones=(zone,))
    planner = RoutePlanner(cfg)
    try:
        result = planner.plan(start=START, goal=GOAL)
        # amber never degrades the route
        assert result.warning is None
        assert len(result.waypoints) >= 2
        # the crossing is reported for permission / authority notification
        assert len(result.zones_crossed) == 1
        z = result.zones_crossed[0]
        assert z.kind == "amber"
        assert z.name == "Amritsar Ctrl"
    finally:
        planner.close()


def test_plan_red_zone_config_still_blocks(planner_settings):
    """A RED zone (typed, from config) stays a hard obstacle: the route
    degrades, and the planner refuses to fly through the red polygon (the
    0 m retry snaps the goal to the nearest free cell OUTSIDE the zone, so
    the red zone never appears among the crossed zones)."""
    import dataclasses

    zone = _zone_around(*GOAL, kind="red", name="Airport Red")
    cfg = dataclasses.replace(planner_settings, no_fly_zones=(zone,))
    planner = RoutePlanner(cfg)
    try:
        result = planner.plan(start=START, goal=GOAL)
        assert result.warning is not None
        # red zones must never be entered: no red crossing is reported
        assert not any(z.kind == "red" for z in result.zones_crossed)
        # the direct line (which would cross the red zone) stays available
        # only as an explicit operator backup
        assert result.backup_waypoints is not None
    finally:
        planner.close()


def test_plan_no_zones_crossed_when_none(planner_settings):
    """No configured zones -> empty ``zones_crossed`` on a normal route."""
    planner = RoutePlanner(planner_settings)
    try:
        result = planner.plan(start=START, goal=GOAL)
        assert result.zones_crossed == ()
    finally:
        planner.close()


def test_crossed_zones_detection_pure():
    """Unit check of the crossing logic: only zones the polyline really
    intersects are reported, with kind + name preserved."""
    from planner.routing.planner import _crossed_zones

    wps = [(30.899, 75.845, 50.0), (30.903, 75.855, 50.0)]  # START -> GOAL
    on_line = _zone_around(30.901, 75.850, kind="amber", name="ctrl")
    far = _zone_around(31.05, 76.05, kind="red", name="far")
    crossed = _crossed_zones(wps, [on_line, far])
    assert [z.name for z in crossed] == ["ctrl"]
    assert crossed[0].kind == "amber"


def test_plan_degraded_retries_at_zero_margin(planner_settings):
    """A huge requested margin seals every corridor; the degraded fallback
    retries at 0 m (legacy envelope mode, where the margin is not capped) and
    returns a real corridor with the tightest-clearance warning."""
    import dataclasses

    cfg = dataclasses.replace(
        planner_settings,
        rasterize_exact_polygons=False,  # margin expands envelopes directly
    )
    planner = RoutePlanner(cfg)
    try:
        result = planner.plan(start=START, goal=GOAL, safety_margin_m=200.0)
        assert result.warning is not None
        assert "0 m" in result.warning
        assert len(result.waypoints) >= 2
        # a real corridor was found (detours around the wall), not the
        # degenerate straight-through route
        straight = haversine_m(*START, *GOAL)
        assert result.distance > straight * 1.05
        assert result.backup_waypoints is not None
    finally:
        planner.close()


def test_load_region_missing_parquet(planner_settings, tmp_path):
    import dataclasses

    cfg = dataclasses.replace(planner_settings, buildings_parquet=str(tmp_path / "nope.parquet"))
    planner = RoutePlanner(cfg)
    try:
        with pytest.raises(RegionLoadError):
            planner.load_region((75.84, 30.898, 75.86, 30.904))
    finally:
        planner.close()


def test_effective_polygon_buffer():
    """The grid corridor is capped at the safety margin (down to 0 m) but
    never widened beyond the config polygon_buffer_m default."""
    import dataclasses

    from planner.core.config import Settings
    from planner.routing.planner import effective_polygon_buffer

    base = Settings(safety_margin_m=5.0, polygon_buffer_m=1.0)
    assert effective_polygon_buffer(base) == 1.0  # margin >= buffer: unchanged
    assert effective_polygon_buffer(
        dataclasses.replace(base, safety_margin_m=0.5)
    ) == 0.5
    assert effective_polygon_buffer(
        dataclasses.replace(base, safety_margin_m=0.0)
    ) == 0.0
    # legacy envelope mode expands the bounding box by safety_margin_m
    # directly, so the cap does not apply
    env = dataclasses.replace(base, rasterize_exact_polygons=False)
    assert effective_polygon_buffer(env) == 1.0


def test_safety_margin_zero_tightens_grid(planner_settings):
    """safety_margin_m=0 caps the grid buffer at 0 m: fewer blocked cells
    and a route no longer than the default-margin one."""
    planner = RoutePlanner(planner_settings)
    try:
        loose = planner.plan(start=START, goal=GOAL, safety_margin_m=5.0)
        n_loose = int(planner.grid.blocked.sum())
        tight = planner.plan(start=START, goal=GOAL, safety_margin_m=0.0)
        n_tight = int(planner.grid.blocked.sum())
        assert planner.config.polygon_buffer_m == 0.0
        assert n_tight < n_loose
        # a 0 m clearance opens (never lengthens) the corridor; the 5 m
        # slack only absorbs the route distances being rounded to 2 decimals
        # (the free-cell subset argument guarantees the unrounded values
        # satisfy tight <= loose)
        assert tight.distance <= loose.distance + 5.0
    finally:
        planner.close()


def test_request_overrides_affect_plan(planner_settings):
    planner = RoutePlanner(planner_settings)
    try:
        base = planner.plan(start=START, goal=GOAL, grid_resolution_m=20.0)
        assert base.stats.cell_size_m == 20.0
        high = planner.plan(start=START, goal=GOAL, altitude_m=120.0)
        assert all(wp[2] == 120.0 for wp in high.waypoints)
    finally:
        planner.close()


def test_plan_with_theta_star(planner_settings):
    """Any-angle search: valid route, at most A* length, fewer raw cells."""
    planner = RoutePlanner(planner_settings)
    try:
        base = planner.plan(start=START, goal=GOAL, mission_id="t-astar")
        theta = planner.plan(
            start=START, goal=GOAL, mission_id="t-theta", algorithm="theta_star"
        )
        assert len(theta.waypoints) >= 2
        assert theta.distance > 0
        # every segment must respect the real-polygon margin
        _assert_route_clearance(planner, theta, planner_settings.safety_margin_m)
        # Theta* raw paths use no more cells than A* raw paths
        assert theta.stats.path_cells <= base.stats.path_cells
    finally:
        planner.close()


def test_plan_progress_events_stream_partial_waypoints(planner_settings):
    """The progress callback fires at every pipeline stage and carries the
    current best route as ``waypoints`` (raw path first, then LOS-smoothed,
    then geometry-refined) - the data a streaming client draws live."""
    planner = RoutePlanner(planner_settings)
    events: list[tuple[str, dict]] = []
    try:
        result = planner.plan(
            start=START,
            goal=GOAL,
            mission_id="t-progress",
            progress=lambda event, payload: events.append((event, payload)),
        )
        stages = [e for e, _ in events]

        # the pipeline stages fire in order (the wall blocks the direct
        # line, so the grid branch runs and every stage appears)
        assert "region" in stages
        assert "grid" in stages
        assert "path" in stages
        assert "smooth" in stages
        assert "geometry" in stages
        assert stages.index("region") < stages.index("grid") < stages.index("path")
        assert stages.index("path") < stages.index("smooth")

        # region/grid carry their detail
        region = dict(events)["region"]
        assert region["buildings"] > 0
        grid = dict(events)["grid"]
        assert grid["width"] > 0 and grid["height"] > 0

        # every waypoint event carries a usable polyline (>= 2 points)
        for event in ("path", "smooth", "geometry"):
            wps = dict(events)[event]["waypoints"]
            assert len(wps) >= 2
            assert all(len(wp) == 3 for wp in wps)

        # partials converge to the final route: the last partial (geometry)
        # matches the returned waypoints exactly
        final_wps = dict(events)["geometry"]["waypoints"]
        assert [tuple(wp) for wp in final_wps] == list(result.waypoints)
    finally:
        planner.close()


def test_plan_progress_search_events_grow_toward_goal(planner_settings):
    """During the grid search the progress callback receives the growing
    start->frontier path (``search`` events), so a streaming client can draw
    the route as it is constructed - not only after the search ends.

    The streamed line must only ever EXTEND TOWARD the goal: each frame
    ends at the expanded cell closest to the goal so far, so the endpoint's
    distance to the goal decreases monotonically - the line never swings
    sideways through the 360-degree frontier the search explores early."""
    planner = RoutePlanner(planner_settings)
    events: list[tuple[str, dict]] = []
    try:
        result = planner.plan(
            start=START,
            goal=GOAL,
            mission_id="t-search",
            progress=lambda event, payload: events.append((event, payload)),
        )
        search_events = [p for e, p in events if e == "search"]
        # the wall forces a real search: at least a couple of growing frames
        assert search_events, "no search-progress events were emitted"
        # every frame is a valid start->... polyline ending at the current
        # best-progress cell (>= 2 points, start is always the first)
        lens = [len(p["waypoints"]) for p in search_events]
        assert all(n >= 2 for n in lens)
        # every frame starts at (a cell centre within one cell of) the start
        for p in search_events:
            assert haversine_m(*p["waypoints"][0][:2], *START) < 15.0
        # the tip only moves TOWARD the goal: endpoint->goal distance never
        # increases between consecutive frames (best-progress is monotonic)
        dists = [
            haversine_m(*p["waypoints"][-1][:2], *GOAL) for p in search_events
        ]
        for a, b in zip(dists, dists[1:]):
            assert b <= a + 1e-6, "streamed line moved AWAY from the goal"
        # and the route never regresses overall (last frame <= first frame)
        assert dists[-1] <= dists[0]
        # every frame carries the same search epoch (one search attempt),
        # so a client can group frames and reset the line on a new epoch
        assert len({p.get("epoch") for p in search_events}) == 1
        # the final search frame is superseded by the completed-path event
        assert any(e == "path" for e, _ in events)
        assert result.stats.nodes_explored > 0
    finally:
        planner.close()


def test_plan_progress_search_epochs_increment_across_attempts(planner_settings):
    """The degraded fallback can run several searches (requested margin,
    then 0 m retry / red-zone reroute).  Each attempt gets a fresh
    ``epoch`` so a streaming client can tell a NEW search line (which
    starts again from the start cell) from the previous one - without it,
    concatenated frames would look like the line jumping backwards.

    Uses the same full-span red walls as the reroute test so the first
    search is PROVABLY sealed and the red-zone reroute MUST run a second
    search - the assertion ``len(epochs) >= 2`` would fail if the epoch
    counter did not increment per attempt."""
    import dataclasses

    # full-span red walls (same geometry as the reroute test): each spans
    # the whole corridor longitude and sits between START and GOAL in lat,
    # so no way around them fits inside the mission box - the first search
    # MUST fail and the red-zone reroute MUST run a second search
    def _wall(lat0: float) -> tuple[tuple[float, float], ...]:
        return tuple(
            [
                (lat0, 75.8440),
                (lat0, 75.8560),
                (lat0 + 0.0006, 75.8560),
                (lat0 + 0.0006, 75.8440),
                (lat0, 75.8440),
            ]
        )

    cfg = dataclasses.replace(
        planner_settings,
        no_fly_zones=(
            ZoneRecord(kind="red", name="wall1", ring=_wall(30.9002)),
            ZoneRecord(kind="red", name="wall2", ring=_wall(30.9020)),
        ),
    )
    planner = RoutePlanner(cfg)
    events: list[tuple[str, dict]] = []
    try:
        result = planner.plan(
            start=START,
            goal=GOAL,
            progress=lambda event, payload: events.append((event, payload)),
        )
        search_payloads = [p for e, p in events if e == "search" and p.get("waypoints")]
        epochs = {p.get("epoch") for p in search_payloads}
        # the reroute provably ran a second search (mirror of the reroute
        # test): at least two distinct epochs, each a positive int
        assert len(epochs) >= 2, f"expected >= 2 search epochs, got {epochs}"
        assert all(isinstance(e, int) and e >= 1 for e in epochs)
        # a later attempt carries a strictly greater epoch than an earlier one
        seq = [p.get("epoch") for p in search_payloads]
        assert seq == sorted(seq)
        # the reroute still reached the goal (the second search succeeded)
        assert haversine_m(*result.waypoints[-1][:2], *GOAL) < 15.0
    finally:
        planner.close()


def test_plan_progress_direct_path_event(planner_settings):
    """When the straight line is accepted, the ``direct`` event fires and no
    grid stage follows (nothing was materialised)."""
    planner = RoutePlanner(planner_settings)
    events: list[tuple[str, dict]] = []
    try:
        # a fully open corridor: pick start/goal on the same latitude clear
        # of the wall band (30.9010) AND below the scattered field (which
        # starts at lat 30.8992) - 30.8985 has no buildings on the line
        s, g = (30.8985, 75.8450), (30.8985, 75.8540)
        result = planner.plan(
            start=s,
            goal=g,
            progress=lambda event, payload: events.append((event, payload)),
        )
        stages = [e for e, _ in events]
        assert "direct" in stages
        assert "grid" not in stages
        assert result.stats.direct_path is True
        assert len(result.waypoints) == 2
    finally:
        planner.close()


def test_plan_progress_degraded_events(planner_settings):
    """A degrading mission reports each fallback step via ``degraded``
    events (0 m retry, reroute/expansion, flood fill) so the client can
    show why the route is being redrawn."""
    import dataclasses

    zone = _zone_around(*GOAL, kind="red", name="Sealed Goal")
    cfg = dataclasses.replace(planner_settings, no_fly_zones=(zone,))
    planner = RoutePlanner(cfg)
    events: list[tuple[str, dict]] = []
    try:
        planner.plan(
            start=START,
            goal=GOAL,
            progress=lambda event, payload: events.append((event, payload)),
        )
        degraded = [p for e, p in events if e == "degraded"]
        # the mission-box search fails, the 0 m retry is announced, and at
        # least one fallback reason is reported
        assert degraded
        assert any("0 m" in p.get("reason", "") for p in degraded)
    finally:
        planner.close()


def test_plan_with_visibility(planner_settings, water_parquet, tmp_path):
    """Exact-shortest-path mode on a small wall+gap+lake scene."""
    import dataclasses

    from planner.tests.conftest import _rect_wkt, _write_parquet

    # two wall buildings (22 m) blocking the direct line, gap between them,
    # two scattered buildings; the shared lake fixture sits near the goal
    rows = [
        ("w0", 12.0, _rect_wkt(30.9010, 75.8470, 22, 22)),
        ("w1", 12.0, _rect_wkt(30.9010, 75.8500, 22, 22)),
        ("s0", 8.0, _rect_wkt(30.8990, 75.8475, 15, 15)),
        ("s1", 8.0, _rect_wkt(30.9025, 75.8460, 15, 15)),
    ]
    bp = tmp_path / "vis_buildings.parquet"
    _write_parquet(str(bp), rows, ("id", "height", "geometry"))
    cfg = dataclasses.replace(planner_settings, buildings_parquet=str(bp))

    planner = RoutePlanner(cfg)
    try:
        grid_res = planner.plan(start=START, goal=GOAL, mission_id="t-a")
        result = planner.plan(
            start=START, goal=GOAL, mission_id="t-vis", algorithm="visibility"
        )
        assert len(result.waypoints) >= 2
        straight = haversine_m(*START, *GOAL)
        # a sane route: near-straight (the wall gap + lake edge are only a
        # short lateral shuffle) but never longer than the grid route
        assert straight * 0.98 < result.distance < straight * 1.05
        assert result.distance <= grid_res.distance * 1.01
        assert result.stats.graph_vertices > 0
        assert result.stats.graph_edges > 0
        assert result.stats.nodes_explored > 0
    finally:
        planner.close()
