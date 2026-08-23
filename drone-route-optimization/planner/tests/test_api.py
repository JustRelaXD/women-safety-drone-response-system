"""API endpoint tests (FastAPI TestClient against synthetic data)."""

import json

import pytest
from fastapi.testclient import TestClient

from planner.api.main import create_app

from planner.tests.conftest import GOAL, START


@pytest.fixture(scope="module")
def client(planner_settings):
    app = create_app(planner_settings)
    return TestClient(app)


def _body(**kw):
    body = {
        "start_lat": START[0],
        "start_lon": START[1],
        "goal_lat": GOAL[0],
        "goal_lon": GOAL[1],
    }
    body.update(kw)
    return body


def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    data = r.json()
    assert data["status"] == "ok"
    assert data["memory_limit"] == "256MB"


def test_generate_route(client):
    r = client.post("/generate-route", json=_body())
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["mission_id"]
    assert data["distance"] > 0
    assert data["estimated_time"] > 0
    assert len(data["waypoints"]) >= 2
    wp = data["waypoints"][0]
    assert set(wp.keys()) == {"lat", "lon", "alt"}
    assert wp["alt"] == 50.0


def test_generate_route_with_overrides(client):
    r = client.post(
        "/generate-route",
        json=_body(altitude_m=120.0, grid_resolution_m=20.0, speed_mps=25.0),
    )
    assert r.status_code == 200
    data = r.json()
    assert all(w["alt"] == 120.0 for w in data["waypoints"])


def test_generate_route_zero_safety_margin(client):
    """safety_margin_m=0 is a valid request: the grid corridor opens to 0 m."""
    r = client.post("/generate-route", json=_body(safety_margin_m=0.0))
    assert r.status_code == 200, r.text
    assert len(r.json()["waypoints"]) >= 2


def test_generate_route_negative_margin_422(client):
    r = client.post("/generate-route", json=_body(safety_margin_m=-1.0))
    assert r.status_code == 422


def test_generate_route_no_path_degrades_with_warning(client):
    """A sealed goal no longer 409s: the planner degrades and returns a
    best-effort route with an explicit warning + the direct-line backup."""
    zone = {
        "ring": [
            [GOAL[0] - 0.0005, GOAL[1] - 0.0005],
            [GOAL[0] - 0.0005, GOAL[1] + 0.0005],
            [GOAL[0] + 0.0005, GOAL[1] + 0.0005],
            [GOAL[0] + 0.0005, GOAL[1] - 0.0005],
            [GOAL[0] - 0.0005, GOAL[1] - 0.0005],
        ]
    }
    r = client.post("/generate-route", json=_body(no_fly_zones=[zone]))
    assert r.status_code == 200
    data = r.json()
    assert data["warning"]
    assert len(data["waypoints"]) >= 2
    # the direct start->goal line is always available as a backup
    assert len(data["backup_waypoints"]) >= 2
    assert data["backup_waypoints"][0]["lat"] == START[0]
    assert data["backup_waypoints"][-1]["lat"] == GOAL[0]


def test_generate_route_validation_422(client):
    r = client.post("/generate-route", json={"start_lat": 999.0})
    assert r.status_code == 422


def test_replan(client):
    r = client.post(
        "/replan",
        json=_body(start_lat=START[0] + 0.0002, start_lon=START[1] + 0.0002),
    )
    assert r.status_code == 200
    assert len(r.json()["waypoints"]) >= 2


def test_generate_route_stream_ndjson(client):
    """The streaming endpoint emits NDJSON: stage events (with partial
    waypoints) then a complete event carrying the same shape as
    /generate-route."""
    r = client.post("/generate-route/stream", json=_body())
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("application/x-ndjson")

    stages: list[str] = []
    partials: list[list] = []
    complete: dict | None = None
    for line in r.text.splitlines():
        if not line.strip():
            continue
        evt = json.loads(line)
        assert "type" in evt
        if evt["type"] == "stage":
            stages.append(evt["stage"])
            if evt.get("waypoints"):
                partials.append(evt["waypoints"])
        elif evt["type"] == "complete":
            complete = evt["data"]

    # the full route arrives exactly once and matches the classic response
    assert complete is not None
    assert complete["mission_id"]
    assert len(complete["waypoints"]) >= 2
    assert set(complete["waypoints"][0].keys()) == {"lat", "lon", "alt"}

    # stage events cover the pipeline; at least one carried live waypoints
    assert stages
    assert "region" in stages
    assert any(s in stages for s in ("path", "smooth", "geometry"))
    assert any(len(p) >= 2 for p in partials)

    # the streamed route agrees with the non-streaming endpoint (mission_id
    # is random per call, so compare the route itself)
    classic = client.post("/generate-route", json=_body()).json()
    assert len(complete["waypoints"]) == len(classic["waypoints"])
    assert complete["distance"] == classic["distance"]
    assert complete["estimated_time"] == classic["estimated_time"]


def test_generate_route_stream_error_event(client, planner_settings, tmp_path):
    """A planning failure inside the stream is delivered as an error event
    with the HTTP-style status, not a broken HTTP response.  Uses a missing
    parquet file (PlannerError -> 500) so the error path is actually
    exercised - sealed-goal inputs degrade with a warning instead."""
    import dataclasses

    from planner.api.main import create_app as make_app

    broken = dataclasses.replace(
        planner_settings, buildings_parquet=str(tmp_path / "nope.parquet")
    )
    app = make_app(broken)
    bad_client = TestClient(app)
    r = bad_client.post("/generate-route/stream", json=_body())
    assert r.status_code == 200, r.text  # transport-level 200, event carries status
    errors = []
    for line in r.text.splitlines():
        evt = json.loads(line)
        if evt["type"] == "error":
            errors.append(evt)
    assert len(errors) == 1
    assert errors[0]["status"] == 500
    assert errors[0]["detail"]


def test_generate_route_stream_degraded_has_no_error_event(client):
    """A mission that degrades (no corridor) does NOT emit an error event:
    the stream ends with a complete event whose route carries the warning."""
    zone = {
        "ring": [
            [GOAL[0] - 0.0005, GOAL[1] - 0.0005],
            [GOAL[0] - 0.0005, GOAL[1] + 0.0005],
            [GOAL[0] + 0.0005, GOAL[1] + 0.0005],
            [GOAL[0] + 0.0005, GOAL[1] - 0.0005],
            [GOAL[0] - 0.0005, GOAL[1] - 0.0005],
        ]
    }
    r = client.post(
        "/generate-route/stream",
        json=_body(no_fly_zones=[zone]),
    )
    assert r.status_code == 200, r.text
    complete = None
    for line in r.text.splitlines():
        evt = json.loads(line)
        if evt["type"] == "complete":
            complete = evt["data"]
    assert complete is not None
    assert complete["warning"]
    assert len(complete["waypoints"]) >= 2


def test_mission_create(client):
    r = client.post("/mission", json=_body(mission_id="test-mission"))
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["mission_id"] == "test-mission"
    assert data["status"] == "planned"
    assert data["route"]["mission_id"] == "test-mission"
    assert client.app.state.missions.get("test-mission") is not None
