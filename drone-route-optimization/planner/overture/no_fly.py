"""No-fly zone data: fetch, convert and persist DGCA airspace rings.

The planner consumes no-fly zones as rings of ``(lat, lon)`` vertices (see
:data:`planner.core.config.NoFlyRing`).  This module provides the three pieces
around that data:

- :func:`fetch_facilities` - one GET against the third-party airspace map
  backend (the same source the airspacemap.in UI renders).  Used by
  ``scripts/import_no_fly_zones.py``; the app itself never touches the network.
- :func:`zones_from_facilities` - pure conversion of the backend's zone
  GeoJSON into typed ``(kind, ring)`` records, bbox-filtered.
- :func:`load_no_fly_zones` / :func:`write_no_fly_zones` - a local snapshot
  JSON (``planner/data/no_fly_zones.json``) with a download timestamp, so the
  planner is fully offline and the snapshot's age is always known.

Legal note (see README): the endpoint is public, unauthenticated and
crawler-allowed (robots.txt allows everything), and the underlying zone
boundaries are DGCA regulatory facts.  We fetch ONCE and cache locally; we
never hammer the server or redistribute the raw dataset.

Source data model (verified live, 2026-08):

    facilities: [{
        "_id": "...", "name": "Beas Airstrip", "type": "approach",
        "coordinates": [lon, lat],
        "zones": {
            "red":         {"radius": 0, "geojson": {Polygon ...}},
            "innerYellow": {"radius": 0, "geojson": {Polygon ...} or None},
            "outerYellow": {"radius": 0, "geojson": {Polygon ...} or None},
            "approach":    {"radius": 0, "geojson": {Polygon ...} or None},
            "boundary": ..., "others": ...
        },
        "updatedAt": ...
    }]

Each airfield carries several polygons, and the planner treats them by
what they actually ARE on the ground:

- ``red`` (the runway/airfield footprint itself, and for ``type=airport``
  records a small no-drone circle around the airport shrunk to
  ``airport_red_radius_km`` = 1 km by default - the DGCA circle is
  11-14 km wide and sat on top of city centres) is a hard obstacle: a
  drone must never fly through the runway or the airport's no-drone
  circle.
- ``approach`` (the departure/approach funnels extending from the runway
  ends - the "two triangular shapes" pointing away from the airport) and
  ``innerYellow`` / ``outerYellow`` (the large round controlled-airspace
  circles) are ALL amber: passable with permission, every crossing
  reported via ``zones_crossed``.  This is a deliberate policy decision:
  the funnels are tens of km long and would otherwise make whole cities
  with an airport unreachable, while DGCA's own controlled band already
  extends 8-12 km from the airport perimeter (i.e. inside the funnel
  span) and is passable with permission.

Non-airport red zones (border strips, cantonments, jails, railway
stations, power plants) always keep their exact DGCA polygons.
"""

from __future__ import annotations

import json
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..core.config import NoFlyRing, ZoneKind, ZoneRecord

#: Default third-party backend (public, unauthenticated).  Overridable via the
#: import script's ``--url`` flag.
AIRSPACE_BACKEND_URL = (
    "https://airspace-map-backend-592407489838.asia-south1.run.app/api/facilities"
)

#: Default local snapshot location (gitignored, like the parquet files).
DEFAULT_SNAPSHOT = "planner/data/no_fly_zones.json"

#: backend zone-layer key -> planner kind (see :class:`ZoneRecord` in
#: ``planner.core.config`` for what each kind means to the planner)
#:
#: The DGCA data ships each airfield as several polygons:
#:
#: - ``red`` - the runway / airfield footprint itself (small, ~1-3 km)
#: - ``approach`` - the elongated approach / departure funnels extending
#:   from the runway ends (the "two triangular shapes" pointing away from
#:   the airport)
#: - ``innerYellow`` / ``outerYellow`` - the large round controlled-
#:   airspace circles AROUND the airfield
#:
#: Only the runway footprint and the (shrunk) airport no-drone circle are
#: RED (absolute prohibition).  The approach funnels are amber like the
#: round circles (passable-with-permission, reported via ``zones_crossed``):
#: they are tens of km long and would otherwise make any city with an
#: airport unreachable, while DGCA's own controlled band already extends
#: 8-12 km from the airport perimeter (i.e. inside the funnel span) and is
#: passable with permission.
_LAYER_KINDS: dict[str, ZoneKind] = {
    "red": "red",
    "approach": "amber",
    "innerYellow": "amber",
    "outerYellow": "amber",
}


