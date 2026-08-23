# VPS Setup - Drone Route Planner (agent-runnable playbook)

This is the step-by-step recipe to stand up the route-planning backend on a
**1 GB RAM VPS** and connect it to the deployed frontend. An agent (or a
human) can follow this top to bottom - every step has an exact command and
an expected result. Run the steps in order; skip the optional ones only if
you know why.

> The `women-safety` frontend does NOT run on the VPS. It runs on Vercel
> (static assets + `server.js` + Neon Postgres). The VPS runs ONLY this
> repo and exposes it with an outbound tunnel. Nothing from the
> `women-safety` repo needs to be cloned on the VPS.

---

## 0. Prerequisites (check once, then move on)

| Requirement | Check command | Expected |
|---|---|---|
| OS | `cat /etc/os-release` | Ubuntu 22.04/24.04 (or any Linux) |
| RAM | `free -h` | >= 1 GB total, >= 700 MB free |
| Disk | `df -h /` | >= 8 GB free (needs ~6 GB: 2.5 GB parquet + staging + spill) |
| git | `git --version` | any recent version |
| uv | `curl -LsSf https://astral.sh/uv/install.sh \| sh` then `uv --version` | `uv 0.6.x` or newer |
| netbird | `netbird version` | installed and `netbird status` shows Connected |
| Python | (handled by uv) | - |

If `uv` is missing, install it with the curl command above, then
`source $HOME/.local/bin/env` (or log out/in).

---

## 1. Clone + install the backend

```bash
git clone git@github.com:JustRelaXD/drone-route-optimization.git
cd drone-route-optimization
uv sync
```

**Expected:** `uv sync` finishes without errors (installs duckdb, fastapi,
shapely, overturemaps, etc. into `.venv/`).

> **Paths:** every step below uses `~/drone-route-optimization` as the repo
> path. If you cloned somewhere else (e.g. `~/code/ro-backend/drone-route-
> optimization`), substitute your actual path in every command, the
> systemd unit's `WorkingDirectory=`, and the `scp` targets.

```bash
uv run pytest -q   # optional but recommended
```

**Expected:** all tests pass (144). This proves the code + venv are sound
before the data step.

---

## 2. Download the buildings data - DIRECTLY ON THE VPS (recommended)

### The decision (read once)

**Download on the VPS.** Use the low-memory script in 2b below - NOT the
`overturemaps` CLI. The CLI streams from S3 with pyarrow prefetching
(`fragment_readahead=4, batch_readahead=16`), holding several decompressed
tiles in RAM at once; on a 1 GB VPS that swap-thrashes and gets OOM-killed
(symptom: the tmux pane prints `DONE:137`). The script reads the same
STAC-filtered tiles from the public S3 bucket but one tile / one batch at
a time, so RAM stays flat at ~200-300 MB. Bandwidth-wise S3 -> VPS is
almost always far faster than your home PC -> Netbird -> VPS (home upload
is typically 5-30 Mbps, so a 2.45 GB file would take 15-60+ minutes and
can be flaky; the VPS can usually pull it in 3-10 minutes).

**Do NOT** download all of India "just in case": the planner is per-file
with bbox pushdown, so it only needs the states you operate in. Punjab
alone is 2.45 GB / ~18.2 M buildings. Add more states later by downloading
their bboxes and pointing `PLANNER_BUILDINGS_PARQUET` at a merged file.

**Transferring from your PC is the fallback**, only if the VPS has
terrible internet or you want bit-identical data. You already have the
Punjab file locally, so over the Netbird mesh:

```bash
# from your LOCAL machine, to the VPS over Netbird (replace the IP):
scp punjab_buildings.parquet user@<netbird-ip-of-vps>:~/drone-route-optimization/
```

The rest of this section assumes the direct download.

### 2a. Check disk space first

```bash
df -h / && du -sh ~/drone-route-optimization
```

**Expected:** >= 8 GB free on `/`.

### 2b. Download (takes ~10-25 minutes)

Run it inside `tmux` so a dropped SSH session does not kill it. Create the
low-memory download script once, then launch it:

