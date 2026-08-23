"""Tests for the no-fly zone import module and /no-fly-zones endpoint."""

from __future__ import annotations

import dataclasses
import json

from fastapi.testclient import TestClient

from planner.api.main import create_app
from planner.core.config import Settings
from planner.overture.no_fly import (
    load_no_fly_snapshot,
    write_no_fly_zones,
    zones_from_facilities,
)

def _ring_area_km2(ring: tuple[tuple[float, float], ...]) -> float:
    """Rough planar area (km^2) of a (lat, lon) ring via the shoelace
    formula on a local equirectangular projection."""
    import math

    n = len(ring)
    s = 0.0
    for i in range(n):
        lat1, lon1 = ring[i]
        lat2, lon2 = ring[(i + 1) % n]
        x1 = lon1 * 111.32 * math.cos(math.radians(lat1))
        y1 = lat1 * 111.32
        x2 = lon2 * 111.32 * math.cos(math.radians(lat2))
        y2 = lat2 * 111.32
        s += x1 * y2 - x2 * y1
    return abs(s) / 2.0


# a minimal facility with one red polygon (lon/lat order in GeoJSON)
_FACILITY = {
    "_id": "x",
    "name": "Test Airport",
    "type": "airport",
    "coordinates": [75.756, 31.433],
    "zones": {
        "red": {
            "radius": 0,
            "geojson": {
                "type": "Polygon",
                "coordinates": [
                    [[75.7, 31.4], [75.8, 31.4], [75.8, 31.5], [75.7, 31.5], [75.7, 31.4]]
                ],
            },
        },
        "innerYellow": {"radius": 0, "geojson": None},
        "outerYellow": {"radius": 0, "geojson": None},
        "approach": {"radius": 0, "geojson": None},
    },
}


def test_airport_red_circle_shrunk_to_configured_radius():
    """The DGCA ``type=airport`` red no-drone circle (an 11-14 km wide
    polygon that made cities with an airport unreachable) is replaced by a
    circle of ``airport_red_radius_km`` around the airport reference point
    when the knob is set.  A 1 km radius circle is ~2 km wide."""
    zones = zones_from_facilities([_FACILITY], airport_red_radius_km=1.0)
    assert len(zones) == 1
    z = zones[0]
    assert z.kind == "red"
    lats = [p[0] for p in z.ring]
    lons = [p[1] for p in z.ring]
    import math
    lat_c = sum(lats) / len(lats)
    w = (max(lons) - min(lons)) * 111.32 * math.cos(math.radians(lat_c))
    h = (max(lats) - min(lats)) * 111.32
    assert 1.5 < w < 2.5 and 1.5 < h < 2.5  # ~1 km radius circle
    # centred on the facility coordinates ([lon, lat] in the payload)
    assert abs(sum(lats) / len(lats) - 31.433) < 0.01
    assert abs(sum(lons) / len(lons) - 75.756) < 0.01
    assert len(z.ring) > 30  # smooth circle, not the 5-vertex box


def test_airport_circle_kept_when_radius_none():
    """Without the knob the DGCA circle is kept as-is (the ring is the
    original polygon, not a generated circle)."""
    zones = zones_from_facilities([_FACILITY])
    assert len(zones) == 1
    z = zones[0]
    # original 0.1 deg box fixture: ring starts at (31.4, 75.7) and has
    # exactly the 5 fixture vertices
    assert z.ring[0] == (31.4, 75.7)
    assert len(z.ring) == 5


def test_airport_radius_default_is_one_km():
    """Settings default is 1 km (the import applies it when no flag/env is
    given), so cities with an airport at their centre stay reachable."""
    from planner.core.config import Settings

    assert Settings().airport_red_radius_km == 1.0


def test_airport_radius_does_not_touch_non_airport_red():
    """The shrink applies ONLY to ``type=airport`` records.  Border strips,
    cantonments, jails and railway stations (``type=states``) keep their
    exact DGCA polygons even when a radius is configured."""
    fac = json.loads(json.dumps(_FACILITY))
    fac["type"] = "states"
    fac["name"] = "Jalandhar cantonment"
    zones = zones_from_facilities([fac], airport_red_radius_km=2.0)
    assert len(zones) == 1
    z = zones[0]
    assert z.ring[0] == (31.4, 75.7)  # original polygon untouched
    assert len(z.ring) == 5


