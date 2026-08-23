"""Inbound request schemas."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator

#: supported pathfinding algorithms
AlgorithmName = Literal["astar", "theta_star", "visibility"]


class NoFlyZone(BaseModel):
    """A closed polygon ring of (lat, lon) vertices in WGS84."""

    ring: list[tuple[float, float]] = Field(..., min_length=4)

    @field_validator("ring")
    @classmethod
    def _ring_closed(cls, ring: list[tuple[float, float]]) -> list[tuple[float, float]]:
        if ring[0] != ring[-1]:
            ring = ring + [ring[0]]
        return ring


class _MissionBase(BaseModel):
    """Shared mission fields. All optionals override planner settings."""

    start_lat: float = Field(..., ge=-90.0, le=90.0)
    start_lon: float = Field(..., ge=-180.0, le=180.0)
    goal_lat: float = Field(..., ge=-90.0, le=90.0)
    goal_lon: float = Field(..., ge=-180.0, le=180.0)

    altitude_m: float | None = Field(default=None, gt=0.0, le=500.0)
    grid_resolution_m: float | None = Field(default=None, gt=0.0, le=500.0)
    safety_margin_m: float | None = Field(default=None, ge=0.0, le=200.0)
    speed_mps: float | None = Field(default=None, gt=0.0, le=200.0)
    #: shift a start/goal that lands on a blocked cell to the nearest free
    #: cell (recommended for imprecise controller GPS)
    snap_start_goal: bool = False
    #: pathfinding algorithm override (default: config.planner_algorithm).
    #: "astar" = uniform grid, "theta_star" = any-angle grid,
    #: "visibility" = exact shortest path (small regions only)
    algorithm: AlgorithmName | None = None
    no_fly_zones: list[NoFlyZone] | None = None


class MissionRequest(_MissionBase):
    """Body of POST /generate-route."""


class ReplanRequest(_MissionBase):
    """Body of POST /replan: recompute from a new current position."""


class MissionCreateRequest(_MissionBase):
    """Body of POST /mission: register a mission and plan it."""

    mission_id: str | None = Field(default=None, min_length=3, max_length=64)
