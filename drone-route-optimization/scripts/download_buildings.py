"""Resumable, memory-safe Overture Maps buildings downloader.

Downloads the Overture ``building`` shards that overlap one or more region
bounding boxes, writing each shard to its own GeoParquet file under
``buildings/tiles/<release>/``.  Shards are keyed by their Overture filename,
so:

  * overlapping regions never re-download the same shard,
  * a run interrupted with Ctrl+C (or a dropped SSH session) resumes by
    skipping shards that are already complete.

RAM stays flat (~200-300 MB) no matter how much you download, because only
one shard is streamed at a time with a small record-batch size.  This is the
multi-region replacement for the single-shot ``dl_punjab.py`` recipe in
SETUP.md.

Why whole shards (not a state-by-state bbox cut)?
------------------------------------------------
Overture is a global shard grid, not state boundaries.  Cutting each state's
bbox and merging produces overlapping, duplicated buildings at every shared
border.  Downloading whole shards and de-duplicating by filename means each
shard is fetched exactly once, and "add another state later" just means
downloading whichever shards are new.

Usage
-----
    uv run python scripts/download_buildings.py --list
    uv run python scripts/download_buildings.py --region delhi-haryana
    uv run python scripts/download_buildings.py --region up west-bengal
    uv run python scripts/download_buildings.py --bbox 74.35,27.3,77.7,30.95
    uv run python scripts/download_buildings.py --region delhi-haryana --dry-run

After downloading, point the planner at the shard glob:
    PLANNER_BUILDINGS_PARQUET='buildings/tiles/*/*.parquet'
DuckDB reads the glob and prunes row groups by bbox, so a wide multi-region
glob costs no more per mission than the single Punjab file did.  (Or pass
``--merge`` once to combine everything into one parquet instead.)
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

import pyarrow.dataset as ds
import pyarrow.parquet as pq
from overturemaps import core

# Named regions: xmin, ymin, xmax, ymax (EPSG:4326 lon/lat = west, south, east, north).
# These are loose state envelopes - the shard download de-duplicates by file,
# so it is harmless to make them a little generous (overlapping neighbours).
REGIONS: dict[str, tuple[float, float, float, float]] = {
    "punjab": (73.5, 29.5, 77.0, 32.5),
    "himachal-pradesh": (75.5, 30.3, 79.0, 33.2),
    "delhi": (76.83, 28.40, 77.35, 28.90),
    "chandigarh": (76.70, 30.65, 76.90, 30.80),
    "haryana": (74.44, 27.39, 77.60, 30.88),
    # Delhi + Haryana + Chandigarh in one pass (Chandigarh is already inside
    # the Punjab envelope, but including it here costs nothing extra).
    "delhi-haryana": (74.35, 27.30, 77.70, 30.95),
    "up": (77.00, 23.80, 84.70, 30.50),
    "uttarakhand": (77.50, 28.60, 81.10, 31.50),
    "west-bengal": (85.70, 21.50, 89.95, 27.30),
    "bihar": (83.20, 24.20, 88.40, 27.60),
    "jharkhand": (83.30, 21.97, 87.90, 25.30),
}

#: Rows per record batch while streaming.  Overture building rows are wide
#: (nested names/sources/facade/roof blobs), so 32k rows ~= 30-160 MB per
#: batch - comfortably under the 800 MB VPS with one batch in flight.
BATCH_ROWS = 32_768


def describe_region(name: str, bbox: tuple[float, float, float, float]) -> str:
    return f"{name:<14} {bbox[0]:>7.2f},{bbox[1]:>7.2f},{bbox[2]:>7.2f},{bbox[3]:>7.2f}"


def list_regions() -> None:
    print("Named regions (xmin,ymin,xmax,ymax = west,south,east,north):")
    for name, bbox in REGIONS.items():
        print("  " + describe_region(name, bbox))


def parse_bbox(text: str) -> tuple[float, float, float, float]:
    parts = [p.strip() for p in text.split(",")]
    if len(parts) != 4:
        raise SystemExit(f"bbox must be 'xmin,ymin,xmax,ymax', got {text!r}")
    return tuple(float(p) for p in parts)  # type: ignore[return-value]


def _is_complete(path: Path) -> bool:
    """A shard is complete iff it has a readable parquet footer."""
    if not path.exists():
        return False
    try:
        pq.ParquetFile(path).metadata
        return True
    except Exception:
        return False


def _shard_rows(fragment) -> int | None:
    """Total rows in a shard from its footer (cheap range read; None on failure)."""
    try:
        md = fragment.metadata
        return int(md.num_rows) if md is not None else None
    except Exception:
        return None


def _shard_name(fragment) -> str:
    return Path(fragment.path).name


def download_shard(
    fragment,
    schema,
    out_dir: Path,
    release: str,
    *,
    force: bool,
) -> tuple[str, int, bool]:
    """Stream one shard to ``out_dir/release/<name>.parquet``.

    Returns ``(name, rows, skipped)``.  Writes to a ``.part`` file and
    atomically renames on success, so a crash never leaves a half-written
    shard that a later resume would mistake for a completed one.
    """
    name = _shard_name(fragment)
    out = out_dir / release / name
    out.parent.mkdir(parents=True, exist_ok=True)

    if not force and _is_complete(out):
        return name, 0, True

    tmp = out.with_suffix(out.suffix + ".part")
    tmp.unlink(missing_ok=True)

    writer = None
    rows = 0
    try:
        for batch in fragment.to_batches(
            use_threads=False,
            batch_size=BATCH_ROWS,
            batch_readahead=1,
            fragment_readahead=1,
        ):
            if batch.num_rows == 0:
                continue
            if writer is None:
                writer = pq.ParquetWriter(tmp, schema)
            writer.write_batch(batch.cast(schema))
            rows += batch.num_rows
        if writer is None:
            # Shard had no rows: still emit a valid (empty) parquet so the
            # glob reader sees a consistent set of files.
            writer = pq.ParquetWriter(tmp, schema)
        writer.close()
        writer = None
        os.replace(tmp, out)
        return name, rows, False
    finally:
        if writer is not None:
            writer.close()
        tmp.unlink(missing_ok=True)


def merge_shards(out_dir: Path, release: str, merged_path: Path) -> None:
    """Combine all downloaded shards into one parquet (optional convenience).

    Streams shard-by-shard, so it is RAM-safe.  A single file makes the
    planner config a plain path (and keeps the /health check happy), at the
    cost of temporarily using roughly 2x disk during the merge.
    """
    shards = sorted((out_dir / release).glob("*.parquet"))
    if not shards:
        print(f"no shards found under {out_dir / release}")
        return

    dataset = ds.dataset(shards, format="parquet")
    schema = core.geoarrow_schema_adapter(dataset.schema)

    writer = None
    total = 0
    for shard in shards:
        for batch in ds.dataset(str(shard)).to_batches(
            use_threads=False,
            batch_size=BATCH_ROWS,
            batch_readahead=1,
            fragment_readahead=1,
        ):
            if batch.num_rows == 0:
                continue
            if writer is None:
                writer = pq.ParquetWriter(merged_path, schema)
            writer.write_batch(batch.cast(schema))
            total += batch.num_rows
    if writer is not None:
        writer.close()
    print(f"merged {total:,} rows -> {merged_path}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--list", action="store_true", help="print named regions and exit")
    ap.add_argument(
        "--region",
        nargs="*",
        default=[],
        help="one or more region names (see --list); may be comma-separated",
    )
    ap.add_argument(
        "--bbox",
        action="append",
        default=[],
        help="raw bbox xmin,ymin,xmax,ymax (repeatable)",
    )
    ap.add_argument("--out", default="buildings/tiles", help="output directory")
    ap.add_argument("--release", default=None, help="Overture release (default: latest)")
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="list shards and skip/download status without downloading",
    )
    ap.add_argument(
        "--force",
        action="store_true",
        help="re-download shards that are already present",
    )
    ap.add_argument(
        "--merge",
        metavar="PATH",
        default=None,
        help="after downloading, merge all shards into this single parquet",
    )
    ap.add_argument(
        "--timeout",
        type=float,
        default=None,
        help="S3 connect/request timeout in seconds (default: pyarrow default)",
    )
    args = ap.parse_args()

    if args.list:
        list_regions()
        return

    # Resolve requested regions + raw bboxes.
    bboxes: list[tuple[str, tuple[float, float, float, float]]] = []
    for token in args.region:
        for name in token.split(","):
            name = name.strip()
            if not name:
                continue
            if name not in REGIONS:
                raise SystemExit(
                    f"unknown region {name!r}; run --list to see available regions"
                )
            bboxes.append((name, REGIONS[name]))
    for raw in args.bbox:
        bboxes.append((f"bbox:{raw}", parse_bbox(raw)))

    if not bboxes:
        raise SystemExit("nothing to do: pass --region <name> or --bbox xmin,ymin,xmax,ymax")

    release = args.release or core.get_latest_release()
    out_dir = Path(args.out)

    # Resolve shards for every bbox, de-duplicated by (release, filename).
    # Whole shards are downloaded (the bbox filter is deliberately NOT applied)
    # so overlapping regions reuse the same files instead of re-downloading.
    shards: dict[str, tuple[object, object]] = {}
    schema = None
    for label, bbox in bboxes:
        print(f"resolving shards for {label}: {bbox}", flush=True)
        result = core._prepare_query(
            "building",
            bbox=bbox,
            release=release,
            stac=True,
            connect_timeout=args.timeout,
            request_timeout=args.timeout,
        )
        if result is None:
            print(f"  no shards overlap {label}", flush=True)
            continue
        dataset, _filter_expr = result
        if schema is None:
            schema = core.geoarrow_schema_adapter(dataset.schema)
        for fragment in dataset.get_fragments():
            shards.setdefault(_shard_name(fragment), (fragment, label))

    if not shards:
        print("no shards resolved for the requested regions.", flush=True)
        return

    print(f"\nrelease: {release}")
    print(f"shards:  {len(shards)} unique (dedup across regions)")
    print(f"output:  {out_dir / release}\n", flush=True)

    # Dry run: report what would happen.
    if args.dry_run:
        pending = 0
        done = 0
        for name, (fragment, label) in sorted(shards.items()):
            out = out_dir / release / name
            rows = _shard_rows(fragment)
            status = "skip" if (_is_complete(out) and not args.force) else "download"
            if status == "download":
                pending += 1
            else:
                done += 1
            rowstr = f"{rows:,}" if rows is not None else "?"
            print(f"  [{status:>8}] {name}  rows={rowstr}  via={label}", flush=True)
        print(f"\ndry-run: {pending} to download, {done} already complete", flush=True)
        return

    # Download each unique shard once.
    t0 = time.monotonic()
    total_rows = 0
    downloaded = 0
    skipped = 0
    for i, (name, (fragment, label)) in enumerate(sorted(shards.items()), 1):
        out = out_dir / release / name
        if not args.force and _is_complete(out):
            skipped += 1
            print(f"[{i}/{len(shards)}] skip   {name}", flush=True)
            continue
        print(f"[{i}/{len(shards)}] fetch  {name}  (via {label})...", flush=True)
        _, rows, was_skipped = download_shard(
            fragment, schema, out_dir, release, force=args.force
        )
        if was_skipped:
            skipped += 1
        else:
            downloaded += 1
            total_rows += rows
            size_mb = out.stat().st_size / 1024.0**2
            print(
                f"         wrote  {name}  {rows:,} rows  {size_mb:.1f} MB "
                f"({time.monotonic() - t0:.0f}s elapsed)",
                flush=True,
            )

    print(
        f"\nDONE: {downloaded} shards downloaded ({total_rows:,} rows), "
        f"{skipped} already present",
        flush=True,
    )

    if args.merge:
        print("merging shards...", flush=True)
        merge_shards(out_dir, release, Path(args.merge))
        print(
            f"\nPoint the planner at the merged file:\n"
            f"  PLANNER_BUILDINGS_PARQUET={args.merge}",
            flush=True,
        )
    else:
        print(
            "\nPoint the planner at the shard glob:\n"
            f"  PLANNER_BUILDINGS_PARQUET='{out_dir}/*/*.parquet'",
            flush=True,
        )


if __name__ == "__main__":
    main()