def test_airport_radius_zero_keeps_circle():
    """radius=0 means "keep the DGCA circle" (explicit opt-out)."""
    zones = zones_from_facilities([_FACILITY], airport_red_radius_km=0.0)
    assert len(zones) == 1
    assert zones[0].ring[0] == (31.4, 75.7)
    assert len(zones[0].ring) == 5


def test_zone_kind_and_ring_order():
    zones = zones_from_facilities([_FACILITY])
    assert len(zones) == 1
    z = zones[0]
    assert z.kind == "red"
    assert z.name == "Test Airport"
    # GeoJSON [lon, lat] -> planner (lat, lon)
    assert z.ring[0] == (31.4, 75.7)
    assert z.ring[-1] == z.ring[0]  # closed ring


def test_amber_layers_mapped():
    fac = json.loads(json.dumps(_FACILITY))
    fac["zones"]["innerYellow"] = {
        "radius": 0,
        "geojson": {
            "type": "Polygon",
            "coordinates": [
                [[75.71, 31.41], [75.79, 31.41], [75.79, 31.49], [75.71, 31.49], [75.71, 31.41]]
            ],
        },
    }
    zones = zones_from_facilities([fac])
    kinds = {z.kind for z in zones}
    assert kinds == {"red", "amber"}


def test_approach_layer_is_amber():
    """The approach/departure funnels (the "two triangular shapes" away
    from the runway) are AMBER: they are tens of km long and would make
    whole cities with an airport unreachable, so they are passable-with-
    permission like the controlled-airspace circles, not hard obstacles."""
    fac = json.loads(json.dumps(_FACILITY))
    fac["zones"]["approach"] = {
        "radius": 0,
        "geojson": {
            "type": "Polygon",
            "coordinates": [
                [[75.60, 31.30], [75.85, 31.30], [75.85, 31.60], [75.60, 31.60], [75.60, 31.30]]
            ],
        },
    }
    zones = zones_from_facilities([fac])
    kinds = {z.kind for z in zones}
    assert kinds == {"red", "amber"}  # runway red, approach funnel amber
    assert len(zones) == 2
    amber = next(z for z in zones if z.kind == "amber")
    assert amber.name == "Test Airport"


def test_outer_yellow_layer_is_amber():
    """The large round controlled-airspace circles stay amber (passable
    with permission) - the runway footprint is the only red part."""
    fac = json.loads(json.dumps(_FACILITY))
    fac["zones"]["outerYellow"] = {
        "radius": 0,
        "geojson": {
            "type": "Polygon",
            "coordinates": [
                [[75.70, 31.35], [75.80, 31.35], [75.80, 31.45], [75.70, 31.45], [75.70, 31.35]]
            ],
        },
    }
    zones = zones_from_facilities([fac])
    kinds = {z.kind for z in zones}
    assert kinds == {"red", "amber"}
    amber = next(z for z in zones if z.kind == "amber")
    assert amber.name == "Test Airport"


def test_bbox_filter_drops_far_facility():
    zones = zones_from_facilities([_FACILITY], bbox=(80.0, 20.0, 81.0, 21.0))
    assert zones == []


def test_bbox_keeps_overlapping_facility():
    zones = zones_from_facilities([_FACILITY], bbox=(75.65, 31.35, 75.85, 31.55))
    assert len(zones) == 1


def test_bbox_keeps_runway_when_only_amber_overlaps():
    """Regression: airstrip runways must survive the bbox filter.

    The runway (red) polygon can sit just outside the operating-area bbox
    while the approach circle (amber) overlaps it (Shimla Airstrip, lon
    77.064 vs the Punjab cut at 77.0).  The bbox is a FACILITY-level filter:
    once any zone is in scope, the whole facility is kept.
    """
    fac = json.loads(json.dumps(_FACILITY))
    # red runway just east of the bbox (lon > 75.9)
    fac["zones"]["red"] = {
        "radius": 0,
        "geojson": {
            "type": "Polygon",
            "coordinates": [
                [[75.96, 31.4], [75.97, 31.4], [75.97, 31.5], [75.96, 31.5], [75.96, 31.4]]
            ],
        },
    }
    # amber innerYellow circle overlapping the bbox (lon 75.7-75.85)
    fac["zones"]["innerYellow"] = {
        "radius": 0,
        "geojson": {
            "type": "Polygon",
            "coordinates": [
                [[75.7, 31.2], [75.85, 31.2], [75.85, 31.7], [75.7, 31.7], [75.7, 31.2]]
            ],
        },
    }
    zones = zones_from_facilities([fac], bbox=(75.6, 31.2, 75.9, 31.7))
    kinds = {z.kind for z in zones}
    # the red runway is OUTSIDE the bbox but must still be kept
    assert "red" in kinds
    assert "amber" in kinds
    red = [z for z in zones if z.kind == "red"][0]
    lons = [p[1] for p in red.ring]
    assert max(lons) > 75.9  # the kept runway really is the outside-the-bbox one


