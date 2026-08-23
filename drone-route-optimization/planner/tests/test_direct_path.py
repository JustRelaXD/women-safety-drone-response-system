"""Direct-line fast path tests.

Six required scenarios plus unit tests:

- open field                          -> returns exactly [start, goal]
- single building crossing the line   -> falls back to the grid planner
- water crossing the line             -> falls back
- no-fly zone crossing the line       -> falls back
- building near the line (no touch)   -> direct path (margins ignored)
- building envelope crosses, polygon  -> direct path (real geometry only)
  does not

Every fallback is asserted through ``stats.direct_path is False`` and a
real grid result; every acceptance through ``stats.direct_path is True``
and exactly two waypoints.
"""

from __future__ import annotations

import dataclasses

import shapely
from shapely import affinity

from planner.core.geometry import LocalProjection, haversine_m
from planner.routing.direct_path import generate_direct_waypoints, is_direct_path_clear
from planner.routing.planner import RoutePlanner
from planner.tests.conftest import _rect_wkt, _write_parquet

# straight line at lat 30.9000, lon 75.8450 -> 75.8550 (test 5/6 corridor)
LINE = ((30.9000, 75.8450), (30.9000, 75.8550))
# the standard mission diagonal (tests 1-4)
MISSION = ((30.9000, 75.8450), (30.9030, 75.8550))


def _cfg(planner_settings, buildings: str, water: str | None = None, **kw):
    return dataclasses.replace(
        planner_settings, buildings_parquet=buildings, water_parquet=water, **kw
    )


def _write_buildings(tmp_path, name: str, rows) -> str:
    bp = tmp_path / name
    _write_parquet(str(bp), rows, ("id", "height", "geometry"))
    return str(bp)


def _write_water(tmp_path, name: str, rows) -> str:
    wp = tmp_path / name
    _write_parquet(str(wp), rows, ("id", "geometry"))
    return str(wp)


# --------------------------------------------------------------------------
# unit tests
# --------------------------------------------------------------------------


def test_generate_direct_waypoints_exactly_two():
    wps = generate_direct_waypoints((10.0, 20.0), (10.1, 20.1), 50.0, 25.0)
    assert wps == [(10.0, 20.0, 50.0), (10.1, 20.1, 50.0)]


def test_is_direct_path_clear_hit_and_miss(planner_settings, tmp_path):
    bp = _write_buildings(
        tmp_path, "b.parquet", [("mid", 12.0, _rect_wkt(30.9015, 75.8500, 30, 30))]
    )
    cfg = _cfg(planner_settings, bp)
    planner = RoutePlanner(cfg)
    try:
        start, goal = MISSION
        res = is_direct_path_clear(planner.con, cfg, start, goal, [])
        assert not res.clear
        assert res.building_hit
        assert not res.water_hit
        assert not res.no_fly_hit
        assert "building polygon" in res.reasons

        # a corridor 167 m south of the building is clear
        res2 = is_direct_path_clear(planner.con, cfg, *LINE, [])
        assert res2.clear
        assert not res2.building_hit
    finally:
        planner.close()


def test_zero_length_mission_is_never_clear(planner_settings, tmp_path):
    bp = _write_buildings(
        tmp_path, "b.parquet", [("far", 8.0, _rect_wkt(30.9100, 75.8600, 15, 15))]
    )
    cfg = _cfg(planner_settings, bp)
    planner = RoutePlanner(cfg)
    try:
        res = is_direct_path_clear(
            planner.con, cfg, (30.9000, 75.8500), (30.9000, 75.8500), []
        )
        assert res.clear is False
    finally:
        planner.close()


# --------------------------------------------------------------------------
# scenario 1: open field -> direct path
# --------------------------------------------------------------------------


def test_open_field_returns_direct_path(planner_settings, tmp_path):
    # only buildings far outside the corridor: the straight line is clear
    bp = _write_buildings(
        tmp_path,
        "open.parquet",
        [
            ("far1", 8.0, _rect_wkt(30.9100, 75.8600, 15, 15)),
            ("far2", 8.0, _rect_wkt(30.8900, 75.8350, 15, 15)),
        ],
    )
    planner = RoutePlanner(_cfg(planner_settings, bp))
    try:
        start, goal = MISSION
        result = planner.plan(start=start, goal=goal, mission_id="open")
        assert result.stats.direct_path is True
        assert len(result.waypoints) == 2
        assert result.waypoints[0] == (30.9000, 75.8450, 50.0)
        assert result.waypoints[1] == (30.9030, 75.8550, 50.0)
        # nothing materialised, no grid built
        assert result.stats.grid_width == 0
        assert result.stats.grid_height == 0
        assert result.stats.buildings_queried == 0
        assert result.stats.path_cells == 2
        assert result.distance == round(haversine_m(*start, *goal), 2)
    finally:
        planner.close()


# --------------------------------------------------------------------------
# scenario 2: a building crossing the line -> fall back to the planner
# --------------------------------------------------------------------------


