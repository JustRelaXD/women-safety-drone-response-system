"""In-memory mission registry.

A mission is created via POST /mission and stored here so controllers can
replan against a known mission id.  Deliberately minimal (dict + lock): for a
single-worker VM this is enough; swap for Redis/Postgres later without
touching the planner itself.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field


@dataclass
class Mission:
    mission_id: str
    status: str = "created"
    created_at: float = field(default_factory=time.time)
    request: dict = field(default_factory=dict)
    route: dict | None = None


class MissionStore:
    """Thread-safe registry of active missions."""

    def __init__(self) -> None:
        self._missions: dict[str, Mission] = {}
        self._lock = threading.Lock()

    def put(self, mission: Mission) -> None:
        with self._lock:
            self._missions[mission.mission_id] = mission

    def get(self, mission_id: str) -> Mission | None:
        with self._lock:
            return self._missions.get(mission_id)

    def update_route(self, mission_id: str, route: dict) -> None:
        with self._lock:
            m = self._missions.get(mission_id)
            if m is not None:
                m.route = route
                m.status = "planned"

    def __len__(self) -> int:
        with self._lock:
            return len(self._missions)