def test_facility_fully_outside_bbox_is_dropped():
    """A facility with no zone in scope is still dropped entirely."""
    fac = json.loads(json.dumps(_FACILITY))
    fac["zones"]["red"] = {
        "radius": 0,
        "geojson": {
            "type": "Polygon",
            "coordinates": [
                [[80.0, 20.0], [80.2, 20.0], [80.2, 20.2], [80.0, 20.2], [80.0, 20.0]]
            ],
        },
    }
    zones = zones_from_facilities([fac], bbox=(75.6, 31.2, 75.9, 31.7))
    assert zones == []


def test_airstrip_facility_split_red_runway_amber_approach_and_circle():
    """The DGCA model: airstrips carry a small red RUNWAY, amber APPROACH
    funnels (the "two triangular shapes" away from the runway) and a big
    amber innerYellow circle.  Only the runway footprint is a hard
    obstacle; the funnels and circle stay passable-with-permission.
    """
    fac = json.loads(json.dumps(_FACILITY))
    fac["name"] = "Beas Airstrip"
    fac["zones"]["red"] = {
        "radius": 0,
        "geojson": {
            "type": "Polygon",
            "coordinates": [
                # small runway ~0.9 x 2.2 km
                [[75.3368, 31.5508], [75.3454, 31.5508], [75.3454, 31.5706],
                 [75.3368, 31.5706], [75.3368, 31.5508]]
            ],
        },
    }
    fac["zones"]["approach"] = {
        "radius": 0,
        "geojson": {
            "type": "Polygon",
            "coordinates": [
                # elongated funnels along the runway axis ~18 x 32 km
                [[75.2489, 31.4162], [75.4331, 31.4162], [75.4331, 31.7052],
                 [75.2489, 31.7052], [75.2489, 31.4162]]
            ],
        },
    }
    fac["zones"]["innerYellow"] = {
        "radius": 0,
        "geojson": {
            "type": "Polygon",
            "coordinates": [
                # round circle around it ~24 x 24 km
                [[75.20, 31.45], [75.48, 31.45], [75.48, 31.68],
                 [75.20, 31.68], [75.20, 31.45]]
            ],
        },
    }
    zones = zones_from_facilities([fac])
    kinds = {z.kind for z in zones}
    assert kinds == {"red", "amber"}
    reds = [z for z in zones if z.kind == "red"]
    ambers = [z for z in zones if z.kind == "amber"]
    # only the runway is red; approach funnel + circle are amber
    assert len(reds) == 1
    assert len(ambers) == 2
    assert all(z.name == "Beas Airstrip" for z in reds + ambers)
    # the runway ring is the small one, the funnel the big one
    runway = reds[0]
    funnel = next(z for z in ambers if _ring_area_km2(z.ring) > 50)
    circle = next(z for z in ambers if z is not funnel)
    assert _ring_area_km2(runway.ring) < 5
    assert _ring_area_km2(funnel.ring) > 50
    assert _ring_area_km2(circle.ring) > 10


def test_write_and_load_roundtrip(tmp_path):
    out = tmp_path / "no_fly.json"
    zones = zones_from_facilities([_FACILITY])
    payload = write_no_fly_zones(out, zones, "test-source")
    assert out.exists()
    assert payload["source"] == "test-source"
    snap = load_no_fly_snapshot(out)
    assert len(snap.zones) == 1
    assert snap.source == "test-source"
    assert snap.fetched_at is not None
    assert snap.zones[0].ring == zones[0].ring


def test_load_missing_file_is_empty():
    snap = load_no_fly_snapshot("/nonexistent/no_fly.json")
    assert len(snap.zones) == 0
    assert not snap


def test_load_corrupt_file_is_empty(tmp_path):
    out = tmp_path / "bad.json"
    out.write_text("{not json", encoding="utf-8")
    snap = load_no_fly_snapshot(out)
    assert len(snap.zones) == 0


