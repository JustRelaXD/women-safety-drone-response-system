"""Grid A* search with an octile heuristic.

Standard best-first search over the cell grid with 8-connectivity and
`sqrt(2)` diagonal costs, lazy-deletion heap, and early exit on the goal.
Memory is two float/int grids plus a byte grid, so a 2000 x 2000 cell map
costs well under 100 MB.

Also hosts :func:`closest_reachable_cell`, the degraded-mode flood fill
that finds the reachable free cell nearest the goal when no full corridor
exists (used by the planner's last-resort fallback).
"""

from __future__ import annotations

import heapq
import math
import time
from collections import deque
from dataclasses import dataclass
from typing import Callable

import numpy as np

from .grid import GeoGrid

_SQRT2 = math.sqrt(2.0)

# (di, dj) 8-neighbourhood
_DIRS: tuple[tuple[int, int], ...] = (
    (1, 0), (-1, 0), (0, 1), (0, -1),
    (1, 1), (1, -1), (-1, 1), (-1, -1),
)


@dataclass(frozen=True)
class PathResult:
    """A found path as an ordered list of (i, j) cells plus stats."""

    cells: tuple[tuple[int, int], ...]
    nodes_explored: int


class AStar:
    def __init__(self, grid: GeoGrid) -> None:
        self.grid = grid

    def _heuristic(self, i: int, j: int, gi: int, gj: int) -> float:
        dx, dy = abs(i - gi), abs(j - gj)
        return max(dx, dy) + (_SQRT2 - 1.0) * min(dx, dy)

    def find_path(
        self,
        start: tuple[int, int],
        goal: tuple[int, int],
        progress: Callable[[list[tuple[int, int]]], None] | None = None,
    ) -> PathResult | None:
        """Path from ``start`` to ``goal`` cells, or None if unreachable.

        ``progress`` (optional) receives the current best path from the
        start to the expanded cell CLOSEST to the goal so far, throttled
        to a few times per second, so a streaming client can draw the
        route growing toward the goal while the search is still running.
        The endpoint's heuristic distance to the goal is monotonic, so the
        line never swings sideways through the 360-degree frontier the
        search explores early.
        """
        grid = self.grid
        blocked = grid.blocked
        w, h = grid.width, grid.height
        si, sj = start
        gi, gj = goal

        if blocked[sj, si] or blocked[gj, gi]:
            return None

        g = np.full((h, w), np.inf, dtype=np.float32)
        parent = np.full((h, w), -1, dtype=np.int32)
        closed = np.zeros((h, w), dtype=np.uint8)

        g[sj, si] = 0.0
        start_idx = sj * w + si
        goal_idx = gj * w + gi
        heap: list[tuple[float, int, int]] = [
            (self._heuristic(si, sj, gi, gj), 0, start_idx)
        ]
        counter = 1
        expanded = 0
        last_emit_expanded = 0
        last_emit_time = 0.0
        # the expanded cell CLOSEST to the goal so far - the streamed line
        # ends here, so it only ever grows TOWARD the goal instead of
        # swinging through the whole 360-degree frontier A* explores early
        best_h = math.inf
        best_idx = start_idx

        while heap:
            f, _, idx = heapq.heappop(heap)
            j, i = divmod(idx, w)
            if closed[j, i]:
                continue
            closed[j, i] = 1
            expanded += 1
            hval = self._heuristic(i, j, gi, gj)
            if hval < best_h:
                best_h = hval
                best_idx = idx
                if (
                    progress is not None
                    and expanded - last_emit_expanded >= 64
                ):
                    now = time.perf_counter()
                    if now - last_emit_time >= 0.15:
                        # the current best path from the start to the cell
                        # CLOSEST to the goal found so far - the route
                        # literally extends toward the destination as the
                        # search improves (never sideways, always a prefix)
                        progress(
                            list(self._reconstruct(parent, start_idx, best_idx, w))
                        )
                        last_emit_expanded = expanded
                        last_emit_time = now
            if idx == goal_idx:
                return PathResult(cells=self._reconstruct(parent, start_idx, goal_idx, w),
                                  nodes_explored=expanded)

            gij = g[j, i]
            for di, dj in _DIRS:
                ni, nj = i + di, j + dj
                if ni < 0 or ni >= w or nj < 0 or nj >= h or blocked[nj, ni]:
                    continue
                if closed[nj, ni]:
                    continue
                step = _SQRT2 if di and dj else 1.0
                ng = gij + step
                if ng < g[nj, ni]:
                    g[nj, ni] = ng
                    parent[nj, ni] = idx
                    f_ = ng + self._heuristic(ni, nj, gi, gj)
                    heapq.heappush(heap, (f_, counter, nj * w + ni))
                    counter += 1
        return None

    @staticmethod
    def _reconstruct(
        parent: np.ndarray, start_idx: int, goal_idx: int, w: int
    ) -> tuple[tuple[int, int], ...]:
        path: list[tuple[int, int]] = []
        idx = goal_idx
        while idx != -1:
            j, i = divmod(idx, w)
            path.append((i, j))
            if idx == start_idx:
                break
            idx = parent[j, i]
        path.reverse()
        return tuple(path)


def closest_reachable_cell(
    grid: GeoGrid,
    start: tuple[int, int],
    goal: tuple[int, int],
) -> tuple[list[tuple[int, int]], float, int]:
    """BFS flood fill from ``start`` over free cells; returns the path to the
    reachable free cell closest to ``goal``, the remaining straight-line
    distance in metres, and the number of cells actually visited.

    Used only by the degraded fallback when no start->goal corridor exists:
    the drone flies the returned path, then a straight segment from its last
    cell to the real goal (that final segment may cross buildings or amber
    zones - the caller attaches the warning).  The caller must NOT append
    the straight segment when it would cross a RED zone: red is an absolute
    prohibition, so the route ends at the closest reachable cell instead.
    Cell distances are squared-cell units, so the scan is exact 8-connected
    flood fill with no heap overhead.
    """
    blocked = grid.blocked
    w, h = grid.width, grid.height
    si, sj = start
    gi, gj = goal

    # start itself blocked (should not happen after snapping): return the
    # degenerate path so the caller still produces start -> goal straight
    if blocked[sj, si]:
        return (
            [start],
            math.hypot(si - gi, sj - gj) * grid.cell_size_m,
            1,
        )

    parent = np.full((h, w), -1, dtype=np.int32)
    visited = np.zeros((h, w), dtype=np.bool_)
    visited[sj, si] = True
    queue: deque[tuple[int, int]] = deque([(si, sj)])
    best = (si, sj)
    best_d2 = (si - gi) ** 2 + (sj - gj) ** 2
    visited_count = 1

    while queue:
        i, j = queue.popleft()
        d2 = (i - gi) ** 2 + (j - gj) ** 2
        if d2 < best_d2:
            best_d2 = d2
            best = (i, j)
        for di, dj in _DIRS:
            ni, nj = i + di, j + dj
            if (
                0 <= ni < w
                and 0 <= nj < h
                and not blocked[nj, ni]
                and not visited[nj, ni]
            ):
                visited[nj, ni] = True
                visited_count += 1
                parent[nj, ni] = j * w + i
                queue.append((ni, nj))

    # reconstruct the path from start to the best reachable cell
    path: list[tuple[int, int]] = []
    ci, cj = best
    while (ci, cj) != (si, sj):
        path.append((ci, cj))
        idx = parent[cj, ci]
        if idx < 0:
            break
        cj, ci = divmod(idx, w)
    path.append((si, sj))
    path.reverse()
    remaining_m = math.sqrt(best_d2) * grid.cell_size_m
    return path, remaining_m, visited_count
