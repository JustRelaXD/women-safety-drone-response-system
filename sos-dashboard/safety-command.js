const DEFAULT_CONFIG = {
  city: {
    id: 'patiala',
    name: 'Patiala',
    country: 'India',
    center: [76.3865, 30.3385],
    zoom: 12.6
  },
  stations: [
    { id: 'DST-01', name: 'City Core Post', coordinate: [76.398, 30.3337], droneId: 'DRN-01', reserveDroneId: 'RSV-01' },
    { id: 'DST-02', name: 'Sirhind Road Post', coordinate: [76.4199, 30.3384], droneId: 'DRN-02', reserveDroneId: 'RSV-02' },
    { id: 'DST-03', name: 'South City Post', coordinate: [76.3998, 30.3262], droneId: 'DRN-03', reserveDroneId: 'RSV-03' },
    { id: 'DST-04', name: 'Tripuri Post', coordinate: [76.3887, 30.3467], droneId: 'DRN-04', reserveDroneId: 'RSV-04' }
  ],
  drones: [
    // Patrol zones are convex-hull polygon rings around each corridor's danger
    // zones; stations sit at the zone centroids (near the center of each zone).
    { id: 'DRN-01', label: 'Qila Guardian', status: 'Patrol', battery: 92, response: '1.8 min', stationId: 'DST-01', position: [76.398, 30.3337], routeName: 'City Core - Qila loop', route: [[76.3978, 30.3286], [76.3952, 30.3321], [76.3986, 30.3394], [76.4005, 30.3345], [76.3978, 30.3286]] },
    { id: 'DRN-02', label: 'University Watch', status: 'Patrol', battery: 78, response: '2.4 min', stationId: 'DST-02', position: [76.4199, 30.3384], routeName: 'University - Sirhind Rd corridor', route: [[76.405, 30.338], [76.421, 30.334], [76.437, 30.339], [76.414, 30.3425], [76.405, 30.338]] },
    { id: 'DRN-03', label: 'Railway Sentinel', status: 'Patrol', battery: 85, response: '3.1 min', stationId: 'DST-03', position: [76.3998, 30.3262], routeName: 'Railway - South corridor', route: [[76.4055, 30.333], [76.409, 30.328], [76.385, 30.3175], [76.3925, 30.323], [76.4055, 30.333]] },
    { id: 'DRN-04', label: 'Tripuri Shield', status: 'Patrol', battery: 88, response: '2.1 min', stationId: 'DST-04', position: [76.3887, 30.3467], routeName: 'Tripuri - North loop', route: [[76.3904, 30.3506], [76.392, 30.342], [76.3796, 30.3455], [76.3945, 30.3525], [76.3904, 30.3506]] },
    { id: 'RSV-01', label: 'Qila Guardian Reserve', status: 'Standby', battery: 100, response: 'standby', stationId: 'DST-01', role: 'Reserve', coverageForDroneId: 'DRN-01', position: [76.398, 30.3337], routeName: 'City Core - Qila loop coverage', route: [[76.3978, 30.3286], [76.3952, 30.3321], [76.3986, 30.3394], [76.4005, 30.3345], [76.3978, 30.3286]] },
    { id: 'RSV-02', label: 'University Watch Reserve', status: 'Standby', battery: 100, response: 'standby', stationId: 'DST-02', role: 'Reserve', coverageForDroneId: 'DRN-02', position: [76.4199, 30.3384], routeName: 'University - Sirhind Rd corridor coverage', route: [[76.405, 30.338], [76.421, 30.334], [76.437, 30.339], [76.414, 30.3425], [76.405, 30.338]] },
    { id: 'RSV-03', label: 'Railway Sentinel Reserve', status: 'Standby', battery: 100, response: 'standby', stationId: 'DST-03', role: 'Reserve', coverageForDroneId: 'DRN-03', position: [76.3998, 30.3262], routeName: 'Railway - South corridor coverage', route: [[76.4055, 30.333], [76.409, 30.328], [76.385, 30.3175], [76.3925, 30.323], [76.4055, 30.333]] },
    { id: 'RSV-04', label: 'Tripuri Shield Reserve', status: 'Standby', battery: 100, response: 'standby', stationId: 'DST-04', role: 'Reserve', coverageForDroneId: 'DRN-04', position: [76.3887, 30.3467], routeName: 'Tripuri - North loop coverage', route: [[76.3904, 30.3506], [76.392, 30.342], [76.3796, 30.3455], [76.3945, 30.3525], [76.3904, 30.3506]] }
  ],
  patrolPoints: [
    { id: 'PAT-01', name: 'Baradari Gardens Gate', coordinate: [76.399, 30.3465], sequence: 1 },
    { id: 'PAT-02', name: 'Qila Mubarak East', coordinate: [76.4015, 30.3286], sequence: 2 },
    { id: 'PAT-03', name: 'Sirhind Road Turn', coordinate: [76.423, 30.336], sequence: 3 },
    { id: 'PAT-04', name: 'Bus Stand Junction', coordinate: [76.4055, 30.333], sequence: 4 },
    { id: 'PAT-05', name: 'Tripuri Market Gate', coordinate: [76.3904, 30.3506], sequence: 5 },
    { id: 'PAT-06', name: 'Punjabi University Gate', coordinate: [76.4435, 30.357], sequence: 6 }
  ],
  dangerZones: [
    { id: 'HS-101', name: 'Qila Mubarak old city cluster', category: 'Old City', severity: 0.96, coordinate: [76.3978, 30.3286], radiusM: 170 },
    { id: 'HS-102', name: 'Rajindra Hospital approach', category: 'Hospital', severity: 0.88, coordinate: [76.3952, 30.3321], radiusM: 170 },
    { id: 'HS-103', name: 'Adalat Bazar market pressure', category: 'Market', severity: 0.82, coordinate: [76.3986, 30.3394], radiusM: 170 },
    { id: 'HS-104', name: 'Chowk / Anardana Bazar', category: 'Market', severity: 0.9, coordinate: [76.4005, 30.3345], radiusM: 170 },
    { id: 'HS-105', name: 'Model Town market crossing', category: 'Market', severity: 0.84, coordinate: [76.405, 30.338], radiusM: 170 },
    { id: 'HS-106', name: 'Sirhind Road late-night stretch', category: 'Road', severity: 0.72, coordinate: [76.421, 30.334], radiusM: 170 },
    { id: 'HS-107', name: 'Punjabi University gate area', category: 'Campus', severity: 0.7, coordinate: [76.437, 30.339], radiusM: 170 },
    { id: 'HS-108', name: 'Urban Estate walkway reports', category: 'Residential', severity: 0.76, coordinate: [76.414, 30.3425], radiusM: 170 },
    { id: 'HS-109', name: 'New Bus Stand terminal', category: 'Transit', severity: 0.86, coordinate: [76.4055, 30.333], radiusM: 170 },
    { id: 'HS-110', name: 'Railway approach / Dak Ghar', category: 'Transit', severity: 0.8, coordinate: [76.409, 30.328], radiusM: 170 },
    { id: 'HS-111', name: 'Nabha Road crossing', category: 'Road', severity: 0.68, coordinate: [76.385, 30.3175], radiusM: 170 },
    { id: 'HS-112', name: 'Bhupindra Colony lanes', category: 'Residential', severity: 0.74, coordinate: [76.3925, 30.323], radiusM: 170 },
    { id: 'HS-113', name: 'Tripuri town market', category: 'Market', severity: 0.78, coordinate: [76.3904, 30.3506], radiusM: 170 },
    { id: 'HS-114', name: 'Sheranwala Gate junction', category: 'Junction', severity: 0.66, coordinate: [76.392, 30.342], radiusM: 170 },
    { id: 'HS-115', name: 'Chandan Nagar low-light block', category: 'Residential', severity: 0.7, coordinate: [76.3796, 30.3455], radiusM: 170 },
    { id: 'HS-116', name: 'New Lal Bagh Colony', category: 'Residential', severity: 0.64, coordinate: [76.3945, 30.3525], radiusM: 170 }
  ],
  // null = auto: the route planner picks 5 m for routes up to 10 km and
  // 10 m beyond, so dense-street corridors stay connected without blowing up
  // rasterization cost on long routes.  A fixed number forces that grid for
  // every route (sent as grid_resolution_m on each planner request).
  planner: { gridResolutionM: null }
};