def test_from_env_with_no_fly_falls_back_when_configured_file_missing(monkeypatch, tmp_path):
    """A configured but MISSING no-fly file must not silently disable
    red-zone blocking: the loader falls back to the india snapshot so the
    planner still rasterises red zones as obstacles."""
    india = tmp_path / "india.json"
    write_no_fly_zones(india, zones_from_facilities([_FACILITY]), "india-src")
    monkeypatch.setenv("PLANNER_NO_FLY_ZONES_FILE", str(tmp_path / "missing.json"))
    monkeypatch.setenv("PLANNER_NO_FLY_ZONES_FILES", f"india={india}")
    settings = Settings.from_env_with_no_fly()
    assert len(settings.no_fly_zones) == 1
    assert settings.no_fly_zones[0].kind == "red"


def test_from_env_with_no_fly_falls_back_when_configured_file_empty(monkeypatch, tmp_path):
    """An EMPTY configured file (zero zones) falls back too - an empty
    obstacle set would let drones fly through red zones."""
    punjab = tmp_path / "punjab.json"
    india = tmp_path / "india.json"
    write_no_fly_zones(punjab, [], "empty-src")
    write_no_fly_zones(india, zones_from_facilities([_FACILITY]), "india-src")
    monkeypatch.setenv("PLANNER_NO_FLY_ZONES_FILE", str(punjab))
    monkeypatch.setenv("PLANNER_NO_FLY_ZONES_FILES", f"india={india}")
    settings = Settings.from_env_with_no_fly()
    assert len(settings.no_fly_zones) == 1
    assert settings.no_fly_zones[0].kind == "red"


def test_from_env_with_no_fly_keeps_configured_file_when_present(monkeypatch, tmp_path):
    """A configured file that actually has zones wins - no fallback."""
    punjab = tmp_path / "punjab.json"
    india = tmp_path / "india.json"
    fac_p = json.loads(json.dumps(_FACILITY))
    fac_p["name"] = "Punjab Airport"
    write_no_fly_zones(punjab, zones_from_facilities([fac_p]), "punjab-src")
    fac2 = json.loads(json.dumps(_FACILITY))
    fac2["coordinates"] = [77.0, 28.0]  # Delhi-ish
    write_no_fly_zones(india, zones_from_facilities([fac2]), "india-src")
    monkeypatch.setenv("PLANNER_NO_FLY_ZONES_FILE", str(punjab))
    monkeypatch.setenv("PLANNER_NO_FLY_ZONES_FILES", f"india={india}")
    settings = Settings.from_env_with_no_fly()
    assert len(settings.no_fly_zones) == 1
    assert settings.no_fly_zones[0].name == "Punjab Airport"


def test_no_fly_zones_endpoint_with_file(planner_settings, tmp_path):
    """GET /no-fly-zones serves the imported snapshot with metadata."""
    out = tmp_path / "no_fly.json"
    write_no_fly_zones(out, zones_from_facilities([_FACILITY]), "test-source")
    cfg = dataclasses.replace(planner_settings, no_fly_zones_file=str(out))
    app = create_app(cfg)
    client = TestClient(app)
    r = client.get("/no-fly-zones")
    assert r.status_code == 200
    data = r.json()
    assert len(data["zones"]) == 1
    assert data["zones"][0]["kind"] == "red"
    assert data["source"] == "test-source"
    assert data["fetched_at"] is not None


def test_no_fly_zones_endpoint_without_file(planner_settings):
    """No configured file -> empty zone list (frontend shows nothing)."""
    cfg = dataclasses.replace(planner_settings, no_fly_zones_file=None)
    app = create_app(cfg)
    client = TestClient(app)
    r = client.get("/no-fly-zones")
    assert r.status_code == 200
    data = r.json()
    assert data["zones"] == []
    assert data["scope"] == "punjab"
    assert data["available"] == []


