"""Geometry helper tests."""

import math

from planner.core.geometry import (
    LocalProjection,
    bbox_of_points,
    expand_bbox,
    haversine_m,
    meters_per_degree_lon,
    path_length_m,
)


def test_haversine_known_distance():
    # 1 degree of latitude ~= 111.2 km
    d = haversine_m(30.0, 75.0, 31.0, 75.0)
    assert 110_000 < d < 112_500


def test_haversine_zero():
    assert haversine_m(30.0, 75.0, 30.0, 75.0) == 0.0


def test_path_length_m():
    pts = [(30.0, 75.0), (30.5, 75.0), (31.0, 75.0)]
    expected = 2 * haversine_m(30.0, 75.0, 30.5, 75.0)
    assert math.isclose(path_length_m(pts), expected, rel_tol=1e-9)


def test_meters_per_degree_lon():
    assert meters_per_degree_lon(0.0) > meters_per_degree_lon(60.0)


def test_projection_roundtrip():
    proj = LocalProjection(30.9, 75.85)
    x, y = proj.to_local(30.9030, 75.8550)
    lat, lon = proj.to_geo(x, y)
    assert abs(lat - 30.9030) < 1e-9
    assert abs(lon - 75.8550) < 1e-9


def test_bbox_of_points_and_expand():
    b = bbox_of_points([(30.9, 75.84), (30.91, 75.86)], 100.0)
    assert b[0] < 75.84 and b[1] < 30.9 and b[2] > 75.86 and b[3] > 30.91
    e = expand_bbox(b, 50.0)
    assert e[0] < b[0] and e[1] < b[1] and e[2] > b[2] and e[3] > b[3]