def fetch_facilities(url: str = AIRSPACE_BACKEND_URL) -> list[dict[str, Any]]:
    """One GET of the facilities payload (list of dicts).

    Raises:
        OSError / json.JSONDecodeError on network or format failure.
    """
    with urllib.request.urlopen(url, timeout=60) as resp:  # noqa: S310 - https only
        return json.load(resp)


def _ring_from_geojson(geojson: dict[str, Any] | None) -> NoFlyRing | None:
    """Convert a zone GeoJSON geometry to a ``(lat, lon)`` ring.

    Handles Polygon and MultiPolygon (first polygon wins - a multi-part zone
    is rare in this dataset and the planner's ring model is single-ring).
    Coordinates arrive as ``[lon, lat, (z?)]``; our rings are ``(lat, lon)``.
    """
    if not geojson or geojson.get("type") not in ("Polygon", "MultiPolygon"):
        return None
    if geojson["type"] == "MultiPolygon":
        polys = geojson.get("coordinates") or []
        if not polys:
            return None
        coords = polys[0]
    else:
        coords = geojson.get("coordinates")
        if not coords:
            return None
    # outer ring only; drop any trailing altitude element
    ring = [(float(pt[1]), float(pt[0])) for pt in coords[0]]
    if len(ring) < 4:
        return None
    # enforce closure so the module is self-contained even if the source
    # polygon is not explicitly closed (shapely would auto-close anyway)
    if ring[0] != ring[-1]:
        ring.append(ring[0])
    return tuple(ring)


def _circle_ring(
    lat: float, lon: float, radius_km: float, n: int = 48
) -> NoFlyRing:
    """A closed ``(lat, lon)`` ring approximating a circle of ``radius_km``
    around ``(lat, lon)`` (the airport reference point).

    Replaces the DGCA ``type=airport`` no-drone circle (an 11-14 km wide
    polygon) with a configurable smaller one so cities with an airport at
    their centre stay reachable; ``n`` vertices keep it a smooth circle.
    """
    import math

    rlat = radius_km / 111.32
    rlon = radius_km / (111.32 * math.cos(math.radians(lat)))
    ring = [
        (lat + rlat * math.sin(2 * math.pi * i / n),
         lon + rlon * math.cos(2 * math.pi * i / n))
        for i in range(n)
    ]
    ring.append(ring[0])
    return tuple(ring)


def _ring_bounds(ring: NoFlyRing) -> tuple[float, float, float, float]:
    lats = [p[0] for p in ring]
    lons = [p[1] for p in ring]
    return (min(lons), min(lats), max(lons), max(lats))


def _rings_overlap_bbox(
    ring: NoFlyRing, bbox: tuple[float, float, float, float] | None
) -> bool:
    if bbox is None:
        return True
    xmin, ymin, xmax, ymax = bbox
    rxmin, rymin, rxmax, rymax = _ring_bounds(ring)
    return not (rxmax < xmin or rxmin > xmax or rymax < ymin or rymin > ymax)