def test_no_fly_zones_scope_selects_snapshot(planner_settings, tmp_path):
    """?scope=india serves the all-india snapshot; available lists both."""
    punjab = tmp_path / "punjab.json"
    india = tmp_path / "india.json"
    write_no_fly_zones(punjab, zones_from_facilities([_FACILITY]), "punjab-src")
    fac2 = json.loads(json.dumps(_FACILITY))
    fac2["coordinates"] = [77.0, 28.0]  # Delhi-ish
    write_no_fly_zones(india, zones_from_facilities([fac2]), "india-src")
    cfg = dataclasses.replace(
        planner_settings,
        no_fly_zones_file=str(punjab),
        no_fly_zones_files={"punjab": str(punjab), "india": str(india)},
    )
    app = create_app(cfg)
    client = TestClient(app)

    # default scope = punjab
    r = client.get("/no-fly-zones")
    assert r.status_code == 200
    data = r.json()
    assert data["scope"] == "punjab"
    assert len(data["zones"]) == 1
    assert len(data["available"]) == 2
    names = {a["name"] for a in data["available"]}
    assert names == {"punjab", "india"}

    # explicit india scope
    r = client.get("/no-fly-zones", params={"scope": "india"})
    assert r.status_code == 200
    data = r.json()
    assert data["scope"] == "india"
    assert len(data["zones"]) == 1
    assert data["source"] == "india-src"


def test_filter_zones_by_bbox_keeps_only_overlapping():
    """The server-side view filter keeps only rings overlapping the box."""
    from planner.overture.no_fly import filter_zones_by_bbox

    zones = zones_from_facilities([_FACILITY])
    assert len(zones) == 1
    assert filter_zones_by_bbox(zones, (75.0, 30.5, 76.5, 32.0)) == zones
    assert filter_zones_by_bbox(zones, (80.0, 20.0, 81.0, 21.0)) == []


def test_no_fly_zones_bbox_filters_snapshot(planner_settings, tmp_path):
    """?bbox= restricts the overlay to zones overlapping the box - a
    regional view of an all-India snapshot without shipping every ring to
    the browser."""
    punjab = tmp_path / "punjab.json"
    india = tmp_path / "india.json"
    write_no_fly_zones(punjab, zones_from_facilities([_FACILITY]), "punjab-src")
    fac2 = json.loads(json.dumps(_FACILITY))
    fac2["coordinates"] = [77.0, 28.0]  # Delhi-ish reference point
    fac2["zones"]["red"]["geojson"]["coordinates"] = [
        [[76.9, 27.9], [77.1, 27.9], [77.1, 28.1], [76.9, 28.1], [76.9, 27.9]]
    ]
    write_no_fly_zones(india, zones_from_facilities([fac2]), "india-src")
    cfg = dataclasses.replace(
        planner_settings,
        no_fly_zones_file=str(punjab),
        no_fly_zones_files={"punjab": str(punjab), "india": str(india)},
    )
    app = create_app(cfg)
    client = TestClient(app)

    # a Patiala bbox keeps the punjab zone (75.7, 31.4) and drops Delhi
    r = client.get(
        "/no-fly-zones", params={"scope": "punjab", "bbox": "75.0,30.5,76.5,32.0"}
    )
    assert r.status_code == 200
    assert len(r.json()["zones"]) == 1

    r = client.get(
        "/no-fly-zones", params={"scope": "india", "bbox": "75.0,30.5,76.5,32.0"}
    )
    assert r.status_code == 200
    assert r.json()["zones"] == []  # the india zone sits at (77.0, 28.0)

    r = client.get(
        "/no-fly-zones", params={"scope": "punjab", "bbox": "80.0,20.0,81.0,21.0"}
    )
    assert r.status_code == 200
    assert r.json()["zones"] == []


def test_no_fly_zones_malformed_bbox_400(planner_settings, tmp_path):
    """A non-numeric bbox is a client error, not a silent empty overlay."""
    out = tmp_path / "no_fly.json"
    write_no_fly_zones(out, zones_from_facilities([_FACILITY]), "test-source")
    cfg = dataclasses.replace(planner_settings, no_fly_zones_file=str(out))
    app = create_app(cfg)
    client = TestClient(app)
    r = client.get("/no-fly-zones", params={"bbox": "not-a-bbox"})
    assert r.status_code == 400


def test_no_fly_zones_unknown_scope_falls_back(planner_settings, tmp_path):
    """Unknown scope -> configured no_fly_zones_file (backward compatible)."""
    out = tmp_path / "no_fly.json"
    write_no_fly_zones(out, zones_from_facilities([_FACILITY]), "test-source")
    cfg = dataclasses.replace(
        planner_settings,
        no_fly_zones_file=str(out),
        no_fly_zones_files={"india": str(out)},
    )
    app = create_app(cfg)
    client = TestClient(app)
    r = client.get("/no-fly-zones", params={"scope": "nonexistent"})
    assert r.status_code == 200
    data = r.json()
    assert len(data["zones"]) == 1  # falls back to no_fly_zones_file
    assert data["scope"] == "nonexistent"
