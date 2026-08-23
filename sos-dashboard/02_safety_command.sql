-- Isolated configuration schema for the women-safety command dashboard.
-- This intentionally does not alter the existing mangalore logistics/routing tables.

BEGIN;

CREATE SCHEMA IF NOT EXISTS safety_command;

CREATE TABLE IF NOT EXISTS safety_command.city_profiles (
  id text PRIMARY KEY,
  name text NOT NULL,
  country text NOT NULL DEFAULT 'India',
  center_longitude numeric(10,7) NOT NULL,
  center_latitude numeric(10,7) NOT NULL,
  zoom numeric(5,2) NOT NULL DEFAULT 12.2,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS safety_command.stations (
  id text PRIMARY KEY,
  city_id text NOT NULL REFERENCES safety_command.city_profiles(id) ON DELETE CASCADE,
  name text NOT NULL,
  longitude numeric(10,7) NOT NULL,
  latitude numeric(10,7) NOT NULL,
  drone_id text,
  reserve_drone_id text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS safety_command.drones (
  id text PRIMARY KEY,
  city_id text NOT NULL REFERENCES safety_command.city_profiles(id) ON DELETE CASCADE,
  label text NOT NULL,
  status text NOT NULL DEFAULT 'Patrol',
  battery integer NOT NULL DEFAULT 100 CHECK (battery BETWEEN 0 AND 100),
  response text NOT NULL DEFAULT 'standby',
  station_id text,
  role text NOT NULL DEFAULT 'Patrol',
  coverage_for_drone_id text,
  position_longitude numeric(10,7) NOT NULL,
  position_latitude numeric(10,7) NOT NULL,
  route_name text NOT NULL,
  route jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS safety_command.patrol_points (
  id text PRIMARY KEY,
  city_id text NOT NULL REFERENCES safety_command.city_profiles(id) ON DELETE CASCADE,
  name text NOT NULL,
  longitude numeric(10,7) NOT NULL,
  latitude numeric(10,7) NOT NULL,
  sequence integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS safety_command.danger_zones (
  id text PRIMARY KEY,
  city_id text NOT NULL REFERENCES safety_command.city_profiles(id) ON DELETE CASCADE,
  name text NOT NULL,
  category text NOT NULL DEFAULT 'General',
  severity numeric(4,3) NOT NULL DEFAULT 0.5 CHECK (severity BETWEEN 0 AND 1),
  longitude numeric(10,7) NOT NULL,
  latitude numeric(10,7) NOT NULL,
  radius_m integer NOT NULL DEFAULT 150 CHECK (radius_m > 0),
  ring jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_safety_stations_city ON safety_command.stations(city_id);
CREATE INDEX IF NOT EXISTS idx_safety_drones_city ON safety_command.drones(city_id);
CREATE INDEX IF NOT EXISTS idx_safety_patrol_points_city ON safety_command.patrol_points(city_id, sequence);
CREATE INDEX IF NOT EXISTS idx_safety_danger_zones_city ON safety_command.danger_zones(city_id);
CREATE INDEX IF NOT EXISTS idx_safety_sos_log_city ON safety_command.sos_log(city_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_safety_incident_reports_city ON safety_command.incident_reports(city_id, occurred_at DESC);

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

ALTER TABLE safety_command.stations ADD COLUMN IF NOT EXISTS reserve_drone_id text;
ALTER TABLE safety_command.drones ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'Patrol';  ALTER TABLE safety_command.drones ADD COLUMN IF NOT EXISTS coverage_for_drone_id text;
  UPDATE safety_command.drones SET role = 'Patrol' WHERE role IS NULL;

  INSERT INTO safety_command.city_profiles (id, name, country, center_longitude, center_latitude, zoom)
VALUES ('mangalore', 'Mangalore', 'India', 74.856, 12.914, 12.2)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  country = EXCLUDED.country,
  center_longitude = EXCLUDED.center_longitude,
  center_latitude = EXCLUDED.center_latitude,
  zoom = EXCLUDED.zoom,
  updated_at = now();

INSERT INTO safety_command.stations (id, city_id, name, longitude, latitude, drone_id, reserve_drone_id)
VALUES
  ('DST-01', 'mangalore', 'Ladyhill Standby Post', 74.845, 12.936, 'DRN-01', 'RSV-01'),
  ('DST-02', 'mangalore', 'Pumpwell Response Post', 74.851, 12.884, 'DRN-02', 'RSV-02'),
  ('DST-03', 'mangalore', 'Panambur Inland Post', 74.835, 12.917, 'DRN-03', 'RSV-03'),
  ('DST-04', 'mangalore', 'Bejai Campus Post', 74.880, 12.923, 'DRN-04', 'RSV-04'),
  ('DST-05', 'mangalore', 'Ullal Shore Watch Post', 74.860, 12.808, 'DRN-05', 'RSV-05')
ON CONFLICT (id) DO UPDATE SET
  city_id = EXCLUDED.city_id,
  name = EXCLUDED.name,
  longitude = EXCLUDED.longitude,
  latitude = EXCLUDED.latitude,
  drone_id = EXCLUDED.drone_id,
  reserve_drone_id = EXCLUDED.reserve_drone_id,
  updated_at = now();

INSERT INTO safety_command.drones (id, city_id, label, status, battery, response, station_id, role, coverage_for_drone_id, position_longitude, position_latitude, route_name, route)
VALUES
  ('DRN-01', 'mangalore', 'Falcon North', 'Patrol', 92, '1.8 min', 'DST-01', 'Patrol', NULL, 74.845, 12.936, 'Ladyhill - Lalbagh loop', '[[74.839,12.943],[74.851,12.938],[74.861,12.929],[74.855,12.921],[74.843,12.926],[74.839,12.943]]'::jsonb),
  ('DRN-02', 'mangalore', 'Netravati Watch', 'Patrol', 78, '2.4 min', 'DST-02', 'Patrol', NULL, 74.851, 12.884, 'Pumpwell - Kankanady corridor', '[[74.846,12.895],[74.861,12.891],[74.866,12.881],[74.853,12.873],[74.842,12.882],[74.846,12.895]]'::jsonb),
  ('DRN-03', 'mangalore', 'Coastal Shield', 'Patrol', 85, '3.1 min', 'DST-03', 'Patrol', NULL, 74.835, 12.917, 'Panambur inland watch', '[[74.828,12.935],[74.839,12.927],[74.846,12.909],[74.836,12.893],[74.826,12.908],[74.828,12.935]]'::jsonb),
  ('DRN-04', 'mangalore', 'Campus Escort', 'Patrol', 64, '4.0 min', 'DST-04', 'Patrol', NULL, 74.880, 12.923, 'University - Bejai loop', '[[74.874,12.934],[74.891,12.929],[74.895,12.916],[74.880,12.907],[74.868,12.917],[74.874,12.934]]'::jsonb),
  ('DRN-05', 'mangalore', 'Ullal Shore Watch', 'Patrol', 88, '2.1 min', 'DST-05', 'Patrol', NULL, 74.860, 12.808, 'Ullal - Someshwara loop', '[[74.858,12.815],[74.868,12.812],[74.872,12.798],[74.861,12.795],[74.855,12.805],[74.858,12.815]]'::jsonb),
  ('RSV-01', 'mangalore', 'Falcon North Reserve', 'Standby', 100, 'standby', 'DST-01', 'Reserve', 'DRN-01', 74.845, 12.936, 'Ladyhill - Lalbagh loop coverage', '[[74.839,12.943],[74.851,12.938],[74.861,12.929],[74.855,12.921],[74.843,12.926],[74.839,12.943]]'::jsonb),
  ('RSV-02', 'mangalore', 'Netravati Watch Reserve', 'Standby', 100, 'standby', 'DST-02', 'Reserve', 'DRN-02', 74.851, 12.884, 'Pumpwell - Kankanady corridor coverage', '[[74.846,12.895],[74.861,12.891],[74.866,12.881],[74.853,12.873],[74.842,12.882],[74.846,12.895]]'::jsonb),
  ('RSV-03', 'mangalore', 'Coastal Shield Reserve', 'Standby', 100, 'standby', 'DST-03', 'Reserve', 'DRN-03', 74.835, 12.917, 'Panambur inland watch coverage', '[[74.828,12.935],[74.839,12.927],[74.846,12.909],[74.836,12.893],[74.826,12.908],[74.828,12.935]]'::jsonb),
  ('RSV-04', 'mangalore', 'Campus Escort Reserve', 'Standby', 100, 'standby', 'DST-04', 'Reserve', 'DRN-04', 74.880, 12.923, 'University - Bejai loop coverage', '[[74.874,12.934],[74.891,12.929],[74.895,12.916],[74.880,12.907],[74.868,12.917],[74.874,12.934]]'::jsonb),
  ('RSV-05', 'mangalore', 'Ullal Shore Watch Reserve', 'Standby', 100, 'standby', 'DST-05', 'Reserve', 'DRN-05', 74.860, 12.808, 'Ullal - Someshwara loop coverage', '[[74.858,12.815],[74.868,12.812],[74.872,12.798],[74.861,12.795],[74.855,12.805],[74.858,12.815]]'::jsonb)
ON CONFLICT (id) DO UPDATE SET
  city_id = EXCLUDED.city_id,
  label = EXCLUDED.label,
  status = EXCLUDED.status,
  battery = EXCLUDED.battery,
  response = EXCLUDED.response,
  station_id = EXCLUDED.station_id,
  role = EXCLUDED.role,
  coverage_for_drone_id = EXCLUDED.coverage_for_drone_id,
  position_longitude = EXCLUDED.position_longitude,
  position_latitude = EXCLUDED.position_latitude,
  route_name = EXCLUDED.route_name,
  route = EXCLUDED.route,
  updated_at = now();

INSERT INTO safety_command.danger_zones (id, city_id, name, category, severity, longitude, latitude, radius_m)
VALUES
  ('HS-101', 'mangalore', 'Late-night transit cluster', 'Transit', 0.960, 74.855, 12.921, 150),
  ('HS-102', 'mangalore', 'Unlit walkway reports', 'Walkway', 0.720, 74.843, 12.926, 150),
  ('HS-103', 'mangalore', 'Market crowd pressure', 'Market', 0.820, 74.860, 12.877, 150),
  ('HS-104', 'mangalore', 'Kodikal road watch zone', 'Road', 0.640, 74.826, 12.908, 150),
  ('HS-105', 'mangalore', 'Hostel return corridor', 'Campus', 0.770, 74.880, 12.907, 150),
  ('HS-106', 'mangalore', 'Bus stop incident history', 'Transit', 0.880, 74.846, 12.895, 150),
  ('HS-107', 'mangalore', 'Low visibility junction', 'Junction', 0.660, 74.891, 12.929, 150),
  ('HS-108', 'mangalore', 'Rail approach cluster', 'Transit', 0.700, 74.842, 12.882, 150),
  ('HS-109', 'mangalore', 'Ullal beach late reports', 'Beach', 0.850, 74.861, 12.795, 150)
ON CONFLICT (id) DO UPDATE SET
  city_id = EXCLUDED.city_id,
  name = EXCLUDED.name,
  category = EXCLUDED.category,
  severity = EXCLUDED.severity,
  longitude = EXCLUDED.longitude,
  latitude = EXCLUDED.latitude,
  radius_m = EXCLUDED.radius_m,
  updated_at = now();

COMMIT;
