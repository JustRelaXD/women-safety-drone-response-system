"""Outbound response schemas."""

from __future__ import annotations

from pydantic import BaseModel, Field

from ..core.config import ZoneKind


class Waypoint(BaseModel):
    """A single GPS waypoint the drone controller must fly to."""

    lat: float
    lon: float
    alt: float


class RouteResponse(BaseModel):
    """A computed route: GPS waypoints plus mission-level metadata.

    Normally ``warning`` is null and ``backup_waypoints`` is the direct
    start->goal line (an operator-verifiable shortcut).  When no
    collision-free corridor exists, the planner degrades instead of failing:
    ``waypoints`` becomes a best-effort route (closest reachable point, then
    a straight segment to the goal) and ``warning`` explains why and what to
    verify before flight.
    """

    mission_id: str
    distance: float = Field(description="route length in metres")
    estimated_time: float = Field(description="flight time in seconds")
    waypoints: list[Waypoint]
    #: null on a normal route; a human-readable warning when the returned
    #: route is degraded (see docstring)
    warning: str | None = None
    #: the direct start->goal line, always available as an operator backup
    backup_waypoints: list[Waypoint] | None = None
    #: every airspace zone the route crosses (kind preserved).  Amber zones
    #: are passable WITH permission: the operator must request it and notify
    #: the airport authority.  Red zones should never appear on a normal
    #: route (they are hard obstacles) but can on a degraded one.
    zones_crossed: list[NoFlyZoneInfo] = Field(default_factory=list)


class MissionResponse(BaseModel):
    """A registered mission with its plan."""

    mission_id: str
    status: str
    route: RouteResponse


class NoFlyZoneInfo(BaseModel):
    """One no-fly polygon for the frontend overlay."""

    kind: ZoneKind
    name: str
    ring: list[tuple[float, float]]


class NoFlyZoneScopeInfo(BaseModel):
    """One available overlay scope (e.g. punjab / india) and its size."""

    name: str
    zones: int
    fetched_at: str | None


class NoFlyZonesResponse(BaseModel):
    """GET /no-fly-zones payload (red/amber overlay + snapshot age).

    ``scope`` is the requested (or default) snapshot; ``available`` lists
    every configured scope so the frontend can render a switcher.
    """

    scope: str
    fetched_at: str | None
    source: str | None
    zones: list[NoFlyZoneInfo]
    available: list[NoFlyZoneScopeInfo] = Field(default_factory=list)


class HealthResponse(BaseModel):
    """GET /health payload."""

    status: str
    version: str
    buildings_parquet: str
    water_parquet: str | None
    memory_limit: str
    grid_resolution_m: float
    safety_margin_m: float
    default_altitude_m: float
    planner_algorithm: str
