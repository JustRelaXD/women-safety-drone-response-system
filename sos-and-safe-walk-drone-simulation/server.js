import 'dotenv/config';
import express from 'express';
import pg from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { Pool } = pg;

const app = express();
const port = Number(process.env.PORT || 3000);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.join(__dirname, 'dist');
const staticDir = path.join(__dirname, 'public');

const databaseUrl = process.env.DATABASE_URL;
const pool = databaseUrl
  ? new Pool({
      connectionString: databaseUrl,
      ssl: databaseUrl.includes('sslmode=require')
        ? { rejectUnauthorized: false }
        : undefined
    })
  : null;

const getPool = () => {
  if (!pool) {
    const error = new Error('DATABASE_URL is not configured');
    error.status = 503;
    throw error;
  }
  return pool;
};

const query = (...args) => getPool().query(...args);

app.use(express.json({ limit: '5mb' }));
app.use(express.static(clientDir));
app.use(express.static(staticDir));

const featureCollectionSql = (innerSql) => `
  SELECT COALESCE(
    jsonb_build_object(
      'type', 'FeatureCollection',
      'features', COALESCE(jsonb_agg(ST_AsGeoJSON(t.*, 'geom')::jsonb), '[]'::jsonb)
    ),
    jsonb_build_object('type', 'FeatureCollection', 'features', '[]'::jsonb)
  ) AS geojson
  FROM (${innerSql}) AS t
`;

const asyncRoute = (handler) => async (req, res, next) => {
  try {
    await handler(req, res);
  } catch (error) {
    next(error);
  }
};

const toNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toIntArray = (value) => {
  if (!Array.isArray(value)) return [];
  return value.map((item) => Number.parseInt(item, 10)).filter(Number.isInteger);
};

const allowedLocationTypes = new Set(['DEPOT', 'BIN', 'CUSTOMER', 'VENDOR', 'TRUCK_STOP']);

const normalizeSqlIdentifier = (value) => value.trim().replace(/^"|"$/g, '').toLowerCase();