```bash
cd ~/drone-route-optimization
rm -f punjab_buildings.parquet    # never reuse an interrupted file

tmux kill-session -t dl 2>/dev/null

cat > dl_punjab.py <<'EOF'
import pyarrow.parquet as pq
from overturemaps import core

# Punjab bbox = xmin,ymin,xmax,ymax (west,south,east,north)
# lon 73.5..77.0, lat 29.5..32.5 (same bbox the no-fly import uses)
bbox = (73.5, 29.5, 77.0, 32.5)
result = core._prepare_query("building", bbox=bbox, stac=True)
assert result is not None, "no tiles for bbox"
dataset, filter_expr = result
schema = core.geoarrow_schema_adapter(dataset.schema)
print(f"tiles: {len(dataset.files)}", flush=True)

writer = None
total = 0
for batch in dataset.to_batches(
    filter=filter_expr, use_threads=False, batch_readahead=1, fragment_readahead=1
):
    if batch.num_rows == 0:
        continue
    if writer is None:
        writer = pq.ParquetWriter("punjab_buildings.parquet", schema)
    writer.write_batch(batch.cast(schema))
    prev = total
    total += batch.num_rows
    if total // 1_000_000 != prev // 1_000_000:
        print(f"{total:,} rows...", flush=True)
if writer is not None:
    writer.close()
print(f"ROWS WRITTEN: {total:,}", flush=True)
EOF

tmux new -s dl -d 'uv run python dl_punjab.py; echo DONE:$?; sleep 300'
tmux attach -t dl          # watch progress; Ctrl+B then D to detach
```

**Expected:** `tiles: 6`, then `1,000,000 rows...`, `2,000,000 rows...`
roughly every minute, finishing with `ROWS WRITTEN: 18,2xx,xxx` and
`DONE:0`. RAM stays under ~300 MB (watch with `watch -n 2 free -h` in a
second terminal). If the run is interrupted, `DONE:130` = Ctrl+C and
`DONE:137` = OOM - delete the partial parquet and restart.

Notes:
- This uses the same `core._prepare_query` STAC filtering the CLI uses, so
  it downloads only the ~6 tiles overlapping the bbox.
- Default release is the latest (`overturemaps releases latest`). The
  schema has been stable across recent releases; if a future release
  changes it, pin the one your dev machine used with `-r <release>` in
  `_prepare_query`.
- To watch progress without attaching (zero risk of Ctrl+C killing it):
  `tmux capture-pane -t dl -p | tail -5`.

### 2c. Verify the download

```bash
cd ~/drone-route-optimization
uv run python - <<'EOF'
import duckdb
con = duckdb.connect()
print('rows    :', con.execute("SELECT count(*) FROM 'punjab_buildings.parquet'").fetchone()[0])
print('extent  :', con.execute("SELECT min(bbox.xmin), max(bbox.xmax), min(bbox.ymin), max(bbox.ymax) FROM 'punjab_buildings.parquet'").fetchone())
print('columns :', [r[0] for r in con.execute("DESCRIBE SELECT * FROM 'punjab_buildings.parquet'").fetchall()])
EOF
```

**Expected:** rows ~= 18.2 M (the local dev file is 18,234,971), extent
inside 73.5..77.0 / 29.5..32.5, and the columns include at least:
`id, height, level, class, subtype, num_floors, geometry, bbox`.

> This file is gitignored (`*.parquet`) - a `git pull` will never bring it.
> It is a one-time download; keep it on local NVMe if possible.

### 2d. Expanding to more states (Delhi, Haryana, UP, West Bengal, ...)

The single-file recipe above works for one region.  For multiple regions use
`scripts/download_buildings.py` - it downloads **whole Overture shards** (one
at a time, keyed by filename) so overlapping regions never re-download the
same data, and an interrupted run resumes by skipping completed shards.

```bash
cd ~/drone-route-optimization
uv run python scripts/download_buildings.py --list            # show named regions

# preview without downloading anything (lists shards + row counts):
uv run python scripts/download_buildings.py --region delhi-haryana --dry-run

# the real download - run inside tmux so a dropped SSH session can't kill it:
tmux kill-session -t dl 2>/dev/null
tmux new -s dl -d 'uv run python scripts/download_buildings.py --region delhi-haryana; echo DONE:$?; sleep 300'
tmux attach -t dl      # Ctrl+B then D to detach; `tmux capture-pane -t dl -p | tail -5` to peek
```

- Add more regions later with `--region up west-bengal bihar ...` - existing
  shards are skipped, only new ones download.
- `--region` accepts names from `--list`; use `--bbox xmin,ymin,xmax,ymax`
  (west,south,east,north) for anything not named.
