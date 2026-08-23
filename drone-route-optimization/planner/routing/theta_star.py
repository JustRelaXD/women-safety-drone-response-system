"""Theta* - any-angle path search over the same grid as A*.

Theta* differs from A* in one relaxation rule: when expanding node ``s``
towards neighbour ``n`` it first checks line-of-sight from ``s``'s parent to
``n``.  If the straight segment is clear, the path can jump parent -> n
directly (a segment of any angle, much shorter than the 8-connected
stair-step A* produces); otherwise the usual A* step s -> n is kept.  The
result is a path whose *vertices* are grid cells but whose *legs* are
straight lines of arbitrary angle.

Everything (grid, obstacle map, LOS with the conservative thick-line corner
check) is shared with A* and the post-processing smoother, so the three stay
consistent with each other and with the drone physical footprint.  The
heuristic is the euclidean distance (not the octile metric used by A*):
Theta* legs are straight segments costed at exactly euclidean length, so the
octile metric would overestimate and break admissibility; euclidean is
always a lower bound on the remaining any-angle path cost.

Memory profile is identical to A*: two float/int grids plus a byte grid.
"""

from __future__ import annotations

import heapq
import math
import time
from typing import Callable

import numpy as np

from .astar import PathResult
from .grid import GeoGrid
from .smoothing import has_line_of_sight

_SQRT2 = math.sqrt(2.0)

_DIRS: tuple[tuple[int, int], ...] = (
    (1, 0), (-1, 0), (0, 1), (0, -1),
    (1, 1), (1, -1), (-1, 1), (-1, -1),
)


class ThetaStar:
    """Any-angle variant of A* over a :class:`GeoGrid`."""

    def __init__(self, grid: GeoGrid) -> None:
        self.grid = grid

    @staticmethod
    def _distance(i0: int, j0: int, i1: int, j1: int) -> float:
        return math.hypot(i1 - i0, j1 - j0)

    @staticmethod
    def _heuristic(i: int, j: int, gi: int, gj: int) -> float:
        """Euclidean distance - admissible for any-angle segments."""
        return math.hypot(gi - i, gj - j)

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
        route growing toward the goal while the search is still running
        (same contract as A*: the endpoint's heuristic distance to the
        goal is monotonic, so the line never swings sideways through the
        early 360-degree frontier).
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
        parent[sj, si] = start_idx  # parent of start is itself
        heap: list[tuple[float, int, int]] = [
            (self._heuristic(si, sj, gi, gj), 0, start_idx)
        ]
        counter = 1
        expanded = 0
        last_emit_expanded = 0
        last_emit_time = 0.0
        # the expanded cell CLOSEST to the goal so far - the streamed line
        # ends here, so it only ever grows TOWARD the goal instead of
        # swinging through the whole 360-degree frontier Theta* explores early
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
                return PathResult(
                    cells=self._reconstruct(parent, start_idx, goal_idx, w),
                    nodes_explored=expanded,
                )

            gij = g[j, i]
            pidx = parent[j, i]
            # parent cell is (i=pi, j=pj); divmod yields (j, i) order
            pj, pi = divmod(pidx, w)
            for di, dj in _DIRS:
                ni, nj = i + di, j + dj
                if ni < 0 or ni >= w or nj < 0 or nj >= h or blocked[nj, ni]:
                    continue
                if closed[nj, ni]:
                    continue
                if has_line_of_sight(grid, (pi, pj), (ni, nj)):
                    # any-angle shortcut through the parent
                    ng = g[pj, pi] + self._distance(pi, pj, ni, nj)
                    new_parent = pidx
                else:
                    step = _SQRT2 if di and dj else 1.0
                    ng = gij + step
                    new_parent = idx
                if ng < g[nj, ni]:
                    g[nj, ni] = ng
                    parent[nj, ni] = new_parent
                    heapq.heappush(
                        heap, (ng + self._heuristic(ni, nj, gi, gj), counter, nj * w + ni)
                    )
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