const splitSqlList = (value) => {
  const items = [];
  let current = '';
  let quote = null;
  let depth = 0;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const next = value[index + 1];

    if (quote) {
      current += char;
      if (char === quote) {
        if (quote === '\'' && next === '\'') {
          current += next;
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }

    if (char === '\'' || char === '"') {
      quote = char;
      current += char;
      continue;
    }

    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;

    if (char === ',' && depth === 0) {
      items.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  if (current.trim()) items.push(current.trim());
  return items;
};

const splitSqlStatements = (sql) => {
  const statements = [];
  let current = '';
  let quote = null;

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];

    if (quote) {
      current += char;
      if (char === quote) {
        if (quote === '\'' && next === '\'') {
          current += next;
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }

    if (char === '-' && next === '-') {
      while (index < sql.length && sql[index] !== '\n') index += 1;
      current += '\n';
      continue;
    }

    if (char === '\'' || char === '"') {
      quote = char;
      current += char;
      continue;
    }

    if (char === ';') {
      if (current.trim()) statements.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  if (current.trim()) statements.push(current.trim());
  return statements;
};

const parseSqlLiteral = (value) => {
  const trimmed = value.trim();
  if (/^null$/i.test(trimmed)) return null;
  if (/^'.*'$/s.test(trimmed)) return trimmed.slice(1, -1).replaceAll('\'\'', '\'');
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
};

const parseLocationTuples = (valuesSql) => {
  const rows = [];
  let index = 0;

  while (index < valuesSql.length) {
    while (index < valuesSql.length && /[\s,]/.test(valuesSql[index])) index += 1;
    if (valuesSql[index] !== '(') break;

    let depth = 0;
    let quote = null;
    let tuple = '';

    for (; index < valuesSql.length; index += 1) {
      const char = valuesSql[index];
      const next = valuesSql[index + 1];

      if (quote) {
        tuple += char;
        if (char === quote) {
          if (quote === '\'' && next === '\'') {
            tuple += next;
            index += 1;
          } else {
            quote = null;
          }
        }
        continue;
      }

      if (char === '\'' || char === '"') {
        quote = char;
        tuple += char;
        continue;
      }

      if (char === '(') {
        depth += 1;
        if (depth > 1) tuple += char;
        continue;
      }

      if (char === ')') {
        depth -= 1;
        if (depth === 0) {
          rows.push(splitSqlList(tuple).map(parseSqlLiteral));
          index += 1;
          break;
        }
        tuple += char;
        continue;
      }

      tuple += char;
    }
  }

  return rows;
};

const parseCopyValue = (value) => {
  if (value === '\\N') return null;
  return value
    .replaceAll('\\t', '\t')
    .replaceAll('\\n', '\n')
    .replaceAll('\\r', '\r')
    .replaceAll('\\\\', '\\');
};

const locationFromRow = (row) => {
  const locationType = String(row.location_type || 'CUSTOMER').trim().toUpperCase();
  const latitude = Number(row.latitude);
  const longitude = Number(row.longitude);

  if (!row.name || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  return {
    name: String(row.name).trim(),
    location_type: allowedLocationTypes.has(locationType) ? locationType : 'CUSTOMER',
    address: row.address ? String(row.address).trim() : null,
    latitude,
    longitude,
    place_query: row.place_query ? String(row.place_query).trim() : null
  };
};

const extractLocationsFromSql = (sql) => {
  const locations = [];
  const copyPattern = /copy\s+(?:(?:"?mangalore"?|\w+)\.)?"?locations"?\s*\(([\s\S]+?)\)\s+from\s+stdin;\r?\n([\s\S]*?)\r?\n\\\./gi;

  for (const match of sql.matchAll(copyPattern)) {
    const columns = splitSqlList(match[1]).map(normalizeSqlIdentifier);
    match[2].split(/\r?\n/).forEach((line) => {
      if (!line.trim()) return;
      const values = line.split('\t').map(parseCopyValue);
      const row = Object.fromEntries(columns.map((column, index) => [column, values[index]]));
      const location = locationFromRow(row);
      if (location) locations.push(location);
    });
  }

  splitSqlStatements(sql).forEach((statement) => {
    const match = statement.match(/^insert\s+into\s+(?:(?:"?mangalore"?|\w+)\.)?"?locations"?\s*\(([\s\S]+?)\)\s+values\s+([\s\S]+?)(?:\s+on\s+conflict[\s\S]*)?$/i);
    if (!match) return;

    const columns = splitSqlList(match[1]).map(normalizeSqlIdentifier);
    parseLocationTuples(match[2]).forEach((values) => {
      const row = Object.fromEntries(columns.map((column, index) => [column, values[index]]));
      const location = locationFromRow(row);
      if (location) locations.push(location);
    });
  });

  return locations;
};

const ensureLocationBackupTable = async (client) => {
  await client.query(`
    CREATE TABLE IF NOT EXISTS mangalore.location_backup_snapshots (
      id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      reason text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      locations jsonb NOT NULL DEFAULT '[]'::jsonb,
      customers jsonb NOT NULL DEFAULT '[]'::jsonb,
      vendors jsonb NOT NULL DEFAULT '[]'::jsonb,
      service_orders jsonb NOT NULL DEFAULT '[]'::jsonb
    )
  `);
};

const createLocationBackup = async (client, reason) => {
  await ensureLocationBackupTable(client);
  const { rows } = await client.query(`
    INSERT INTO mangalore.location_backup_snapshots (
      reason,
      locations,
      customers,
      vendors,
      service_orders
    )
    SELECT
      $1,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', id,
        'name', name,
        'location_type', location_type,
        'address', address,
        'latitude', latitude,
        'longitude', longitude,
        'place_query', place_query,
        'geocoding_source', geocoding_source,
        'geocoded_at', geocoded_at,
        'created_at', created_at
      ) ORDER BY id) FROM mangalore.locations), '[]'::jsonb),
      COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM mangalore.customers AS c), '[]'::jsonb),
      COALESCE((SELECT jsonb_agg(to_jsonb(v) ORDER BY v.id) FROM mangalore.vendors AS v), '[]'::jsonb),
      COALESCE((SELECT jsonb_agg(to_jsonb(so) ORDER BY so.id) FROM mangalore.service_orders AS so), '[]'::jsonb)
    RETURNING id, created_at
  `, [reason]);
  return rows[0];
};

const resetIdentitySequence = async (client, tableName, columnName = 'id') => {
  await client.query(`
    SELECT setval(
      pg_get_serial_sequence($1, $2),
      COALESCE((SELECT max(id) FROM ${tableName}), 1),
      true
    )
  `, [tableName, columnName]);
};

const clearLocationData = async (client) => {
  const { rows } = await client.query('DELETE FROM mangalore.route_plan_segments RETURNING id');
  const deletedRouteSegments = rows.length;
  await client.query('DELETE FROM mangalore.route_plan_stops');
  await client.query('DELETE FROM mangalore.route_plans');
  await client.query('DELETE FROM mangalore.service_orders');
  await client.query('DELETE FROM mangalore.customers');
  await client.query('DELETE FROM mangalore.vendors');
  const deletedLocations = await client.query('DELETE FROM mangalore.locations RETURNING id');
  return { deletedRouteSegments, deletedLocations: deletedLocations.rows.length };
};

const ensureCompletedFeaturesTable = async (client = getPool()) => {
  await client.query(`
    CREATE TABLE IF NOT EXISTS mangalore.completed_map_features (
      feature_type text NOT NULL,
      feature_id bigint NOT NULL,
      completed_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (feature_type, feature_id)
    )
  `);
};

const createRouteSegmentsForPlan = async (client, routePlanId) => {
  await client.query(`
    WITH stop_vertices AS (
      SELECT
        s.id AS stop_id,
        s.route_plan_id,
        s.stop_sequence,
        n.vertex_id
      FROM mangalore.route_plan_stops AS s
      JOIN mangalore.location_network_nodes AS n ON n.location_id = s.location_id
      WHERE s.route_plan_id = $1
    ),
    pairs AS (
      SELECT
        a.route_plan_id,
        a.stop_id AS from_stop_id,
        b.stop_id AS to_stop_id,
        a.stop_sequence AS segment_sequence,
        a.vertex_id AS start_vertex_id,
        b.vertex_id AS end_vertex_id
      FROM stop_vertices AS a
      JOIN stop_vertices AS b
        ON b.route_plan_id = a.route_plan_id
       AND b.stop_sequence = a.stop_sequence + 1
    ),
    paths AS (
      SELECT
        p.*,
        d.path_seq,
        d.node,
        lead(d.node) OVER (
          PARTITION BY p.route_plan_id, p.from_stop_id, p.to_stop_id, p.segment_sequence
          ORDER BY d.path_seq
        ) AS next_node,
        d.edge,
        d.cost,
        d.agg_cost,
        e.length_m,
        CASE
          WHEN d.edge = -1 THEN NULL
          WHEN e.source = d.node AND e.target = lead(d.node) OVER (
            PARTITION BY p.route_plan_id, p.from_stop_id, p.to_stop_id, p.segment_sequence
            ORDER BY d.path_seq
          ) THEN e.geom
          WHEN e.target = d.node AND e.source = lead(d.node) OVER (
            PARTITION BY p.route_plan_id, p.from_stop_id, p.to_stop_id, p.segment_sequence
            ORDER BY d.path_seq
          ) THEN ST_Reverse(e.geom)
          ELSE e.geom
        END AS geom
      FROM pairs AS p
      CROSS JOIN LATERAL pgr_dijkstra(
        'SELECT id, source, target, cost, reverse_cost FROM mangalore.routing_edges',
        p.start_vertex_id::bigint,
        p.end_vertex_id::bigint,
        true
      ) AS d
      LEFT JOIN mangalore.routing_edges AS e ON e.id = d.edge
    ),
    aggs AS (
      SELECT
        route_plan_id,
        from_stop_id,
        to_stop_id,
        segment_sequence,
        start_vertex_id,
        end_vertex_id,
        sum(COALESCE(length_m, 0)) FILTER (WHERE edge <> -1) AS distance_m,
        max(agg_cost) AS cost,
        jsonb_agg(
          jsonb_build_object(
            'path_seq', path_seq,
            'node', node,
            'edge', edge,
            'cost', cost,
            'agg_cost', agg_cost
          )
          ORDER BY path_seq
        ) AS path,
        ST_Multi(ST_LineMerge(ST_Collect(geom ORDER BY path_seq) FILTER (WHERE edge <> -1)))::geometry(MultiLineString,3857) AS geom
      FROM paths
      GROUP BY route_plan_id, from_stop_id, to_stop_id, segment_sequence, start_vertex_id, end_vertex_id
    )
    INSERT INTO mangalore.route_plan_segments (
      route_plan_id,
      from_stop_id,
      to_stop_id,
      segment_sequence,
      start_vertex_id,
      end_vertex_id,
      distance_m,
      cost,
      path,
      geom
    )
    SELECT
      route_plan_id,
      from_stop_id,
      to_stop_id,
      segment_sequence,
      start_vertex_id,
      end_vertex_id,
      distance_m,
      cost,
      path,
      geom
    FROM aggs
  `, [routePlanId]);

  await client.query(`
    UPDATE mangalore.route_plans AS rp
    SET
      total_distance_m = s.total_distance_m,
      total_cost = s.total_cost,
      planned_end_at = CASE
        WHEN rp.planned_start_at IS NULL THEN NULL
        ELSE COALESCE(rp.planned_end_at, rp.planned_start_at + make_interval(mins => (s.segment_count + 1) * 20))
      END,
      updated_at = now()
    FROM (
      SELECT
        route_plan_id,
        sum(distance_m) AS total_distance_m,
        sum(cost) AS total_cost,
        count(*)::integer AS segment_count
      FROM mangalore.route_plan_segments
      WHERE route_plan_id = $1
      GROUP BY route_plan_id
    ) AS s
    WHERE rp.id = s.route_plan_id
  `, [routePlanId]);
};

const createRoutePlan = async (client, { planCode, truckId = null, depotLocationId, plannedStartAt = null, stops }) => {
  const plan = await client.query(`
    INSERT INTO mangalore.route_plans (plan_code, truck_id, depot_location_id, status, planned_start_at)
    VALUES ($1, $2, $3, 'PLANNED', $4)
    RETURNING id, plan_code
  `, [planCode, truckId, depotLocationId, plannedStartAt]);
  const routePlanId = plan.rows[0].id;

  for (let index = 0; index < stops.length; index += 1) {
    const arrival = plannedStartAt ? new Date(plannedStartAt.getTime() + (index * 20 * 60 * 1000)) : null;
    const departure = arrival ? new Date(arrival.getTime() + 10 * 60 * 1000) : null;
    await client.query(`
      INSERT INTO mangalore.route_plan_stops (
        route_plan_id,
        stop_sequence,
        location_id,
        service_order_id,
        stop_type,
        planned_arrival_at,
        planned_departure_at,
        notes
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [
      routePlanId,
      index + 1,
      stops[index].locationId,
      stops[index].serviceOrderId || null,
      stops[index].stopType,
      arrival,
      departure,
      stops[index].notes || null
    ]);
  }

  await createRouteSegmentsForPlan(client, routePlanId);
  return { id: routePlanId, plan_code: plan.rows[0].plan_code };
};

const assertPgRoutingCostMatrixSupport = async (client) => {
  const { rows } = await client.query(`
    SELECT EXISTS (
      SELECT 1
      FROM pg_proc
      WHERE lower(proname) = 'pgr_dijkstracostmatrix'
    ) AS available
  `);
  if (!rows[0]?.available) {
    const error = new Error('pgRouting pgr_dijkstraCostMatrix is required for SQL-based clustered pickup planning');
    error.status = 503;
    throw error;
  }
};

const getClusteredPickupStopRows = async (client, requestedClusterCount) => {
  const { rows } = await client.query(`
    WITH depot AS (
      SELECT
        l.id AS location_id,
        l.name,
        n.vertex_id
      FROM mangalore.locations AS l
      JOIN mangalore.location_network_nodes AS n ON n.location_id = l.id
      WHERE l.location_type = 'DEPOT'
      ORDER BY l.id
      LIMIT 1
    ),
    pending_orders AS (
      SELECT
        so.id AS service_order_id,
        so.order_code,
        so.pickup_location_id,
        so.waste_type,
        so.estimated_weight_kg,
        pickup.name AS pickup_name,
        pickup_node.vertex_id AS pickup_vertex_id
      FROM mangalore.service_orders AS so
      JOIN mangalore.locations AS pickup ON pickup.id = so.pickup_location_id
      JOIN mangalore.location_network_nodes AS pickup_node ON pickup_node.location_id = so.pickup_location_id
      WHERE so.status = 'PENDING'
    ),
    active_vendors AS (
      SELECT
        v.id AS vendor_id,
        l.id AS vendor_location_id,
        l.name AS vendor_name,
        v.accepted_waste_types,
        vendor_node.vertex_id AS vendor_vertex_id
      FROM mangalore.vendors AS v
      JOIN mangalore.locations AS l ON l.id = v.location_id
      JOIN mangalore.location_network_nodes AS vendor_node ON vendor_node.location_id = l.id
      WHERE v.is_active = true
    ),
    cluster_meta AS (
      SELECT LEAST(
        GREATEST($1::integer, 1),
        8,
        GREATEST((SELECT count(*)::integer FROM pending_orders), 1)
      ) AS cluster_count
    ),
    network_vertices AS (
      SELECT vertex_id FROM depot
      UNION
      SELECT pickup_vertex_id FROM pending_orders
      UNION
      SELECT vendor_vertex_id FROM active_vendors
    ),
    cost_matrix AS MATERIALIZED (
      SELECT *
      FROM pgr_dijkstraCostMatrix(
        'SELECT id, source, target, cost, reverse_cost FROM mangalore.routing_edges',
        ARRAY(SELECT DISTINCT vertex_id::bigint FROM network_vertices),
        true
      )
    ),
    reachable_orders AS (
      SELECT
        po.*,
        COALESCE(depot_cost.agg_cost, 1e18::float8) AS depot_cost
      FROM pending_orders AS po
      CROSS JOIN depot AS d
      LEFT JOIN cost_matrix AS depot_cost
        ON depot_cost.start_vid = d.vertex_id
       AND depot_cost.end_vid = po.pickup_vertex_id
    ),
    seeds AS (
      SELECT *
      FROM (
        SELECT
          ro.*,
          row_number() OVER (ORDER BY ro.depot_cost DESC, ro.service_order_id) AS cluster_index
        FROM reachable_orders AS ro
      ) AS ranked
      WHERE ranked.cluster_index <= (SELECT cluster_count FROM cluster_meta)
    ),
    assignments AS (
      SELECT DISTINCT ON (ro.service_order_id)
        ro.*,
        s.cluster_index,
        CASE
          WHEN ro.service_order_id = s.service_order_id THEN 0::float8
          ELSE COALESCE(seed_cost.agg_cost, 1e18::float8)
        END AS seed_cost
      FROM reachable_orders AS ro
      CROSS JOIN seeds AS s
      LEFT JOIN cost_matrix AS seed_cost
        ON seed_cost.start_vid = s.pickup_vertex_id
       AND seed_cost.end_vid = ro.pickup_vertex_id
      ORDER BY ro.service_order_id, seed_cost, s.cluster_index
    ),
    cluster_waste AS (
      SELECT
        cluster_index,
        array_remove(array_agg(DISTINCT waste_type), NULL) AS waste_types
      FROM assignments
      GROUP BY cluster_index
    ),
    vendor_rankings AS (
      SELECT
        a.cluster_index,
        v.vendor_id,
        v.vendor_location_id,
        v.vendor_name,
        v.vendor_vertex_id,
        CASE
          WHEN COALESCE(cardinality(cw.waste_types), 0) = 0 THEN 0
          WHEN v.accepted_waste_types && cw.waste_types THEN 0
          ELSE 1
        END AS compatibility_rank,
        sum(COALESCE(pickup_vendor_cost.agg_cost, 1e18::float8)) +
          max(COALESCE(vendor_depot_cost.agg_cost, 1e18::float8)) AS vendor_cost
      FROM assignments AS a
      JOIN cluster_waste AS cw ON cw.cluster_index = a.cluster_index
      CROSS JOIN depot AS d
      CROSS JOIN active_vendors AS v
      LEFT JOIN cost_matrix AS pickup_vendor_cost
        ON pickup_vendor_cost.start_vid = a.pickup_vertex_id
       AND pickup_vendor_cost.end_vid = v.vendor_vertex_id
      LEFT JOIN cost_matrix AS vendor_depot_cost
        ON vendor_depot_cost.start_vid = v.vendor_vertex_id
       AND vendor_depot_cost.end_vid = d.vertex_id
      GROUP BY
        a.cluster_index,
        v.vendor_id,
        v.vendor_location_id,
        v.vendor_name,
        v.vendor_vertex_id,
        compatibility_rank
    ),
    selected_vendors AS (
      SELECT DISTINCT ON (cluster_index)
        *
      FROM vendor_rankings
      ORDER BY cluster_index, compatibility_rank, vendor_cost, vendor_id
    ),
    ordered_pickups AS (
      SELECT
        a.*,
        row_number() OVER (
          PARTITION BY a.cluster_index
          ORDER BY
            COALESCE(depot_pickup_cost.agg_cost, 1e18::float8),
            COALESCE(pickup_vendor_cost.agg_cost, 1e18::float8),
            a.service_order_id
        ) + 1 AS stop_sequence
      FROM assignments AS a
      JOIN selected_vendors AS sv ON sv.cluster_index = a.cluster_index
      CROSS JOIN depot AS d
      LEFT JOIN cost_matrix AS depot_pickup_cost
        ON depot_pickup_cost.start_vid = d.vertex_id
       AND depot_pickup_cost.end_vid = a.pickup_vertex_id
      LEFT JOIN cost_matrix AS pickup_vendor_cost
        ON pickup_vendor_cost.start_vid = a.pickup_vertex_id
       AND pickup_vendor_cost.end_vid = sv.vendor_vertex_id
    ),
    cluster_counts AS (
      SELECT cluster_index, count(*)::integer AS pickup_count
      FROM ordered_pickups
      GROUP BY cluster_index
    ),
    cluster_order_codes AS (
      SELECT cluster_index, string_agg(order_code, ', ' ORDER BY stop_sequence) AS order_codes
      FROM ordered_pickups
      GROUP BY cluster_index
    ),
    stops AS (
      SELECT
        cc.cluster_index,
        1 AS stop_sequence,
        d.location_id,
        NULL::bigint AS service_order_id,
        'DEPOT_START'::text AS stop_type,
        format('Clustered pickup plan %s', cc.cluster_index) AS notes,
        sv.vendor_id,
        sv.vendor_name,
        ARRAY[]::text[] AS order_codes,
        cc.pickup_count AS order_count
      FROM cluster_counts AS cc
      CROSS JOIN depot AS d
      JOIN selected_vendors AS sv ON sv.cluster_index = cc.cluster_index

      UNION ALL

      SELECT
        op.cluster_index,
        op.stop_sequence::integer,
        op.pickup_location_id AS location_id,
        op.service_order_id,
        'PICKUP'::text AS stop_type,
        format('%s: %s %s kg', op.order_code, COALESCE(op.waste_type, 'waste'), COALESCE(op.estimated_weight_kg, 0)) AS notes,
        sv.vendor_id,
        sv.vendor_name,
        ARRAY[op.order_code]::text[] AS order_codes,
        NULL::integer AS order_count
      FROM ordered_pickups AS op
      JOIN selected_vendors AS sv ON sv.cluster_index = op.cluster_index

      UNION ALL

      SELECT
        cc.cluster_index,
        cc.pickup_count + 2 AS stop_sequence,
        sv.vendor_location_id AS location_id,
        NULL::bigint AS service_order_id,
        'DROPOFF'::text AS stop_type,
        format('%s dropoff for %s', sv.vendor_name, coc.order_codes) AS notes,
        sv.vendor_id,
        sv.vendor_name,
        ARRAY[]::text[] AS order_codes,
        NULL::integer AS order_count
      FROM cluster_counts AS cc
      JOIN selected_vendors AS sv ON sv.cluster_index = cc.cluster_index
      JOIN cluster_order_codes AS coc ON coc.cluster_index = cc.cluster_index

      UNION ALL

      SELECT
        cc.cluster_index,
        cc.pickup_count + 3 AS stop_sequence,
        d.location_id,
        NULL::bigint AS service_order_id,
        'DEPOT_END'::text AS stop_type,
        'Return to depot'::text AS notes,
        sv.vendor_id,
        sv.vendor_name,
        ARRAY[]::text[] AS order_codes,
        NULL::integer AS order_count
      FROM cluster_counts AS cc
      CROSS JOIN depot AS d
      JOIN selected_vendors AS sv ON sv.cluster_index = cc.cluster_index
    )
    SELECT
      cluster_index,
      stop_sequence,
      location_id,
      service_order_id,
      stop_type,
      notes,
      vendor_id,
      vendor_name,
      order_codes,
      order_count
    FROM stops
    ORDER BY cluster_index, stop_sequence
  `, [requestedClusterCount]);

  return rows;
};

app.get('/api/health', asyncRoute(async (_req, res) => {
  const { rows } = await query(`
    SELECT
      current_database() AS database,
      current_user AS username,
      EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'postgis') AS postgis,
      EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgrouting') AS pgrouting
  `);
  res.json(rows[0]);
}));

app.get('/api/summary', asyncRoute(async (_req, res) => {
  const { rows } = await query(`
    SELECT table_name, row_count
    FROM (
      SELECT 'locations' AS table_name, count(*)::bigint AS row_count FROM mangalore.locations
      UNION ALL SELECT 'location_network_nodes', count(*)::bigint FROM mangalore.location_network_nodes
      UNION ALL SELECT 'roads', count(*)::bigint FROM mangalore.roads
      UNION ALL SELECT 'roads_noded', count(*)::bigint FROM mangalore.roads_noded
      UNION ALL SELECT 'roads_noded_vertices_pgr', count(*)::bigint FROM mangalore.roads_noded_vertices_pgr
      UNION ALL SELECT 'routing_edges', count(*)::bigint FROM mangalore.routing_edges
      UNION ALL SELECT 'roadside_detections', count(*)::bigint FROM mangalore.roadside_detections
      UNION ALL SELECT 'route_plans', count(*)::bigint FROM mangalore.route_plans
      UNION ALL SELECT 'route_plan_segments', count(*)::bigint FROM mangalore.route_plan_segments
    ) AS counts
    ORDER BY table_name
  `);
  res.json(rows);
}));

app.get('/api/locations', asyncRoute(async (_req, res) => {
  await ensureCompletedFeaturesTable();
  const { rows } = await query(featureCollectionSql(`
    SELECT
      l.id,
      l.name,
      l.location_type,
      l.address,
      l.latitude,
      l.longitude,
      l.place_query,
      l.geocoding_source,
      l.geocoded_at,
      n.vertex_id,
      n.road_segment_id,
      round(n.distance_to_road::numeric, 3) AS distance_to_road_m,
      round(n.distance_to_vertex::numeric, 3) AS distance_to_vertex_m,
      ST_Transform(l.geom, 4326) AS geom
    FROM mangalore.locations AS l
    LEFT JOIN mangalore.location_network_nodes AS n ON n.location_id = l.id
    WHERE NOT EXISTS (
      SELECT 1
      FROM mangalore.completed_map_features AS cmf
      WHERE cmf.feature_type = 'location'
        AND cmf.feature_id = l.id
    )
    ORDER BY l.id
  `));
  res.json(rows[0].geojson);
}));

app.get('/api/roadside-detections', asyncRoute(async (_req, res) => {
  await ensureCompletedFeaturesTable();
  const { rows } = await query(featureCollectionSql(`
    SELECT
      d.id,
      d.title,
      d.ward,
      d.priority,
      d.status,
      d.waste_type,
      d.estimated_weight_kg,
      d.confidence,
      d.source,
      d.notes,
      d.confirmed_at,
      d.false_positive_at,
      d.created_at,
      d.updated_at,
      d.customer_id,
      d.service_order_id,
      ST_Transform(d.geom, 4326) AS geom
    FROM mangalore.roadside_detections AS d
    WHERE d.geom IS NOT NULL
      AND COALESCE(d.status, 'NEW') <> 'FALSE_POSITIVE'
      AND NOT EXISTS (
        SELECT 1
        FROM mangalore.completed_map_features AS cmf
        WHERE cmf.feature_type = 'roadside_detection'
          AND cmf.feature_id = d.id
      )
    ORDER BY
      CASE d.status
        WHEN 'NEW' THEN 1
        WHEN 'REVIEWING' THEN 2
        WHEN 'CONFIRMED' THEN 3
        ELSE 4
      END,
      d.created_at DESC,
      d.id DESC
  `));
  res.json(rows[0].geojson);
}));

app.get('/api/snapped-points', asyncRoute(async (_req, res) => {
  await ensureCompletedFeaturesTable();
  const { rows } = await query(featureCollectionSql(`
    SELECT
      l.id,
      l.name,
      l.location_type,
      n.vertex_id,
      n.road_segment_id,
      round(n.distance_to_road::numeric, 3) AS distance_to_road_m,
      round(n.distance_to_vertex::numeric, 3) AS distance_to_vertex_m,
      ST_Transform(n.snapped_geom, 4326) AS geom
    FROM mangalore.location_network_nodes AS n
    JOIN mangalore.locations AS l ON l.id = n.location_id
    WHERE NOT EXISTS (
      SELECT 1
      FROM mangalore.completed_map_features AS cmf
      WHERE cmf.feature_type = 'location'
        AND cmf.feature_id = l.id
    )
    ORDER BY l.id
  `));
  res.json(rows[0].geojson);
}));

app.get('/api/snap-lines', asyncRoute(async (_req, res) => {
  await ensureCompletedFeaturesTable();
  const { rows } = await query(featureCollectionSql(`
    SELECT
      l.id,
      l.name,
      l.location_type,
      round(n.distance_to_road::numeric, 3) AS distance_to_road_m,
      ST_Transform(ST_MakeLine(n.original_geom, n.snapped_geom), 4326) AS geom
    FROM mangalore.location_network_nodes AS n
    JOIN mangalore.locations AS l ON l.id = n.location_id
    WHERE n.original_geom IS NOT NULL
      AND n.snapped_geom IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM mangalore.completed_map_features AS cmf
        WHERE cmf.feature_type = 'location'
          AND cmf.feature_id = l.id
      )
    ORDER BY l.id
  `));
  res.json(rows[0].geojson);
}));

app.get('/api/routing-edges', asyncRoute(async (req, res) => {
  const limit = Math.min(toNumber(req.query.limit, 25000), 50000);
  const highway = typeof req.query.highway === 'string' && req.query.highway ? req.query.highway : null;
  const params = [limit];
  let highwayClause = '';
  if (highway) {
    params.push(highway);
    highwayClause = `AND highway = $${params.length}`;
  }

  const { rows } = await query(featureCollectionSql(`
    SELECT
      id,
      old_road_id,
      source,
      target,
      round(length_m::numeric, 3) AS length_m,
      round(cost::numeric, 3) AS cost,
      round(reverse_cost::numeric, 3) AS reverse_cost,
      osm_id,
      name,
      highway,
      oneway,
      surface,
      width,
      ST_Transform(geom, 4326) AS geom
    FROM mangalore.routing_edges
    WHERE geom IS NOT NULL
      ${highwayClause}
    ORDER BY id
    LIMIT $1
  `), params);
  res.json(rows[0].geojson);
}));

app.get('/api/highways', asyncRoute(async (_req, res) => {
  const { rows } = await query(`
    SELECT COALESCE(highway, '(unknown)') AS highway, count(*)::bigint AS edge_count
    FROM mangalore.routing_edges
    GROUP BY COALESCE(highway, '(unknown)')
    ORDER BY edge_count DESC, highway
  `);
  res.json(rows);
}));

app.get('/api/route-plans', asyncRoute(async (_req, res) => {
  const { rows } = await query(`
    SELECT
      rp.id,
      rp.plan_code,
      rp.status,
      rp.planned_start_at,
      rp.planned_end_at,
      round(rp.total_distance_m::numeric, 3) AS total_distance_m,
      round(rp.total_cost::numeric, 3) AS total_cost,
      d.name AS depot_name,
      t.truck_code,
      rp.created_at,
      COALESCE(jsonb_agg(
        jsonb_build_object(
          'id', s.id,
          'sequence', s.stop_sequence,
          'location_id', s.location_id,
          'location_name', l.name,
          'service_order_id', s.service_order_id,
          'type', s.stop_type,
          'arrival', s.planned_arrival_at,
          'departure', s.planned_departure_at,
          'notes', s.notes
        )
        ORDER BY s.stop_sequence
      ) FILTER (WHERE s.id IS NOT NULL), '[]'::jsonb) AS stops
    FROM mangalore.route_plans AS rp
    LEFT JOIN mangalore.locations AS d ON d.id = rp.depot_location_id
    LEFT JOIN mangalore.trucks AS t ON t.id = rp.truck_id
    LEFT JOIN mangalore.route_plan_stops AS s ON s.route_plan_id = rp.id
    LEFT JOIN mangalore.locations AS l ON l.id = s.location_id
    WHERE rp.status <> 'COMPLETED'
    GROUP BY rp.id, d.name, t.truck_code
    ORDER BY rp.created_at DESC, rp.id DESC
  `);
  res.json(rows);
}));

app.get('/api/route-segments', asyncRoute(async (req, res) => {
  const planId = Number.parseInt(req.query.planId, 10);
  const params = [];
  const clauses = [`rp.status <> 'COMPLETED'`];
  if (Number.isInteger(planId)) {
    params.push(planId);
    clauses.push(`rps.route_plan_id = $${params.length}`);
  }
  const whereClause = `WHERE ${clauses.join(' AND ')}`;

  const { rows } = await query(featureCollectionSql(`
    SELECT
      rps.id,
      rps.route_plan_id,
      rp.plan_code,
      rps.segment_sequence,
      rps.start_vertex_id,
      rps.end_vertex_id,
      round(rps.distance_m::numeric, 3) AS distance_m,
      round(rps.cost::numeric, 3) AS cost,
      ST_Transform(rps.geom, 4326) AS geom
    FROM mangalore.route_plan_segments AS rps
    JOIN mangalore.route_plans AS rp ON rp.id = rps.route_plan_id
    ${whereClause}
    ORDER BY rps.route_plan_id, rps.segment_sequence
  `), params);
  res.json(rows[0].geojson);
}));

app.post('/api/locations', asyncRoute(async (req, res) => {
  const { name, location_type, address, latitude, longitude, place_query } = req.body;
  const lat = Number(latitude);
  const lon = Number(longitude);

  if (!name || !location_type || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    res.status(400).json({ error: 'name, location_type, latitude, and longitude are required' });
    return;
  }

  const { rows } = await query(`
    INSERT INTO mangalore.locations (
      name, location_type, address, latitude, longitude, place_query, geocoding_source, geocoded_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, 'web-app', now())
    RETURNING id, name, location_type, latitude, longitude
  `, [name, location_type, address || null, lat, lon, place_query || null]);

  res.status(201).json(rows[0]);
}));

app.patch('/api/locations/:id', asyncRoute(async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: 'Invalid location id' });
    return;
  }

  const { name, location_type, address, latitude, longitude, place_query } = req.body;
  const lat = latitude === undefined ? undefined : Number(latitude);
  const lon = longitude === undefined ? undefined : Number(longitude);
  if ((latitude !== undefined && !Number.isFinite(lat)) || (longitude !== undefined && !Number.isFinite(lon))) {
    res.status(400).json({ error: 'latitude and longitude must be numbers' });
    return;
  }

  const { rows } = await query(`
    UPDATE mangalore.locations
    SET
      name = COALESCE($2, name),
      location_type = COALESCE($3, location_type),
      address = COALESCE($4, address),
      latitude = COALESCE($5, latitude),
      longitude = COALESCE($6, longitude),
      place_query = COALESCE($7, place_query),
      geocoding_source = 'web-app',
      geocoded_at = now()
    WHERE id = $1
    RETURNING id, name, location_type, latitude, longitude
  `, [
    id,
    name || null,
    location_type || null,
    address || null,
    lat ?? null,
    lon ?? null,
    place_query || null
  ]);

  if (!rows[0]) {
    res.status(404).json({ error: 'Location not found' });
    return;
  }

  res.json(rows[0]);
}));

app.post('/api/locations/import-sql', asyncRoute(async (req, res) => {
  const sql = typeof req.body.sql === 'string' ? req.body.sql : '';
  if (!sql.trim()) {
    res.status(400).json({ error: 'SQL file content is required' });
    return;
  }

  const locations = extractLocationsFromSql(sql);
  if (!locations.length) {
    res.status(400).json({ error: 'No location rows found. Expected INSERT or COPY data for mangalore.locations.' });
    return;
  }

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const backup = await createLocationBackup(client, 'before_sql_import');
    const { rows } = await client.query(`
      WITH payload AS (
        SELECT *
        FROM jsonb_to_recordset($1::jsonb) AS item (
          name text,
          location_type text,
          address text,
          latitude numeric,
          longitude numeric,
          place_query text
        )
      ),
      upserted AS (
        INSERT INTO mangalore.locations (
          name,
          location_type,
          address,
          latitude,
          longitude,
          place_query,
          geocoding_source,
          geocoded_at
        )
        SELECT
          name,
          location_type,
          address,
          latitude,
          longitude,
          COALESCE(place_query, address),
          'sql-import',
          now()
        FROM payload
        ON CONFLICT (name) DO UPDATE
        SET
          location_type = EXCLUDED.location_type,
          address = EXCLUDED.address,
          latitude = EXCLUDED.latitude,
          longitude = EXCLUDED.longitude,
          place_query = EXCLUDED.place_query,
          geocoding_source = 'sql-import',
          geocoded_at = now()
        RETURNING id, location_type
      ),
      customer_locations AS (
        INSERT INTO mangalore.customers (location_id)
        SELECT id
        FROM upserted
        WHERE location_type = 'CUSTOMER'
        ON CONFLICT (location_id) DO NOTHING
      ),
      vendor_locations AS (
        INSERT INTO mangalore.vendors (location_id)
        SELECT id
        FROM upserted
        WHERE location_type = 'VENDOR'
        ON CONFLICT (location_id) DO NOTHING
      )
      SELECT count(*)::integer AS imported_count
      FROM upserted
    `, [JSON.stringify(locations)]);

    await client.query('COMMIT');
    res.status(201).json({ imported: rows[0].imported_count, backup_id: backup.id });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

app.delete('/api/locations', asyncRoute(async (_req, res) => {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const backup = await createLocationBackup(client, 'before_clear_locations');
    const result = await clearLocationData(client);
    await client.query('COMMIT');
    res.json({ deleted: result.deletedLocations, backup_id: backup.id });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

app.post('/api/locations/restore-backup', asyncRoute(async (_req, res) => {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await ensureLocationBackupTable(client);
    const backupResult = await client.query(`
      SELECT *
      FROM mangalore.location_backup_snapshots
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `);
    const backup = backupResult.rows[0];
    if (!backup) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'No local location backup is available yet' });
      return;
    }

    await clearLocationData(client);
    const locationInsert = await client.query(`
      INSERT INTO mangalore.locations (
        id,
        name,
        location_type,
        address,
        latitude,
        longitude,
        place_query,
        geocoding_source,
        geocoded_at,
        created_at
      )
      SELECT
        id,
        name,
        location_type,
        address,
        latitude,
        longitude,
        place_query,
        geocoding_source,
        geocoded_at,
        created_at
      FROM jsonb_to_recordset($1::jsonb) AS item (
        id bigint,
        name text,
        location_type text,
        address text,
        latitude numeric,
        longitude numeric,
        place_query text,
        geocoding_source text,
        geocoded_at timestamptz,
        created_at timestamp
      )
      RETURNING id
    `, [JSON.stringify(backup.locations || [])]);

    await client.query(`
      INSERT INTO mangalore.customers (
        id,
        location_id,
        contact_name,
        phone,
        email,
        pickup_notes,
        is_active,
        created_at,
        updated_at
      )
      SELECT
        id,
        location_id,
        contact_name,
        phone,
        email,
        pickup_notes,
        is_active,
        created_at,
        updated_at
      FROM jsonb_to_recordset($1::jsonb) AS item (
        id bigint,
        location_id bigint,
        contact_name text,
        phone text,
        email text,
        pickup_notes text,
        is_active boolean,
        created_at timestamptz,
        updated_at timestamptz
      )
    `, [JSON.stringify(backup.customers || [])]);

    await client.query(`
      INSERT INTO mangalore.vendors (
        id,
        location_id,
        contact_name,
        phone,
        email,
        accepted_waste_types,
        pickup_days,
        acceptance_details,
        is_active,
        created_at,
        updated_at
      )
      SELECT
        id,
        location_id,
        contact_name,
        phone,
        email,
        accepted_waste_types,
        pickup_days,
        acceptance_details,
        is_active,
        created_at,
        updated_at
      FROM jsonb_to_recordset($1::jsonb) AS item (
        id bigint,
        location_id bigint,
        contact_name text,
        phone text,
        email text,
        accepted_waste_types text[],
        pickup_days text[],
        acceptance_details text,
        is_active boolean,
        created_at timestamptz,
        updated_at timestamptz
      )
    `, [JSON.stringify(backup.vendors || [])]);

    await client.query(`
      INSERT INTO mangalore.service_orders (
        id,
        order_code,
        customer_id,
        vendor_id,
        pickup_location_id,
        dropoff_location_id,
        waste_type,
        estimated_weight_kg,
        status,
        requested_at,
        service_window_start,
        service_window_end,
        notes,
        created_at,
        updated_at
      )
      SELECT
        id,
        order_code,
        customer_id,
        vendor_id,
        pickup_location_id,
        dropoff_location_id,
        waste_type,
        estimated_weight_kg,
        status,
        requested_at,
        service_window_start,
        service_window_end,
        notes,
        created_at,
        updated_at
      FROM jsonb_to_recordset($1::jsonb) AS item (
        id bigint,
        order_code text,
        customer_id bigint,
        vendor_id bigint,
        pickup_location_id bigint,
        dropoff_location_id bigint,
        waste_type text,
        estimated_weight_kg numeric,
        status text,
        requested_at timestamptz,
        service_window_start timestamptz,
        service_window_end timestamptz,
        notes text,
        created_at timestamptz,
        updated_at timestamptz
      )
    `, [JSON.stringify(backup.service_orders || [])]);

    await resetIdentitySequence(client, 'mangalore.locations');
    await resetIdentitySequence(client, 'mangalore.customers');
    await resetIdentitySequence(client, 'mangalore.vendors');
    await resetIdentitySequence(client, 'mangalore.service_orders');
    await client.query('COMMIT');
    res.json({ restored: locationInsert.rows.length, backup_id: backup.id, backup_created_at: backup.created_at });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

app.post('/api/map-features/complete', asyncRoute(async (req, res) => {
  const featureType = String(req.body.featureType || '').trim();
  const featureId = Number.parseInt(req.body.featureId, 10);
  if (!Number.isInteger(featureId)) {
    res.status(400).json({ error: 'featureId is required' });
    return;
  }

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await ensureCompletedFeaturesTable(client);

    if (featureType === 'location') {
      const { rowCount } = await client.query('SELECT 1 FROM mangalore.locations WHERE id = $1', [featureId]);
      if (!rowCount) {
        await client.query('ROLLBACK');
        res.status(404).json({ error: 'Location marker not found' });
        return;
      }
      await client.query(`
        INSERT INTO mangalore.completed_map_features (feature_type, feature_id)
        VALUES ('location', $1)
        ON CONFLICT (feature_type, feature_id) DO UPDATE
        SET completed_at = now()
      `, [featureId]);
      await client.query('COMMIT');
      res.json({ completed: true, featureType, featureId });
      return;
    }

    if (featureType === 'roadside_detection') {
      const { rowCount } = await client.query('SELECT 1 FROM mangalore.roadside_detections WHERE id = $1', [featureId]);
      if (!rowCount) {
        await client.query('ROLLBACK');
        res.status(404).json({ error: 'Roadside detection marker not found' });
        return;
      }
      await client.query(`
        INSERT INTO mangalore.completed_map_features (feature_type, feature_id)
        VALUES ('roadside_detection', $1)
        ON CONFLICT (feature_type, feature_id) DO UPDATE
        SET completed_at = now()
      `, [featureId]);
      await client.query('COMMIT');
      res.json({ completed: true, featureType, featureId });
      return;
    }

    if (featureType === 'route_plan') {
      const { rowCount } = await client.query(`
        UPDATE mangalore.route_plans
        SET status = 'COMPLETED', updated_at = now()
        WHERE id = $1
      `, [featureId]);
      if (!rowCount) {
        await client.query('ROLLBACK');
        res.status(404).json({ error: 'Route plan not found' });
        return;
      }
      await client.query(`
        UPDATE mangalore.service_orders AS so
        SET status = 'COMPLETED', updated_at = now()
        WHERE so.id IN (
          SELECT service_order_id
          FROM mangalore.route_plan_stops
          WHERE route_plan_id = $1
            AND service_order_id IS NOT NULL
        )
      `, [featureId]);
      await client.query('COMMIT');
      res.json({ completed: true, featureType, featureId });
      return;
    }

    await client.query('ROLLBACK');
    res.status(400).json({ error: 'Unsupported featureType' });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

app.post('/api/routes/preview', asyncRoute(async (req, res) => {
  const startLocationId = Number.parseInt(req.body.startLocationId, 10);
  const endLocationId = Number.parseInt(req.body.endLocationId, 10);
  if (!Number.isInteger(startLocationId) || !Number.isInteger(endLocationId)) {
    res.status(400).json({ error: 'startLocationId and endLocationId are required' });
    return;
  }

  const { rows } = await query(featureCollectionSql(`
    WITH endpoints AS (
      SELECT
        (SELECT vertex_id FROM mangalore.location_network_nodes WHERE location_id = $1) AS start_vid,
        (SELECT vertex_id FROM mangalore.location_network_nodes WHERE location_id = $2) AS end_vid
    ),
    route AS (
      SELECT
        d.*,
        lead(d.node) OVER (ORDER BY d.path_seq) AS next_node
      FROM endpoints e
      CROSS JOIN LATERAL pgr_dijkstra(
        'SELECT id, source, target, cost, reverse_cost FROM mangalore.routing_edges',
        e.start_vid::bigint,
        e.end_vid::bigint,
        true
      ) AS d
    )
    SELECT
      1 AS id,
      $1::bigint AS start_location_id,
      $2::bigint AS end_location_id,
      count(*) AS step_count,
      round(max(route.agg_cost)::numeric, 3) AS total_cost,
      ST_Transform(
        ST_Multi(ST_LineMerge(ST_Collect(
          CASE
            WHEN route.edge = -1 THEN NULL
            WHEN re.source = route.node AND re.target = route.next_node THEN re.geom
            WHEN re.target = route.node AND re.source = route.next_node THEN ST_Reverse(re.geom)
            ELSE re.geom
          END
          ORDER BY route.path_seq
        ) FILTER (WHERE route.edge <> -1)))::geometry(MultiLineString,3857),
        4326
      ) AS geom
    FROM route
    LEFT JOIN mangalore.routing_edges AS re ON re.id = route.edge
  `), [startLocationId, endLocationId]);

  res.json(rows[0].geojson);
}));

app.post('/api/route-plans', asyncRoute(async (req, res) => {
  const locationIds = toIntArray(req.body.locationIds);
  const planCode = String(req.body.planCode || `WEB-PLAN-${Date.now()}`).trim();
  if (locationIds.length < 2) {
    res.status(400).json({ error: 'At least two locationIds are required' });
    return;
  }

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');

    const result = await createRoutePlan(client, {
      planCode,
      depotLocationId: locationIds[0],
      plannedStartAt: new Date(),
      stops: locationIds.map((locationId, index) => ({
        locationId,
        stopType:
          index === 0 ? 'DEPOT_START' :
          index === locationIds.length - 1 ? 'DROPOFF' :
          'PICKUP'
      }))
    });

    await client.query('COMMIT');
    res.status(201).json(result);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

app.post('/api/route-plans/generate-clustered-pickups', asyncRoute(async (req, res) => {
  const requestedClusterCount = Math.round(Math.min(Math.max(toNumber(req.body.clusterCount, 4), 1), 8));
  const regenerate = req.body.regenerate === true;
  const client = await getPool().connect();

  try {
    await client.query('BEGIN');
    await assertPgRoutingCostMatrixSupport(client);

    if (regenerate) {
      await client.query(`
        UPDATE mangalore.service_orders AS so
        SET
          status = 'PENDING',
          updated_at = now()
        WHERE so.id IN (
          SELECT DISTINCT rps.service_order_id
          FROM mangalore.route_plan_stops AS rps
          JOIN mangalore.route_plans AS rp ON rp.id = rps.route_plan_id
          WHERE rp.plan_code LIKE 'AREA-%'
            AND rps.service_order_id IS NOT NULL
        )
          AND so.status = 'PLANNED'
      `);
      await client.query(`
        DELETE FROM mangalore.route_plans
        WHERE plan_code LIKE 'AREA-%'
      `);
    }

    const depotResult = await client.query(`
      SELECT l.id, l.name
      FROM mangalore.locations AS l
      JOIN mangalore.location_network_nodes AS n ON n.location_id = l.id
      WHERE l.location_type = 'DEPOT'
      ORDER BY l.id
      LIMIT 1
    `);
    const depot = depotResult.rows[0];
    if (!depot) {
      res.status(400).json({ error: 'At least one DEPOT location with a snapped network node is required before generating vendor pickup routes' });
      await client.query('ROLLBACK');
      return;
    }

    const truckResult = await client.query(`
      SELECT id, truck_code
      FROM mangalore.trucks
      WHERE is_active = true
      ORDER BY id
      LIMIT 1
    `);
    const truck = truckResult.rows[0] || null;

    const { rows: readiness } = await client.query(`
      SELECT
        count(DISTINCT so.id)::integer AS order_count,
        count(DISTINCT v.id) FILTER (WHERE vendor_node.location_id IS NOT NULL)::integer AS vendor_count
      FROM mangalore.service_orders AS so
      JOIN mangalore.location_network_nodes AS pickup_node ON pickup_node.location_id = so.pickup_location_id
      LEFT JOIN mangalore.vendors AS v ON v.is_active = true
      LEFT JOIN mangalore.location_network_nodes AS vendor_node ON vendor_node.location_id = v.location_id
      WHERE so.status = 'PENDING'
    `);
    const orderCount = readiness[0]?.order_count || 0;
    const vendorCount = readiness[0]?.vendor_count || 0;
    if (!orderCount) {
      await client.query('COMMIT');
      res.status(201).json({ generated_count: 0, plans: [] });
      return;
    }
    if (!vendorCount) {
      res.status(400).json({ error: 'At least one active vendor marker with a snapped network node is required before generating clustered pickup routes' });
      await client.query('ROLLBACK');
      return;
    }

    const plans = [];
    const plannedStops = await getClusteredPickupStopRows(client, requestedClusterCount);
    const clusters = new Map();
    plannedStops.forEach((row) => {
      const rows = clusters.get(row.cluster_index) || [];
      rows.push(row);
      clusters.set(row.cluster_index, rows);
    });
    for (const [clusterIndex, rows] of clusters.entries()) {
      const areaNumber = Number(clusterIndex);
      const planCode = `AREA-${String(areaNumber).padStart(2, '0')}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      const stops = rows.map((row) => ({
        locationId: row.location_id,
        serviceOrderId: row.service_order_id,
        stopType: row.stop_type,
        notes: row.notes
      }));

      const plan = await createRoutePlan(client, {
        planCode,
        truckId: truck?.id || null,
        depotLocationId: depot.id,
        stops
      });

      const orderIds = rows.map((row) => row.service_order_id).filter(Boolean);
      await client.query(`
        UPDATE mangalore.service_orders
        SET
          status = 'PLANNED',
          updated_at = now()
        WHERE id = ANY($1::bigint[])
      `, [orderIds]);

      plans.push({
        ...plan,
        area: `Area ${areaNumber}`,
        vendor_id: rows[0]?.vendor_id || null,
        vendor_name: rows[0]?.vendor_name || null,
        order_count: rows.find((row) => row.order_count !== null)?.order_count || orderIds.length,
        order_codes: rows.flatMap((row) => row.order_codes || []),
        truck_code: truck?.truck_code || null
      });
    }

    await client.query('COMMIT');
    res.status(201).json({
      generated_count: plans.length,
      plans
    });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}));

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(error.status || 500).json({ error: error.message || 'Unexpected server error' });
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(clientDir, 'index.html'), (error) => {
    if (error) res.sendFile(path.join(staticDir, 'index.html'));
  });
});

if (!process.env.VERCEL) {
  app.listen(port, () => {
    console.log(`Mangalore routing map running at http://localhost:${port}`);
  });
}

export default app;