const schemaSql = `
  CREATE SCHEMA IF NOT EXISTS safety_command;
  CREATE TABLE IF NOT EXISTS safety_command.city_profiles (
    id text PRIMARY KEY, name text NOT NULL, country text NOT NULL DEFAULT 'India',
    center_longitude numeric(10,7) NOT NULL, center_latitude numeric(10,7) NOT NULL,
    zoom numeric(5,2) NOT NULL DEFAULT 12.2, updated_at timestamptz NOT NULL DEFAULT now()
  );
  ALTER TABLE safety_command.city_profiles ADD COLUMN IF NOT EXISTS grid_resolution_m numeric(6,1);
  CREATE TABLE IF NOT EXISTS safety_command.stations (
    id text PRIMARY KEY, city_id text NOT NULL REFERENCES safety_command.city_profiles(id) ON DELETE CASCADE,
    name text NOT NULL, longitude numeric(10,7) NOT NULL, latitude numeric(10,7) NOT NULL,
    drone_id text, reserve_drone_id text, updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS safety_command.drones (
    id text PRIMARY KEY, city_id text NOT NULL REFERENCES safety_command.city_profiles(id) ON DELETE CASCADE,
    label text NOT NULL, status text NOT NULL DEFAULT 'Patrol', battery integer NOT NULL DEFAULT 100 CHECK (battery BETWEEN 0 AND 100),
    response text NOT NULL DEFAULT 'standby', station_id text, role text NOT NULL DEFAULT 'Patrol', coverage_for_drone_id text,
    position_longitude numeric(10,7) NOT NULL,
    position_latitude numeric(10,7) NOT NULL, route_name text NOT NULL, route jsonb NOT NULL DEFAULT '[]'::jsonb,
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS safety_command.patrol_points (
    id text PRIMARY KEY, city_id text NOT NULL REFERENCES safety_command.city_profiles(id) ON DELETE CASCADE,
    name text NOT NULL, longitude numeric(10,7) NOT NULL, latitude numeric(10,7) NOT NULL,
    sequence integer NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS safety_command.danger_zones (
    id text PRIMARY KEY, city_id text NOT NULL REFERENCES safety_command.city_profiles(id) ON DELETE CASCADE,
    name text NOT NULL, category text NOT NULL DEFAULT 'General', severity numeric(4,3) NOT NULL DEFAULT 0.5 CHECK (severity BETWEEN 0 AND 1),
    longitude numeric(10,7) NOT NULL, latitude numeric(10,7) NOT NULL, radius_m integer NOT NULL DEFAULT 150 CHECK (radius_m > 0),
    ring jsonb, updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS safety_command.sos_log (
    id text PRIMARY KEY,
    city_id text NOT NULL DEFAULT 'patiala',
    caller_label text NOT NULL,
    priority text NOT NULL DEFAULT 'Critical',
    longitude numeric(10,7) NOT NULL,
    latitude numeric(10,7) NOT NULL,
    drone_id text,
    status text NOT NULL DEFAULT 'Received',
    started_at timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz,
    warning text,
    route_km numeric(8,3),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_safety_stations_city ON safety_command.stations(city_id);
  CREATE INDEX IF NOT EXISTS idx_safety_drones_city ON safety_command.drones(city_id);
  CREATE INDEX IF NOT EXISTS idx_safety_patrol_points_city ON safety_command.patrol_points(city_id, sequence);
  CREATE INDEX IF NOT EXISTS idx_safety_danger_zones_city ON safety_command.danger_zones(city_id);
  CREATE INDEX IF NOT EXISTS idx_safety_sos_log_city ON safety_command.sos_log(city_id, started_at DESC);
  CREATE TABLE IF NOT EXISTS safety_command.incident_reports (
    id text PRIMARY KEY,
    city_id text NOT NULL DEFAULT 'patiala',
    title text NOT NULL,
    category text NOT NULL DEFAULT 'Other',
    severity text NOT NULL DEFAULT 'Medium',
    status text NOT NULL DEFAULT 'Open',
    longitude numeric(10,7) NOT NULL,
    latitude numeric(10,7) NOT NULL,
    street text,
    landmark text,
    reporter_id text,
    responder_notes text,
    media_type text,
    media_url text,
    media_poster text,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_safety_incident_reports_city ON safety_command.incident_reports(city_id, occurred_at DESC);
  ALTER TABLE safety_command.stations ADD COLUMN IF NOT EXISTS reserve_drone_id text;
  ALTER TABLE safety_command.drones ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'Patrol';
  ALTER TABLE safety_command.drones ADD COLUMN IF NOT EXISTS coverage_for_drone_id text;
  ALTER TABLE safety_command.danger_zones ADD COLUMN IF NOT EXISTS ring jsonb;
`;