- Output lands in `buildings/tiles/<release>/`.  Point the planner at the glob:

  ```
  PLANNER_BUILDINGS_PARQUET='buildings/tiles/*/*.parquet'
  ```

  DuckDB reads the glob with bbox pushdown, so a wide multi-region glob costs
  no more per mission than the single Punjab file.  (`/health` reports
  `degraded` with a glob because it does a plain `os.path.exists` check - the
  planner still routes normally.  Alternatively run with
  `--merge buildings.parquet` after downloading to get one file and a clean
  health check.)

RAM stays ~200-300 MB regardless of total size.  Disk: Delhi + Haryana is ~9
shards (~4-6 GB); each extra state adds a few more shards.  The whole-shard
approach deliberately includes a little area beyond each state's border - that
is what makes re-running with a bigger region reuse existing shards instead of
duplicating border tiles.

---

## 3. No-fly zones (DGCA overlay)

Two equivalent options - pick one. The files are small (~8 MB total).

**Option A (recommended - deterministic):** copy the snapshot you already
generated on your dev machine, so the VPS shows exactly what you tested
with:

```bash
# from your LOCAL machine:
scp -r overture-test/planner/data/ user@<netbird-ip-of-vps>:~/drone-route-optimization/planner/
```

**Option B:** regenerate on the VPS (fetches once from the public DGCA
airspace endpoint, caches locally):

```bash
cd ~/drone-route-optimization
uv run python scripts/import_no_fly_zones.py --bbox none
```

Either way, verify:

```bash
ls -la ~/drone-route-optimization/planner/data/no_fly_zones.json   # ~267 KB
```

---

## 4. Run the planner (persistent systemd unit)

Pick an API key (a long random string, e.g. `openssl rand -hex 24`), then:

```bash
sudo tee /etc/systemd/system/planner.service > /dev/null <<'EOF'
[Unit]
Description=Drone route planner (FastAPI :8000)
After=network-online.target
Wants=network-online.target

[Service]
User=<your-username>
WorkingDirectory=/home/<your-username>/drone-route-optimization
Environment=PLANNER_BUILDINGS_PARQUET=punjab_buildings.parquet
# The india snapshot is the file this deployment actually carries (see the
# data-transfer step below); the punjab-scoped file is NOT downloaded on the
# VPS.  If the configured file is missing, the planner now falls back to the
# india snapshot automatically, but pointing at the real file is cleaner.
Environment=PLANNER_NO_FLY_ZONES_FILE=planner/data/no_fly_zones_india.json
Environment=PLANNER_API_KEY=<your-secret-key>
Environment=PLANNER_MEMORY_LIMIT=512MB
Environment=PLANNER_THREADS=1
ExecStart=/home/<your-username>/drone-route-optimization/.venv/bin/uvicorn planner.api.main:app --host 0.0.0.0 --port 8000 --workers 1
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now planner.service
sudo systemctl status planner.service
```

**Expected:** `active (running)`, no errors. First request after boot pays
a cold page-cache read of the 2.45 GB parquet (a few seconds) - that is
normal.

**Local smoke test (no tunnel needed):**

```bash
curl -s localhost:8000/health
# data available + config echo (no API key needed - /health stays open)

curl -s -X POST localhost:8000/generate-route \
  -H 'content-type: application/json' -H "X-API-Key: <your-secret-key>" \
  -d '{"start_lat":30.338,"start_lon":76.3895,"goal_lat":30.3286,"goal_lon":76.3978,"altitude_m":80,"speed_mps":15,"snap_start_goal":true}'
# 200 with waypoints (a real Patiala old-city route; may carry a "degraded" warning - that is normal, see below)

curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:8000/generate-route \
  -H 'content-type: application/json' \
  -d '{"start_lat":30.338,"start_lon":76.3895,"goal_lat":30.3286,"goal_lon":76.3978,"altitude_m":80}'
# 401/403 - the API key gate works
```

> A `"warning"` in the response is NOT an error: it means "no continuous
> collision-free corridor, here is a best-effort route + the straight-line
> backup". The planner never 500s on "no path".

---

## 5. Expose the port publicly (outbound tunnel)

The VPS has no inbound public IP, so publish the port with Netbird (you
already use it - the tunnel is an outbound connection, no ports opened):

```bash
netbird expose 8000
```

**Expected:** prints a public URL like `https://<hash>.proxy.netbird.io`.

**Important:** the CLI form is **ephemeral** - it dies with the process.
Run it as a systemd unit so it survives reboots (or create a permanent
service via the Netbird dashboard - dashboard services persist until
deleted and can be gated by group/PIN):