def test_building_crossing_falls_back(planner_settings, tmp_path):
    bp = _write_buildings(
        tmp_path, "cross.parquet", [("mid", 12.0, _rect_wkt(30.9015, 75.8500, 30, 30))]
    )
    planner = RoutePlanner(_cfg(planner_settings, bp))
    try:
        start, goal = MISSION
        result = planner.plan(start=start, goal=goal, mission_id="cross")
        assert result.stats.direct_path is False
        assert result.stats.grid_width > 0
        straight = haversine_m(*start, *goal)
        assert result.distance > straight  # a real detour around the building
        assert len(result.waypoints) > 2
    finally:
        planner.close()


# --------------------------------------------------------------------------
# scenario 3: water crossing the line -> fall back
# --------------------------------------------------------------------------


def test_water_crossing_falls_back(planner_settings, tmp_path):
    bp = _write_buildings(
        tmp_path, "b.parquet", [("far", 8.0, _rect_wkt(30.9100, 75.8600, 15, 15))]
    )
    wp = _write_water(tmp_path, "w.parquet", [("lake", _rect_wkt(30.9015, 75.8500, 60, 40))])
    planner = RoutePlanner(_cfg(planner_settings, bp, water=wp))
    try:
        start, goal = MISSION
        result = planner.plan(start=start, goal=goal)
        assert result.stats.direct_path is False
        straight = haversine_m(*start, *goal)
        assert result.distance > straight
        assert len(result.waypoints) > 2
    finally:
        planner.close()


# --------------------------------------------------------------------------
# scenario 4: no-fly zone crossing the line -> fall back
# --------------------------------------------------------------------------


def test_no_fly_crossing_falls_back(planner_settings, tmp_path):
    bp = _write_buildings(
        tmp_path, "b.parquet", [("far", 8.0, _rect_wkt(30.9100, 75.8600, 15, 15))]
    )
    zone = (
        (30.9010, 75.8495),
        (30.9010, 75.8505),
        (30.9020, 75.8505),
        (30.9020, 75.8495),
        (30.9010, 75.8495),
    )
    planner = RoutePlanner(_cfg(planner_settings, bp))
    try:
        start, goal = MISSION
        result = planner.plan(start=start, goal=goal, no_fly_zones=[zone])
        assert result.stats.direct_path is False
        assert result.distance > haversine_m(*start, *goal)
    finally:
        planner.close()


# --------------------------------------------------------------------------
# scenario 5: building near the line but not touching -> direct path
# --------------------------------------------------------------------------


def test_near_building_without_touch_returns_direct(planner_settings, tmp_path):
    # building 1 m from the line: the buffered envelope (safety margin 2 m)
    # intersects the line, the actual polygon does not -> the fast path (real
    # geometry only) must accept it, even though the grid would block it
    line_lat = LINE[0][0]
    lat_c = line_lat + 3.0 / 111_320.0  # 3 m north of the line
    bp = _write_buildings(
        tmp_path, "near.parquet", [("near", 8.0, _rect_wkt(lat_c, 75.8500, 10, 4))]
    )
    planner = RoutePlanner(_cfg(planner_settings, bp))
    try:
        # prove the scenario: buffered envelope hits, polygon does not
        poly = shapely.from_wkt(_rect_wkt(lat_c, 75.8500, 10, 4))
        line = shapely.LineString([(lon, lat) for lat, lon in LINE])
        assert not poly.intersects(line)
        envelope = shapely.box(*poly.bounds).buffer(2.0 / 111_320.0)
        assert envelope.intersects(line)

        result = planner.plan(start=LINE[0], goal=LINE[1], mission_id="near")
        assert result.stats.direct_path is True
        assert len(result.waypoints) == 2
    finally:
        planner.close()


# --------------------------------------------------------------------------
# scenario 6: envelope intersects, polygon does not -> direct path
# --------------------------------------------------------------------------


def test_envelope_intersects_polygon_does_not_returns_direct(planner_settings, tmp_path):
    # a 45 deg rotated square (20 m side) at the mission origin: its raw
    # bounding box crosses the mission line, but the diamond itself misses it
    # - the classic envelope-vs-geometry discrepancy the fast path must ignore
    proj = LocalProjection(LINE[0][0], LINE[0][1])
    diamond = affinity.rotate(shapely.box(-10, -10, 10, 10), 45)
    coords = shapely.get_coordinates(diamond)
    latlons = [proj.to_geo(float(x), float(y)) for x, y in coords]  # (lat, lon)
    poly = shapely.geometry.Polygon([(lon, lat) for lat, lon in latlons])
    bp = _write_buildings(tmp_path, "rot.parquet", [("rot", 8.0, poly.wkt)])
    planner = RoutePlanner(_cfg(planner_settings, bp))
    try:
        # mission from local (5, 13) to (20, 13): passes through the diamond's
        # bbox corner region, never through the polygon itself
        start = proj.to_geo(5.0, 13.0)
        goal = proj.to_geo(20.0, 13.0)
        mission_line = shapely.LineString(
            [(start[1], start[0]), (goal[1], goal[0])]
        )

        # prove the scenario: raw bbox crosses the line, polygon does not
        assert not poly.intersects(mission_line)
        assert shapely.box(*poly.bounds).intersects(mission_line)

        result = planner.plan(start=start, goal=goal, mission_id="rot")
        assert result.stats.direct_path is True
        assert len(result.waypoints) == 2
    finally:
        planner.close()