// How many invisible spare drones every station keeps parked, available to
// cover patrols or extra missions whenever the designated reserve is busy.
const SPARES_PER_STATION = 6;

const numberOr = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const coordinateOr = (value, fallback) => Array.isArray(value) && value.length === 2
  ? [numberOr(value[0], fallback[0]), numberOr(value[1], fallback[1])]
  : fallback;

function normalizeConfig(input = {}) {
  const city = input.city || {};
  const fallbackCity = DEFAULT_CONFIG.city;
  const cityId = String(city.id || fallbackCity.id).replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
  const cityConfig = {
    id: cityId,
    name: String(city.name || fallbackCity.name).trim().slice(0, 100),
    country: String(city.country || fallbackCity.country).trim().slice(0, 100),
    center: coordinateOr(city.center, fallbackCity.center),
    zoom: numberOr(city.zoom, fallbackCity.zoom)
  };
  const stations = (Array.isArray(input.stations) ? input.stations : []).map((item, index) => ({
    id: String(item.id || `DST-${String(index + 1).padStart(2, '0')}`).trim(),
    name: String(item.name || 'Response station').trim().slice(0, 150),
    coordinate: coordinateOr(item.coordinate, cityConfig.center),
    droneId: item.droneId ? String(item.droneId).trim() : null,
    reserveDroneId: item.reserveDroneId ? String(item.reserveDroneId).trim() : null
  }));
  const drones = (Array.isArray(input.drones) ? input.drones : []).map((item, index) => {
    const rawRole = String(item.role || 'Patrol').trim();
    return {
    id: String(item.id || `DRN-${String(index + 1).padStart(2, '0')}`).trim(),
    label: String(item.label || 'Safety drone').trim().slice(0, 150),
    status: String(item.status || 'Patrol').trim().slice(0, 40),
    battery: Math.round(Math.min(100, Math.max(0, numberOr(item.battery, 100)))),
    response: String(item.response || 'standby').trim().slice(0, 60),
    stationId: item.stationId ? String(item.stationId).trim() : null,
    role: rawRole === 'Reserve' || rawRole === 'Spare' ? rawRole : 'Patrol',
    coverageForDroneId: item.coverageForDroneId ? String(item.coverageForDroneId).trim() : null,
    position: coordinateOr(item.position, cityConfig.center),
    routeName: String(item.routeName || 'Custom patrol route').trim().slice(0, 150),
    route: Array.isArray(item.route) ? item.route.map((point) => coordinateOr(point, cityConfig.center)) : []
  };
  });
  const patrolPoints = (Array.isArray(input.patrolPoints) ? input.patrolPoints : []).map((item, index) => ({
    id: String(item.id || `PAT-${String(index + 1).padStart(2, '0')}`).trim(),
    name: String(item.name || 'Patrol point').trim().slice(0, 150),
    coordinate: coordinateOr(item.coordinate, cityConfig.center),
    sequence: Math.round(numberOr(item.sequence, index))
  }));
  const dangerZones = (Array.isArray(input.dangerZones) ? input.dangerZones : []).map((item, index) => ({
    id: String(item.id || `ZONE-${String(index + 1).padStart(2, '0')}`).trim(),
    name: String(item.name || 'Danger zone').trim().slice(0, 150),
    category: String(item.category || 'General').trim().slice(0, 80),
    severity: Math.min(1, Math.max(0, numberOr(item.severity, 0.5))),
    coordinate: coordinateOr(item.coordinate, cityConfig.center),
    radiusM: Math.max(1, Math.round(numberOr(item.radiusM, 150))),
    ring: Array.isArray(item.ring) && item.ring.length >= 3
      ? item.ring.map((coord) => coordinateOr(coord, cityConfig.center))
      : null
  }));
  // Route-planner tuning.  gridResolutionM null = auto (the planner picks a
  // 5 m grid up to 10 km and 10 m beyond); a number forces that grid for
  // every route.  Stored on the city profile and sent per request.
  const rawGrid = input.planner?.gridResolutionM;
  const gridValue = rawGrid === null || rawGrid === undefined || rawGrid === ''
    ? null
    : Number(rawGrid);
  const planner = {
    gridResolutionM: Number.isFinite(gridValue) && gridValue > 0 && gridValue <= 500
      ? Math.round(gridValue * 10) / 10
      : null
  };
  return { city: cityConfig, stations, drones, patrolPoints, dangerZones, planner };
}