def zones_from_facilities(
    facilities: list[dict[str, Any]],
    bbox: tuple[float, float, float, float] | None = None,
    airport_red_radius_km: float | None = None,
) -> list[ZoneRecord]:
    """Extract typed no-fly rings from the facilities payload.

    Args:
        facilities: the raw list from :func:`fetch_facilities`.
        bbox: ``(xmin=lon, ymin=lat, xmax, ymax)``; None keeps everything.
            Facilities are kept when any extracted zone overlaps the box.
        airport_red_radius_km: replaces each ``type=airport`` facility's
            red no-drone circle (an 11-14 km wide polygon) with a circle
            of this radius around the airport reference point, so cities
            with an airport at their centre stay reachable.  None (default)
            keeps the DGCA circle unchanged.  The runway footprint
            (``type=approach`` red) and non-airport red zones (border
            strips, cantonments, jails, railway stations) are untouched.
    """
    zones: list[ZoneRecord] = []
    for fac in facilities:
        name = str(fac.get("name") or fac.get("_id") or "unknown")
        fac_zones = fac.get("zones") or {}
        # Extract every zone of the facility FIRST, then decide whether the
        # facility is in scope.  The bbox is a facility-level filter: as soon
        # as ANY of its zones overlaps the box the whole facility is kept.
        #
        # This matters for airstrips: the runway (red) polygon can sit just
        # outside the operating-area bbox while its approach circle (amber)
        # overlaps it (Shimla Airstrip, lon 77.064 vs the Punjab cut at 77.0).
        # Per-zone filtering silently dropped the runway, leaving the airstrip
        # fully passable - exactly the hole this module exists to close.
        extracted: list[ZoneRecord] = []
        is_airport_record = str(fac.get("type") or "") == "airport"
        coords = fac.get("coordinates") or []
        for layer, kind in _LAYER_KINDS.items():
            layer_data = fac_zones.get(layer)
            geojson = (
                layer_data.get("geojson") if isinstance(layer_data, dict) else None
            )
            ring = _ring_from_geojson(geojson)
            if ring is None:
                continue
            # The DGCA ``type=airport`` record carries the big no-drone
            # circle around the airport (11-14 km wide).  When a radius is
            # configured, shrink that circle around the airport reference
            # point (``coordinates`` is [lon, lat]) so cities with an
            # airport at their centre stay reachable.  Every other red
            # zone (runway footprint on ``type=approach`` records, border
            # strips, cantonments, jails, railway stations) is untouched.
            if (
                kind == "red"
                and is_airport_record
                and airport_red_radius_km
                and len(coords) >= 2
            ):
                ring = _circle_ring(
                    float(coords[1]), float(coords[0]), airport_red_radius_km
                )
            extracted.append(ZoneRecord(kind=kind, ring=ring, name=name))
        if not extracted:
            continue
        if bbox is not None and not any(
            _rings_overlap_bbox(z.ring, bbox) for z in extracted
        ):
            continue
        zones.extend(extracted)
    return zones


def filter_zones_by_bbox(
    zones: list[ZoneRecord], bbox: tuple[float, float, float, float]
) -> list[ZoneRecord]:
    """Keep only zones whose ring overlaps ``(xmin, ymin, xmax, ymax)``
    (lon, lat) - a server-side view filter over a full-region snapshot
    (e.g. the all-india overlay, served per operating bounds to the
    frontend map)."""
    return [z for z in zones if _rings_overlap_bbox(z.ring, bbox)]


def write_no_fly_zones(
    path: str | Path,
    zones: list[ZoneRecord],
    source: str,
) -> dict[str, Any]:
    """Persist the snapshot JSON (typed rings + download timestamp)."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": source,
        "zones": [
            {"kind": z.kind, "name": z.name, "ring": list(z.ring)} for z in zones
        ],
    }
    path.write_text(json.dumps(payload, indent=1), encoding="utf-8")
    return payload


@dataclass(frozen=True)
class NoFlySnapshot:
    """The snapshot payload: zones plus provenance metadata."""

    zones: list[ZoneRecord]
    fetched_at: str | None = None
    source: str | None = None

    def __bool__(self) -> bool:
        return bool(self.zones)


def load_no_fly_snapshot(path: str | Path | None) -> NoFlySnapshot:
    """Load the snapshot JSON (zones + metadata); empty snapshot if absent."""
    if not path:
        return NoFlySnapshot(zones=[])
    p = Path(path)
    if not p.exists():
        return NoFlySnapshot(zones=[])
    try:
        payload = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return NoFlySnapshot(zones=[])
    zones: list[ZoneRecord] = []
    for item in payload.get("zones", []):
        kind = item.get("kind")
        if kind not in ("red", "amber"):
            continue
        ring = tuple(tuple(float(v) for v in pt) for pt in item.get("ring", []))
        if len(ring) < 4:
            continue
        zones.append(ZoneRecord(kind=kind, ring=ring, name=str(item.get("name", ""))))
    return NoFlySnapshot(
        zones=zones,
        fetched_at=payload.get("fetched_at"),
        source=payload.get("source"),
    )


def load_no_fly_zones(path: str | Path | None) -> list[ZoneRecord]:
    """Convenience: zones only (see :func:`load_no_fly_snapshot`)."""
    return load_no_fly_snapshot(path).zones
