import pyarrow.parquet as pq
from overturemaps import core
 
bbox = (73.5, 29.5, 77.0, 32.5)   # Punjab: lon 73.5..77, lat 29.5..32.5
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