async function ensureSchema(client) {
  await client.query(schemaSql);
  await client.query("UPDATE safety_command.drones SET role = 'Patrol' WHERE role IS NULL");
}

async function ensureReserveFleet(client, cityId = 'patiala') {
  const stationRows = await client.query('SELECT id, drone_id, reserve_drone_id FROM safety_command.stations WHERE city_id = $1', [cityId]);
  const patrolRows = await client.query("SELECT id, label, battery, response, station_id, position_longitude, position_latitude, route_name, route FROM safety_command.drones WHERE city_id = $1 AND COALESCE(role, 'Patrol') = 'Patrol'", [cityId]);
  const reserveIds = new Set((await client.query("SELECT id FROM safety_command.drones WHERE city_id = $1 AND role = 'Reserve'", [cityId])).rows.map((row) => row.id));
  const stationsByPatrolId = new Map(stationRows.rows.filter((row) => row.drone_id).map((row) => [row.drone_id, row]));

  for (const patrol of patrolRows.rows) {
    const station = stationsByPatrolId.get(patrol.id);
    if (!station) continue;
    const reserveId = station.reserve_drone_id || `RSV-${patrol.id}`;
    if (!station.reserve_drone_id) {
      await client.query('UPDATE safety_command.stations SET reserve_drone_id = $1 WHERE id = $2', [reserveId, station.id]);
    }
    if (reserveIds.has(reserveId)) {
      await client.query(`
        UPDATE safety_command.drones
        SET label = $1, station_id = $2, coverage_for_drone_id = $3,
            position_longitude = $4, position_latitude = $5,
            route_name = $6, route = $7, updated_at = now()
        WHERE id = $8 AND role = 'Reserve'
      `, [
        `${patrol.label} Reserve`,
        patrol.station_id || station.id,
        patrol.id,
        patrol.position_longitude,
        patrol.position_latitude,
        `${patrol.route_name} coverage`,
        JSON.stringify(patrol.route || []),
        reserveId
      ]);
      continue;
    }
    await client.query(`
      INSERT INTO safety_command.drones (
        id, city_id, label, status, battery, response, station_id, role, coverage_for_drone_id,
        position_longitude, position_latitude, route_name, route
      )
      VALUES ($1,$2,$3,'Standby',$4,'standby',$5,'Reserve',$6,$7,$8,$9,$10)
      ON CONFLICT (id) DO NOTHING
    `, [
      reserveId,
      cityId,
      `${patrol.label} Reserve`,
      patrol.battery,
      patrol.station_id || station.id,
      patrol.id,
      patrol.position_longitude,
      patrol.position_latitude,
      `${patrol.route_name} coverage`,
      JSON.stringify(patrol.route || [])
    ]);
  }
}

/** Keep a pool of invisible spare drones parked at every station.  They are
 *  returned by readConfig like any other drone (role 'Spare') so the frontend
 *  can dispatch them as backups whenever the designated reserve for a corridor
 *  is busy, but the UI hides them while standing by. */
async function ensureSparePool(client, cityId = 'patiala') {
  const stationRows = await client.query('SELECT id, name, longitude, latitude FROM safety_command.stations WHERE city_id = $1 ORDER BY id', [cityId]);
  const existing = new Set((await client.query("SELECT id FROM safety_command.drones WHERE city_id = $1 AND role = 'Spare'", [cityId])).rows.map((row) => row.id));
  for (const station of stationRows.rows) {
    for (let n = 1; n <= SPARES_PER_STATION; n += 1) {
      const id = `SPR-${station.id}-${n}`;
      if (existing.has(id)) continue;
      await client.query(`
        INSERT INTO safety_command.drones (
          id, city_id, label, status, battery, response, station_id, role, coverage_for_drone_id,
          position_longitude, position_latitude, route_name, route
        )
        VALUES ($1,$2,$3,'Standby',$4,'standby',$5,'Spare',NULL,$6,$7,$8,'[]'::jsonb)
        ON CONFLICT (id) DO NOTHING
      `, [
        id,
        cityId,
        `${station.name} spare`,
        86 + (n % 3) * 3,
        station.id,
        station.longitude,
        station.latitude,
        `${station.name} spare pool`
      ]);
    }
  }
}

async function seedIfEmpty(client) {
  const result = await client.query('SELECT 1 FROM safety_command.city_profiles LIMIT 1');
  if (!result.rowCount) await saveConfig(client, DEFAULT_CONFIG);
}

/** Demo incident reports seeded into Neon so the incident log panel is never
 *  empty.  Matches the demo data the panel used to ship with; media paths are
 *  local (public/media/incidents/...) and fall back to placeholders when the
 *  files are absent (e.g. on Vercel). */
