"""RAM measurement helpers (stdlib only, Linux)."""

from __future__ import annotations

import resource


def peak_rss_kb() -> int:
    """Peak resident set size of this process so far, in KiB (Linux)."""
    return int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)


def fmt_mb(kb: int) -> str:
    return f"{kb / 1024.0:.1f} MB"
