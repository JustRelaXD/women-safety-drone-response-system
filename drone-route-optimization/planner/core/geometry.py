"""Geometry math for the planner.

All planning happens on a local equirectangular (plate carrée) projection
centred on the mission: at the scale of a 20 km drone mission the distortion
is negligible (<< 1 %), and it keeps every grid operation a simple affine
map, so rasterization and A* never touch expensive geodesic math.
"""

from __future__ import annotations

import math
from typing import Sequence

import numpy as np

EARTH_RADIUS_M = 6_371_000.0
M_PER_DEG_LAT = 111_320.0

Point = tuple[float, float]  # (lat, lon) degrees


def meters_per_degree_lon(lat: float) -> float:
    """Approx. metres per degree of longitude at ``lat``."""
    return M_PER_DEG_LAT * math.cos(math.radians(lat))


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in metres between two WGS84 points."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(a))


def path_length_m(points: Sequence[Point]) -> float:
    """Sum of haversine distances along a list of (lat, lon) points."""
    total = 0.0
    for (lat1, lon1), (lat2, lon2) in zip(points, points[1:]):
        total += haversine_m(lat1, lon1, lat2, lon2)
    return total


class LocalProjection:
    """Equirectangular projection with an arbitrary origin (affine in lat/lon)."""

    __slots__ = ("origin_lat", "origin_lon", "scale_x", "scale_y")

    def __init__(self, origin_lat: float, origin_lon: float) -> None:
        self.origin_lat = origin_lat
        self.origin_lon = origin_lon
        self.scale_x = meters_per_degree_lon(origin_lat)
        self.scale_y = M_PER_DEG_LAT

    def to_local(self, lat: float, lon: float) -> tuple[float, float]:
        return ((lon - self.origin_lon) * self.scale_x,
                (lat - self.origin_lat) * self.scale_y)

    def to_local_arr(self, lats, lons) -> tuple[np.ndarray, np.ndarray]:
        """Vectorised version; returns (x, y) arrays in metres."""
        return ((np.asarray(lons) - self.origin_lon) * self.scale_x,
                (np.asarray(lats) - self.origin_lat) * self.scale_y)

    def to_geo(self, x: float, y: float) -> tuple[float, float]:
        return (self.origin_lat + y / self.scale_y,
                self.origin_lon + x / self.scale_x)

    def to_geo_arr(self, xs, ys) -> tuple[np.ndarray, np.ndarray]:
        return (self.origin_lat + np.asarray(ys) / self.scale_y,
                self.origin_lon + np.asarray(xs) / self.scale_x)

    def affine_transform(self):
        """Shapely affine matrix mapping (lon, lat) -> (x, y) metres."""
        return (self.scale_x, 0.0, 0.0, self.scale_y,
                -self.origin_lon * self.scale_x, -self.origin_lat * self.scale_y)


BBox = tuple[float, float, float, float]  # (xmin=lon_min, ymin=lat_min, xmax, ymax)


def bbox_of_points(points: Sequence[Point], expansion_m: float) -> BBox:
    """Bounding box of points expanded by ``expansion_m`` metres on all sides."""
    lats = [p[0] for p in points]
    lons = [p[1] for p in points]
    lat0 = (min(lats) + max(lats)) / 2.0
    dlat = expansion_m / M_PER_DEG_LAT
    dlon = expansion_m / meters_per_degree_lon(lat0)
    return (min(lons) - dlon, min(lats) - dlat, max(lons) + dlon, max(lats) + dlat)


def expand_bbox(bbox: BBox, expansion_m: float) -> BBox:
    """Expand a bbox by ``expansion_m`` metres (lon width uses mid-latitude)."""
    xmin, ymin, xmax, ymax = bbox
    lat0 = (ymin + ymax) / 2.0
    dlat = expansion_m / M_PER_DEG_LAT
    dlon = expansion_m / meters_per_degree_lon(lat0)
    return (xmin - dlon, ymin - dlat, xmax + dlon, ymax + dlat)