const DEMO_INCIDENTS = [
  {
    id: 'INC-2408', title: 'Street harassment reported', category: 'Harassment', severity: 'Critical', status: 'Dispatched',
    longitude: -122.4098, latitude: 37.8087, street: 'North Beach / Pier 39', landmark: "Near Fisherman's Wharf",
    reporterId: 'USR-A4F2K', responderNotes: 'Unit S-14 dispatched. Caller guided to well-lit cafe pending arrival.',
    mediaType: 'screenshot', mediaUrl: '/media/incidents/INC-2408/snapshot-001.jpg', mediaPoster: null,
    occurredAt: '2026-08-22T10:42:00Z'
  },
  {
    id: 'INC-2407', title: 'Followed home from transit station', category: 'Stalking', severity: 'High', status: 'Open',
    longitude: -122.4074, latitude: 37.7879, street: 'Union Square / Stockton St', landmark: 'Powell Station exit',
    reporterId: 'USR-B8C3D', responderNotes: 'Helpline volunteer on call, guiding user to nearest safe zone.',
    mediaType: null, mediaUrl: null, mediaPoster: null,
    occurredAt: '2026-08-22T10:28:00Z'
  },
  {
    id: 'INC-2406', title: 'Assault near park entrance', category: 'Assault', severity: 'Critical', status: 'Dispatched',
    longitude: -122.4177, latitude: 37.7796, street: 'Civic Center / Grove St', landmark: 'Civic Center Plaza',
    reporterId: 'USR-C2E9F', responderNotes: 'EMS + patrol dispatched. Scene secured, victim receiving aid.',
    mediaType: 'recording', mediaUrl: '/media/incidents/INC-2406/recording-001.mp4', mediaPoster: '/media/incidents/INC-2406/poster.jpg',
    occurredAt: '2026-08-22T09:56:00Z'
  },
  {
    id: 'INC-2405', title: 'Poor lighting on walking route', category: 'Poor Lighting', severity: 'Medium', status: 'Resolved',
    longitude: -122.3937, latitude: 37.7955, street: 'Embarcadero / Ferry Building', landmark: 'Ferry Plaza',
    reporterId: 'USR-D7A1B', responderNotes: 'City maintenance notified, streetlight repaired within 2 hrs.',
    mediaType: 'screenshot', mediaUrl: '/media/incidents/INC-2405/snapshot-001.jpg', mediaPoster: null,
    occurredAt: '2026-08-22T09:41:00Z'
  },
  {
    id: 'INC-2404', title: 'Unsafe taxi — driver taking detour', category: 'Unsafe Transport', severity: 'High', status: 'Open',
    longitude: -122.4197, latitude: 37.7651, street: 'Mission District / 16th St', landmark: '16th & Mission BART',
    reporterId: 'USR-E5F4C', responderNotes: 'Live tracking shared with helpline. Driver rerouting confirmed via GPS.',
    mediaType: null, mediaUrl: null, mediaPoster: null,
    occurredAt: '2026-08-22T09:18:00Z'
  },
  {
    id: 'INC-2403', title: 'Stalking pattern over 3 days', category: 'Stalking', severity: 'Low', status: 'Open',
    longitude: -122.3878, latitude: 37.7582, street: 'Dogpatch / 3rd Street', landmark: 'Minnesota St',
    reporterId: 'USR-F9D2A', responderNotes: 'Pattern report logged, flagged for patrol attention in corridor.',
    mediaType: 'recording', mediaUrl: '/media/incidents/INC-2403/recording-001.mp4', mediaPoster: '/media/incidents/INC-2403/poster.jpg',
    occurredAt: '2026-08-22T08:56:00Z'
  }
];

async function seedIncidentsIfEmpty(client) {
  const result = await client.query('SELECT 1 FROM safety_command.incident_reports LIMIT 1');
  if (result.rowCount) return;
  for (const incident of DEMO_INCIDENTS) {
    await client.query(`
      INSERT INTO safety_command.incident_reports (
        id, city_id, title, category, severity, status, longitude, latitude, street, landmark,
        reporter_id, responder_notes, media_type, media_url, media_poster, occurred_at
      )
      VALUES ($1, 'patiala', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      ON CONFLICT (id) DO NOTHING
    `, [
      incident.id,
      incident.title,
      incident.category,
      incident.severity,
      incident.status,
      incident.longitude,
      incident.latitude,
      incident.street,
      incident.landmark,
      incident.reporterId,
      incident.responderNotes,
      incident.mediaType,
      incident.mediaUrl,
      incident.mediaPoster,
      incident.occurredAt
    ]);
  }
}

