"""Obstacle sources.

The route planner avoids any geometry produced by an :class:`ObstacleSource`.
New obstacle types (airports, restricted airspace, weather cells) plug in by
implementing the protocol - the rasterizer and planner never change.

Sources stream *envelope bounds* (4 floats per obstacle) for the cheap
common case and only expose full WKB geometries to the rasterizer when a
polygon is large enough to need exact painting.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

import numpy as np
import shapely
import duckdb

from ..core.geometry import BBox
from ..overture import region


@runtime_checkable
class ObstacleSource(Protocol):
    name: str

    def bounds(self) -> np.ndarray:
        """(N, 4) array of [xmin, ymin, xmax, ymax] envelopes, EPSG:4326."""
        ...

    def fetch(self, indices: np.ndarray) -> np.ndarray:
        """Shapely geometries for the given rows (same order as bounds())."""
        ...


class _RegionSource:
    """Shared DuckDB-backed source over a materialised RTREE-indexed table."""

    def __init__(self, con: duckdb.DuckDBPyConnection, table: str, bbox: BBox) -> None:
        self._con = con
        self._table = table
        self._bbox = bbox
        self._bounds: np.ndarray | None = None
        self._rowids: np.ndarray | None = None

    def bounds(self) -> np.ndarray:
        if self._bounds is None:
            self._bounds, self._rowids = region.region_bounds(
                self._con, self._table, *self._bbox
            )
        return self._bounds

    def fetch(self, indices: np.ndarray) -> np.ndarray:
        self.bounds()  # ensure rowids loaded
        rowids = self._rowids[indices]
        wkbs = region.region_wkb_for_ids(self._con, self._table, rowids)
        return shapely.from_wkb(wkbs)


class BuildingsSource(_RegionSource):
    """Buildings already materialised in the working region table."""

    name = "buildings"

    def __init__(self, con: duckdb.DuckDBPyConnection, table: str, bbox: BBox) -> None:
        super().__init__(con, table, bbox)


class WaterSource(_RegionSource):
    """Water bodies already materialised in the working region table."""

    name = "water"

    def __init__(self, con: duckdb.DuckDBPyConnection, table: str, bbox: BBox) -> None:
        super().__init__(con, table, bbox)


class NoFlySource:
    """Static no-fly polygons from config / mission request."""

    name = "no_fly_zones"

    def __init__(self, rings: list[tuple[tuple[float, float], ...]]) -> None:
        geoms = [
            shapely.geometry.Polygon([(lon, lat) for lat, lon in ring])
            for ring in rings
        ]
        self._geoms = np.array(geoms, dtype=object) if geoms else np.empty(0, dtype=object)

    def bounds(self) -> np.ndarray:
        if len(self._geoms) == 0:
            return np.empty((0, 4), dtype=np.float64)
        return np.asarray(shapely.bounds(self._geoms), dtype=np.float64).reshape(-1, 4)

    def fetch(self, indices: np.ndarray) -> np.ndarray:
        return self._geoms[indices]


class AirportSource:
    """Placeholder for future airport obstacle data.

    Overture does not ship an airport-footprint layer in the buildings theme;
    when an airports GeoParquet (geometry + bbox, same conventions) is added,
    point this source at it exactly like :class:`BuildingsSource`.  The
    planner, rasterizer and API are unaffected.
    """

    name = "airports"

    def __init__(self, con: duckdb.DuckDBPyConnection | None = None,
                 table: str | None = None, bbox: BBox | None = None) -> None:
        self._con = con
        self._table = table
        self._bbox = bbox

    def bounds(self) -> np.ndarray:
        if self._con is None or self._table is None or self._bbox is None:
            return np.empty((0, 4), dtype=np.float64)
        return region.region_bounds(self._con, self._table, *self._bbox)[0]

    def fetch(self, indices: np.ndarray) -> np.ndarray:
        if indices.size == 0:
            return np.empty(0, dtype=object)
        raise NotImplementedError("airport source: data layer not wired yet")