```bash
sudo tee /etc/systemd/system/planner-tunnel.service > /dev/null <<'EOF'
[Unit]
Description=Netbird expose :8000 (public tunnel)
After=network-online.target
Wants=network-online.target

[Service]
User=<your-username>
ExecStart=/usr/bin/netbird expose 8000
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now planner-tunnel.service
journalctl -u planner-tunnel.service -f    # grab the public URL from the log
```

**Expected:** a stable public `https://...proxy.netbird.io` URL.

---

## 6. Public smoke test + stream check

From your laptop browser (or curl):

```bash
PUB=https://<hash>.proxy.netbird.io
curl -s $PUB/health                                    # 200, open
curl -s -X POST $PUB/generate-route \
  -H 'content-type: application/json' -H "X-API-Key: <your-secret-key>" \
  -d '{"start_lat":30.338,"start_lon":76.3895,"goal_lat":30.3286,"goal_lon":76.3978,"altitude_m":80,"speed_mps":15,"snap_start_goal":true}'
# 200 with waypoints

# stream endpoint (NDJSON live progress):
curl -sN -X POST $PUB/generate-route/stream \
  -H 'content-type: application/json' -H "X-API-Key: <your-secret-key>" \
  -d '{"start_lat":30.338,"start_lon":76.3895,"goal_lat":30.3286,"goal_lon":76.3978,"altitude_m":80,"speed_mps":15,"snap_start_goal":true}' | head -20
# stage lines then {"type":"complete",...}
```

**Expected:** JSON waypoints over HTTP; the stream emits `stage` events
(region/grid/search/path/...) then a `complete` event. No-fly check:
`curl -s "$PUB/no-fly-zones?scope=punjab" -H "X-API-Key: <key>"` returns
red/amber rings.

---

## 7. Point the frontend at it (Vercel, one-time)

```bash
vercel env add VITE_PLANNER_API_URL   # https://<hash>.proxy.netbird.io
vercel env add VITE_PLANNER_API_KEY   # same secret as PLANNER_API_KEY
vercel --prod
```

If the tunnel URL ever changes, update `VITE_PLANNER_API_URL` and redeploy.

**E2E verify:** open the deployed app, hard-refresh, then:
1. Simulate SOS -> drone routes to an off-route spot (route draws live
   through the building-avoiding planner - you will see the streamed line
   take shape, then the final route).
2. Toggle No-fly (Dashboard panel) -> red/amber DGCA overlay renders.
3. Safe Walk -> planner-routed escort legs.

---

## 8. Resource budget (what fits in 1 GB RAM)

| Phase | Peak RAM | Notes |
|---|---|---|
| `dl_punjab.py` download | ~200-300 MB | streams S3 tiles one batch at a time |
| `uv run pytest` | ~400 MB | one-off, can be skipped on the VPS |
| planner runtime (per mission) | ~220-350 MB | region materialisation + grid + A* |
| whole-province index build (`build_region_db.py`) | **765 MB** | optional; do NOT run on a 1 GB VPS - the planner works per-mission in memory without it |

Disk: ~2.5 GB (parquet) + ~8 MB (no-fly data) + a few hundred MB of DuckDB
spill under load.

**Tuning knobs if the box is tight:** `PLANNER_MEMORY_LIMIT` (512 MB
default, DuckDB spills to `planner/data/spill`), `PLANNER_THREADS=1`
(default), `grid_resolution_m` per request (10 m default; coarsens
automatically to respect the cell cap).

---

## 9. Troubleshooting

| Symptom | Fix |
|---|---|
| `uv sync` slow/fails | needs internet for PyPI; retry; `uv sync` is idempotent |
| Download "bbox requires exactly 4 values" | order is `xmin,ymin,xmax,ymax`, comma-separated, no spaces |
| Download is huge/slow | you are downloading a wider bbox than Punjab - that is expected for more states; for Punjab only use `73.5,29.5,77.0,32.5` |
| `no_fly_zones.json` missing at startup | run step 3 (Option B) or copy `planner/data/` |
| Planner 500s on first request | cold parquet read; retry once; check disk space and that the parquet path is correct |
| `/health` shows data unavailable | `PLANNER_BUILDINGS_PARQUET` points at a missing/renamed file |
| Tunnel URL dies on reboot | ensure `planner-tunnel.service` is enabled and Netbird auto-connects (`systemctl enable netbird`) |
| Frontend falls back to straight lines | `VITE_PLANNER_API_URL` unset/stale on Vercel, or the URL changed; redeploy after updating it |
| 401/403 from the app | `VITE_PLANNER_API_KEY` (Vercel) != `PLANNER_API_KEY` (VPS) |