async function saveConfig(client, rawConfig) {
  const config = normalizeConfig(rawConfig);
  await client.query('BEGIN');
  try {
    await ensureSchema(client);
    await client.query(`
      INSERT INTO safety_command.city_profiles (id, name, country, center_longitude, center_latitude, zoom, grid_resolution_m, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, now())
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, country = EXCLUDED.country,
        center_longitude = EXCLUDED.center_longitude, center_latitude = EXCLUDED.center_latitude,
        zoom = EXCLUDED.zoom, grid_resolution_m = EXCLUDED.grid_resolution_m, updated_at = now()
    `, [config.city.id, config.city.name, config.city.country, config.city.center[0], config.city.center[1], config.city.zoom, config.planner.gridResolutionM]);
    // Replace this city's rows (handles removals), then also clear any rows
    // from other cities that share the global id space - the tables use bare
    // `id` primary keys, so orphaned leftovers from a previous profile of
    // THIS city would otherwise make the inserts below fail with a
    // duplicate-key error.  The id-based deletes are scoped to the city so
    // re-saving one city can never delete another city's rows that happen to
    // share an id (ids are globally unique, so collisions are impossible when
    // every city prefixes its entity ids with its own slug).
    await client.query('DELETE FROM safety_command.stations WHERE city_id = $1', [config.city.id]);
    await client.query('DELETE FROM safety_command.stations WHERE id = ANY($1) AND city_id = $2', [config.stations.map((station) => station.id), config.city.id]);
    await client.query('DELETE FROM safety_command.drones WHERE city_id = $1', [config.city.id]);
    await client.query('DELETE FROM safety_command.drones WHERE id = ANY($1) AND city_id = $2', [config.drones.map((drone) => drone.id), config.city.id]);
    await client.query('DELETE FROM safety_command.patrol_points WHERE city_id = $1', [config.city.id]);
    await client.query('DELETE FROM safety_command.patrol_points WHERE id = ANY($1) AND city_id = $2', [config.patrolPoints.map((point) => point.id), config.city.id]);
    await client.query('DELETE FROM safety_command.danger_zones WHERE city_id = $1', [config.city.id]);
    await client.query('DELETE FROM safety_command.danger_zones WHERE id = ANY($1) AND city_id = $2', [config.dangerZones.map((zone) => zone.id), config.city.id]);
    for (const station of config.stations) await client.query(
      'INSERT INTO safety_command.stations (id, city_id, name, longitude, latitude, drone_id, reserve_drone_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [station.id, config.city.id, station.name, station.coordinate[0], station.coordinate[1], station.droneId, station.reserveDroneId]
    );
    for (const drone of config.drones) await client.query(
      'INSERT INTO safety_command.drones (id, city_id, label, status, battery, response, station_id, role, coverage_for_drone_id, position_longitude, position_latitude, route_name, route) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
      [drone.id, config.city.id, drone.label, drone.status, drone.battery, drone.response, drone.stationId, drone.role, drone.coverageForDroneId, drone.position[0], drone.position[1], drone.routeName, JSON.stringify(drone.route)]
    );
    for (const point of config.patrolPoints) await client.query(
      'INSERT INTO safety_command.patrol_points (id, city_id, name, longitude, latitude, sequence) VALUES ($1,$2,$3,$4,$5,$6)',
      [point.id, config.city.id, point.name, point.coordinate[0], point.coordinate[1], point.sequence]
    );
    for (const zone of config.dangerZones) await client.query(
      'INSERT INTO safety_command.danger_zones (id, city_id, name, category, severity, longitude, latitude, radius_m, ring) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [zone.id, config.city.id, zone.name, zone.category, zone.severity, zone.coordinate[0], zone.coordinate[1], zone.radiusM, zone.ring ? JSON.stringify(zone.ring) : null]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
  return config;
}

async function readConfig(client, cityId = 'mangalore') {
  await ensureSchema(client);
  await seedIfEmpty(client);
  await ensureReserveFleet(client, cityId);
  await ensureSparePool(client, cityId);
  const cityResult = await client.query('SELECT id, name, country, center_longitude, center_latitude, zoom, grid_resolution_m FROM safety_command.city_profiles WHERE id = $1', [cityId]);
  if (!cityResult.rows[0]) return null;
  const city = cityResult.rows[0];
  const stations = await client.query('SELECT id, name, longitude, latitude, drone_id, reserve_drone_id FROM safety_command.stations WHERE city_id = $1 ORDER BY id', [cityId]);
  const drones = await client.query('SELECT id, label, status, battery, response, station_id, role, coverage_for_drone_id, position_longitude, position_latitude, route_name, route FROM safety_command.drones WHERE city_id = $1 ORDER BY id', [cityId]);
  const patrolPoints = await client.query('SELECT id, name, longitude, latitude, sequence FROM safety_command.patrol_points WHERE city_id = $1 ORDER BY sequence, id', [cityId]);
  const dangerZones = await client.query('SELECT id, name, category, severity, longitude, latitude, radius_m, ring FROM safety_command.danger_zones WHERE city_id = $1 ORDER BY id', [cityId]);
  return {
    city: { id: city.id, name: city.name, country: city.country, center: [Number(city.center_longitude), Number(city.center_latitude)], zoom: Number(city.zoom) },
    stations: stations.rows.map((row) => ({ id: row.id, name: row.name, coordinate: [Number(row.longitude), Number(row.latitude)], droneId: row.drone_id, reserveDroneId: row.reserve_drone_id })),
    drones: drones.rows.map((row) => ({ id: row.id, label: row.label, status: row.status, battery: row.battery, response: row.response, stationId: row.station_id, role: row.role, coverageForDroneId: row.coverage_for_drone_id, position: [Number(row.position_longitude), Number(row.position_latitude)], routeName: row.route_name, route: row.route || [] })),
    patrolPoints: patrolPoints.rows.map((row) => ({ id: row.id, name: row.name, coordinate: [Number(row.longitude), Number(row.latitude)], sequence: row.sequence })),
    dangerZones: dangerZones.rows.map((row) => ({ id: row.id, name: row.name, category: row.category, severity: Number(row.severity), coordinate: [Number(row.longitude), Number(row.latitude)], radiusM: row.radius_m, ring: Array.isArray(row.ring) ? row.ring : (row.ring ? JSON.parse(row.ring) : null) })),
    planner: { gridResolutionM: city.grid_resolution_m === null ? null : Number(city.grid_resolution_m) }
  };
}

export function registerSafetyRoutes(app, getPool) {
  app.get('/api/safety/config', async (req, res, next) => {
    const client = await getPool().connect();
    try {
      const config = await readConfig(client, String(req.query.cityId || 'patiala'));
      res.json(config);
    } catch (error) { next(error); }
    finally { client.release(); }
  });

  app.put('/api/safety/config', async (req, res, next) => {
    const client = await getPool().connect();
    try {
      await saveConfig(client, req.body);
      res.json(await readConfig(client, String(req.body?.city?.id || 'patiala')));
    } catch (error) { next(error); }
    finally { client.release(); }
  });

  // Multi-city management: list every city profile (with entity counts) and
  // delete one.  stations/drones/patrol_points/danger_zones cascade off the
  // city profile via FK; sos_log + incident_reports have no FK so they are
  // cleared explicitly in the same transaction.
  app.get('/api/safety/cities', async (req, res, next) => {
    const client = await getPool().connect();
    try {
      await ensureSchema(client);
      await seedIfEmpty(client);
      const { rows } = await client.query(`
        SELECT
          c.id, c.name, c.country,
          c.center_longitude, c.center_latitude, c.zoom,
          (SELECT count(*) FROM safety_command.stations s WHERE s.city_id = c.id)::integer AS stations,
          (SELECT count(*) FROM safety_command.drones d WHERE d.city_id = c.id)::integer AS drones,
          (SELECT count(*) FROM safety_command.danger_zones z WHERE z.city_id = c.id)::integer AS danger_zones
        FROM safety_command.city_profiles c
        ORDER BY c.name, c.id
      `);
      res.json({
        cities: rows.map((row) => ({
          id: row.id,
          name: row.name,
          country: row.country,
          center: [Number(row.center_longitude), Number(row.center_latitude)],
          zoom: Number(row.zoom),
          stations: row.stations,
          drones: row.drones,
          dangerZones: row.danger_zones
        }))
      });
    } catch (error) { next(error); }
    finally { client.release(); }
  });

  app.delete('/api/safety/cities/:id', async (req, res, next) => {
    const client = await getPool().connect();
    try {
      await ensureSchema(client);
      const cityId = String(req.params.id || '').trim();
      const found = await client.query('SELECT 1 FROM safety_command.city_profiles WHERE id = $1', [cityId]);
      if (!found.rowCount) {
        res.status(404).json({ error: 'City not found' });
        return;
      }
      await client.query('BEGIN');
      await client.query('DELETE FROM safety_command.sos_log WHERE city_id = $1', [cityId]);
      await client.query('DELETE FROM safety_command.incident_reports WHERE city_id = $1', [cityId]);
      await client.query('DELETE FROM safety_command.city_profiles WHERE id = $1', [cityId]);
      await client.query('COMMIT');
      res.json({ ok: true, id: cityId });
    } catch (error) {
      await client.query('ROLLBACK');
      next(error);
    }
    finally { client.release(); }
  });

  app.get('/api/safety/health', async (_req, res, next) => {
    const client = await getPool().connect();
    try {
      await ensureSchema(client);
      await seedIfEmpty(client);
      const { rows } = await client.query(`SELECT current_schema() AS schema, (SELECT count(*) FROM safety_command.drones) AS drones, (SELECT count(*) FROM safety_command.stations) AS stations, (SELECT count(*) FROM safety_command.patrol_points) AS patrol_points, (SELECT count(*) FROM safety_command.danger_zones) AS danger_zones`);
      res.json(rows[0]);
    } catch (error) { next(error); }
    finally { client.release(); }
  });

  // SOS call log: one row per emergency call, idempotently upserted by call id
  // as the call moves through Received -> Dispatched -> Monitoring -> Resolved.
  app.get('/api/safety/sos-log', async (req, res, next) => {
    const client = await getPool().connect();
    try {
      await ensureSchema(client);
      const cityId = String(req.query.cityId || 'patiala');
      const requestedLimit = Number(req.query.limit);
      const limit = Number.isFinite(requestedLimit) ? Math.min(500, Math.max(1, Math.round(requestedLimit))) : 50;
      const { rows } = await client.query(`
        SELECT id, city_id, caller_label, priority, longitude, latitude, drone_id,
               status, started_at, resolved_at, warning, route_km, updated_at
        FROM safety_command.sos_log
        WHERE city_id = $1
        ORDER BY started_at DESC, id DESC
        LIMIT $2
      `, [cityId, limit]);
      res.json({
        entries: rows.map((row) => ({
          id: row.id,
          callerLabel: row.caller_label,
          priority: row.priority,
          coordinate: [Number(row.longitude), Number(row.latitude)],
          droneId: row.drone_id,
          status: row.status,
          startedAt: row.started_at,
          resolvedAt: row.resolved_at,
          warning: row.warning,
          routeKm: row.route_km === null ? null : Number(row.route_km),
          updatedAt: row.updated_at
        }))
      });
    } catch (error) { next(error); }
    finally { client.release(); }
  });

  app.post('/api/safety/sos-log', async (req, res, next) => {
    const client = await getPool().connect();
    try {
      await ensureSchema(client);
      const body = req.body || {};
      const id = String(body.id || '').trim();
      if (!id) {
        res.status(400).json({ detail: 'id is required' });
        return;
      }
      const coordinate = Array.isArray(body.coordinate) && body.coordinate.length === 2
        ? [Number(body.coordinate[0]), Number(body.coordinate[1])]
        : null;
      if (!coordinate || !Number.isFinite(coordinate[0]) || !Number.isFinite(coordinate[1])) {
        res.status(400).json({ detail: 'coordinate [lng, lat] is required' });
        return;
      }
      const status = String(body.status || 'Received').trim().slice(0, 40) || 'Received';
      await client.query(`
        INSERT INTO safety_command.sos_log (
          id, city_id, caller_label, priority, longitude, latitude, drone_id,
          status, started_at, resolved_at, warning, route_km, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
        ON CONFLICT (id) DO UPDATE SET
          city_id = EXCLUDED.city_id,
          caller_label = EXCLUDED.caller_label,
          priority = EXCLUDED.priority,
          longitude = EXCLUDED.longitude,
          latitude = EXCLUDED.latitude,
          drone_id = COALESCE(EXCLUDED.drone_id, safety_command.sos_log.drone_id),
          status = EXCLUDED.status,
          started_at = COALESCE(safety_command.sos_log.started_at, EXCLUDED.started_at),
          resolved_at = COALESCE(EXCLUDED.resolved_at, safety_command.sos_log.resolved_at),
          warning = COALESCE(EXCLUDED.warning, safety_command.sos_log.warning),
          route_km = COALESCE(EXCLUDED.route_km, safety_command.sos_log.route_km),
          updated_at = now()
      `, [
        id,
        String(body.cityId || 'patiala'),
        String(body.callerLabel || id).trim().slice(0, 150),
        String(body.priority || 'Critical').trim().slice(0, 20),
        coordinate[0],
        coordinate[1],
        body.droneId ? String(body.droneId).trim().slice(0, 40) : null,
        status,
        body.startedAt ? new Date(body.startedAt) : new Date(),
        body.resolvedAt ? new Date(body.resolvedAt) : null,
        body.warning ? String(body.warning).slice(0, 500) : null,
        Number.isFinite(Number(body.routeKm)) ? Number(body.routeKm) : null
      ]);
      res.json({ ok: true, id });
    } catch (error) { next(error); }
    finally { client.release(); }
  });

  // Rich incident reports backing the right-side incident log panel.  One row
  // per incident, idempotently upserted by id - simulated SOS calls write here
  // with the same id they use for sos_log, so the panel and the call log stay
  // in sync as a call moves through its lifecycle.
  app.get('/api/safety/incidents', async (req, res, next) => {
    const client = await getPool().connect();
    try {
      await ensureSchema(client);
      await seedIncidentsIfEmpty(client);
      const cityId = String(req.query.cityId || 'patiala');
      const requestedLimit = Number(req.query.limit);
      const limit = Number.isFinite(requestedLimit) ? Math.min(500, Math.max(1, Math.round(requestedLimit))) : 50;
      const { rows } = await client.query(`
        SELECT id, city_id, title, category, severity, status, longitude, latitude, street, landmark,
               reporter_id, responder_notes, media_type, media_url, media_poster, occurred_at, updated_at
        FROM safety_command.incident_reports
        WHERE city_id = $1
        ORDER BY occurred_at DESC, id DESC
        LIMIT $2
      `, [cityId, limit]);
      res.json({
        entries: rows.map((row) => ({
          id: row.id,
          title: row.title,
          category: row.category,
          severity: row.severity,
          status: row.status,
          coordinate: [Number(row.longitude), Number(row.latitude)],
          street: row.street,
          landmark: row.landmark,
          reporterId: row.reporter_id,
          responderNotes: row.responder_notes,
          media: row.media_type
            ? { type: row.media_type, src: row.media_url, poster: row.media_poster || undefined }
            : null,
          occurredAt: row.occurred_at,
          updatedAt: row.updated_at
        }))
      });
    } catch (error) { next(error); }
    finally { client.release(); }
  });

  app.post('/api/safety/incidents', async (req, res, next) => {
    const client = await getPool().connect();
    try {
      await ensureSchema(client);
      const body = req.body || {};
      const id = String(body.id || '').trim();
      if (!id) {
        res.status(400).json({ detail: 'id is required' });
        return;
      }
      const coordinate = Array.isArray(body.coordinate) && body.coordinate.length === 2
        ? [Number(body.coordinate[0]), Number(body.coordinate[1])]
        : null;
      if (!coordinate || !Number.isFinite(coordinate[0]) || !Number.isFinite(coordinate[1])) {
        res.status(400).json({ detail: 'coordinate [lng, lat] is required' });
        return;
      }
      const allowedSeverity = new Set(['Low', 'Medium', 'High', 'Critical']);
      const allowedStatus = new Set(['Open', 'Dispatched', 'Resolved']);
      const media = body.media && typeof body.media === 'object' ? body.media : null;
      const mediaType = media && (media.type === 'screenshot' || media.type === 'recording') ? media.type : null;
      await client.query(`
        INSERT INTO safety_command.incident_reports (
          id, city_id, title, category, severity, status, longitude, latitude, street, landmark,
          reporter_id, responder_notes, media_type, media_url, media_poster, occurred_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        ON CONFLICT (id) DO UPDATE SET
          city_id = EXCLUDED.city_id,
          title = COALESCE(EXCLUDED.title, safety_command.incident_reports.title),
          category = COALESCE(EXCLUDED.category, safety_command.incident_reports.category),
          severity = COALESCE(EXCLUDED.severity, safety_command.incident_reports.severity),
          status = EXCLUDED.status,
          longitude = EXCLUDED.longitude,
          latitude = EXCLUDED.latitude,
          street = COALESCE(EXCLUDED.street, safety_command.incident_reports.street),
          landmark = COALESCE(EXCLUDED.landmark, safety_command.incident_reports.landmark),
          reporter_id = COALESCE(EXCLUDED.reporter_id, safety_command.incident_reports.reporter_id),
          responder_notes = COALESCE(EXCLUDED.responder_notes, safety_command.incident_reports.responder_notes),
          media_type = COALESCE(EXCLUDED.media_type, safety_command.incident_reports.media_type),
          media_url = COALESCE(EXCLUDED.media_url, safety_command.incident_reports.media_url),
          media_poster = COALESCE(EXCLUDED.media_poster, safety_command.incident_reports.media_poster),
          occurred_at = COALESCE(EXCLUDED.occurred_at, safety_command.incident_reports.occurred_at),
          updated_at = now()
      `, [
        id,
        String(body.cityId || 'patiala'),
        String(body.title || id).trim().slice(0, 200),
        String(body.category || 'Other').trim().slice(0, 80),
        allowedSeverity.has(String(body.severity)) ? String(body.severity) : 'Medium',
        allowedStatus.has(String(body.status)) ? String(body.status) : 'Open',
        coordinate[0],
        coordinate[1],
        body.street ? String(body.street).trim().slice(0, 200) : null,
        body.landmark ? String(body.landmark).trim().slice(0, 200) : null,
        body.reporterId ? String(body.reporterId).trim().slice(0, 150) : null,
        body.responderNotes ? String(body.responderNotes).slice(0, 500) : null,
        mediaType,
        media && media.src ? String(media.src).slice(0, 500) : null,
        media && media.poster ? String(media.poster).slice(0, 500) : null,
        body.occurredAt ? new Date(body.occurredAt) : new Date()
      ]);
      res.json({ ok: true, id });
    } catch (error) { next(error); }
    finally { client.release(); }
  });
}
