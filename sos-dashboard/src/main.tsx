import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AnimatePresence, motion } from 'framer-motion';
import maplibregl, { GeoJSONSource, LngLatBounds, Map as MapLibreMap } from 'maplibre-gl';
import { gsap } from 'gsap';
import * as turf from '@turf/turf';
import {
  Activity,
  AlertTriangle,
  Bot,
  Cpu,
  History,
  Layers3,
  LocateFixed,
  MapPin,
  MapPinned,
  Maximize2,
  PanelLeftOpen,
  Plus,
  Radio,
  Route,
  Save,
  Search,
  Settings2,
  Shield,
  Siren,
  Timer,
  Trash2,
  UserRound,
  X,
  Zap
} from 'lucide-react';
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles.css';
import './incident-logs.css';

import { IncidentLogs } from './IncidentLogs';

import {
  configurePlanner,
  isPlannerConfigured,
  PlannerError,
  fetchHealth,
  fetchNoFlyZones,
  generateRoute,
  generateRouteStream,
  type NoFlyZoneInfo,
  type RouteResponse
} from './planner';
import { dispatchSitlMission, getSitlStatus, subscribeSitlTelemetry, type SitlPhase } from './sitl';
import { patialaConfig } from './patiala';
import './studio.css';

type FeatureCollection = GeoJSON.FeatureCollection<GeoJSON.Geometry, Record<string, unknown>>;
type PointFeature = GeoJSON.Feature<GeoJSON.Point, Record<string, unknown>>;
type Coordinate = [number, number];

type Drone = {
  id: string;
  label: string;
  stationId: string | null;
  status: 'Patrol' | 'Dispatching' | 'Monitoring' | 'Charging' | 'Standby';
  role?: 'Patrol' | 'Reserve' | 'Spare';
  coverageForDroneId?: string | null;
  battery: number;
  response: string;
  position: Coordinate;
  route: Coordinate[];
  routeName: string;
};

type Alert = {
  id: string;
  label: string;
  priority: 'Critical' | 'High' | 'Watch';
  status: string;
  coordinate: Coordinate;
  time: string;
  droneId?: string;
};

/** One row of the persistent SOS call log (mirrors safety_command.sos_log). */
type SosLogEntry = {
  id: string;
  callerLabel: string;
  priority: string;
  coordinate: Coordinate;
  droneId: string | null;
  status: string;
  startedAt: string | null;
  resolvedAt?: string | null;
  warning?: string | null;
  routeKm?: number | null;
  updatedAt?: string | null;
};

/** A live (in-flight) SOS response. Multiple responses can run concurrently -
 *  each owns its drones, tweens, timers, and route feature. */
type SosResponse = {
  id: string;
  alert: Alert;
  patrolDroneId: string | null;
  stationDroneId: string | null;
  coverageDroneId: string | null;
  tweens: gsap.core.Tween[];
  timers: number[];
  startedAt: number;
  /** Set when this response is flown by the real SITL copter; closes the
   *  telemetry stream (e.g. when the operator ends the SOS mid-mission). */
  sitlUnsubscribe?: () => void;
};

type SafeWalk = {
  origin: Coordinate | null;
  destination: Coordinate | null;
  eta: number;
  status: string;
  activeDroneId?: string;
};

type SafeWalkUser = {
  id: string;
  name: string;
  origin: Coordinate;
  destination: Coordinate;
  status: 'waiting' | 'pickup' | 'escorting' | 'arrived' | 'returning' | 'complete';
  progress: number;
  assignedDroneId?: string;
};

type TimelineEvent = {
  time: string;
  label: string;
  detail: string;
};

type NavView = 'dashboard' | 'sos' | 'safewalk' | 'about';
type StudioTab = 'city' | 'drones' | 'stations' | 'danger' | 'planner';

/** Summary of a saved city profile (GET /api/safety/cities) for the
 *  multi-city picker in Command Studio. */
type CitySummary = {
  id: string;
  name: string;
  country: string;
  center: Coordinate;
  zoom: number;
  stations: number;
  drones: number;
  dangerZones: number;
};

type SafetyConfig = {
  city: { id: string; name: string; country: string; center: Coordinate; zoom: number };
  stations: Array<{ id: string; name: string; coordinate: Coordinate; droneId?: string | null; reserveDroneId?: string | null }>;
  drones: Drone[];
  patrolPoints: Array<{ id: string; name: string; coordinate: Coordinate; sequence: number }>;
  dangerZones: Array<{ id: string; name: string; category: string; severity: number; coordinate: Coordinate; radiusM: number; ring?: Coordinate[] | null }>;
  planner: { gridResolutionM: number | null };
};

const emptyCollection: FeatureCollection = { type: 'FeatureCollection', features: [] };
const center: Coordinate = patialaConfig.center;

const sources = {
  patrolRoutes: 'patrolRoutes',
  activeRoute: 'activeRoute',
  safeRoute: 'safeRoute',
  safeUser: 'safeUser',
  droneStations: 'droneStations',
  sosTarget: 'sosTarget',
  hotspots: 'hotspots',
  safePoints: 'safePoints',
  riskHeatmap: 'riskHeatmap',
  noFlyZones: 'noFlyZones',
  zoneRings: 'zoneRings'
};

const lightOsmStyle: maplibregl.StyleSpecification = {
  version: 8,
  glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '&copy; OpenStreetMap contributors'
    }
  },
  layers: [
    {
      id: 'osm-base',
      type: 'raster',
      source: 'osm',
      paint: {
        'raster-opacity': 1,
        'raster-contrast': 0.02,
        'raster-saturation': 0.12
      }
    }
  ]
};

const initialDrones: Drone[] = patialaConfig.corridors.map((corridor, index) => {
  const seed = patialaConfig.drones[index];
  const station = patialaConfig.stations.find((station) => station.id === corridor.stationId);
  // The un-optimized loop first (station -> danger zones -> station); the
  // route planner replaces these with building-avoiding loops at startup.
  const loop = patrolZoneRing(corridor.dangerZones.map((zone) => zone.coordinate));
  return {
    id: seed.id,
    label: seed.label,
    stationId: station ? station.id : null,
    status: 'Patrol',
    battery: seed.battery,
    response: seed.response,
    position: station ? station.coordinate : patialaConfig.center,
    routeName: corridor.name,
    route: loop
  };
});

const droneStations: SafetyConfig['stations'] = patialaConfig.stations.map((station, index) => ({
  id: station.id,
  name: station.name,
  coordinate: station.coordinate,
  droneId: patialaConfig.corridors.find((corridor) => corridor.stationId === station.id)?.droneId || null,
  reserveDroneId: `RSV-${String(index + 1).padStart(2, '0')}`
}));

const reserveDrones: Drone[] = initialDrones.map((drone, index) => ({
  ...drone,
  id: `RSV-${String(index + 1).padStart(2, '0')}`,
  label: `${drone.label} Reserve`,
  status: 'Standby',
  role: 'Reserve',
  response: 'standby',
  coverageForDroneId: drone.id,
  routeName: `${drone.routeName} coverage`
}));

// Spare pool: a few extra drones parked at every station.  They are invisible
// on the dashboard while standing by, but dispatch falls back to them whenever
// a corridor's designated reserve is already busy - so the demo never runs out
// of drones.  The backend keeps the same pool in Neon (role 'Spare').
const SPARES_PER_STATION = 6;

const spareDrones: Drone[] = droneStations.flatMap((station) =>
  Array.from({ length: SPARES_PER_STATION }, (_, index) => ({
    id: `SPR-${station.id}-${index + 1}`,
    label: `${station.name} spare`,
    stationId: station.id,
    status: 'Standby' as const,
    role: 'Spare' as const,
    battery: 86 + (index % 3) * 3,
    response: 'standby',
    position: station.coordinate,
    route: [],
    routeName: `${station.name} spare pool`
  }))
);

const allInitialDrones = [...initialDrones, ...reserveDrones, ...spareDrones];

const hotspots: Array<{ id: string; label: string; coordinate: Coordinate; severity: number; category: string }> = patialaConfig.corridors.flatMap((corridor) =>
  corridor.dangerZones.map((zone) => ({
    id: zone.id,
    label: zone.label,
    coordinate: zone.coordinate,
    severity: zone.severity,
    category: zone.category
  }))
);

const defaultSafetyConfig: SafetyConfig = {
  city: { id: 'patiala', name: patialaConfig.name, country: 'India', center, zoom: patialaConfig.initialZoom },
  stations: droneStations,
  drones: allInitialDrones,
  patrolPoints: patialaConfig.patrolPoints,
  dangerZones: hotspots.map((hotspot) => ({ id: hotspot.id, name: hotspot.label, category: hotspot.category, severity: hotspot.severity, coordinate: hotspot.coordinate, radiusM: 170 })),
  // null = auto: the route planner starts on a fast 10 m grid and only
  // refines to 5 m / 2.5 m when no corridor exists at the coarse grid.  A
  // fixed number forces that grid for every route.
  planner: { gridResolutionM: null }
};

// Start with the city centre/zoom but no command-grid geometry, so the map
// never flashes the seed layout before the Neon profile arrives.  The config
// fetch (or its fallback timer) populates stations/drones/zones within ~2s.
const emptySafetyConfig: SafetyConfig = {
  city: defaultSafetyConfig.city,
  stations: [],
  drones: [],
  patrolPoints: [],
  dangerZones: [],
  planner: defaultSafetyConfig.planner
};

const heatPoints = patialaConfig.heatPoints;

const seededAlerts: Alert[] = patialaConfig.seededAlerts;

const seededSafeWalkUsers: SafeWalkUser[] = patialaConfig.safeWalkUsers.map((user) => ({ ...user, status: 'waiting' as const, progress: 0 }));

const demoBounds = patialaConfig.bounds;

const DETAIL_LAYER_MIN_ZOOM = 11.6;
const ROUTE_LAYER_OPACITIES: Record<string, number> = {
  'active-route-glow': 0.16,
  'active-route': 0.9,
  'safe-route-glow': 0.15,
  'safe-route': 0.86
};

const ROUTE_FADE_DURATION = 0.8;

// localStorage key for the once-computed optimized patrol loops.  Bump the
// scenario `version` in patiala.ts (or hit "Regenerate Patrol Routes") to
// force a fresh optimization when danger zones change.
const PATROL_CACHE_KEY = 'patiala-patrol-routes-v3';

/** Reserve + spare drones form the station pool: they never patrol on their
 *  own, are hidden from the dashboard while standing by, and exist only to
 *  cover patrols or launch for extra missions. */
function isPoolDrone(drone: Drone) {
  return drone.role === 'Reserve' || drone.role === 'Spare';
}

/** How long the SITL copter loiters over the SOS target before returning. */
const SITL_LOITER_SECONDS = 30;

/** Map a live SITL phase onto the dashboard's Drone status field. */
function sitlStatusForPhase(phase: SitlPhase): Drone['status'] {
  if (phase === 'EN_ROUTE') return 'Dispatching';
  if (phase === 'HOVERING' || phase === 'RTL') return 'Monitoring';
  return 'Patrol';
}

/** Map a live SITL phase onto the human label shown in the drone list. */
function sitlResponseForPhase(phase: SitlPhase): string {
  if (phase === 'EN_ROUTE') return 'SITL en route';
  if (phase === 'HOVERING') return 'SITL on scene';
  if (phase === 'RTL') return 'SITL returning';
  return 'SITL patrolling';
}

function patrolConfigSignature(nextDrones: Drone[]) {
  return JSON.stringify(nextDrones.map(({ id, status, role, position, route, routeName }) => ({ id, status, role, position, route, routeName })));
}

function ensureLandCoordinate([lng, lat]: Coordinate): Coordinate {
  // Patiala is inland - just clamp to the operating bounds (the Mangalore
  // coastal geofence no longer applies).
  return [clamp(lng, demoBounds.west, demoBounds.east), clamp(lat, demoBounds.south, demoBounds.north)];
}

function ensureLandRoute(route: Coordinate[]) {
  return route.map(ensureLandCoordinate);
}

function setRouteLayerOpacity(map: MapLibreMap | null, layerId: string, opacity: number) {
  if (!map || !map.getLayer(layerId)) return;
  map.setPaintProperty(layerId, 'line-opacity', opacity);
}

function resetRouteLayerOpacities(map: MapLibreMap | null, layerIds: string[]) {
  layerIds.forEach((layerId) => setRouteLayerOpacity(map, layerId, ROUTE_LAYER_OPACITIES[layerId] ?? 1));
}

function fadeAndClearRoute(map: MapLibreMap | null, sourceId: string, layerIds: string[], onComplete?: () => void) {
  if (!map) {
    onComplete?.();
    return;
  }

  const fadeState = { value: 1 };
  gsap.to(fadeState, {
    value: 0,
    duration: ROUTE_FADE_DURATION,
    ease: 'power1.out',
    onUpdate: () => {
      layerIds.forEach((layerId) => {
        const baseOpacity = ROUTE_LAYER_OPACITIES[layerId] ?? 1;
        setRouteLayerOpacity(map, layerId, baseOpacity * fadeState.value);
      });
    },
    onComplete: () => {
      setSource(map, sourceId, emptyCollection);
      resetRouteLayerOpacities(map, layerIds);
      onComplete?.();
    }
  });
}




function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/** Id of the station closest to the given coordinate (used to route new
 *  danger zones to the right patrol loop). */
function nearestStationId(coordinate: Coordinate, stations: Array<{ id: string; coordinate: Coordinate }>): string | null {
  let bestId: string | null = null;
  let bestDistance = Infinity;
  stations.forEach((station) => {
    const distance = turf.distance(turf.point(coordinate), turf.point(station.coordinate), { units: 'kilometers' });
    if (distance < bestDistance) {
      bestDistance = distance;
      bestId = station.id;
    }
  });
  return bestId;
}

/** Assign danger zones to a patrol drone: its corridor's zones plus any
 *  unclaimed zone nearest to its station - so new danger zones naturally
 *  extend patrol coverage. Shared by the map patrol generator and the
 *  Command Studio preview. */
function zonesForPatrolDrone(drone: Drone, config: SafetyConfig): { station: SafetyConfig['stations'][number]; zones: SafetyConfig['dangerZones'] } | null {
  const corridor = patialaConfig.corridors.find((corridor) => corridor.droneId === drone.id);
  const station = config.stations.find((station) => station.id === (corridor?.stationId ?? drone.stationId ?? ''));
  if (!station) return null;
  const corridorZoneIds = new Set(corridor?.dangerZones.map((zone) => zone.id) ?? []);
  const corridorZones = config.dangerZones.filter((zone) => corridorZoneIds.has(zone.id));
  const claimedIds = new Set(patialaConfig.corridors.flatMap((corridor) => corridor.dangerZones.map((zone) => zone.id)));
  const extras = config.dangerZones.filter((zone) => !claimedIds.has(zone.id) && nearestStationId(zone.coordinate, config.stations) === station.id);
  return { station, zones: [...corridorZones, ...extras] };
}

/** The patrol zone for a corridor: the convex hull of its danger zones, as a
 *  closed ring.  A convex hull is always a simple, non-self-intersecting
 *  polygon, so patrol zones look clean on the map no matter how dense the
 *  surrounding buildings are (the route planner's grid often degrades inside
 *  Patiala's old city, which is why patrol zones are drawn as polygons here
 *  instead of planner-routed lines).  The station sits at the zone centroid,
 *  not on the ring. */
function patrolZoneRing(zones: Coordinate[]): Coordinate[] {
  if (!zones.length) return [];
  if (zones.length < 3) return [...zones, zones[0]];
  const hull = turf.convex(turf.featureCollection(zones.map((zone) => turf.point(zone))));
  if (!hull) return [...zones, zones[0]];
  // NOTE: no ensureLandRoute here - this runs at module scope (initialDrones)
  // before demoBounds is initialized, and clamping is applied downstream by
  // runPatrolLoop / patrolRouteCollection anyway.
  return hull.geometry.coordinates[0] as Coordinate[];
}

function App() {
  const mapNode = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const droneMarkersRef = useRef(new globalThis.Map<string, maplibregl.Marker>());
  const patrolTweensRef = useRef(new globalThis.Map<string, gsap.core.Tween>());
  const dispatchTweenRef = useRef<gsap.core.Tween | null>(null);
  const liveDronePositionsRef = useRef(new globalThis.Map<string, Coordinate>());
  const droneStatePublishRef = useRef(new globalThis.Map<string, number>());
  const patrolConfigSignatureRef = useRef<string | null>(null);
  const dronesRef = useRef<Drone[]>(allInitialDrones);
  const safetyConfigRef = useRef<SafetyConfig>(defaultSafetyConfig);
  // Multi-response SOS machinery: one record per in-flight call.  Each owns
  // its drones, tweens, timers, and route feature, so any number of SOS
  // responses can run concurrently (each with its own drone).
  const sosResponsesRef = useRef(new globalThis.Map<string, SosResponse>());
  // Drones currently committed to a response - excluded from new dispatches
  // even before React re-renders their status.
  const busyDronesRef = useRef(new globalThis.Set<string>());
  // Route line features per SOS call (multiple concurrent routes share the
  // single `activeRoute` map source).
  const activeRouteFeaturesRef = useRef(new globalThis.Map<string, GeoJSON.Feature<GeoJSON.LineString>>());
  const liveTickerRef = useRef(0);
  const safeClickModeRef = useRef<'origin' | 'destination' | null>(null);
  // SOS demo: "Choose Location" mode - the next map click places the SOS.
  const sosPickModeRef = useRef(false);

  const [activeView, setActiveView] = useState<NavView>('dashboard');
  const [mapReady, setMapReady] = useState(false);
  const [safetyConfig, setSafetyConfig] = useState<SafetyConfig>(emptySafetyConfig);
  // Active city id - persisted so a reload lands on the same command grid.
  // The config + sos-log effects key off this, so switching cities reloads
  // the whole grid, log, and incident panel.
  const [activeCityId, setActiveCityId] = useState<string>(() => {
    try { return window.localStorage.getItem('sos-dashboard:activeCity') || 'patiala'; } catch { return 'patiala'; }
  });
  const [cities, setCities] = useState<CitySummary[]>([]);
  // Local ArduPilot SITL bridge status (polled).  Dispatch uses the ref so it
  // always reads the freshest value without re-subscribing effects; the state
  // only drives the small SITL/SIM pill in the top bar.
  const [sitlAvailable, setSitlAvailable] = useState(false);
  const [sitlPhase, setSitlPhase] = useState<SitlPhase | null>(null);
  const sitlStatusRef = useRef<{ available: boolean; phase: SitlPhase | null }>({ available: false, phase: null });
  const [studioOpen, setStudioOpen] = useState(false);
  const [studioTab, setStudioTab] = useState<StudioTab>('city');
  const [drones, setDrones] = useState<Drone[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>(() => seededAlerts.map((alert) => ({ ...alert, coordinate: ensureLandCoordinate(alert.coordinate) })));
  const [timeline, setTimeline] = useState<TimelineEvent[]>([
    { time: 'Now', label: 'Operations online', detail: 'Drone patrol grid synced with high-risk zones.' },
    { time: '01:12', label: 'Patrol route refresh', detail: '4 drones assigned to safety corridors.' },
    { time: '02:48', label: 'Video AI standby', detail: 'YOLOv8 service listed for backend integration.' }
  ]);
  const [toast, setToast] = useState('Syncing Patiala command grid...');
  const [routeProgress, setRouteProgress] = useState(0);
  const [safeWalk, setSafeWalk] = useState<SafeWalk>({ origin: null, destination: null, eta: 0, status: 'Select origin on map' });
  const [operationsOpen, setOperationsOpen] = useState(false);
  // Action deck (left panel under the top bar): closable + auto-hides after a
  // few seconds unless the pointer is hovering over it.
  const [deckVisible, setDeckVisible] = useState(true);
  const deckHoverRef = useRef(false);
  const [sosTargetVisible, setSosTargetVisible] = useState(false);
  const [sosBanner, setSosBanner] = useState<string | null>(null);
  const [sosPicking, setSosPicking] = useState(false);
  // UI mirror of sosResponsesRef (ids of in-flight responses) - re-renders
  // the SOS panel and sidebar when the set of active calls changes.
  const [activeSosIds, setActiveSosIds] = useState<string[]>([]);
  const sosBannerTimersRef = useRef<number[]>([]);
  const [sosLog, setSosLog] = useState<SosLogEntry[]>([]);
  const [sosLogExpanded, setSosLogExpanded] = useState(false);
  const [safeWalkUsers, setSafeWalkUsers] = useState<SafeWalkUser[]>(() => seededSafeWalkUsers.map((u) => ({ ...u, origin: ensureLandCoordinate(u.origin), destination: ensureLandCoordinate(u.destination) })));
  const [selectedSafeWalkUserId, setSelectedSafeWalkUserId] = useState<string | null>(null);
  const safeWalkTweensRef = useRef(new globalThis.Map<string, gsap.core.Tween>());

  // --- route-planner integration state ---
  const plannerRef = useRef({ online: false });
  const patrolOptimizedRef = useRef<string | null>(null);
  const [noFlyZones, setNoFlyZones] = useState<NoFlyZoneInfo[] | null>(null);
  const [showNoFly, setShowNoFly] = useState(true);
  const [plannerOnline, setPlannerOnline] = useState<boolean | null>(null);
  // Mirror of the fetched no-fly overlay for the (async) patrol generator.
  const noFlyZonesRef = useRef<NoFlyZoneInfo[]>([]);

  dronesRef.current = drones;
  safetyConfigRef.current = safetyConfig;
  noFlyZonesRef.current = noFlyZones ?? [];

  // Load the active city's command grid from Neon (or the local fallback grid
  // when the API is unreachable).  Re-runs whenever the active city changes.
  useEffect(() => {
    let cancelled = false;
    let settled = false;

    const fallback = (message: string) => {
      if (cancelled || settled) return;
      settled = true;
      setSafetyConfig(defaultSafetyConfig);
      setDrones(allInitialDrones);
      setToast(message);
    };

    // If Neon is slow, don't leave the command center blank - fall back to
    // the local grid after ~2s (a late response still swaps in the profile).
    const fallbackTimer = window.setTimeout(
      () => fallback('Using local command grid until the API responds'),
      2000
    );

    fetch(`/api/safety/config?cityId=${encodeURIComponent(activeCityId)}`)
      .then((response) => response.ok ? response.json() : Promise.reject(new Error('Safety config unavailable')))
      .then((config: SafetyConfig | null) => {
        window.clearTimeout(fallbackTimer);
        if (cancelled) return;
        // server has no profile for this city yet - keep the local grid
        if (!config) {
          fallback('Using local command grid (no saved profile yet)');
          return;
        }
        settled = true;
        setSafetyConfig(config);
        setDrones(config.drones);
        setToast(`${config.city.name} command grid loaded from Neon`);
        mapRef.current?.easeTo({ center: config.city.center, zoom: config.city.zoom, duration: 900 });
      })
      .catch(() => {
        window.clearTimeout(fallbackTimer);
        fallback('Using local command grid until the API is available');
      });

    return () => {
      cancelled = true;
      window.clearTimeout(fallbackTimer);
    };
  }, [activeCityId]);

  // Seed the SOS log sidebar from the persisted call history for the active
  // city (cleared on switch so stale entries from another city never linger).
  useEffect(() => {
    let cancelled = false;
    setSosLog([]);
    fetch(`/api/safety/sos-log?cityId=${encodeURIComponent(activeCityId)}&limit=50`)
      .then((response) => response.ok ? response.json() : Promise.reject(new Error('SOS log unavailable')))
      .then((data: { entries: SosLogEntry[] }) => {
        if (!cancelled && Array.isArray(data.entries)) setSosLog(data.entries);
      })
      .catch(() => { if (!cancelled) setSosLog([]); });
    return () => { cancelled = true; };
  }, [activeCityId]);

  // --- multi-city management ---
  const persistActiveCity = (cityId: string) => {
    try { window.localStorage.setItem('sos-dashboard:activeCity', cityId); } catch { /* private mode */ }
  };

  const switchCity = (cityId: string) => {
    persistActiveCity(cityId);
    setActiveCityId(cityId);
  };

  const refreshCities = useCallback(async () => {
    try {
      const response = await fetch('/api/safety/cities');
      if (!response.ok) throw new Error('cities unavailable');
      const data = await response.json() as { cities: CitySummary[] };
      const list = Array.isArray(data.cities) ? data.cities : [];
      setCities(list);
      return list;
    } catch {
      return [];
    }
  }, []);

  useEffect(() => { refreshCities(); }, [refreshCities]);

  // Poll the local SITL bridge so an SOS can be handed to the real simulated
  // copter when it is online and patrolling.  The GSAP simulation remains the
  // fallback whenever the bridge is unreachable - polling failures are silent.
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      const status = await getSitlStatus();
      if (cancelled) return;
      const available = Boolean(status?.ok && status.connected);
      sitlStatusRef.current = { available, phase: status?.phase ?? null };
      setSitlAvailable(available);
      setSitlPhase(status?.phase ?? null);
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const deleteCity = async (cityId: string) => {
    if (!window.confirm(`Delete ${cityId}? This removes its stations, drones, zones, and logs from Neon.`)) return;
    try {
      const response = await fetch(`/api/safety/cities/${encodeURIComponent(cityId)}`, { method: 'DELETE' });
      if (!response.ok) throw new Error('Could not delete city');
      const remaining = await refreshCities();
      if (cityId === activeCityId) switchCity(remaining.length ? remaining[0].id : 'patiala');
      setToast('City deleted');
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'Could not delete city');
    }
  };

  const activeDrones = drones.filter((drone) => !isPoolDrone(drone) && drone.status === 'Patrol').length;
  const criticalAlerts = alerts.filter((alert) => alert.priority === 'Critical' && alert.status !== 'Resolved').length;
  const responseMetric = criticalAlerts ? '01:46' : '02:18';

  // Compact summaries of the in-flight SOS responses for the SOS panel.
  const activeSosSummaries = activeSosIds.map((id) => {
    const alert = alerts.find((item) => item.id === id);
    const response = sosResponsesRef.current.get(id);
    return {
      id,
      label: alert?.label || response?.alert.label || id,
      droneId: response?.alert.droneId || response?.patrolDroneId || response?.stationDroneId || null
    };
  });

  /** A log entry is live while its call is in flight - either it has an
   *  active response or it is still in the pre-dispatch Received phase. */
  function isLogEntryActive(entry: SosLogEntry): boolean {
    return activeSosIds.includes(entry.id)
      || entry.status === 'Received'
      || entry.status === 'Dispatched'
      || entry.status === 'Monitoring';
  }

  const patrolRouteCollection = useMemo(
    () => featureCollection(safetyConfig.drones
      .filter((drone) => !isPoolDrone(drone))
      // turf.polygon needs a closed ring (4+ points); single-point routes
      // (e.g. a brand-new Studio drone) are skipped for drawing.
      .filter((drone) => drone.route.length >= 4)
      .map((drone) => turf.polygon([ensureLandRoute(drone.route)], { id: drone.id, label: drone.routeName }))),
    [safetyConfig.drones]
  );

  const droneStationCollection = useMemo(
    () => featureCollection(safetyConfig.stations.map((station) => turf.point(ensureLandCoordinate(station.coordinate), station))),
    [safetyConfig.stations]
  );

  const hotspotCollection = useMemo(
    () => featureCollection(safetyConfig.dangerZones.map((zone) => turf.point(ensureLandCoordinate(zone.coordinate), { ...zone, label: zone.name, category: zone.category }))),
    [safetyConfig.dangerZones]
  );

  // Danger zones drawn as polygon areas (rings from the studio builder) get a
  // fill + boundary on the map.  Zones without a ring keep the circle/heatmap
  // rendering, so old point+radius grids are untouched.
  const zoneRingCollection = useMemo(
    () => featureCollection(
      safetyConfig.dangerZones
        .filter((zone) => zone.ring && zone.ring.length >= 3)
        .map((zone) => turf.polygon([zone.ring as Coordinate[]], { id: zone.id, name: zone.name, severity: zone.severity }))
    ),
    [safetyConfig.dangerZones]
  );

  const riskHeatmapCollection = useMemo(() => {
    const points = heatPoints.map((point) => turf.point([point[1], point[0]], { intensity: point[2] * 0.4 }));
    const configuredZones = safetyConfig.dangerZones.map((zone) => turf.point(zone.coordinate, { intensity: zone.severity * 2 }));
    const alertPoints = alerts.map((alert) => turf.point(alert.coordinate, { intensity: alert.priority === 'Critical' ? 2 : 1.5 }));
    return featureCollection([...points, ...configuredZones, ...alertPoints]);
  }, [alerts, safetyConfig.dangerZones]);

  useEffect(() => {
    if (!mapNode.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: mapNode.current,
      style: lightOsmStyle,
      center: safetyConfig.city.center,
      zoom: safetyConfig.city.zoom,
      attributionControl: false,
      pitch: 0,
      bearing: 0
    });

    mapRef.current = map;

    map.on('load', () => {
      addSourcesAndLayers(map);
      setSource(map, sources.patrolRoutes, patrolRouteCollection);
      setSource(map, sources.droneStations, droneStationCollection);
      setSource(map, sources.hotspots, hotspotCollection);
      setSource(map, sources.riskHeatmap, riskHeatmapCollection);
      setSource(map, sources.zoneRings, zoneRingCollection);
      renderDroneMarkers(map, safetyConfig.drones);
      bindMap(map);
      fitCollections(map, [patrolRouteCollection, hotspotCollection, droneStationCollection]);
      startPatrols(safetyConfig.drones);
      patrolConfigSignatureRef.current = patrolConfigSignature(safetyConfig.drones);
      setMapReady(true);
      initPlanner();
    });

    return () => {
      patrolTweensRef.current.forEach((tween) => tween.kill());
      dispatchTweenRef.current?.kill();
      sosResponsesRef.current.forEach((response) => {
        response.tweens.forEach((tween) => tween.kill());
        response.timers.forEach((timer) => window.clearTimeout(timer));
      });
      sosResponsesRef.current.clear();
      sosBannerTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      sosBannerTimersRef.current = [];
      droneMarkersRef.current.forEach((marker) => marker.remove());
      map.remove();
      mapRef.current = null;
      setMapReady(false);
    };
  }, []);

  useEffect(() => {
    if (!mapReady) return;
    if (activeView === 'sos') {
      setSosTargetVisible(true);
      setSource(mapRef.current, sources.sosTarget, createSosMarkerCollection(alerts, activeSosIds));
    } else {
      setSosTargetVisible(false);
      setSource(mapRef.current, sources.sosTarget, emptyCollection);
      // leaving the SOS view cancels an in-progress location pick
      if (sosPickModeRef.current) {
        sosPickModeRef.current = false;
        setSosPicking(false);
        const map = mapRef.current;
        if (map) map.getCanvas().style.cursor = '';
      }
    }
  }, [activeView, alerts, mapReady, activeSosIds]);

  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    const map = mapRef.current;
    setSource(map, sources.patrolRoutes, patrolRouteCollection);
    setSource(map, sources.droneStations, droneStationCollection);
    setSource(map, sources.hotspots, hotspotCollection);
    setSource(map, sources.riskHeatmap, riskHeatmapCollection);
    setSource(map, sources.zoneRings, zoneRingCollection);
  }, [mapReady, patrolRouteCollection, droneStationCollection, hotspotCollection, riskHeatmapCollection, zoneRingCollection]);

  useEffect(() => {
    if (!mapReady || !mapRef.current || sosResponsesRef.current.size > 0) return;
    const map = mapRef.current;
    const nextSignature = patrolConfigSignature(safetyConfig.drones);
    if (patrolConfigSignatureRef.current === nextSignature) return;
    patrolConfigSignatureRef.current = nextSignature;
    // Config changes reconcile markers without replacing live positions. This
    // effect intentionally does not depend on alerts or map-source data, so an
    // SOS status update cannot restart the entire patrol fleet. The signature
    // guard also prevents the initial map-ready render from restarting every
    // tween a second time.
    patrolTweensRef.current.forEach((tween) => tween.kill());
    const configuredDroneIds = new Set(safetyConfig.drones.map((drone) => drone.id));
    droneMarkersRef.current.forEach((marker, droneId) => {
      if (!configuredDroneIds.has(droneId)) {
        marker.remove();
        droneMarkersRef.current.delete(droneId);
        liveDronePositionsRef.current.delete(droneId);
      }
    });
    const missingMarkers = safetyConfig.drones.filter((drone) => !droneMarkersRef.current.has(drone.id));
    renderDroneMarkers(map, missingMarkers);
    startPatrols(safetyConfig.drones);
    map.easeTo({ center: safetyConfig.city.center, zoom: safetyConfig.city.zoom, duration: 700 });
  }, [safetyConfig, mapReady]);

  // Auto-hide the action deck a few seconds after it appears (or after the
  // view changes) unless the pointer is hovering over it.
  useEffect(() => {
    if (!deckVisible || operationsOpen) return;
    const hideTimer = window.setTimeout(() => {
      if (!deckHoverRef.current) setDeckVisible(false);
    }, 3000);
    return () => window.clearTimeout(hideTimer);
  }, [deckVisible, operationsOpen, activeView]);

  useEffect(() => {
    liveTickerRef.current = window.setInterval(() => {
      setDrones((current) => current.map((drone) => ({
        ...drone,
        battery: drone.status === 'Charging' ? Math.min(100, drone.battery + 1) : Math.max(38, drone.battery - (Math.random() > 0.65 ? 1 : 0)),
        response: drone.status === 'Dispatching' ? '0.8 min' : drone.response
      })));
    }, 4200);
    return () => window.clearInterval(liveTickerRef.current);
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const syncPointVisibility = () => {
      const zoom = map.getZoom();
      const detailVisible = zoom >= DETAIL_LAYER_MIN_ZOOM ? 'visible' : 'none';
      const droneVisible = zoom >= 10.8; // Drones linger slightly longer when zooming out
      [
        'patrol-routes',
        'safe-route-glow',
        'safe-route',
        'active-route-glow',
        'active-route',
        'drone-stations',
        'drone-station-halo',
        'safe-user-halo',
        'safe-user-point',
        'target-halo',
        'target-point',
        'safe-points',
        'unclustered-hotspot'
      ].forEach((layerId) => {
        if (map.getLayer(layerId)) map.setLayoutProperty(layerId, 'visibility', detailVisible);
      });
      droneMarkersRef.current.forEach((marker) => {
        const el = marker.getElement();
        const reserveStandby = el.dataset.reserve === 'true' && el.dataset.reserveStandby === 'true';
        el.style.display = droneVisible && !reserveStandby ? 'block' : 'none';
      });
    };

    syncPointVisibility();
    map.on('zoom', syncPointVisibility);
    map.on('moveend', syncPointVisibility);
    return () => {
      map.off('zoom', syncPointVisibility);
      map.off('moveend', syncPointVisibility);
    };
  }, [mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    ['nofly-red-fill', 'nofly-red-line', 'nofly-amber-fill', 'nofly-amber-line'].forEach((layerId) => {
      if (map.getLayer(layerId)) map.setLayoutProperty(layerId, 'visibility', showNoFly ? 'visible' : 'none');
    });
  }, [showNoFly, mapReady]);

  // Build the patrol zone polygons once per scenario (station + danger-zone
  // layout), then reuse them until the layout changes or the operator forces
  // a refresh - matches the "compute once, cache, refresh on demand"
  // requirement.  Zones are local convex hulls, so this does not need the
  // planner to be online.
  useEffect(() => {
    if (!mapReady) return;
    const signature = scenarioSignature(safetyConfig);
    if (patrolOptimizedRef.current === signature) return;
    patrolOptimizedRef.current = signature;
    generatePatrolRoutes().then((routes) => applyOptimizedRoutes(routes));
  }, [mapReady, safetyConfig]);

  function bindMap(map: MapLibreMap) {
    ['unclustered-hotspot', 'target-point', 'drone-stations'].forEach((layerId) => {
      map.on('mouseenter', layerId, () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', layerId, () => { map.getCanvas().style.cursor = ''; });
    });

    map.on('click', 'unclustered-hotspot', (event) => {
      const feature = event.features?.[0] as PointFeature | undefined;
      if (!feature) return;
      const coordinate = ensureLandCoordinate(feature.geometry.coordinates as Coordinate);
      const id = String(feature.properties.id || feature.properties.label || 'HOTSPOT');

      const popupNode = document.createElement('div');
      popupNode.innerHTML = `
        <div style="display: flex; flex-direction: column; gap: 4px;">
          <strong>${feature.properties.label}</strong>
          <span>${feature.properties.category} risk zone / severity ${Math.round(Number(feature.properties.severity) * 100)}%</span>
          <button class="primary-action danger-action dispatch-btn" style="margin-top: 8px; width: 100%; justify-content: center; font-size: 13px; cursor: pointer;">
            Emergency Dispatch
          </button>
        </div>
      `;

      const popup = new maplibregl.Popup({ className: 'ops-popup', offset: 16 })
        .setLngLat(coordinate)
        .setDOMContent(popupNode)
        .addTo(map);

      const btn = popupNode.querySelector('.dispatch-btn');
      if (btn) {
        (btn as HTMLButtonElement).onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          popup.remove();
          beginSosSequence({
            id,
            label: String(feature.properties.label),
            priority: 'Critical' as Alert['priority'],
            status: 'Drone dispatching',
            coordinate,
            time: 'Just now'
          });
        };
      }
    });

    map.on('click', 'drone-stations', (event) => {
      const feature = event.features?.[0] as PointFeature | undefined;
      if (!feature) return;
      const coordinate = ensureLandCoordinate(feature.geometry.coordinates as Coordinate);
      new maplibregl.Popup({ className: 'ops-popup', offset: 16 })
        .setLngLat(coordinate)
        .setHTML(`<strong>${feature.properties.name}</strong><span>Standby station for ${feature.properties.droneId}<br/>Responds to nearby SOS calls.</span>`)
        .addTo(map);
    });

    map.on('click', 'target-point', (event) => {
      const feature = event.features?.[0] as PointFeature | undefined;
      if (!feature) return;
      const coordinate = ensureLandCoordinate(feature.geometry.coordinates as Coordinate);
      const id = String(feature.properties.id || feature.properties.label || 'SOS');

      const popupNode = document.createElement('div');
      popupNode.innerHTML = `
        <div style="display: flex; flex-direction: column; gap: 4px;">
          <strong>${feature.properties.label || 'SOS caller'}</strong>
          <span>Priority: ${feature.properties.priority || 'Critical'} | ${feature.properties.time || 'Just now'}</span>
          <button class="primary-action danger-action dispatch-btn" style="margin-top: 8px; width: 100%; justify-content: center; font-size: 13px; cursor: pointer;">
            Emergency Dispatch
          </button>
        </div>
      `;

      const popup = new maplibregl.Popup({ className: 'ops-popup', offset: 16 })
        .setLngLat(coordinate)
        .setDOMContent(popupNode)
        .addTo(map);

      const btn = popupNode.querySelector('.dispatch-btn');
      if (btn) {
        (btn as HTMLButtonElement).onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          popup.remove();
          beginSosSequence({
            id,
            label: String(feature.properties.label || 'SOS caller'),
            priority: String(feature.properties.priority || 'Critical') as Alert['priority'],
            status: 'Drone dispatching',
            coordinate,
            time: String(feature.properties.time || 'Just now')
          });
        };
      }
    });

    map.on('click', (event) => {
      // SOS demo "Choose Location": the next click places the emergency
      // exactly where the operator clicked (clamped to the operating area).
      if (sosPickModeRef.current) {
        const rawCoordinate: Coordinate = [event.lngLat.lng, event.lngLat.lat];
        const redZones = (noFlyZonesRef.current ?? []).filter((zone) => zone.kind === 'red');
        const coordinate = clampToSafeCoordinate(ensureLandCoordinate(rawCoordinate), redZones);
        const wasAdjusted = coordinate[0] !== rawCoordinate[0] || coordinate[1] !== rawCoordinate[1];
        sosPickModeRef.current = false;
        setSosPicking(false);
        map.getCanvas().style.cursor = '';
        setActiveView('sos');
        const started = beginSosSequence({
          id: `SOS-${Date.now().toString().slice(-6)}`,
          label: 'Custom SOS location',
          priority: 'Critical',
          status: 'Drone dispatching',
          coordinate,
          time: 'Just now'
        });
        // beginSosSequence toasts its own failure reasons when it returns false
        if (started) {
          setToast(wasAdjusted
            ? 'SOS moved to nearest safe spot outside no-fly zones - dispatching nearest drone'
            : 'SOS placed - dispatching nearest drone');
        }
        return;
      }
      if (!safeClickModeRef.current) return;
      const rawCoordinate: Coordinate = [event.lngLat.lng, event.lngLat.lat];
      const redZones = (noFlyZonesRef.current ?? []).filter((zone) => zone.kind === 'red');
      const coordinate = clampToSafeCoordinate(ensureLandCoordinate(rawCoordinate), redZones);
      const wasAdjusted = coordinate[0] !== rawCoordinate[0] || coordinate[1] !== rawCoordinate[1];
      if (safeClickModeRef.current === 'origin') {
        setSafeWalk({ origin: coordinate, destination: null, eta: 0, status: 'Select destination on map' });
        safeClickModeRef.current = 'destination';
        setToast(wasAdjusted ? 'Origin moved to nearest safe spot outside no-fly zones. Choose destination.' : 'Origin locked. Choose destination.');
      } else {
        setSafeWalk((current) => {
          buildSafeWalk(current.origin || patialaConfig.center, coordinate).then((next) => setSafeWalk(next));
          return current;
        });
        safeClickModeRef.current = null;
      }
    });
  }

  function setDroneMarkerVisible(droneId: string, visible: boolean) {
    const marker = droneMarkersRef.current.get(droneId);
    if (!marker) return;
    const element = marker.getElement();
    element.dataset.reserveStandby = visible ? 'false' : 'true';
    element.style.display = visible ? 'block' : 'none';
  }

  function renderDroneMarkers(map: MapLibreMap, nextDrones: Drone[]) {
    nextDrones.forEach((drone) => {
      const markerNode = document.createElement('button');
      markerNode.className = 'drone-marker';
      const standbyHidden = isPoolDrone(drone) && drone.status === 'Standby';
      markerNode.dataset.reserve = isPoolDrone(drone) ? 'true' : 'false';
      markerNode.dataset.reserveStandby = standbyHidden ? 'true' : 'false';
      markerNode.style.display = standbyHidden ? 'none' : 'block';
      markerNode.type = 'button';
      markerNode.title = `${drone.id} ${drone.label}${drone.role === 'Reserve' ? ' / reserve' : drone.role === 'Spare' ? ' / spare' : ''}`;
      markerNode.innerHTML = '<span></span>';
      markerNode.addEventListener('click', () => {
        new maplibregl.Popup({ className: 'ops-popup', offset: 18 })
          .setLngLat(ensureLandCoordinate(drone.position))
          .setHTML(`<strong>${drone.id} / ${drone.label}</strong><span>${drone.status} on ${drone.routeName}<br/>Battery ${drone.battery}%</span>`)
          .addTo(map);
      });
      const livePosition = liveDronePositionsRef.current.get(drone.id) || ensureLandCoordinate(drone.position);
      const marker = new maplibregl.Marker({
        element: markerNode,
        anchor: 'center',
        pitchAlignment: 'map',
        rotationAlignment: 'map',
        subpixelPositioning: true
      })
        .setLngLat(livePosition)
        .addTo(map);
      liveDronePositionsRef.current.set(drone.id, livePosition);
      droneMarkersRef.current.set(drone.id, marker);
    });
  }

  function publishDronePosition(droneId: string, coordinate: Coordinate, force = false) {
    const now = performance.now();
    const lastPublished = droneStatePublishRef.current.get(droneId) || 0;
    if (!force && now - lastPublished < 100) return;
    droneStatePublishRef.current.set(droneId, now);
    setDrones((current) => current.map((drone) => drone.id === droneId ? { ...drone, position: coordinate } : drone));
  }

  function runPatrolLoop(drone: Drone, route: Coordinate[], startSegmentIndex: number, cycleDuration: number, startCoordinate?: Coordinate, onFirstSegmentComplete?: () => void, resumePath?: Coordinate[]) {
    patrolTweensRef.current.get(drone.id)?.kill();
    const marker = droneMarkersRef.current.get(drone.id);
    const safeRoute = ensureLandRoute(route);
    if (safeRoute.length < 2) return;

    const waypoints: Coordinate[] = [...safeRoute];
    const first = waypoints[0];
    const last = waypoints[waypoints.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
      waypoints.push([first[0], first[1]]);
    }

    const segmentCount = waypoints.length - 1;
    if (segmentCount < 1) return;

    const segmentDistances = waypoints.slice(0, -1).map((point, index) => turf.distance(turf.point(point), turf.point(waypoints[index + 1]), { units: 'kilometers' }));
    const totalDistance = segmentDistances.reduce((sum, value) => sum + value, 0);
    if (totalDistance < 0.001) return;

    const speed = totalDistance / cycleDuration;
    // A planner-routed rejoin path (returning from an SOS) is played through
    // first, so the drone reaches its ring without cutting across red
    // no-fly zones; the ring then starts at waypoints[0], where the path ends.
    let resumePathQueue = resumePath && resumePath.length >= 2 ? resumePath.map(ensureLandCoordinate) : undefined;
    let segmentIndex = resumePathQueue ? 0 : ((startSegmentIndex % segmentCount) + segmentCount) % segmentCount;
    let firstSegment = true;
    let resumeCoordinate = startCoordinate ? ensureLandCoordinate(startCoordinate) : undefined;

    if (resumeCoordinate) {
      const nearestRoutePoint = turf.nearestPointOnLine(turf.lineString(waypoints), turf.point(resumeCoordinate), { units: 'kilometers' });
      const nearestSegment = Number(nearestRoutePoint.properties.index);
      if (Number.isFinite(nearestSegment)) segmentIndex = Math.min(segmentCount - 1, Math.max(0, nearestSegment));
    }

    const moveToSegment = () => {
      // Play the routed rejoin path leg by leg before starting the ring.
      if (resumePathQueue && resumePathQueue.length >= 2) {
        const pathFrom = resumePathQueue[0];
        const pathTo = resumePathQueue[1];
        const pathDistance = turf.distance(turf.point(pathFrom), turf.point(pathTo), { units: 'kilometers' });
        const pathDuration = Math.max(0.2, pathDistance / speed);
        const pathHeading = turf.bearing(turf.point(pathFrom), turf.point(pathTo));
        const pathProgress = { value: 0 };

        marker?.setLngLat(pathFrom);
        marker?.setRotation(pathHeading);

        const tween = gsap.to(pathProgress, {
          value: 1,
          duration: pathDuration,
          ease: 'none',
          onUpdate: () => {
            const lng = pathFrom[0] + (pathTo[0] - pathFrom[0]) * pathProgress.value;
            const lat = pathFrom[1] + (pathTo[1] - pathFrom[1]) * pathProgress.value;
            const currentCoordinate = [lng, lat] as Coordinate;

            marker?.setLngLat(currentCoordinate);
            marker?.setRotation(pathHeading);
            liveDronePositionsRef.current.set(drone.id, currentCoordinate);
            publishDronePosition(drone.id, currentCoordinate);
          },
          onComplete: () => {
            publishDronePosition(drone.id, pathTo, true);
            resumePathQueue = resumePathQueue!.slice(1);
            if (resumePathQueue.length >= 2) {
              moveToSegment();
            } else {
              // Reached the ring start - continue with the normal segments;
              // the first ring segment completion releases the coverage.
              resumePathQueue = undefined;
              resumeCoordinate = undefined;
              firstSegment = true;
              moveToSegment();
            }
          }
        });

        patrolTweensRef.current.set(drone.id, tween);
        return;
      }

      const from = firstSegment && resumeCoordinate ? resumeCoordinate : waypoints[segmentIndex];
      const to = waypoints[segmentIndex + 1];
      const distance = turf.distance(turf.point(from), turf.point(to), { units: 'kilometers' });
      const duration = Math.max(0.2, distance / speed);
      const heading = turf.bearing(turf.point(from), turf.point(to));
      const progress = { value: 0 };

      marker?.setLngLat(from);
      marker?.setRotation(heading);

      const tween = gsap.to(progress, {
        value: 1,
        duration,
        ease: 'none',
        onUpdate: () => {
          const lng = from[0] + (to[0] - from[0]) * progress.value;
          const lat = from[1] + (to[1] - from[1]) * progress.value;
          const currentCoordinate = [lng, lat] as Coordinate;

          marker?.setLngLat(currentCoordinate);
          marker?.setRotation(heading);
          liveDronePositionsRef.current.set(drone.id, currentCoordinate);
          publishDronePosition(drone.id, currentCoordinate);
        },
        onComplete: () => {
          publishDronePosition(drone.id, to, true);
          if (firstSegment) onFirstSegmentComplete?.();
          firstSegment = false;
          resumeCoordinate = undefined;
          segmentIndex = (segmentIndex + 1) % segmentCount;
          moveToSegment();
        }
      });

      patrolTweensRef.current.set(drone.id, tween);
    };

    moveToSegment();
  }

  function startPatrols(nextDrones: Drone[]) {
    nextDrones.forEach((drone, index) => {
      if (drone.status !== 'Patrol' || isPoolDrone(drone)) return;
      const baseDuration = 24 + index * 5;
      runPatrolLoop(drone, drone.route, index, baseDuration, liveDronePositionsRef.current.get(drone.id));
    });
  }

  // ------------------------------------------------------------------
  // Route-planner integration (overture-test backend)
  // ------------------------------------------------------------------

  /** Signature of the scenario layout - patrol loops are cached per layout
   *  and re-optimized only when stations / danger zones move. */
  function scenarioSignature(config: SafetyConfig): string {
    const stations = config.stations.map((station) => `${station.id}:${station.coordinate[0].toFixed(5)},${station.coordinate[1].toFixed(5)}`).join('|');
    const zones = config.dangerZones.map((zone) => `${zone.id}:${zone.coordinate[0].toFixed(5)},${zone.coordinate[1].toFixed(5)}`).join('|');
    return `${stations}~${zones}`;
  }

  /** Plan a building-avoiding path between two coordinates.  Falls back to
   *  a straight line when the planner is not configured, unreachable, or
   *  honestly reports no corridor - the drone always flies.  `warning` is set
   *  on degraded routes (the backend returns a best-effort route instead of
   *  an error). */
  async function planPath(
    from: Coordinate,
    to: Coordinate,
    onPartial?: (waypoints: Coordinate[]) => void,
  ): Promise<{ waypoints: Coordinate[]; zonesCrossed: NoFlyZoneInfo[]; warning?: string | null }> {
    // The planner is unreachable or gave up: a straight line is the only
    // option, but it must never silently cut through a prohibited red zone -
    // report any crossing so the operator sees it (PROHIBITED toast + log).
    const fallbackDirect = () => {
      const waypoints = createCurvedRoute(from, to);
      const crossed = lineCrossesRedZones(from, to, (noFlyZonesRef.current ?? []).filter((zone) => zone.kind === 'red'));
      if (!crossed.length) return { waypoints, zonesCrossed: [] as NoFlyZoneInfo[], warning: null as string | null };
      const names = Array.from(new Set(crossed.map((zone) => zone.name))).join(', ');
      return {
        waypoints,
        zonesCrossed: crossed,
        warning: `Planner unreachable - direct route crosses PROHIBITED no-fly zone(s): ${names}. Verify before flight.`,
      };
    };
    if (!isPlannerConfigured()) return fallbackDirect();
    const body = {
      start_lat: from[1],
      start_lon: from[0],
      goal_lat: to[1],
      goal_lon: to[0],
      altitude_m: 80,
      speed_mps: 15,
      safety_margin_m: 0,
      snap_start_goal: true,
      // A fixed grid resolution from the Command Studio forces that grid;
      // auto (null) omits the field so the planner uses its default (fast
      // 10 m first, refining to 5 m only when no corridor exists).
      ...(safetyConfigRef.current.planner?.gridResolutionM ? { grid_resolution_m: safetyConfigRef.current.planner.gridResolutionM } : {}),
    };
    // The tunnel proxy's HTTP/2 handling of the streaming endpoint is flaky
    // (browser ERR_HTTP2_PROTOCOL_ERROR / CORS preflight on a dead connection).
    // The blocking endpoint is proxy-friendly - retry it a few times with a
    // short backoff on pure transport failures before giving up.  Real planner
    // answers (no path, infeasible, validation) are never retried.
    const retryBlocking = async (): Promise<RouteResponse> => {
      let lastError: unknown;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          return await generateRoute(body);
        } catch (err) {
          lastError = err;
          const retryable = err instanceof PlannerError && err.transport && err.status === undefined;
          if (!retryable) throw err;
          await new Promise((resolve) => window.setTimeout(resolve, 600 * (attempt + 1)));
        }
      }
      throw lastError;
    };
    try {
      let result: RouteResponse;
      if (onPartial) {
        try {
          result = await generateRouteStream(body, {
            onPartial: (waypoints) => onPartial(waypoints.map((waypoint) => [waypoint.lon, waypoint.lat] as Coordinate)),
          });
        } catch (streamErr) {
          // The stream failed for infrastructure reasons: endpoint missing on
          // an older backend, or the tunnel proxy's HTTP/2 handling of
          // long-lived responses (browser ERR_HTTP2_PROTOCOL_ERROR).  The
          // blocking endpoint is proxy-friendly, so retry with it.  In-band
          // planner errors (real answers like "no corridor") are NOT retried.
          if (streamErr instanceof PlannerError && streamErr.transport) {
            result = await retryBlocking();
          } else {
            throw streamErr;
          }
        }
      } else {
        result = await retryBlocking();
      }
      const waypoints = result.waypoints.map((waypoint) => [waypoint.lon, waypoint.lat] as Coordinate);
      if (waypoints.length >= 2) return { waypoints, zonesCrossed: result.zones_crossed ?? [], warning: result.warning ?? null };
      return fallbackDirect();
    } catch (err) {
      if (plannerRef.current.online) {
        setToast(`Planner error (${err instanceof PlannerError ? err.message : 'request failed'}) - using direct route`);
      }
      return fallbackDirect();
    }
  }

  /** Assign every danger zone to exactly one patrol loop: zones named in the
   *  scenario corridors keep their corridor (using live coordinates, so
   *  moving one re-routes), and any zone added in the Command Studio goes to
   *  the nearest station's drone - so adding a new danger zone naturally
   *  extends patrol coverage. */

  /** True when the ring intersects any of the given red (prohibited) zones.
   *  Zone rings arrive as [lat, lon] from the backend; the patrol ring is
   *  [lon, lat] - flip when building the polygon. */
  function ringCrossesRedZones(ring: Coordinate[], redZones: NoFlyZoneInfo[]): boolean {
    if (!redZones.length || ring.length < 4) return false;
    const redPolys = redZones.map((zone) => turf.polygon([zone.ring.map(([lat, lon]) => [lon, lat])]));
    const ringPoly = turf.polygon([ring]);
    return redPolys.some((poly) => turf.booleanIntersects(ringPoly, poly));
  }

  /** Replace every hull edge that crosses a red zone with a planner-routed
   *  detour (buildings AND red zones avoided).  Legs that fail or degrade
   *  fall back to the original straight edge, so a corridor is never worse
   *  than the plain hull - and when the planner is offline this is a no-op. */
  async function dodgeRedZonesInRing(ring: Coordinate[], redZones: NoFlyZoneInfo[]): Promise<Coordinate[]> {
    if (!redZones.length || ring.length < 4) return ring;
    const redPolys = redZones.map((zone) => turf.polygon([zone.ring.map(([lat, lon]) => [lon, lat])]));
    const crossingEdges: number[] = [];
    for (let index = 0; index < ring.length - 1; index += 1) {
      const edge = turf.lineString([ring[index], ring[index + 1]]);
      if (redPolys.some((poly) => turf.booleanIntersects(edge, poly))) crossingEdges.push(index);
    }
    if (!crossingEdges.length) return ring;
    const out: Coordinate[] = [ring[0]];
    for (let index = 0; index < ring.length - 1; index += 1) {
      const from = ring[index];
      const to = ring[index + 1];
      if (crossingEdges.includes(index)) {
        const routed = (await planPath(from, to)).waypoints;
        out.push(...(routed.length > 1 ? routed.slice(1) : [to]));
      } else {
        out.push(to);
      }
    }
    return out;
  }

  /** Build the patrol zones for every corridor: a convex-hull polygon ring
   *  around each corridor's danger zones (computed locally - the route
   *  planner's grid frequently degrades inside Patiala's dense old city, so
   *  patrol zones are clean polygons instead of planner-routed lines).
   *  When a red no-fly zone overlaps the hull, the crossing edges are
   *  re-routed through the planner so patrol drones never fly through
   *  prohibited airspace.  Cache to localStorage so it is only recomputed
   *  when the layout changes or the operator forces a refresh. */
  async function generatePatrolRoutes(force = false): Promise<Record<string, Coordinate[]>> {
    const config = safetyConfigRef.current;
    const signature = scenarioSignature(config);
    if (!force) {
      try {
        const cached = localStorage.getItem(PATROL_CACHE_KEY);
        if (cached) {
          const parsed = JSON.parse(cached) as { version: number; signature: string; routes: Record<string, Coordinate[]> };
          if (parsed.version === patialaConfig.version && parsed.signature === signature && parsed.routes) return parsed.routes;
        }
      } catch { /* ignore corrupted cache */ }
    }
    const redZones = (noFlyZonesRef.current ?? []).filter((zone) => zone.kind === 'red');
    const routes: Record<string, Coordinate[]> = {};
    for (const drone of config.drones) {
      if (isPoolDrone(drone)) continue;
      const assignment = zonesForPatrolDrone(drone, config);
      if (!assignment || !assignment.zones.length) continue;
      const hull = patrolZoneRing(assignment.zones.map((zone) => zone.coordinate));
      routes[drone.id] = redZones.length ? await dodgeRedZonesInRing(hull, redZones) : hull;
    }
    try {
      localStorage.setItem(PATROL_CACHE_KEY, JSON.stringify({ version: patialaConfig.version, signature, routes }));
    } catch { /* storage full / private mode - patrols still work this session */ }
    return routes;
  }

  /** Swap the drone routes for the optimized loops (the existing
   *  patrol-config-signature effect restarts the patrols automatically). */
  function applyOptimizedRoutes(routes: Record<string, Coordinate[]>) {
    setSafetyConfig((current) => ({
      ...current,
      drones: current.drones.map((drone) => routes[drone.id] ? { ...drone, route: routes[drone.id] } : drone),
    }));
    setDrones((current) => current.map((drone) => routes[drone.id] ? { ...drone, route: routes[drone.id] } : drone));
  }

  /** Regenerate patrol routes from scratch (ignores the cache) - use when a
   *  new danger zone is added or the operator wants a fresh optimization. */
  function handleRegeneratePatrolRoutes() {
    try { localStorage.removeItem(PATROL_CACHE_KEY); } catch { /* ignore */ }
    setToast('Rebuilding patrol zones...');
    generatePatrolRoutes(true).then((routes) => applyOptimizedRoutes(routes));
  }

  /** One-time startup: resolve the planner URL from the runtime config, probe
   *  it, and load the DGCA no-fly overlay. */
  async function initPlanner() {
    await configurePlanner();
    if (!isPlannerConfigured()) {
      plannerRef.current.online = false;
      setPlannerOnline(false);
      setToast('Planner API not configured - using straight-line fallback');
      return;
    }
    const health = await fetchHealth();
    plannerRef.current.online = Boolean(health);
    setPlannerOnline(Boolean(health));
    setToast(health ? `Route planner online (v${health.version}) - SOS and safe-walk routes optimized` : 'Planner API unreachable - SOS and safe walk use straight-line fallback');
    try {
      // The backend hosts the all-india snapshot; request only the zones
      // overlapping the operating bounds so the browser gets the local
      // overlay instead of every ring in the country.
      const pad = 0.15;
      const { west, south, east, north } = demoBounds;
      const zones = await fetchNoFlyZones(
        'india',
        `${west - pad},${south - pad},${east + pad},${north + pad}`,
      );
      applyNoFlyZones(zones.zones ?? []);
      // Patrol loops built before the overlay arrived were plain hulls - if
      // any crosses a red (prohibited) zone, rebuild them once with planner
      // detours so patrol drones never fly through prohibited airspace.
      const redZones = (zones.zones ?? []).filter((zone) => zone.kind === 'red');
      const needsDetour = redZones.length > 0 && safetyConfigRef.current.drones.some((drone) =>
        !isPoolDrone(drone) && drone.route.length >= 4 && ringCrossesRedZones(drone.route, redZones));
      if (needsDetour) handleRegeneratePatrolRoutes();
    } catch {
      applyNoFlyZones([]);
    }
  }

  /** Render the DGCA red/amber airspace overlay on the map. */
  function applyNoFlyZones(zones: NoFlyZoneInfo[]) {
    setNoFlyZones(zones);
    const map = mapRef.current;
    if (!map || !zones.length) return;
    const features = zones.map((zone) => ({
      type: 'Feature' as const,
      properties: { kind: zone.kind, name: zone.name },
      geometry: {
        type: 'Polygon' as const,
        coordinates: [zone.ring.map(([lat, lon]) => [lon, lat])],
      },
    }));
    setSource(map, sources.noFlyZones, { type: 'FeatureCollection', features });
  }

  function updateDronePosition(droneId: string, coordinate: Coordinate, clampToLand = true): Coordinate {
    const nextCoordinate = clampToLand ? ensureLandCoordinate(coordinate) : coordinate;
    droneMarkersRef.current.get(droneId)?.setLngLat(nextCoordinate);
    liveDronePositionsRef.current.set(droneId, nextCoordinate);
    publishDronePosition(droneId, nextCoordinate);
    return nextCoordinate;
  }

  function getSosDispatch(target: Coordinate) {
    const safeTarget = ensureLandCoordinate(target);
    // The closest available patrol drone is the primary responder: it is
    // already airborne, so it reaches the caller sooner than a drone that
    // must launch from a station.  Only drones whose corridor stays covered
    // (designated reserve or a spare free) are candidates - otherwise the
    // patrol loop would be left unpatrolled while the drone responds.
    const availableDrones = dronesRef.current
      .filter((drone) => drone.status === 'Patrol' && !isPoolDrone(drone) && !busyDronesRef.current.has(drone.id) && Boolean(getReserveDroneForPatrol(drone)))
      .map((drone) => ({
        drone,
        sourceCoordinate: ensureLandCoordinate(liveDronePositionsRef.current.get(drone.id) || drone.position),
        distance: turf.distance(
          turf.point(ensureLandCoordinate(liveDronePositionsRef.current.get(drone.id) || drone.position)),
          turf.point(safeTarget),
          { units: 'kilometers' }
        )
      }))
      .sort((a, b) => a.distance - b.distance);

    const nearestDrone = availableDrones[0];
    if (nearestDrone) {
      return { ...nearestDrone, station: undefined, usesPatrolDrone: true };
    }

    // Every patrol drone is busy or uncovered - fall back to a drone parked
    // at the nearest station so an SOS is never dropped for lack of a drone.
    const stationResponses = safetyConfigRef.current.stations
      .flatMap((station) => {
        // The station's designated reserve, plus every spare parked there - so
        // a launch is possible even when the reserve is already covering a call.
        const reserve = dronesRef.current.find((item) => item.id === station.reserveDroneId && item.status === 'Standby' && !busyDronesRef.current.has(item.id));
        const spares = dronesRef.current.filter((item) => item.role === 'Spare' && item.stationId === station.id && item.status === 'Standby' && !busyDronesRef.current.has(item.id));
        const candidates = [reserve, ...spares].filter((item): item is Drone => Boolean(item));
        const sourceCoordinate = ensureLandCoordinate(station.coordinate);
        return candidates.map((drone) => ({
          drone,
          station,
          sourceCoordinate,
          distance: turf.distance(turf.point(sourceCoordinate), turf.point(safeTarget), { units: 'kilometers' })
        }));
      })
      .sort((a, b) => a.distance - b.distance);

    const nearestStation = stationResponses[0];
    if (nearestStation) {
      return { ...nearestStation, usesPatrolDrone: false };
    }

    return {
      drone: null,
      sourceCoordinate: target,
      distance: Number.POSITIVE_INFINITY,
      station: undefined,
      usesPatrolDrone: true
    };
  }

  function getReserveDroneForPatrol(patrolDrone: Drone) {
    const station = safetyConfigRef.current.stations.find((item) => item.id === patrolDrone.stationId || item.droneId === patrolDrone.id);
    if (!station) return undefined;
    const reserve = station.reserveDroneId
      ? dronesRef.current.find((drone) => drone.id === station.reserveDroneId && drone.status === 'Standby')
      : undefined;
    if (reserve && reserve.role === 'Reserve') return { reserve, station };
    // The designated reserve is away covering another call - fall back to a
    // spare parked at this station so patrol coverage never runs out.
    const spare = dronesRef.current.find((drone) =>
      drone.role === 'Spare' && drone.stationId === station.id && drone.status === 'Standby' && !busyDronesRef.current.has(drone.id));
    return spare ? { reserve: spare, station } : undefined;
  }

  function startReserveCoverage(patrolDrone: Drone, sosId: string) {
    const coverage = getReserveDroneForPatrol(patrolDrone);
    if (!coverage || !mapRef.current) return false;
    const response = sosResponsesRef.current.get(sosId);
    if (response) response.coverageDroneId = coverage.reserve.id;
    const reserveIndex = safetyConfigRef.current.drones.findIndex((drone) => drone.id === coverage.reserve.id);
    const patrolIndex = Math.max(0, safetyConfigRef.current.drones.findIndex((drone) => drone.id === patrolDrone.id));
    const cycleDuration = 24 + patrolIndex * 5;
    busyDronesRef.current.add(coverage.reserve.id);
    setDroneMarkerVisible(coverage.reserve.id, true);
    setDrones((current) => current.map((drone) => drone.id === coverage.reserve.id
      ? { ...drone, status: 'Dispatching', response: `covering ${patrolDrone.routeName}` }
      : drone));
    runPatrolLoop(
      coverage.reserve,
      patrolDrone.route,
      reserveIndex >= 0 ? patrolIndex : 0,
      cycleDuration,
      ensureLandCoordinate(coverage.station.coordinate),
      () => setDrones((current) => current.map((drone) => drone.id === coverage.reserve.id
        ? { ...drone, status: 'Patrol', response: 'route coverage' }
        : drone))
    );
    return true;
  }

  /** Fly a drone home after its response ends.  The return leg is routed
   *  through the planner (buildings AND red no-fly zones avoided) instead of
   *  a straight line, so the drone never cuts across prohibited airspace on
   *  the way back - a straight line is only used when the planner is
   *  unreachable (its own fallback).  Fire-and-forget: the caller's cleanup
   *  must not wait for the flight. */
  async function returnDroneToStation(droneId: string, station: { coordinate: Coordinate }, sosId: string) {
    const marker = droneMarkersRef.current.get(droneId);
    const stationPosition = ensureLandCoordinate(station.coordinate);
    if (!marker) {
      liveDronePositionsRef.current.set(droneId, stationPosition);
      setDrones((current) => current.map((drone) => drone.id === droneId
        ? { ...drone, status: 'Standby', response: 'standby', position: stationPosition }
        : drone));
      return;
    }
    const start = marker.getLngLat();
    const startCoordinate = ensureLandCoordinate([start.lng, start.lat]);
    const planned = await planPath(startCoordinate, stationPosition);
    const returnRoute = turf.lineString(planned.waypoints);
    const returnDistance = turf.length(returnRoute, { units: 'kilometers' });
    const returnProgress = { value: 0 };
    const tween = gsap.to(returnProgress, {
      value: 1,
      duration: Math.min(8, Math.max(2.5, returnDistance * 2.8)),
      ease: 'power1.inOut',
      onUpdate: () => {
        const point = turf.along(returnRoute, returnDistance * returnProgress.value, { units: 'kilometers' });
        updateDronePosition(droneId, point.geometry.coordinates as Coordinate, false);
      },
      onComplete: () => {
        marker.setLngLat(stationPosition);
        liveDronePositionsRef.current.set(droneId, stationPosition);
        const element = marker.getElement();
        element.dataset.reserveStandby = 'true';
        element.style.display = 'none';
        setDrones((current) => current.map((drone) => drone.id === droneId
          ? { ...drone, status: 'Standby', response: 'standby', position: stationPosition }
          : drone));
        busyDronesRef.current.delete(droneId);
      }
    });
    const response = sosResponsesRef.current.get(sosId);
    if (response) response.tweens.push(tween);
  }

  /** Track a tween owned by a response so ending that response kills it. */
  function trackSosTween(sosId: string, tween: gsap.core.Tween) {
    const response = sosResponsesRef.current.get(sosId);
    if (response) response.tweens.push(tween);
  }

  /** Publish/refresh this call's route feature without disturbing the other
   *  concurrent SOS routes sharing the single `activeRoute` map source. */
  function setActiveRouteForSos(sosId: string, feature: GeoJSON.Feature<GeoJSON.LineString>) {
    activeRouteFeaturesRef.current.set(sosId, feature);
    setSource(mapRef.current, sources.activeRoute, featureCollection(Array.from(activeRouteFeaturesRef.current.values())));
  }

  /** Remove a call's route feature once its response ends. */
  function removeActiveRouteForSos(sosId: string) {
    activeRouteFeaturesRef.current.delete(sosId);
    setSource(mapRef.current, sources.activeRoute, featureCollection(Array.from(activeRouteFeaturesRef.current.values())));
  }

  /** Fade the route layers briefly, then drop only this call's feature (the
   *  layer opacity applies to every route in the source, so other live SOS
   *  routes dim momentarily - acceptable for the demo). */
  function fadeAndRemoveSosRoute(map: MapLibreMap, sosId: string, layerIds: string[], onComplete?: () => void) {
    const fadeState = { value: 1 };
    gsap.to(fadeState, {
      value: 0,
      duration: ROUTE_FADE_DURATION,
      ease: 'power1.out',
      onUpdate: () => {
        layerIds.forEach((layerId) => {
          const baseOpacity = ROUTE_LAYER_OPACITIES[layerId] ?? 1;
          setRouteLayerOpacity(map, layerId, baseOpacity * fadeState.value);
        });
      },
      onComplete: () => {
        removeActiveRouteForSos(sosId);
        resetRouteLayerOpacities(map, layerIds);
        onComplete?.();
      }
    });
  }

  /** Append a call-log entry locally (UI) and upsert it into Neon - the log is
   *  best-effort persistence, so a DB hiccup never blocks the live demo. */
  function pushSosLog(entry: SosLogEntry) {
    setSosLog((current) => {
      const exists = current.some((item) => item.id === entry.id);
      const merged = exists
        ? current.map((item) => item.id === entry.id ? { ...item, ...entry, updatedAt: new Date().toISOString() } : item)
        : [{ ...entry, updatedAt: new Date().toISOString() }, ...current];
      return merged.slice(0, 500);
    });
    fetch('/api/safety/sos-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cityId: safetyConfigRef.current.city.id, ...entry })
    }).catch(() => { /* persistence is best-effort */ });
    // Mirror every simulated call into the incident-reports table so the
    // right-side incident log panel is backed by the same Neon data.  Status
    // stages (Received -> Dispatched -> Monitoring -> Resolved) upsert the
    // same id, so the incident row follows the call's lifecycle.
    const severity = entry.priority === 'Critical' || entry.priority === 'High' || entry.priority === 'Medium' || entry.priority === 'Low'
      ? entry.priority
      : 'Medium';
    const status = entry.status === 'Resolved' ? 'Resolved' : entry.status === 'Received' ? 'Open' : 'Dispatched';
    const context = deriveIncidentContext(entry.coordinate);
    fetch('/api/safety/incidents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: entry.id,
        cityId: safetyConfigRef.current.city.id,
        title: entry.callerLabel,
        category: 'Other',
        severity,
        status,
        coordinate: entry.coordinate,
        street: context.street,
        landmark: context.landmark,
        reporterId: entry.callerLabel,
        responderNotes: entry.warning
          ? entry.warning
          : status === 'Dispatched'
            ? 'Drone dispatched; live tracking active.'
            : status === 'Resolved'
              ? 'Response complete; drone returning to patrol.'
              : 'SOS received; authorities alerted.',
        media: null,
        occurredAt: entry.startedAt || new Date().toISOString()
      })
    })
      .then((response) => {
        if (response.ok) window.dispatchEvent(new CustomEvent('sos-incident-updated'));
      })
      .catch(() => { /* persistence is best-effort */ });
  }

  /** Derive a human-readable street/landmark for the incident log from the
   *  nearest configured patrol point and danger zone. */
  function deriveIncidentContext(coordinate: Coordinate) {
    const zones = safetyConfigRef.current.dangerZones || [];
    const points = safetyConfigRef.current.patrolPoints || [];
    let nearestZone: { name: string; distance: number } | null = null;
    let nearestPoint: { name: string; distance: number } | null = null;
    zones.forEach((zone) => {
      const distance = turf.distance(turf.point(coordinate), turf.point(zone.coordinate), { units: 'kilometers' });
      if (!nearestZone || distance < nearestZone.distance) nearestZone = { name: zone.name, distance };
    });
    points.forEach((point) => {
      const distance = turf.distance(turf.point(coordinate), turf.point(point.coordinate), { units: 'kilometers' });
      if (!nearestPoint || distance < nearestPoint.distance) nearestPoint = { name: point.name, distance };
    });
    return {
      street: nearestPoint ? `${nearestPoint.name} area` : 'Patiala',
      landmark: nearestZone ? nearestZone.name : 'City center'
    };
  }

  /** True while at least one SOS response is in flight (drives the guards that
   *  keep Safe Walk and patrol-config restarts off the active grid). */
  function hasActiveSos() {
    return sosResponsesRef.current.size > 0;
  }

  /** Mirror sosResponsesRef into the activeSosIds state that drives the UI. */
  function syncActiveSosUi() {
    setActiveSosIds(Array.from(sosResponsesRef.current.keys()));
  }

  function completeSosResponse(sosId: string) {
    const response = sosResponsesRef.current.get(sosId);
    if (!response) return;
    // Stop tracking the real copter (operator ended the SOS mid-mission) -
    // the SITL copter itself keeps flying its own mission to completion.
    response.sitlUnsubscribe?.();
    response.sitlUnsubscribe = undefined;
    response.timers.forEach((timer) => window.clearTimeout(timer));
    response.tweens.forEach((tween) => tween.kill());
    response.tweens = [];

    const { patrolDroneId, stationDroneId, coverageDroneId } = response;
    // The dispatched drone may be a designated reserve OR a spare from the
    // pool - both are found by their own station reference, not just the
    // station's reserveDroneId column.
    const stationForDrone = (droneId: string) => {
      const drone = dronesRef.current.find((item) => item.id === droneId)
        || safetyConfigRef.current.drones.find((item) => item.id === droneId);
      if (!drone) return undefined;
      return safetyConfigRef.current.stations.find((item) =>
        item.reserveDroneId === droneId || item.id === drone.stationId || item.droneId === droneId);
    };
    const station = stationDroneId ? stationForDrone(stationDroneId) : undefined;
    const coverageStation = coverageDroneId ? stationForDrone(coverageDroneId) : undefined;

    const releaseCoverage = () => {
      if (!coverageDroneId || !coverageStation) return;
      patrolTweensRef.current.get(coverageDroneId)?.kill();
      returnDroneToStation(coverageDroneId, coverageStation, sosId);
    };

    // A station-dispatched reserve has no patrol handoff; return it directly.
    if (stationDroneId && station) {
      patrolTweensRef.current.get(stationDroneId)?.kill();
      returnDroneToStation(stationDroneId, station, sosId);
    }

    // Resume the original patrol from its live position. The reserve is only
    // released after the patrol loop completes its first rejoin segment.
    if (patrolDroneId) {
      const patrolDrone = dronesRef.current.find((drone) => drone.id === patrolDroneId)
        || safetyConfigRef.current.drones.find((drone) => drone.id === patrolDroneId);
      if (patrolDrone) {
        const currentPosition = liveDronePositionsRef.current.get(patrolDroneId) || patrolDrone.position;
        patrolTweensRef.current.get(patrolDroneId)?.kill();
        patrolTweensRef.current.delete(patrolDroneId);
        setDrones((current) => current.map((drone) => drone.id === patrolDroneId
          ? { ...drone, status: 'Patrol', response: 'patrol' }
          : drone));
        const patrolIndex = Math.max(0, safetyConfigRef.current.drones.findIndex((drone) => drone.id === patrolDroneId));
        // Route the rejoin through the planner so the drone does not cut
        // across red no-fly zones while returning to its patrol ring.  The
        // response cleanup below must not wait for the plan, so this runs
        // fire-and-forget (straight-line fallback when the planner is
        // unreachable).  The reserve is still released once the drone is
        // back on the ring (first ring segment complete).
        void (async () => {
          const rejoin = await planPath(currentPosition, patrolDrone.route[0]);
          const resumePath = rejoin.waypoints.length >= 2 ? rejoin.waypoints : undefined;
          runPatrolLoop(
            patrolDrone,
            patrolDrone.route,
            patrolIndex,
            24 + patrolIndex * 5,
            resumePath ? undefined : currentPosition,
            releaseCoverage,
            resumePath
          );
        })();
      } else {
        releaseCoverage();
      }
    } else {
      releaseCoverage();
    }

    removeActiveRouteForSos(sosId);
    setRouteProgress(0);
    sosResponsesRef.current.delete(sosId);
    busyDronesRef.current.delete(patrolDroneId || '');
    busyDronesRef.current.delete(stationDroneId || '');
    busyDronesRef.current.delete(coverageDroneId || '');
    syncActiveSosUi();
    setAlerts((current) => current.map((alert) => alert.id === sosId ? { ...alert, status: 'Resolved' } : alert));
    pushSosLog({
      id: sosId,
      callerLabel: response.alert.label,
      priority: response.alert.priority,
      coordinate: response.alert.coordinate,
      droneId: response.alert.droneId || null,
      status: 'Resolved',
      startedAt: new Date().toISOString(),
      resolvedAt: new Date().toISOString()
    });
    // Only clear the global banner / hide targets when the LAST response ends.
    if (sosResponsesRef.current.size === 0) {
      setSosBanner(null);
      setSosTargetVisible(false);
    }
    setToast('SOS ended; dispatched drone returning to patrol');
  }

  function endSosResponse(sosId: string) {
    if (!sosResponsesRef.current.has(sosId)) {
      setToast('SOS sequence cancelled');
      return;
    }
    completeSosResponse(sosId);
  }

  function beginSosSequence(alert: Alert, showPostArrivalBanners = false): boolean {
    // Safety net: never dispatch INTO a red (prohibited) zone - the seeds and
    // the demo picker already clamp, but a hotspot click / future caller
    // could land inside one; pull the target to the nearest safe spot.
    const redZones = (noFlyZonesRef.current ?? []).filter((zone) => zone.kind === 'red');
    const target = clampToSafeCoordinate(ensureLandCoordinate(alert.coordinate), redZones);
    if (!mapRef.current) return false;
    if (sosResponsesRef.current.has(alert.id)) {
      setToast(`Already responding to ${alert.id}`);
      return false;
    }
    const dispatch = getSosDispatch(target);
    if (!dispatch.drone) {
      setToast('No drone is currently available for SOS dispatch');
      return false;
    }
    const nextAlert: Alert = { ...alert, status: 'Drone dispatching', coordinate: target, droneId: dispatch.drone.id };
    const response: SosResponse = {
      id: nextAlert.id,
      alert: nextAlert,
      patrolDroneId: dispatch.usesPatrolDrone ? dispatch.drone.id : null,
      stationDroneId: dispatch.usesPatrolDrone ? null : dispatch.drone.id,
      coverageDroneId: null,
      tweens: [],
      timers: [],
      startedAt: Date.now()
    };
    sosResponsesRef.current.set(nextAlert.id, response);
    busyDronesRef.current.add(dispatch.drone.id);
    syncActiveSosUi();
    setActiveView('sos');
    setAlerts((current) => {
      const exists = current.some((item) => item.id === nextAlert.id);
      return exists
        ? current.map((item) => item.id === nextAlert.id ? nextAlert : item)
        : [nextAlert, ...current].slice(0, 6);
    });
    setTimeline((current) => [
      { time: 'Now', label: `${nextAlert.id} selected`, detail: dispatch.usesPatrolDrone
        ? `${dispatch.drone.id} assigned from its live patrol position to ${nextAlert.label}.`
        : `${dispatch.drone.id} launched from ${dispatch.station?.name || 'the nearest station'} to ${nextAlert.label}; patrol drone remains on route.` },
      { time: '+04s', label: 'Route generated', detail: 'Dispatch path generated from the selected drone’s actual launch position.' },
      { time: '+12s', label: 'Live tracking', detail: 'Operator timeline and drone position updating.' },
      ...current
    ].slice(0, 8));
    setToast(`${dispatch.drone.id} dispatched to ${nextAlert.id}`);
    if (!showPostArrivalBanners) setSosBanner('🛰️ SOS Active — monitoring caller');
    if (dispatch.usesPatrolDrone) startReserveCoverage(dispatch.drone, nextAlert.id);
    dispatchDrone(nextAlert.id, dispatch.drone.id, target, 'Dispatching', showPostArrivalBanners, dispatch.sourceCoordinate);
    setSosTargetVisible(true);
    pushSosLog({
      id: nextAlert.id,
      callerLabel: nextAlert.label,
      priority: nextAlert.priority,
      coordinate: target,
      droneId: dispatch.drone.id,
      status: 'Dispatched',
      startedAt: new Date().toISOString()
    });
    return true;
  }

  /** Enter/leave "Choose Location" mode: the next map click places the SOS
   *  exactly where the operator clicks (clamped to the operating area). */
  function toggleSosPickMode() {
    const next = !sosPickModeRef.current;
    sosPickModeRef.current = next;
    setSosPicking(next);
    const map = mapRef.current;
    if (map) map.getCanvas().style.cursor = next ? 'crosshair' : '';
    setToast(next ? 'Click anywhere on the map to place the SOS location' : 'SOS location picking cancelled');
  }

  function runSosDemo() {
    // A random simulation replaces any manual location pick in progress.
    if (sosPickModeRef.current) {
      sosPickModeRef.current = false;
      setSosPicking(false);
      const map = mapRef.current;
      if (map) map.getCanvas().style.cursor = '';
    }
    // Clear any previous banner timers
    sosBannerTimersRef.current.forEach((t) => window.clearTimeout(t));
    sosBannerTimersRef.current = [];
    setActiveView('sos');

    // Pick a random SOS caller from seeded alerts, then jitter the caller's
    // position a few hundred metres so the emergency lands off the patrol
    // routes at a plausible random spot - not on a patrolled waypoint.  Each
    // run gets a FRESH call id so every simulated call logs a distinct entry
    // in the SOS log (re-using the seeded id would overwrite history).
    const sosAlerts = alerts.filter((a) => a.id.startsWith('SOS'));
    const randomAlert = sosAlerts[Math.floor(Math.random() * sosAlerts.length)] || alerts[0];
    // Jitter off the patrol routes, then clamp out of any red (prohibited)
    // zone so the simulated caller is always reachable (the planner would
    // otherwise detour around it or stop short of it).
    const redZones = (noFlyZonesRef.current ?? []).filter((zone) => zone.kind === 'red');
    const caller: Alert = {
      ...randomAlert,
      id: `SOS-${Date.now().toString().slice(-6)}`,
      coordinate: clampToSafeCoordinate(jitterCoordinate(randomAlert.coordinate, 0.15, 0.45), redZones)
    };
    // Reflect the jittered caller position on the map right away, so the SOS
    // target marker does not appear at the seeded spot and then jump.
    // (beginSosSequence later reuses the same coordinate - idempotent.)
    setAlerts((current) => [{ ...caller, status: 'SOS Received' }, ...current].slice(0, 6));

    // Phase 1: SOS Received
    setSosBanner('🚨 SOS Received');
    setToast(`SOS received from ${caller.label}`);
    pushSosLog({
      id: caller.id,
      callerLabel: caller.label,
      priority: caller.priority,
      coordinate: caller.coordinate,
      droneId: null,
      status: 'Received',
      startedAt: new Date().toISOString()
    });

    // Phase 2: Alerted Authorities (after 2s)
    sosBannerTimersRef.current.push(window.setTimeout(() => {
      setSosBanner('🔔 Alerted Authorities');
      setTimeline((current) => [{ time: 'Now', label: 'Authorities alerted', detail: `Police and emergency services notified for ${caller.id}.` }, ...current].slice(0, 8));
    }, 2000));

    // Phase 3: Dispatch drone (after 4s)
    sosBannerTimersRef.current.push(window.setTimeout(() => {
      setSosBanner('🚁 Dispatching Drone');
      const started = beginSosSequence(caller, true);
      if (!started && sosResponsesRef.current.size === 0) {
        setSosBanner(null);
        setSosTargetVisible(false);
      }
    }, 4000));
  }

  /** Hand the SOS to the local ArduPilot SITL copter when the bridge is
   *  online and the copter is patrolling.  Returns true when the mission was
   *  accepted - the caller then skips the simulated GSAP flight.  The copter
   *  flies EN_ROUTE -> HOVERING (loiter) -> RTL itself; telemetry moves this
   *  drone's marker live, and returning to PATROL ends the response. */
  async function trySitlDispatch(sosId: string, droneId: string, target: Coordinate): Promise<boolean> {
    const status = sitlStatusRef.current;
    if (!status.available || status.phase !== 'PATROL') return false;
    const map = mapRef.current;
    const drone = dronesRef.current.find((item) => item.id === droneId)
      || safetyConfigRef.current.drones.find((item) => item.id === droneId);
    if (!map || !drone) return false;

    const mission = await dispatchSitlMission({ lat: target[1], lon: target[0], loiterSeconds: SITL_LOITER_SECONDS });
    if (!mission.ok) return false; // busy or unreachable - fall back to simulation

    if (isPoolDrone(drone)) setDroneMarkerVisible(droneId, true);
    setDrones((current) => current.map((item) => item.id === droneId ? { ...item, status: 'Dispatching', response: 'SITL en route' } : item));
    setTimeline((current) => [
      { time: 'Now', label: `${droneId} handed to SITL`, detail: `Real ArduPilot copter flying to ${sosId} (${target[1].toFixed(4)}, ${target[0].toFixed(4)}), loiter ${SITL_LOITER_SECONDS}s.` },
      ...current
    ].slice(0, 8));
    setToast(`SITL mission ${mission.missionId || 'accepted'} - ${droneId} en route`);

    // Snap the marker to the copter's current position before the first
    // telemetry frame arrives, so it does not sit at the old simulated spot.
    const initial = await getSitlStatus();
    if (initial && Number.isFinite(initial.lat) && Number.isFinite(initial.lon)) {
      updateDronePosition(droneId, [initial.lon, initial.lat], false);
    }

    // A mission starts with the copter still reporting PATROL for a moment;
    // only treat PATROL as "done" after we have seen a non-PATROL phase.
    let seenNonPatrol = false;
    let lastPhaseLabel = '';
    const unsubscribe = subscribeSitlTelemetry((telemetry) => {
      if (!sosResponsesRef.current.has(sosId)) {
        unsubscribe();
        return;
      }
      // Move the marker every frame; only re-render the drone list when the
      // status label actually changes (telemetry streams ~10x/sec).
      updateDronePosition(droneId, [telemetry.lon, telemetry.lat], false);
      const phaseLabel = `${sitlStatusForPhase(telemetry.phase)}|${sitlResponseForPhase(telemetry.phase)}`;
      if (phaseLabel !== lastPhaseLabel) {
        lastPhaseLabel = phaseLabel;
        setDrones((current) => current.map((item) => item.id === droneId
          ? { ...item, status: sitlStatusForPhase(telemetry.phase), response: sitlResponseForPhase(telemetry.phase) }
          : item));
      }
      if (telemetry.phase !== 'PATROL') {
        seenNonPatrol = true;
      } else if (seenNonPatrol) {
        // Mission complete: copter is back on patrol - close the stream and
        // run the normal post-incident cleanup (resume patrol loop, resolve).
        unsubscribe();
        completeSosResponse(sosId);
      }
    });
    const response = sosResponsesRef.current.get(sosId);
    if (response) response.sitlUnsubscribe = unsubscribe;
    return true;
  }

  async function dispatchDrone(sosId: string, droneId: string, target: Coordinate, status: Drone['status'], showPostArrivalBanners = false, sourceCoordinate?: Coordinate) {
    const drone = dronesRef.current.find((item) => item.id === droneId) || safetyConfigRef.current.drones.find((item) => item.id === droneId);
    const map = mapRef.current;
    if (!drone || !map) return;
    const safeTarget = ensureLandCoordinate(target);
    const safePosition = ensureLandCoordinate(sourceCoordinate || liveDronePositionsRef.current.get(droneId) || drone.position);
    const marker = droneMarkersRef.current.get(droneId);
    const usesPatrolDrone = !isPoolDrone(drone);

    if (usesPatrolDrone) patrolTweensRef.current.get(droneId)?.pause();
    resetRouteLayerOpacities(map, ['active-route-glow', 'active-route']);
    // Real SITL copter available and patrolling: hand the mission over and
    // skip the simulated GSAP flight entirely.  Falls back silently below.
    if (await trySitlDispatch(sosId, droneId, safeTarget)) return;
    setToast(`Optimizing dispatch route for ${droneId}...`);

    // The drone flies the planner's building-avoiding route from the start -
    // no straight-line lead.  Streamed stages move it along the growing path
    // as it is computed (A* search emits the path extending toward the goal
    // every ~150 ms), and the final route draws the route line + reports
    // warnings / zone crossings.  Intermediate stages just move the drone,
    // so there is no flicker from partial paths.
    const flight = {
      tween: null as ReturnType<typeof gsap.to> | null,
      progress: { value: 0 },
      isFinal: false,
      started: false,
      fitDone: false,
      totalKm: 0,
    };

    const stopFlightTween = () => {
      if (flight.tween) {
        flight.tween.kill();
        flight.tween = null;
      }
    };

    /** Re-target the drone from its current position onto `route` - the
     *  tween continues from where the drone is, so a mid-flight stage update
     *  never makes it jump back to the start of the new path. */
    const flyAlong = (
      route: Coordinate[],
      isFinal: boolean,
      warning?: string | null,
      zonesCrossed: NoFlyZoneInfo[] = [],
    ) => {
      if (!mapRef.current || !sosResponsesRef.current.has(sosId) || route.length < 2) return;
      if (isFinal) {
        flight.isFinal = true;
        if (warning) {
          setToast(`Degraded route: ${warning}`);
          setTimeline((current) => [{ time: 'Now', label: 'Degraded route', detail: warning }, ...current].slice(0, 8));
          pushSosLog({
            id: sosId,
            callerLabel: sosResponsesRef.current.get(sosId)?.alert.label || sosId,
            priority: sosResponsesRef.current.get(sosId)?.alert.priority || 'Critical',
            coordinate: safeTarget,
            droneId,
            status: 'Dispatched',
            startedAt: new Date().toISOString(),
            warning
          });
        }
        if (zonesCrossed.length) {
          // A facility can contribute several rings (runway + funnel + circles),
          // so dedupe names before showing them.  Amber = controlled airspace
          // (passable with permission); red should only appear on a degraded
          // route and is a hard prohibition, so say so instead of "permission".
          const names = Array.from(new Set(zonesCrossed.map((zone) => zone.name))).join(', ');
          const hasRed = zonesCrossed.some((zone) => zone.kind === 'red');
          if (hasRed) {
            setToast(`Route crosses PROHIBITED no-fly zone(s): ${names}`);
            setTimeline((current) => [{ time: 'Now', label: 'Prohibited zone crossed', detail: `Route crosses the prohibited no-fly zone(s): ${names}. Verify the route before flight.` }, ...current].slice(0, 8));
          } else {
            setToast(`Route crosses ${names} controlled airspace - permission required`);
            setTimeline((current) => [{ time: 'Now', label: 'Airspace permission required', detail: `Route crosses ${names} controlled airspace (amber) - notify the airport authority before dispatch.` }, ...current].slice(0, 8));
          }
        }
      }

      // Start the leg from the drone's current position: slice the new path
      // from the nearest point to the drone to the path end.  A re-targeted
      // stage therefore continues the flight instead of restarting it.
      const currentPos = ensureLandCoordinate(liveDronePositionsRef.current.get(droneId) || safePosition);
      const fullLine = turf.lineString(route, { sosId, droneId, target: status });
      if (isFinal) flight.totalKm = turf.length(fullLine, { units: 'kilometers' });
      let routeLine: GeoJSON.Feature<GeoJSON.LineString> = fullLine;
      const nearest = turf.nearestPointOnLine(fullLine, turf.point(currentPos), { units: 'kilometers' });
      const nearestCoord = nearest.geometry.coordinates as Coordinate;
      if (turf.distance(turf.point(route[0]), turf.point(currentPos), { units: 'kilometers' }) > 0.02) {
        try {
          const sliced = turf.lineSlice(turf.point(nearestCoord), turf.point(route[route.length - 1]), fullLine);
          sliced.properties = { sosId, droneId, target: status };
          routeLine = sliced;
        } catch {
          routeLine = fullLine;
        }
      }

      const distanceKm = turf.length(routeLine, { units: 'kilometers' });
      if (distanceKm < 0.001) return;

      stopFlightTween();
      flight.progress.value = 0;

      if (!flight.fitDone) {
        flight.fitDone = true;
        fitCollections(mapRef.current, [featureCollection([routeLine])]);
      }

      const legStart = routeLine.geometry.coordinates[0] as Coordinate;
      const tween = gsap.to(flight.progress, {
        value: 1,
        duration: Math.min(15, Math.max(2, distanceKm * 2.8)),
        ease: 'power1.inOut',
        onStart: () => {
          if (!flight.started) {
            flight.started = true;
            setRouteProgress(0);
            if (isPoolDrone(drone)) setDroneMarkerVisible(droneId, true);
            setDrones((current) => current.map((item) => item.id === droneId ? { ...item, status, response: 'en route' } : item));
          }
        },
        onUpdate: () => {
          const currentDist = distanceKm * flight.progress.value;
          const point = turf.along(routeLine, currentDist, { units: 'kilometers' });
          const currentCoord = point.geometry.coordinates as Coordinate;
          if (marker) updateDronePosition(droneId, currentCoord, false);
          // Partial legs re-target constantly, so only report progress once
          // the final route is flying (otherwise the bar flickers at 0).
          setRouteProgress(isFinal ? flight.progress.value : 0);

          // Draw the traveled line only once the final route is known -
          // partial stages move the drone without touching the map line.
          if (isFinal && currentDist > 0.001) {
            try {
              const trailedRoute = turf.lineSlice(turf.point(legStart), point, routeLine);
              trailedRoute.properties = { sosId, droneId, target: status };
              setActiveRouteForSos(sosId, trailedRoute as GeoJSON.Feature<GeoJSON.LineString>);
            } catch (e) {
              // Fallback for identical points
              setActiveRouteForSos(sosId, turf.lineString([legStart, currentCoord], { sosId, droneId, target: status }));
            }
          }
        },
        onComplete: () => {
          if (!flight.isFinal) return; // a later streamed stage re-targets the drone
          setDrones((current) => current.map((item) => item.id === droneId ? { ...item, status: 'Monitoring', response: 'on scene' } : item));
          setTimeline((current) => [{ time: 'Now', label: `${droneId} arrived`, detail: 'Drone is holding position over target.' }, ...current].slice(0, 8));
          setToast(`${droneId} arrived at target`);
          pushSosLog({
            id: sosId,
            callerLabel: sosResponsesRef.current.get(sosId)?.alert.label || sosId,
            priority: sosResponsesRef.current.get(sosId)?.alert.priority || 'Critical',
            coordinate: safeTarget,
            droneId,
            status: 'Monitoring',
            startedAt: new Date().toISOString(),
            routeKm: Math.round(flight.totalKm * 1000) / 1000
          });

          fadeAndRemoveSosRoute(map, sosId, ['active-route-glow', 'active-route'], () => {
            // The operator may end SOS while the arrival route is fading. Do not
            // start an orbit after the response has already been ended.
            if (!sosResponsesRef.current.has(sosId)) return;

            // Start circling the target
            const circleRadiusKm = 0.12; // 120 meters
            const circlePolygon = turf.circle(safeTarget, circleRadiusKm, { steps: 36, units: 'kilometers' });
            const circleCoords = circlePolygon.geometry.coordinates[0] as Coordinate[];
            const circleLine = turf.lineString(ensureLandRoute(circleCoords), { type: 'orbit' });
            const circleDistance = turf.length(circleLine, { units: 'kilometers' });

            // Transition from caller center to the orbit path smoothly
            const transitionRoute = turf.lineString([safeTarget, circleCoords[0]]);
            const transitionDist = turf.length(transitionRoute, { units: 'kilometers' });

            const transitionProgress = { value: 0 };
            const transitionTween = gsap.to(transitionProgress, {
              value: 1,
              duration: 2.5,
              ease: 'power1.inOut',
              onUpdate: () => {
                const point = turf.along(transitionRoute, transitionProgress.value * transitionDist, { units: 'kilometers' });
                if (marker) updateDronePosition(droneId, point.geometry.coordinates as Coordinate, false);
              },
              onComplete: () => {
                const circleProgress = { value: 0 };
                const orbitTween = gsap.to(circleProgress, {
                  value: 1,
                  duration: 10, // Faster orbit
                  repeat: -1,
                  ease: 'none',
                  onUpdate: () => {
                    const point = turf.along(circleLine, (circleProgress.value % 1) * circleDistance, { units: 'kilometers' });
                    if (marker) updateDronePosition(droneId, point.geometry.coordinates as Coordinate, false);
                  }
                });
                trackSosTween(sosId, orbitTween);
              }
            });
            trackSosTween(sosId, transitionTween);
          });

          if (showPostArrivalBanners) {
            // Sequential post-arrival banners (timers scoped to this response so
            // ending this call clears exactly its own announcements).
            setSosBanner('🎙️ Recording Audio');
            setTimeline((current) => [{ time: 'Now', label: 'Audio recording', detail: 'Drone microphone activated, recording ambient audio.' }, ...current].slice(0, 8));

            const pushResponseTimer = (delay: number, callback: () => void) => {
              const timer = window.setTimeout(callback, delay);
              const response = sosResponsesRef.current.get(sosId);
              if (response) response.timers.push(timer);
            };

            pushResponseTimer(2500, () => {
              setSosBanner('📡 Broadcasting Video');
              setTimeline((current) => [{ time: 'Now', label: 'Video broadcast', detail: 'Live HD video feed streaming to control center.' }, ...current].slice(0, 8));
            });

            pushResponseTimer(5000, () => {
              setSosBanner('📲 Sending Data to Close Contacts');
              setTimeline((current) => [{ time: 'Now', label: 'Contacts notified', detail: 'Location and live status sent to emergency contacts.' }, ...current].slice(0, 8));
            });

            pushResponseTimer(7500, () => {
              // Announcements are independent from the active SOS response. Keep
              // a compact active-state banner visible after the announcement
              // sequence finishes.
              setSosBanner('🛰️ SOS Active — monitoring caller');
            });
          } else {
            // A map-triggered SOS has no announcement sequence, but it remains
            // active until the operator explicitly ends it.
          }
        },
      });
      flight.tween = tween;
      trackSosTween(sosId, tween);
    };

    // Building-avoiding route from the planner.  The drone starts flying the
    // streamed stages as the route grows toward the target (never a straight
    // line), and the final route draws the line + reports warnings / zone
    // crossings.  The blocking fallback is used automatically when the stream
    // is flaky through the tunnel proxy.
    const planned = await planPath(safePosition, safeTarget, (partial) => flyAlong(partial, false));
    if (!mapRef.current || !sosResponsesRef.current.has(sosId)) return; // response ended while planning
    flyAlong(planned.waypoints, true, planned.warning, planned.zonesCrossed);
  }

  function getNearestDrone(target: Coordinate): Drone | undefined {
    const safeTarget = ensureLandCoordinate(target);
    return dronesRef.current
      .filter((drone) => drone.status === 'Patrol' && !isPoolDrone(drone))
      .map((drone) => ({
        drone,
        sourceCoordinate: ensureLandCoordinate(liveDronePositionsRef.current.get(drone.id) || drone.position),
        distance: turf.distance(
          turf.point(ensureLandCoordinate(liveDronePositionsRef.current.get(drone.id) || drone.position)),
          turf.point(safeTarget),
          { units: 'kilometers' }
        )
      }))
      .sort((a, b) => a.distance - b.distance)[0]?.drone;
  }

  function startSafeWalkSelection() {
    if (hasActiveSos()) {
      setToast('End the active SOS before starting Safe Walk');
      return;
    }
    setActiveView('safewalk');
    const resetUsers = seededSafeWalkUsers.map((u) => ({ ...u, origin: ensureLandCoordinate(u.origin), destination: ensureLandCoordinate(u.destination), status: 'waiting' as const, progress: 0, assignedDroneId: undefined }));
    setSafeWalkUsers(resetUsers);
    setSelectedSafeWalkUserId(null);
    activeRouteFeaturesRef.current.clear();
    setSource(mapRef.current, sources.activeRoute, emptyCollection);
    setSource(mapRef.current, sources.safeRoute, emptyCollection);
    setSource(mapRef.current, sources.safePoints, emptyCollection);
    
    // Display all waiting user markers on the map
    const userPoints = resetUsers.map((u) => turf.point(u.origin, { label: u.name, id: u.id }));
    setSource(mapRef.current, sources.safeUser, featureCollection(userPoints));
    
    setToast('Select a user to start Safe Walk escort');
  }

  async function selectSafeWalkUser(userId: string) {
    const user = safeWalkUsers.find((u) => u.id === userId);
    if (!user) return;
    setSelectedSafeWalkUserId(userId);
    const map = mapRef.current;
    if (!map) return;
    setToast('Optimizing Safe Walk route...');
    const route = (await planPath(user.origin, user.destination)).waypoints;
    const routeLine = turf.lineString(route, { type: 'Safe Walk' });
    resetRouteLayerOpacities(map, ['safe-route-glow', 'safe-route']);
    setSource(map, sources.safeRoute, featureCollection([routeLine]));
    setSource(map, sources.safeUser, featureCollection([turf.point(user.origin, { label: `${user.name}'s position` })]));
    setSource(map, sources.safePoints, featureCollection([
      turf.point(user.origin, { label: 'Origin', kind: 'origin' }),
      turf.point(user.destination, { label: 'Destination', kind: 'destination' })
    ]));
    fitCollections(map, [featureCollection([routeLine])]);
  }

  async function beginSafeWalkForUser(userId: string) {
    if (hasActiveSos()) {
      setToast('End the active SOS before starting Safe Walk');
      return;
    }
    const user = safeWalkUsers.find((u) => u.id === userId);
    if (!user || user.status !== 'waiting') return;
    const map = mapRef.current;
    if (!map) return;

    // Find the station closest to user's origin; dispatch drone from station
    const stationForDrone = (droneId: string) => safetyConfig.stations.find((s) => s.droneId === droneId);
    const nearest = getNearestDrone(user.origin);
    if (!nearest) {
      setToast('No patrol drone is currently available for Safe Walk');
      return;
    }
    const station = stationForDrone(nearest.id);
    const stationCoord = station ? ensureLandCoordinate(station.coordinate) : ensureLandCoordinate(nearest.position);

    // Assign drone
    setSafeWalkUsers((prev) => prev.map((u) => u.id === userId ? { ...u, status: 'pickup', assignedDroneId: nearest.id, progress: 0 } : u));
    setSafeWalk({ origin: user.origin, destination: user.destination, eta: 0, status: 'Optimizing escort route', activeDroneId: nearest.id });
    setTimeline((current) => [
      { time: 'Now', label: 'Safe Walk started', detail: `${nearest.id} dispatched from station to ${user.name}.` },
      ...current
    ].slice(0, 8));
    setToast(`Optimizing escort route for ${user.name}...`);

    // Stop patrol
    patrolTweensRef.current.get(nearest.id)?.pause();
    dispatchTweenRef.current?.kill();
    safeWalkTweensRef.current.get(userId)?.kill();

    // Build the pickup / escort / return legs with the route planner
    const [userPlan, pickupPlan, returnPlan] = await Promise.all([
      planPath(user.origin, user.destination),
      planPath(stationCoord, user.origin),
      planPath(user.destination, stationCoord),
    ]);
    if (!mapRef.current) return;
    const userRoute = userPlan.waypoints;
    const userRouteLine = turf.lineString(userRoute, { type: 'Safe Walk' });
    const userRouteDistance = turf.length(userRouteLine, { units: 'kilometers' });
    resetRouteLayerOpacities(map, ['safe-route-glow', 'safe-route']);

    // Phase 1: Drone flies from station to user's origin
    const pickupRoute = turf.lineString(pickupPlan.waypoints, { droneId: nearest.id, mode: 'pickup' });
    const pickupDistance = turf.length(pickupRoute, { units: 'kilometers' });
    setSource(map, sources.safeRoute, featureCollection([userRouteLine]));
    setSource(map, sources.safeUser, featureCollection([turf.point(user.origin, { label: `${user.name}'s position` })]));
    setSource(map, sources.safePoints, featureCollection([
      turf.point(user.origin, { label: 'Origin', kind: 'origin' }),
      turf.point(user.destination, { label: 'Destination', kind: 'destination' })
    ]));
    fitCollections(map, [featureCollection([pickupRoute, userRouteLine])]);

    setDrones((current) => current.map((d) => d.id === nearest.id ? { ...d, status: 'Dispatching', response: 'to user' } : d));
    const pickupProgress = { value: 0 };

    const pickupTween = gsap.to(pickupProgress, {
      value: 1,
      duration: Math.min(10, Math.max(4, pickupDistance * 2.4)),
      ease: 'power1.inOut',
      onUpdate: () => {
        const currentDist = pickupDistance * pickupProgress.value;
        const point = turf.along(pickupRoute, currentDist, { units: 'kilometers' });
        const currentCoord = point.geometry.coordinates as Coordinate;
        
        updateDronePosition(nearest.id, currentCoord, false);
        setSafeWalkUsers((prev) => prev.map((u) => u.id === userId ? { ...u, progress: pickupProgress.value * 0.15 } : u));
        setRouteProgress(pickupProgress.value * 0.15);
      },
      onComplete: () => {
        // Phase 2: Escort along user route
        setSafeWalkUsers((prev) => prev.map((u) => u.id === userId ? { ...u, status: 'escorting' } : u));
        setDrones((current) => current.map((d) => d.id === nearest.id ? { ...d, status: 'Monitoring', response: 'escort' } : d));
        setTimeline((current) => [{ time: 'Now', label: `${nearest.id} reached ${user.name}`, detail: 'Drone is now escorting beside the user.' }, ...current].slice(0, 8));
        setToast(`${nearest.id} is escorting ${user.name}`);

        const escortProgress = { value: 0 };
        
        const escortTween = gsap.to(escortProgress, {
          value: 1,
          duration: Math.min(24, Math.max(9, userRouteDistance * 4.2)),
          ease: 'none',
          onUpdate: () => {
            const currentDist = userRouteDistance * escortProgress.value;
            const userPoint = turf.along(userRouteLine, currentDist, { units: 'kilometers' });
            const userCoord = ensureLandCoordinate(userPoint.geometry.coordinates as Coordinate);
            const droneCoord = getEscortSideCoordinate(userRouteLine, userCoord, currentDist, userRouteDistance);
            
            setSource(map, sources.safeUser, featureCollection([turf.point(userCoord, { label: `${user.name}'s position` })]));
            updateDronePosition(nearest.id, droneCoord, false);
            setSafeWalkUsers((prev) => prev.map((u) => u.id === userId ? { ...u, progress: 0.15 + escortProgress.value * 0.7 } : u));
            setRouteProgress(0.15 + escortProgress.value * 0.7);
          },
          onComplete: () => {
            // Phase 3: Arrived — hold for 1 second
            const dest = ensureLandCoordinate(user.destination);
            setSource(map, sources.safeUser, featureCollection([turf.point(dest, { label: `${user.name} arrived` })]));
            setSafeWalkUsers((prev) => prev.map((u) => u.id === userId ? { ...u, status: 'arrived', progress: 0.85 } : u));
            setTimeline((current) => [{ time: 'Now', label: `${user.name} reached safely`, detail: `${nearest.id} confirmed safe arrival at destination.` }, ...current].slice(0, 8));
            setToast(`✅ ${user.name} reached safely!`);
            setRouteProgress(0.85);

            const holdTween = gsap.delayedCall(1.5, () => {
              // Phase 4: Return to station
              setSafeWalkUsers((prev) => prev.map((u) => u.id === userId ? { ...u, status: 'returning' } : u));
              setDrones((current) => current.map((d) => d.id === nearest.id ? { ...d, status: 'Dispatching', response: 'returning' } : d));
              setTimeline((current) => [{ time: 'Now', label: `${nearest.id} returning`, detail: 'Drone heading back to home station.' }, ...current].slice(0, 8));

              const returnRoute = turf.lineString(returnPlan.waypoints, { droneId: nearest.id, mode: 'return' });
              const returnDistance = turf.length(returnRoute, { units: 'kilometers' });

              const returnProgress = { value: 0 };

              const returnTween = gsap.to(returnProgress, {
                value: 1,
                duration: Math.min(10, Math.max(4, returnDistance * 2.4)),
                ease: 'power1.inOut',
                onUpdate: () => {
                  const currentDist = returnDistance * returnProgress.value;
                  const point = turf.along(returnRoute, currentDist, { units: 'kilometers' });
                  const currentCoord = point.geometry.coordinates as Coordinate;
                  
                  updateDronePosition(nearest.id, currentCoord, false);
                  setSafeWalkUsers((prev) => prev.map((u) => u.id === userId ? { ...u, progress: 0.85 + returnProgress.value * 0.15 } : u));
                  setRouteProgress(0.85 + returnProgress.value * 0.15);
                },
                onComplete: () => {
                  // Done — resume patrol
                  setSafeWalkUsers((prev) => prev.map((u) => u.id === userId ? { ...u, status: 'complete', progress: 1 } : u));
                  setDrones((current) => current.map((d) => d.id === nearest.id ? { ...d, status: 'Patrol', response: 'complete' } : d));
                  setSafeWalk((current) => ({ ...current, status: 'Escort complete' }));
                  setTimeline((current) => [{ time: 'Now', label: `${nearest.id} at station`, detail: 'Drone returned and resuming patrol.' }, ...current].slice(0, 8));
                  setToast(`${nearest.id} returned to station`);
                  fadeAndClearRoute(map, sources.safeRoute, ['safe-route-glow', 'safe-route'], () => {
                    // Restart patrol
                    const droneData = safetyConfig.drones.find((d) => d.id === nearest.id);
                    if (droneData) {
                      patrolTweensRef.current.get(nearest.id)?.kill();
                      const safeRoute = ensureLandRoute(droneData.route);

                      const flyToStart = turf.lineString([stationCoord, safeRoute[0]]);
                      const flyDist = turf.length(flyToStart, { units: 'kilometers' });

                      if (flyDist > 0.05) {
                        const flyProgress = { value: 0 };
                        const flyTween = gsap.to(flyProgress, {
                          value: 1,
                          duration: Math.max(2, flyDist * 2.5),
                          ease: 'power1.inOut',
                          onUpdate: () => {
                            const pt = turf.along(flyToStart, flyProgress.value * flyDist, { units: 'kilometers' });
                            updateDronePosition(nearest.id, pt.geometry.coordinates as Coordinate, false);
                          },
                          onComplete: () => {
                            const patrolIndex = Math.max(0, safetyConfig.drones.findIndex((d) => d.id === nearest.id));
                            runPatrolLoop(droneData, safeRoute, patrolIndex, 24 + patrolIndex * 5);
                          }
                        });
                        patrolTweensRef.current.set(nearest.id, flyTween);
                      } else {
                        const patrolIndex = Math.max(0, safetyConfig.drones.findIndex((d) => d.id === nearest.id));
                        runPatrolLoop(droneData, safeRoute, patrolIndex, 24 + patrolIndex * 5);
                      }
                    }
                  });
                }
              });
              safeWalkTweensRef.current.set(userId, returnTween);
            });
            safeWalkTweensRef.current.set(userId + '-hold', holdTween);
          }
        });
        safeWalkTweensRef.current.set(userId, escortTween);
      }
    });
    safeWalkTweensRef.current.set(userId, pickupTween);
  }

  async function buildSafeWalk(origin: Coordinate, destination: Coordinate): Promise<SafeWalk> {
    const safeOrigin = ensureLandCoordinate(origin);
    const safeDestination = ensureLandCoordinate(destination);
    if (hasActiveSos()) {
      setToast('End the active SOS before starting Safe Walk');
      return { origin: safeOrigin, destination: safeDestination, eta: 0, status: 'SOS response active' };
    }
    setToast('Optimizing Safe Walk route...');
    const route = (await planPath(safeOrigin, safeDestination)).waypoints;
    const routeLine = turf.lineString(route, { type: 'Safe Walk' });
    const distance = turf.length(routeLine, { units: 'kilometers' });
    const nearest = getNearestDrone(safeOrigin);
    if (!nearest) {
      setToast('No patrol drone is currently available for Safe Walk');
      return { origin: safeOrigin, destination: safeDestination, eta: 0, status: 'No patrol drone available' };
    }
    const map = mapRef.current;
    resetRouteLayerOpacities(map, ['safe-route-glow', 'safe-route']);
    setSource(map, sources.safeRoute, featureCollection([routeLine]));
    setSource(map, sources.safeUser, featureCollection([turf.point(safeOrigin, { label: 'User live position' })]));
    setSource(map, sources.safePoints, featureCollection([
      turf.point(safeOrigin, { label: 'User origin', kind: 'origin' }),
      turf.point(safeDestination, { label: 'User destination', kind: 'destination' })
    ]));
    if (map) fitCollections(map, [featureCollection([routeLine])]);
    startSafeWalkEscort(nearest.id, routeLine);
    setTimeline((current) => [
      { time: 'Now', label: 'Safe Walk route active', detail: `${nearest.id} flying to the user pickup point.` },
      { time: '+10s', label: 'ETA calculated', detail: `${Math.round((distance / 4.7) * 60)} min walking estimate.` },
      ...current
    ].slice(0, 8));
    setToast(`${nearest.id} assigned to Safe Walk`);
    return { origin: safeOrigin, destination: safeDestination, eta: Math.max(3, Math.round((distance / 4.7) * 60)), status: 'Live monitoring active', activeDroneId: nearest.id };
  }

  async function saveSafetyConfig(nextConfig: SafetyConfig) {
    try {
      const response = await fetch('/api/safety/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(nextConfig)
      });
      if (!response.ok) {
        let message = 'Could not save command configuration';
        try {
          const body = await response.json() as { error?: string };
          if (body?.error) message = body.error;
        } catch { /* keep the generic message */ }
        throw new Error(message);
      }
      const saved = await response.json() as SafetyConfig;
      setSafetyConfig(saved);
      setDrones(saved.drones);
      persistActiveCity(saved.city.id);
      setActiveCityId(saved.city.id);
      refreshCities();
      setStudioOpen(false);
      setToast(`${saved.city.name} command configuration synced to Neon`);
      mapRef.current?.easeTo({ center: saved.city.center, zoom: saved.city.zoom, duration: 900 });
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'Could not save command configuration');
    }
  }

  async function startSafeWalkEscort(droneId: string, userRouteLine: GeoJSON.Feature<GeoJSON.LineString>) {
    const drone = dronesRef.current.find((item) => item.id === droneId) || safetyConfig.drones.find((item) => item.id === droneId);
    const map = mapRef.current;
    if (!drone || !map) return;

    patrolTweensRef.current.get(droneId)?.pause();
    dispatchTweenRef.current?.kill();

    const userRouteDistance = turf.length(userRouteLine, { units: 'kilometers' });
    const origin = ensureLandCoordinate(userRouteLine.geometry.coordinates[0] as Coordinate);
    const dispatchLeg = await planPath(ensureLandCoordinate(drone.position), origin);
    const dispatchRoute = turf.lineString(dispatchLeg.waypoints, { droneId, mode: 'pickup' });
    const dispatchDistance = turf.length(dispatchRoute, { units: 'kilometers' });

    const pickupProgress = { value: 0 };
    dispatchTweenRef.current = gsap.to(pickupProgress, {
      value: 1,
      duration: Math.min(10, Math.max(4, dispatchDistance * 2.4)),
      ease: 'power1.inOut',
      onStart: () => {
        setRouteProgress(0);
        setDrones((current) => current.map((item) => item.id === droneId ? { ...item, status: 'Dispatching', response: 'to user' } : item));
      },
      onUpdate: () => {
        const point = turf.along(dispatchRoute, dispatchDistance * pickupProgress.value, { units: 'kilometers' });
        updateDronePosition(droneId, point.geometry.coordinates as Coordinate, false);
        setRouteProgress(pickupProgress.value * 0.35);
      },
      onComplete: () => {
        setTimeline((current) => [{ time: 'Now', label: `${droneId} reached user`, detail: 'Drone is now escorting beside the user route.' }, ...current].slice(0, 8));
        setDrones((current) => current.map((item) => item.id === droneId ? { ...item, status: 'Monitoring', response: 'escort' } : item));

        const escortProgress = { value: 0 };
        dispatchTweenRef.current = gsap.to(escortProgress, {
          value: 1,
          duration: Math.min(24, Math.max(9, userRouteDistance * 4.2)),
          ease: 'none',
          onUpdate: () => {
            const currentDist = userRouteDistance * escortProgress.value;
            const userPoint = turf.along(userRouteLine, currentDist, { units: 'kilometers' });
            const userCoordinate = ensureLandCoordinate(userPoint.geometry.coordinates as Coordinate);
            const droneCoordinate = getEscortSideCoordinate(userRouteLine, userCoordinate, currentDist, userRouteDistance);
            setSource(map, sources.safeUser, featureCollection([turf.point(userCoordinate, { label: 'User live position' })]));
            updateDronePosition(droneId, droneCoordinate, false);
            setRouteProgress(0.35 + escortProgress.value * 0.65);
          },
          onComplete: () => {
            const destination = ensureLandCoordinate(userRouteLine.geometry.coordinates.at(-1) as Coordinate);
            setSource(map, sources.safeUser, featureCollection([turf.point(destination, { label: 'User arrived' })]));
            setDrones((current) => current.map((item) => item.id === droneId ? { ...item, status: 'Patrol', response: 'complete' } : item));
            setSafeWalk((current) => ({ ...current, status: 'User reached destination' }));
            setTimeline((current) => [{ time: 'Now', label: 'Safe Walk complete', detail: `${droneId} escorted the user to the destination.` }, ...current].slice(0, 8));
            setToast('Safe Walk complete. User reached destination.');
          }
        });
      }
    });
  }

  return (
    <div className="app">
      <div ref={mapNode} className="map" />
      <div className="vignette" />
      <div className="scanlines" />

      <AnimatePresence>
        {operationsOpen && (
          <motion.aside className="glass-panel sidebar" initial={{ x: -32, opacity: 0, filter: 'blur(8px)' }} animate={{ x: 0, opacity: 1, filter: 'blur(0px)' }} exit={{ x: -22, opacity: 0, filter: 'blur(8px)' }}>
            <div className="metrics-grid">
              <Metric icon={<Bot size={16} />} label="Available drones" value={`${activeDrones}/${drones.filter((drone) => !isPoolDrone(drone)).length}`} />
              <Metric icon={<Siren size={16} />} label="Active SOS" value={String(criticalAlerts)} danger={criticalAlerts > 0} />
              <Metric icon={<UserRound size={16} />} label="Safe Walk" value={safeWalk.activeDroneId ? '1 live' : 'standby'} />
              <Metric icon={<Timer size={16} />} label="Avg response" value={responseMetric} />
            </div>

            <SectionTitle icon={<History size={15} />} label="SOS Log" />
            <div className="sos-log-list">
              {sosLog.slice(0, sosLogExpanded ? undefined : 5).map((entry) => (
                <button
                  className={`sos-log-row${isLogEntryActive(entry) ? ' active' : ''}`}
                  key={entry.id}
                  type="button"
                  onClick={() => mapRef.current?.easeTo({ center: entry.coordinate, zoom: 15, duration: 850, easing: easeOut })}
                >
                  <span className="sos-log-row-title">
                    <span className={isLogEntryActive(entry) ? 'sos-log-pulse' : 'sos-log-dot'} />
                    <strong>{entry.id}</strong>
                    {isLogEntryActive(entry) && <em>active</em>}
                  </span>
                  <span>{entry.callerLabel}</span>
                  <small>{entry.status}{entry.droneId ? ` / ${entry.droneId}` : ''} · {logTimeAgo(entry)}</small>
                </button>
              ))}
              {sosLog.length === 0 && <div className="sos-log-empty">No SOS calls logged yet - run a simulation or place a location.</div>}
            </div>
            {sosLog.length > 5 && (
              <button
                className="sos-log-more"
                type="button"
                onClick={() => {
                  if (sosLogExpanded) {
                    setSosLogExpanded(false);
                    return;
                  }
                  // Pull the complete persisted history before expanding.
                  fetch(`/api/safety/sos-log?cityId=${encodeURIComponent(activeCityId)}&limit=500`)
                    .then((response) => response.ok ? response.json() : Promise.reject(new Error('SOS log unavailable')))
                    .then((data: { entries: SosLogEntry[] }) => {
                      if (Array.isArray(data.entries) && data.entries.length) setSosLog(data.entries);
                    })
                    .catch(() => { /* keep the local list */ });
                  setSosLogExpanded(true);
                }}
              >
                {sosLogExpanded ? 'Show fewer' : `Full log (${sosLog.length} calls)`}
              </button>
            )}

            <SectionTitle icon={<Radio size={15} />} label="Available Drones" />
            <div className="drone-list">
              {drones.filter((drone) => drone.role !== 'Spare').map((drone) => (
                <button className="drone-row" key={drone.id} type="button" onClick={() => mapRef.current?.easeTo({ center: drone.position, zoom: 14.6, duration: 800, easing: easeOut })}>
                  <span className={`status-dot ${drone.status.toLowerCase()}`} />
                  <span>
                    <strong>{drone.id}</strong>
                    <small>{drone.label} / {stationNameForDrone(drone.id, safetyConfig.stations)}</small>
                  </span>
                  <em>{drone.battery}%</em>
                </button>
              ))}
            </div>

          </motion.aside>
        )}
      </AnimatePresence>

      <motion.header className="glass-panel top-dock" initial={{ y: -26, opacity: 0 }} animate={{ y: 0, opacity: 1 }}>
        <div className="top-title">
          <strong>Dashboard</strong>
          <span className={`sitl-pill${sitlAvailable ? ' live' : ''}`} title={sitlAvailable && sitlPhase ? `SITL bridge online - phase ${sitlPhase}` : 'SITL bridge offline - flights are simulated (GSAP)'}>
            <span className="sitl-pill-dot" />
            {sitlAvailable ? `SITL ${sitlPhase ?? 'LIVE'}` : 'SIM'}
          </span>
        </div>
        <div className="top-actions">
          <button
            className={operationsOpen ? 'pill active' : 'pill'}
            type="button"
            onClick={() => setOperationsOpen((current) => !current)}
          >
            <PanelLeftOpen size={16} />
            <span>Operations</span>
          </button>
          {(['dashboard', 'sos', 'safewalk', 'about'] as NavView[]).map((view) => (
            <button
              key={view}
              className={activeView === view ? 'pill active' : 'pill'}
              type="button"
              onClick={() => {
                setOperationsOpen(false);
                setDeckVisible(true);
                setActiveView(view);
              }}
            >
              {navIcon(view)}
              <span>{navLabel(view)}</span>
            </button>
          ))}
        </div>
      </motion.header>

      <AnimatePresence mode="wait">
        {!operationsOpen && deckVisible && (
          <motion.section
            className="glass-panel action-deck"
            initial={{ x: -28, opacity: 0, filter: 'blur(8px)' }}
            animate={{ x: 0, opacity: 1, filter: 'blur(0px)' }}
            exit={{ x: -22, opacity: 0, filter: 'blur(8px)' }}
            onMouseEnter={() => { deckHoverRef.current = true; }}
            onMouseLeave={() => { deckHoverRef.current = false; }}
          >
            <button
              className="deck-close"
              type="button"
              aria-label="Hide panel"
              title="Hide panel"
              onClick={() => setDeckVisible(false)}
            >
              <X size={14} />
            </button>
            {activeView === 'sos' ? (
              <SosDemo timeline={timeline} progress={routeProgress} runSosDemo={runSosDemo} endSosResponse={endSosResponse} activeSos={activeSosSummaries} sosPicking={sosPicking} onToggleSosPick={toggleSosPickMode} />
            ) : activeView === 'safewalk' ? (
              <SafeWalkDemo safeWalk={safeWalk} safeWalkUsers={safeWalkUsers} selectedUserId={selectedSafeWalkUserId} startSafeWalkSelection={startSafeWalkSelection} selectUser={selectSafeWalkUser} beginWalk={beginSafeWalkForUser} routeProgress={routeProgress} />
            ) : activeView === 'about' ? (
              <AboutPanel />
            ) : (
              <DashboardDeck timeline={timeline} openSosDemo={runSosDemo} startSafeWalkSelection={startSafeWalkSelection} openStudio={() => { setStudioTab('city'); setStudioOpen(true); }} showNoFly={showNoFly} noFlyAvailable={Boolean(noFlyZones && noFlyZones.length > 0)} onToggleNoFly={() => setShowNoFly((current) => !current)} />
            )}
          </motion.section>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {studioOpen && (
          <CommandStudio
            key={safetyConfig.city.id}
            config={safetyConfig}
            initialTab={studioTab}
            onTabChange={setStudioTab}
            onClose={() => setStudioOpen(false)}
            onSave={saveSafetyConfig}
            onSwitchCity={switchCity}
            onDeleteCity={deleteCity}
            cities={cities}
            noFlyZones={noFlyZones ?? []}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {sosBanner && (
          <motion.div
            className="sos-banner"
            key={sosBanner}
            initial={{ y: -60, opacity: 0, scale: 0.95 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: -40, opacity: 0, scale: 0.95 }}
            transition={{ type: 'spring', damping: 20, stiffness: 300 }}
          >
            <Siren size={22} />
            <span>{sosBanner}</span>
            <Siren size={22} />
          </motion.div>
        )}
      </AnimatePresence>

      <motion.section className="glass-panel legend" initial={{ y: 24, opacity: 0 }} animate={{ y: 0, opacity: 1 }}>
        <div className="legend-item"><span className="legend-dot drone" />Drone</div>
        <div className="legend-item"><span className="legend-dot station" />Station</div>
        <div className="legend-item"><span className="legend-dot patrol" />Patrol zone</div>
        <div className="legend-item"><span className="legend-dot sos" />Danger zones</div>
        {sosTargetVisible && <div className="legend-item"><span className="legend-dot target" />SOS caller</div>}
        {activeView === 'safewalk' && <div className="legend-item"><span className="legend-dot safewalk-user" />Safe Walk User</div>}
        {noFlyZones && noFlyZones.length > 0 && (
          <>
            <div className="legend-item"><span className="legend-dot nofly-red" />No-fly (red)</div>
            <div className="legend-item"><span className="legend-dot nofly-amber" />Airspace (amber)</div>
          </>
        )}
        <div className="legend-heat"><span className="heat-swatch" />Risk heat</div>
      </motion.section>

      <IncidentLogs cityId={activeCityId} />

      <AnimatePresence>
        <motion.div className="toast" key={toast} initial={{ y: 18, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 12, opacity: 0 }}>
          {toast}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

function SosDemo({ timeline, progress, runSosDemo, endSosResponse, activeSos, sosPicking, onToggleSosPick }: {
  timeline: TimelineEvent[];
  progress: number;
  runSosDemo: () => void;
  endSosResponse: (id: string) => void;
  activeSos: Array<{ id: string; label: string; droneId: string | null }>;
  sosPicking: boolean;
  onToggleSosPick: () => void;
}) {
  return (
    <>
      <PanelTitle eyebrow="SOS Demo" title="Emergency Dispatch" subtitle="Multiple calls can run concurrently - each dispatch claims its own drone." />
      <button className="primary-action danger-action" type="button" onClick={runSosDemo}>
        <Siren size={17} /> {activeSos.length > 0 ? `Simulate Another SOS (${activeSos.length} active)` : 'Simulate SOS'}
      </button>
      <button
        className={sosPicking ? 'primary-action sos-pick-action active' : 'primary-action sos-pick-action'}
        type="button"
        onClick={onToggleSosPick}
      >
        <MapPin size={17} /> {sosPicking ? 'Click on map to place SOS...' : 'Choose Location'}
      </button>
      {activeSos.length > 0 && (
        <div className="sos-active-list">
          <SectionTitle icon={<Siren size={15} />} label={`Active responses (${activeSos.length})`} />
          {activeSos.map((sos) => (
            <div className="sos-active-row" key={sos.id}>
              <span className="sos-active-info">
                <strong>{sos.id}</strong>
                <small>{sos.label}</small>
                <em>{sos.droneId ? `drone ${sos.droneId}` : 'assigning drone'}</em>
              </span>
              <button className="sos-end-action" type="button" onClick={() => endSosResponse(sos.id)}>
                End SOS
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="progress-track"><span style={{ width: `${Math.round(progress * 100)}%` }} /></div>
      <Timeline timeline={timeline} />
    </>
  );
}

function SafeWalkDemo({ safeWalk, safeWalkUsers, selectedUserId, startSafeWalkSelection, selectUser, beginWalk, routeProgress }: {
  safeWalk: SafeWalk;
  safeWalkUsers: SafeWalkUser[];
  selectedUserId: string | null;
  startSafeWalkSelection: () => void;
  selectUser: (id: string) => void;
  beginWalk: (id: string) => void;
  routeProgress: number;
}) {
  const selectedUser = safeWalkUsers.find((u) => u.id === selectedUserId);
  return (
    <>
      <PanelTitle eyebrow="Safe Walk" title="User Route Escort" subtitle="Select a user to view their route and start drone escort." />

      <SectionTitle icon={<UserRound size={15} />} label="Users" />
      <div className="safe-walk-user-list">
        {safeWalkUsers.map((user) => (
          <button
            className={`safe-walk-user-row ${selectedUserId === user.id ? 'selected' : ''}`}
            key={user.id}
            type="button"
            onClick={() => selectUser(user.id)}
          >
            <span className="sw-user-info">
              <strong>{user.name}</strong>
              <small>{safeWalkStatusLabel(user.status)}</small>
            </span>
            <span className={`sw-status-badge ${user.status}`}>{user.status}</span>
            <div className="sw-progress-track"><span style={{ width: `${Math.round(user.progress * 100)}%` }} /></div>
          </button>
        ))}
      </div>

      {selectedUser && (
        <div className="safe-route-card">
          <Metric icon={<Route size={16} />} label="Progress" value={`${Math.round(routeProgress * 100)}%`} />
          <Metric icon={<Shield size={16} />} label="Status" value={safeWalkStatusLabel(selectedUser.status)} />
          <Metric icon={<Bot size={16} />} label="Drone" value={selectedUser.assignedDroneId || 'pending'} />
          {selectedUser.status === 'waiting' && (
            <button className="primary-action" type="button" onClick={() => beginWalk(selectedUser.id)} style={{ marginTop: '8px' }}>
              <Zap size={17} /> Start Safe Walk
            </button>
          )}
        </div>
      )}
    </>
  );
}

function safeWalkStatusLabel(status: SafeWalkUser['status']) {
  const labels: Record<SafeWalkUser['status'], string> = {
    waiting: 'Waiting for escort',
    pickup: 'Drone en route',
    escorting: 'Being escorted',
    arrived: 'Reached safely ✅',
    returning: 'Drone returning',
    complete: 'Completed'
  };
  return labels[status];
}

/** Draft geometry for a brand-new city built on the add-city map: a center
 *  marker, response stations, danger-zone vertex markers, and closed loops
 *  (each loop becomes one danger zone whose area is the polygon). */
type CityBuild = {
  center: Coordinate;
  stations: Array<{ id: string; name: string; coordinate: Coordinate }>;
  vertices: Array<{ id: string; coordinate: Coordinate }>;
  zones: Array<{ id: string; ring: Coordinate[] }>;
};

const emptyCityBuild = (center: Coordinate): CityBuild => ({ center, stations: [], vertices: [], zones: [] });

type StudioMapItemKind = 'city' | 'stations' | 'drones' | 'dangerZones';

type StudioMapItem = {
  key: string;
  name: string;
  coordinate: Coordinate;
  kind: StudioMapItemKind;
  index: number;
};

const STUDIO_KIND_COLOR: Record<StudioMapItemKind, string> = {
  city: '#0891b2',
  stations: '#0891b2',
  drones: '#7c3aed',
  dangerZones: '#ef4444'
};

const STUDIO_KIND_LABEL: Record<StudioMapItemKind, string> = {
  city: 'City center',
  stations: 'Response station',
  drones: 'Drone',
  dangerZones: 'Danger zone'
};

function studioMarkerElement(name: string, kind: StudioMapItemKind, active: boolean): HTMLDivElement {
  const el = document.createElement('div');
  el.className = `studio-marker${active ? ' active' : ''}`;
  const color = STUDIO_KIND_COLOR[kind];
  el.style.setProperty('--marker-color', color);
  el.style.setProperty('--marker-active', `${color}3d`);
  const dot = document.createElement('span');
  dot.className = 'studio-marker-dot';
  const tip = document.createElement('span');
  tip.className = 'studio-marker-tip';
  tip.textContent = name;
  el.append(dot, tip);
  return el;
}

function applyPatrolRings(map: MapLibreMap, rings: Coordinate[][]) {
  if (!map.getSource('picker-patrol')) {
    map.addSource('picker-patrol', { type: 'geojson', data: emptyCollection });
    map.addLayer({ id: 'picker-patrol-fill', type: 'fill', source: 'picker-patrol', paint: { 'fill-color': '#0891b2', 'fill-opacity': 0.1 } });
    map.addLayer({ id: 'picker-patrol-line', type: 'line', source: 'picker-patrol', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#0891b2', 'line-width': 2, 'line-opacity': 0.7, 'line-dasharray': [1.4, 1.8] } });
  }
  setSource(map, 'picker-patrol', rings.length
    ? featureCollection(rings.map((ring) => ({ type: 'Feature' as const, properties: {}, geometry: { type: 'Polygon' as const, coordinates: [ring] } })))
    : emptyCollection);
}

function applyNoFlyOverlay(map: MapLibreMap, zones: NoFlyZoneInfo[]) {
  if (!zones.length) return;
  if (!map.getSource('picker-nofly')) {
    map.addSource('picker-nofly', { type: 'geojson', data: emptyCollection });
    map.addLayer({ id: 'picker-nofly-red-fill', type: 'fill', source: 'picker-nofly', filter: ['==', ['get', 'kind'], 'red'], paint: { 'fill-color': '#dc2626', 'fill-opacity': 0.18 } });
    map.addLayer({ id: 'picker-nofly-red-line', type: 'line', source: 'picker-nofly', filter: ['==', ['get', 'kind'], 'red'], paint: { 'line-color': '#dc2626', 'line-width': 1.5, 'line-opacity': 0.75 } });
    map.addLayer({ id: 'picker-nofly-amber-fill', type: 'fill', source: 'picker-nofly', filter: ['==', ['get', 'kind'], 'amber'], paint: { 'fill-color': '#f59e0b', 'fill-opacity': 0.12 } });
    map.addLayer({ id: 'picker-nofly-amber-line', type: 'line', source: 'picker-nofly', filter: ['==', ['get', 'kind'], 'amber'], paint: { 'line-color': '#f59e0b', 'line-width': 1.5, 'line-opacity': 0.6, 'line-dasharray': [2, 2] } });
  }
  setSource(map, 'picker-nofly', featureCollection(zones.map((zone) => ({
    type: 'Feature' as const,
    properties: { kind: zone.kind, name: zone.name },
    geometry: { type: 'Polygon' as const, coordinates: [zone.ring.map(([lat, lon]) => [lon, lat])] }
  }))));
}

function fitPickerMap(map: MapLibreMap, items: StudioMapItem[]) {
  if (!items.length) return;
  if (items.length === 1) {
    map.jumpTo({ center: items[0].coordinate, zoom: 13 });
    return;
  }
  const coords = items.map((item) => item.coordinate);
  const bounds = coords.reduce((nextBounds, coordinate) => nextBounds.extend(coordinate as Coordinate), new LngLatBounds(coords[0] as Coordinate, coords[0] as Coordinate));
  map.fitBounds(bounds, { padding: 52, maxZoom: 14.5, duration: 600 });
}

function LocationPicker({ label, coordinate, onPlace, items, activeKey, onSelectItem, noFlyZones, patrolRings }: {
  label: string;
  coordinate: Coordinate;
  onPlace: (coordinate: Coordinate) => void;
  items: StudioMapItem[];
  activeKey: string | null;
  onSelectItem: (item: StudioMapItem) => void;
  noFlyZones: NoFlyZoneInfo[];
  patrolRings: Coordinate[][];
}) {
  const mapNode = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markersRef = useRef<Map<string, maplibregl.Marker>>(new Map());
  const coordinateRef = useRef(coordinate);
  const onPlaceRef = useRef(onPlace);
  const onSelectItemRef = useRef(onSelectItem);
  const noFlyZonesRef = useRef(noFlyZones);
  const patrolRingsRef = useRef(patrolRings);
  const itemsRef = useRef(items);
  const dragKeyRef = useRef<string | null>(null);
  const lastDragEndRef = useRef(0);
  const suppressEaseRef = useRef(false);
  const fittedKeysRef = useRef('');
  const [mapLoaded, setMapLoaded] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Array<{ display_name: string; lat: string; lon: string }>>([]);
  const [searching, setSearching] = useState(false);
  const [searchMessage, setSearchMessage] = useState('');
  const searchAbortRef = useRef<AbortController | null>(null);
  const lastSearchAtRef = useRef(0);

  useEffect(() => {
    coordinateRef.current = coordinate;
    onPlaceRef.current = onPlace;
    onSelectItemRef.current = onSelectItem;
    noFlyZonesRef.current = noFlyZones;
    patrolRingsRef.current = patrolRings;
    itemsRef.current = items;
  }, [coordinate, onPlace, onSelectItem, noFlyZones, patrolRings, items]);

  useEffect(() => {
    if (!mapNode.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: mapNode.current,
      style: lightOsmStyle,
      center: coordinateRef.current,
      zoom: 13,
      attributionControl: { compact: true },
      pitch: 0,
      bearing: 0
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.on('load', () => {
      setMapLoaded(true);
      applyNoFlyOverlay(map, noFlyZonesRef.current);
      applyPatrolRings(map, patrolRingsRef.current);
    });
    map.on('click', (event) => {
      if (Date.now() - lastDragEndRef.current < 300) return;
      onPlaceRef.current([event.lngLat.lng, event.lngLat.lat]);
    });
    return () => {
      markersRef.current.forEach((marker) => marker.remove());
      markersRef.current.clear();
      map.remove();
      mapRef.current = null;
      searchAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!suppressEaseRef.current) {
      mapRef.current?.easeTo({ center: coordinate, duration: 550 });
    }
    suppressEaseRef.current = false;
  }, [coordinate]);

  // No-fly overlay: the zones arrive asynchronously, so apply them whenever
  // they change once the picker style is loaded (the map 'load' handler covers
  // the first paint; this keeps the overlay in sync while the studio is open).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    applyNoFlyOverlay(map, noFlyZones);
  }, [noFlyZones, mapLoaded]);

  // Patrol zone preview: hull polygons around each corridor's danger zones,
  // so moving a danger zone shows exactly how the patrol loop follows it.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    applyPatrolRings(map, patrolRings);
  }, [patrolRings, mapLoaded]);

  // Render every item of the active tab as a draggable marker. Clicking a
  // marker selects it (its details show in the list below); dragging commits
  // the new coordinate through onPlace, exactly like clicking the map. The
  // picker is re-fit only when the marker set changes (tab switch / add /
  // remove), never while dragging.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    const keys = new Set(items.map((item) => item.key));
    markersRef.current.forEach((marker, key) => {
      if (!keys.has(key)) {
        marker.remove();
        markersRef.current.delete(key);
      }
    });
    items.forEach((item) => {
      const existing = markersRef.current.get(item.key);
      const active = item.key === activeKey;
      if (existing) {
        if (dragKeyRef.current !== item.key) existing.setLngLat(item.coordinate);
        existing.getElement().className = `studio-marker${active ? ' active' : ''}`;
        return;
      }
      const marker = new maplibregl.Marker({ element: studioMarkerElement(item.name, item.kind, active), anchor: 'center', draggable: true, subpixelPositioning: true })
        .setLngLat(item.coordinate)
        .addTo(map);
      marker.on('dragstart', () => {
        dragKeyRef.current = item.key;
        onSelectItemRef.current(item);
      });
      marker.on('dragend', () => {
        dragKeyRef.current = null;
        lastDragEndRef.current = Date.now();
        suppressEaseRef.current = true;
        onPlaceRef.current(marker.getLngLat().toArray() as Coordinate);
      });
      marker.getElement().addEventListener('click', () => {
        if (Date.now() - lastDragEndRef.current < 300) return;
        onSelectItemRef.current(item);
      });
      markersRef.current.set(item.key, marker);
    });
    const keySignature = items.map((item) => item.key).sort().join('|');
    if (fittedKeysRef.current !== keySignature) {
      fittedKeysRef.current = keySignature;
      fitPickerMap(map, items);
    }
  }, [items, activeKey, mapLoaded]);

  async function searchPlaces(event: React.FormEvent) {
    event.preventDefault();
    const trimmedQuery = query.trim();
    if (!trimmedQuery) return;
    const now = Date.now();
    if (now - lastSearchAtRef.current < 1000) {
      setSearchMessage('Please wait a moment before searching again.');
      return;
    }
    lastSearchAtRef.current = now;
    searchAbortRef.current?.abort();
    const controller = new AbortController();
    searchAbortRef.current = controller;
    setSearching(true);
    setSearchMessage('Searching the map…');
    try {
      const response = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=${encodeURIComponent(trimmedQuery)}`, { headers: { Accept: 'application/json' }, signal: controller.signal });
      if (!response.ok) throw new Error('Search unavailable');
      const nextResults = await response.json() as Array<{ display_name: string; lat: string; lon: string }>;
      setResults(nextResults);
      setSearchMessage(nextResults.length ? '' : 'No places found. Try a nearby landmark or city.');
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setResults([]);
      setSearchMessage('Search is unavailable. You can still click the map to place it.');
    } finally {
      setSearching(false);
    }
  }

  function chooseResult(result: { display_name: string; lat: string; lon: string }) {
    onPlace([Number(result.lon), Number(result.lat)]);
    setQuery(result.display_name.split(',').slice(0, 2).join(','));
    setResults([]);
    setSearchMessage('Location pinned from search.');
  }

  const activeItem = items.find((item) => item.key === activeKey) ?? null;

  return (
    <div className="location-picker">
      <div className="location-picker-heading">
        <div><span className="location-picker-eyebrow"><LocateFixed size={13} /> Placing {label}</span><strong>Drag markers to move them</strong><small>Every item of this section is pinned on the map - click a marker to see its details beside the map, drag it to move it, or click empty map to place it. Red and amber zones are the DGCA no-fly / controlled-airspace overlay for reference.</small></div>
        <span className="location-picker-live"><span /> Live target</span>
      </div>
      <form className="location-search" onSubmit={searchPlaces}>
        <Search size={16} />
        <input aria-label={`Search location for ${label}`} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search a city, street, landmark…" />
        <button type="submit" disabled={searching}>{searching ? 'Searching…' : 'Search'}</button>
      </form>
      {results.length > 0 && <div className="location-results">{results.map((result) => <button type="button" key={`${result.lat}-${result.lon}-${result.display_name}`} onClick={() => chooseResult(result)}><MapPin size={14} /><span>{result.display_name}</span></button>)}</div>}
      {searchMessage && <p className="location-search-message">{searchMessage}</p>}
      <div className="location-picker-map-wrap">
        <div className="location-picker-map-frame">
          <div ref={mapNode} className="location-picker-map" aria-label={`Map location picker for ${label}`} />
          <div className="location-picker-hint"><MapPin size={13} /> Drag a marker to move it · click empty map to place <strong>{label}</strong></div>
        </div>
        <aside className="studio-picker-details" aria-label="Selected marker details">
          {activeItem ? (
            <>
              <div className="studio-picker-details-head"><span className="studio-picker-details-dot" style={{ background: STUDIO_KIND_COLOR[activeItem.kind] }} /><span>Selected marker</span></div>
              <strong className="studio-picker-details-name">{activeItem.name}</strong>
              <span className="studio-picker-details-kind">{STUDIO_KIND_LABEL[activeItem.kind]}</span>
              <dl className="studio-picker-details-coords">
                <div><dt>Latitude</dt><dd>{activeItem.coordinate[1].toFixed(5)}</dd></div>
                <div><dt>Longitude</dt><dd>{activeItem.coordinate[0].toFixed(5)}</dd></div>
              </dl>
              <p className="studio-picker-details-hint">Drag this marker on the map to move it - the change applies to the draft immediately.</p>
            </>
          ) : (
            <p className="studio-picker-details-empty">No marker selected - click a marker or choose one from the list below.</p>
          )}
        </aside>
      </div>
    </div>
  );
}

function LocationField({ active, onSelect }: { active: boolean; onSelect: () => void }) {
  return <div className="studio-location-field"><div><span>Location target</span><strong>{active ? 'Editing this item on the map below' : 'Choose this item to edit it on the map'}</strong></div><button type="button" aria-pressed={active} className={active ? 'secondary-action active-location' : 'secondary-action'} onClick={onSelect}><MapPin size={15} />{active ? 'Editing on map' : 'Edit on map'}</button></div>;
}

/** Draw the loop that's currently being selected (dashed) plus every closed
 *  danger-zone area (filled polygon) on the add-city builder map. */
function applyCityBuilderOverlay(map: MapLibreMap, build: CityBuild, selection: string[]) {
  if (!map.getSource('builder-rings')) {
    map.addSource('builder-rings', { type: 'geojson', data: emptyCollection });
    map.addLayer({ id: 'builder-zone-fill', type: 'fill', source: 'builder-rings', filter: ['==', ['get', 'kind'], 'zone'], paint: { 'fill-color': '#ef4444', 'fill-opacity': 0.16 } });
    map.addLayer({ id: 'builder-zone-line', type: 'line', source: 'builder-rings', filter: ['==', ['get', 'kind'], 'zone'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#dc2626', 'line-width': 2, 'line-opacity': 0.85 } });
    map.addLayer({ id: 'builder-selection-line', type: 'line', source: 'builder-rings', filter: ['==', ['get', 'kind'], 'selection'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#7c3aed', 'line-width': 2.5, 'line-opacity': 0.9, 'line-dasharray': [2, 1.5] } });
  }
  const zoneFeatures = build.zones.map((zone) => ({
    type: 'Feature' as const,
    properties: { kind: 'zone' },
    geometry: { type: 'Polygon' as const, coordinates: [zone.ring] }
  }));
  const selectedCoords = selection
    .map((id) => build.vertices.find((vertex) => vertex.id === id)?.coordinate)
    .filter((coordinate): coordinate is Coordinate => Boolean(coordinate));
  const selectionFeature = selectedCoords.length >= 2
    ? [{ type: 'Feature' as const, properties: { kind: 'selection' }, geometry: { type: 'LineString' as const, coordinates: selectedCoords } }]
    : [];
  setSource(map, 'builder-rings', featureCollection([...zoneFeatures, ...selectionFeature]));
}

function fitBuilderMap(map: MapLibreMap, build: CityBuild) {
  const coords = [build.center, ...build.stations.map((station) => station.coordinate), ...build.vertices.map((vertex) => vertex.coordinate)];
  if (!coords.length) return;
  if (coords.length === 1) {
    map.jumpTo({ center: coords[0], zoom: 13 });
    return;
  }
  const bounds = coords.reduce((nextBounds, coordinate) => nextBounds.extend(coordinate), new LngLatBounds(coords[0], coords[0]));
  map.fitBounds(bounds, { padding: 52, maxZoom: 14.5, duration: 600 });
}

/** The add-city map: drop a center marker, stations, danger-zone vertex
 *  markers, then connect the vertices into closed loops - each loop becomes a
 *  danger zone whose area is the polygon.  Mirrors the studio's LocationPicker
 *  interactions (click to place, drag to move). */
function CityBuilderMap({ build, onChange, noFlyZones }: {
  build: CityBuild;
  onChange: (next: CityBuild) => void;
  noFlyZones: NoFlyZoneInfo[];
}) {
  const mapNode = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markersRef = useRef<Map<string, maplibregl.Marker>>(new Map());
  const buildRef = useRef(build);
  const onChangeRef = useRef(onChange);
  const noFlyZonesRef = useRef(noFlyZones);
  const modeRef = useRef<'center' | 'station' | 'danger' | 'connect'>('center');
  const selectionRef = useRef<string[]>([]);
  const dragKeyRef = useRef<string | null>(null);
  const lastDragEndRef = useRef(0);
  const suppressEaseRef = useRef(false);
  const fittedKeysRef = useRef('');
  const [mode, setMode] = useState<'center' | 'station' | 'danger' | 'connect'>('center');
  const [selection, setSelection] = useState<string[]>([]);
  const [mapLoaded, setMapLoaded] = useState(false);

  useEffect(() => {
    buildRef.current = build;
    onChangeRef.current = onChange;
    noFlyZonesRef.current = noFlyZones;
  }, [build, onChange, noFlyZones]);
  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { selectionRef.current = selection; }, [selection]);

  useEffect(() => {
    if (!mapNode.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: mapNode.current,
      style: lightOsmStyle,
      center: buildRef.current.center,
      zoom: 12,
      attributionControl: { compact: true },
      pitch: 0,
      bearing: 0
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.on('load', () => {
      setMapLoaded(true);
      applyNoFlyOverlay(map, noFlyZonesRef.current);
      applyCityBuilderOverlay(map, buildRef.current, selectionRef.current);
    });
    map.on('click', (event) => {
      if (Date.now() - lastDragEndRef.current < 300) return;
      const coordinate: Coordinate = [event.lngLat.lng, event.lngLat.lat];
      const current = buildRef.current;
      const currentMode = modeRef.current;
      if (currentMode === 'center') {
        onChangeRef.current({ ...current, center: coordinate });
      } else if (currentMode === 'station') {
        onChangeRef.current({ ...current, stations: [...current.stations, { id: `DST-${String(current.stations.length + 1).padStart(2, '0')}`, name: `Station ${current.stations.length + 1}`, coordinate }] });
      } else if (currentMode === 'danger') {
        onChangeRef.current({ ...current, vertices: [...current.vertices, { id: `VP-${String(current.vertices.length + 1).padStart(2, '0')}`, coordinate }] });
      }
      // connect mode: only marker clicks build the loop
    });
    return () => {
      markersRef.current.forEach((marker) => marker.remove());
      markersRef.current.clear();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!suppressEaseRef.current) {
      mapRef.current?.easeTo({ center: build.center, duration: 550 });
    }
    suppressEaseRef.current = false;
  }, [build.center]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    applyNoFlyOverlay(map, noFlyZones);
    applyCityBuilderOverlay(map, build, selection);
  }, [noFlyZones, build, selection, mapLoaded]);

  function toggleVertex(vertexId: string) {
    const current = buildRef.current;
    const selected = selectionRef.current;
    const index = selected.indexOf(vertexId);
    if (index === -1) {
      setSelection([...selected, vertexId]);
      return;
    }
    if (selected.length >= 3) {
      // Clicking an already-selected marker closes the loop: the ordered
      // vertices become a closed ring and that polygon is the danger zone.
      const ring = selected.map((id) => current.vertices.find((vertex) => vertex.id === id)!.coordinate);
      const used = new Set(selected);
      onChangeRef.current({
        ...current,
        vertices: current.vertices.filter((vertex) => !used.has(vertex.id)),
        zones: [...current.zones, { id: `ZONE-${String(current.zones.length + 1).padStart(2, '0')}`, ring: [...ring, ring[0]] }]
      });
      setSelection([]);
    } else {
      setSelection(selected.filter((id) => id !== vertexId));
    }
  }

  // Render center/station/vertex markers; draggable, with loop selection
  // highlight.  Re-fit only when the marker set changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    const markerSpecs: Array<{ key: string; name: string; kind: StudioMapItemKind; coordinate: Coordinate; active: boolean }> = [
      { key: 'center', name: 'City center', kind: 'city', coordinate: build.center, active: mode === 'center' },
      ...build.stations.map((station, index) => ({ key: `station:${station.id}`, name: station.name || station.id, kind: 'stations' as const, coordinate: station.coordinate, active: false })),
      ...build.vertices.map((vertex, index) => ({ key: `vertex:${vertex.id}`, name: `Danger point ${index + 1}`, kind: 'dangerZones' as const, coordinate: vertex.coordinate, active: selection.includes(vertex.id) }))
    ];
    const keys = new Set(markerSpecs.map((spec) => spec.key));
    markersRef.current.forEach((marker, key) => {
      if (!keys.has(key)) {
        marker.remove();
        markersRef.current.delete(key);
      }
    });
    markerSpecs.forEach((spec) => {
      const existing = markersRef.current.get(spec.key);
      if (existing) {
        if (dragKeyRef.current !== spec.key) existing.setLngLat(spec.coordinate);
        existing.getElement().className = `studio-marker${spec.active ? ' active' : ''}`;
        return;
      }
      const marker = new maplibregl.Marker({ element: studioMarkerElement(spec.name, spec.kind, spec.active), anchor: 'center', draggable: true, subpixelPositioning: true })
        .setLngLat(spec.coordinate)
        .addTo(map);
      marker.on('dragstart', () => { dragKeyRef.current = spec.key; });
      marker.on('dragend', () => {
        dragKeyRef.current = null;
        lastDragEndRef.current = Date.now();
        suppressEaseRef.current = true;
        const coordinate = marker.getLngLat().toArray() as Coordinate;
        const current = buildRef.current;
        if (spec.key === 'center') {
          onChangeRef.current({ ...current, center: coordinate });
        } else if (spec.key.startsWith('station:')) {
          onChangeRef.current({ ...current, stations: current.stations.map((station) => station.id === spec.key.slice(8) ? { ...station, coordinate } : station) });
        } else if (spec.key.startsWith('vertex:')) {
          const id = spec.key.slice(7);
          onChangeRef.current({ ...current, vertices: current.vertices.map((vertex) => vertex.id === id ? { ...vertex, coordinate } : vertex) });
        }
      });
      marker.getElement().addEventListener('click', () => {
        if (Date.now() - lastDragEndRef.current < 300) return;
        if (spec.key.startsWith('vertex:') && modeRef.current === 'connect') {
          toggleVertex(spec.key.slice(7));
        }
      });
      markersRef.current.set(spec.key, marker);
    });
    const keySignature = markerSpecs.map((spec) => spec.key).sort().join('|');
    if (fittedKeysRef.current !== keySignature) {
      fittedKeysRef.current = keySignature;
      fitBuilderMap(map, build);
    }
  }, [build, selection, mode, mapLoaded]);

  const hint = mode === 'center'
    ? 'Click the map to drop the city center marker - it becomes the default map view for this city.'
    : mode === 'station'
      ? 'Click the map to drop response station markers. Drag any marker to fine-tune it.'
      : mode === 'danger'
        ? 'Click the map to drop danger-zone vertex markers, then switch to Connect loop.'
        : selection.length === 0
          ? 'Click danger-zone vertex markers one by one to connect them into a route.'
          : `Loop in progress (${selection.length} points) - click a marker that is already selected to close the loop into a danger-zone area.`;

  return (
    <div className="city-builder">
      <div className="city-builder-heading"><span className="location-picker-eyebrow"><MapPinned size={13} /> City builder</span><strong>Drop markers, then connect danger zones into areas</strong><small>Place the city center, stations, and danger-zone vertex markers on the map below. In Connect loop mode, click vertex markers in order - clicking one that is already selected closes the loop and that polygon becomes the danger-zone area.</small></div>
      <div className="city-builder-tools">
        {([['center', 'City center', MapPinned], ['station', 'Station', Radio], ['danger', 'Danger point', AlertTriangle], ['connect', 'Connect loop', Route]] as const).map(([value, label, Icon]) => (
          <button key={value} type="button" className={mode === value ? 'secondary-action active' : 'secondary-action'} onClick={() => setMode(value)}><Icon size={15} /> {label}</button>
        ))}
      </div>
      <p className="city-builder-hint">{hint}</p>
      <div className="location-picker-map-frame">
        <div ref={mapNode} className="location-picker-map city-builder-map" aria-label="Add city map builder" />
        <div className="location-picker-hint"><MapPin size={13} /> {mode === 'connect' ? 'Click vertex markers to connect them' : 'Click empty map to place'} <strong>{mode === 'center' ? 'city center' : mode === 'station' ? 'station' : mode === 'danger' ? 'danger point' : '·'}</strong></div>
      </div>
      <div className="city-builder-lists">
        <div className="city-builder-list">
          <strong>Stations ({build.stations.length})</strong>
          {build.stations.length === 0 ? <span className="city-builder-empty">None placed yet</span> : build.stations.map((station, index) => (
            <div className="city-builder-item" key={station.id}><span>{station.name || station.id}</span><code>{station.coordinate[1].toFixed(4)}, {station.coordinate[0].toFixed(4)}</code><button type="button" className="icon-button" onClick={() => onChange({ ...build, stations: build.stations.filter((_, i) => i !== index) })} aria-label={`Remove ${station.name || station.id}`}><Trash2 size={13} /></button></div>
          ))}
        </div>
        <div className="city-builder-list">
          <strong>Danger points ({build.vertices.length})</strong>
          {build.vertices.length === 0 ? <span className="city-builder-empty">None placed yet</span> : build.vertices.map((vertex, index) => (
            <div className="city-builder-item" key={vertex.id}><span>Point {index + 1}</span><code>{vertex.coordinate[1].toFixed(4)}, {vertex.coordinate[0].toFixed(4)}</code><button type="button" className="icon-button" onClick={() => onChange({ ...build, vertices: build.vertices.filter((_, i) => i !== index) })} aria-label={`Remove point ${index + 1}`}><Trash2 size={13} /></button></div>
          ))}
        </div>
        <div className="city-builder-list">
          <strong>Danger zones ({build.zones.length})</strong>
          {build.zones.length === 0 ? <span className="city-builder-empty">Close a loop to create one</span> : build.zones.map((zone, index) => (
            <div className="city-builder-item" key={zone.id}><span>{zone.id} · {zone.ring.length - 1} points</span><code>area</code><button type="button" className="icon-button" onClick={() => onChange({ ...build, zones: build.zones.filter((_, i) => i !== index) })} aria-label={`Remove ${zone.id}`}><Trash2 size={13} /></button></div>
          ))}
        </div>
      </div>
    </div>
  );
}

function CommandStudio({ config, initialTab, onTabChange, onClose, onSave, onSwitchCity, onDeleteCity, cities, noFlyZones }: {
  config: SafetyConfig;
  initialTab: StudioTab;
  onTabChange: (tab: StudioTab) => void;
  onClose: () => void;
  onSave: (config: SafetyConfig) => Promise<void> | void;
  onSwitchCity: (cityId: string) => void;
  onDeleteCity: (cityId: string) => Promise<void>;
  cities: CitySummary[];
  noFlyZones: NoFlyZoneInfo[];
}) {
  const [draft, setDraft] = useState<SafetyConfig>(() => {
    const initial = structuredClone(config);
    // The spare pool is system-managed - keep it out of the editable grid.
    initial.drones = initial.drones.filter((drone) => drone.role !== 'Spare');
    return initial;
  });
  const [saving, setSaving] = useState(false);
  const [addingCity, setAddingCity] = useState(false);
  const [newCityName, setNewCityName] = useState('');
  const [newCityCountry, setNewCityCountry] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [cityBuild, setCityBuild] = useState<CityBuild>(() => emptyCityBuild(draft.city.center));

  /** Create a new city profile and switch to it.  A blank grid starts with no
   *  stations/drones/zones; choosing a template clones the source city's grid
   *  (re-id'd with the new city's slug so the global id space stays unique). */
  const createCity = async () => {
    const name = newCityName.trim();
    if (!name) return;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'city';
    if (cities.some((city) => city.id === slug)) {
      window.alert(`A city named "${name}" already exists`);
      return;
    }
    let next: SafetyConfig;
    if (templateId) {
      const response = await fetch(`/api/safety/config?cityId=${encodeURIComponent(templateId)}`);
      const source = await response.json() as SafetyConfig | null;
      if (!source) {
        window.alert('Could not load the template city');
        return;
      }
      next = structuredClone(source);
      const prefix = `${slug}-`;
      const stationIds = new Map(next.stations.map((station) => [station.id, `${prefix}${station.id}`]));
      const droneIds = new Map(next.drones.map((drone) => [drone.id, `${prefix}${drone.id}`]));
      next.city = { id: slug, name, country: newCityCountry.trim() || source.city.country, center: source.city.center, zoom: source.city.zoom };
      next.stations = next.stations.map((station) => ({
        ...station,
        id: stationIds.get(station.id) ?? station.id,
        droneId: station.droneId ? droneIds.get(station.droneId) ?? station.droneId : null,
        reserveDroneId: station.reserveDroneId ? droneIds.get(station.reserveDroneId) ?? station.reserveDroneId : null
      }));
      // The spare pool is system-managed - never clone it.
      next.drones = next.drones.filter((drone) => drone.role !== 'Spare').map((drone) => ({
        ...drone,
        id: droneIds.get(drone.id) ?? drone.id,
        stationId: drone.stationId ? stationIds.get(drone.stationId) ?? drone.stationId : null,
        coverageForDroneId: drone.coverageForDroneId ? droneIds.get(drone.coverageForDroneId) ?? drone.coverageForDroneId : null
      }));
      next.patrolPoints = next.patrolPoints.map((point) => ({ ...point, id: `${prefix}${point.id}` }));
      next.dangerZones = next.dangerZones.map((zone) => ({ ...zone, id: `${prefix}${zone.id}` }));
    } else {
      // Blank grid: the city is built on the add-city map - the dropped
      // center marker becomes the map view, placed stations become response
      // stations, and each closed danger-zone loop becomes a polygon area.
      // Entity ids are prefixed with the new city's slug so they can never
      // collide with another city's globally-unique primary keys.
      next = {
        city: { id: slug, name, country: newCityCountry.trim() || 'India', center: cityBuild.center, zoom: draft.city.zoom },
        stations: cityBuild.stations.map((station) => ({ id: `${slug}-${station.id}`, name: station.name, coordinate: station.coordinate })),
        drones: [],
        patrolPoints: [],
        dangerZones: cityBuild.zones.map((zone, index) => ({
          id: `${slug}-${zone.id}`,
          name: `Danger zone ${index + 1}`,
          category: 'General',
          severity: 0.5,
          coordinate: zone.ring[0],
          radiusM: 150,
          ring: zone.ring
        })),
        planner: { gridResolutionM: null }
      };
    }
    setSaving(true);
    await onSave(next);
    setSaving(false);
    setAddingCity(false);
    setNewCityName('');
    setNewCityCountry('');
    setTemplateId('');
    setCityBuild(emptyCityBuild(draft.city.center));
  };
  const openAddCity = () => {
    setAddingCity(true);
    setCityBuild(emptyCityBuild(draft.city.center));
  };
  const cancelAddCity = () => {
    setAddingCity(false);
    setNewCityName('');
    setNewCityCountry('');
    setTemplateId('');
    setCityBuild(emptyCityBuild(draft.city.center));
  };
  const tabs: Array<{ id: StudioTab; label: string; icon: React.ReactNode }> = [
    { id: 'city', label: 'City profile', icon: <MapPinned size={15} /> },
    { id: 'drones', label: 'Drones', icon: <Bot size={15} /> },
    { id: 'stations', label: 'Stations', icon: <Radio size={15} /> },
    { id: 'danger', label: 'Danger zones', icon: <AlertTriangle size={15} /> },
    { id: 'planner', label: 'Planner', icon: <Settings2 size={15} /> }
  ];
  const currentTab = initialTab;
  const [locationTarget, setLocationTarget] = useState<{ kind: 'city' | 'drones' | 'stations' | 'dangerZones'; index: number }>({ kind: 'city', index: 0 });
  const setCity = (field: keyof SafetyConfig['city'], value: string | number | Coordinate) => setDraft((current) => ({ ...current, city: { ...current.city, [field]: value } }));
  const setCoordinate = (kind: 'stations' | 'drones' | 'dangerZones', index: number, coordinate: Coordinate) => setDraft((current) => {
    if (kind === 'drones') return { ...current, drones: current.drones.map((item, itemIndex) => itemIndex === index ? { ...item, position: coordinate } : item) };
    return { ...current, [kind]: current[kind].map((item, itemIndex) => itemIndex === index ? { ...item, coordinate } : item) } as SafetyConfig;
  });
  const selectedLocation = locationTarget.kind === 'city'
    ? draft.city.center
    : locationTarget.kind === 'drones'
      ? draft.drones[locationTarget.index]?.position || draft.city.center
      : draft[locationTarget.kind][locationTarget.index]?.coordinate || draft.city.center;
  const selectedLocationLabel = locationTarget.kind === 'city'
    ? `${draft.city.name} center`
    : `${({ drones: 'Drone', stations: 'Station', dangerZones: 'Danger zone' } as const)[locationTarget.kind]} ${locationTarget.index + 1}`;
  const applyLocation = (coordinate: Coordinate) => locationTarget.kind === 'city'
    ? setCity('center', coordinate)
    : setCoordinate(locationTarget.kind, locationTarget.index, coordinate);
  const selectLocation = (kind: 'stations' | 'drones' | 'dangerZones', index: number) => {
    setLocationTarget({ kind, index });
    window.requestAnimationFrame(() => {
      document.querySelector('.location-picker-map')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  };
  const removeItem = (kind: 'stations' | 'drones' | 'dangerZones', index: number) => setDraft((current) => ({ ...current, [kind]: current[kind].filter((_, itemIndex) => itemIndex !== index) } as SafetyConfig));
  // Entity ids are globally unique (primary keys) across every city, so new
  // items are prefixed with the city slug - bare DST-01/DRN-01/ZONE-01 would
  // collide with other cities' rows on save.
  const addItem = (kind: 'stations' | 'drones' | 'dangerZones') => setDraft((current) => {
    const prefix = `${current.city.id}-`;
    if (kind === 'stations') return { ...current, stations: [...current.stations, { id: `${prefix}DST-${String(current.stations.length + 1).padStart(2, '0')}`, name: 'New response station', coordinate: current.city.center, droneId: null }] };
    if (kind === 'drones') return { ...current, drones: [...current.drones, { id: `${prefix}DRN-${String(current.drones.length + 1).padStart(2, '0')}`, label: 'New safety drone', stationId: '', status: 'Patrol', role: 'Patrol', coverageForDroneId: null, battery: 100, response: 'standby', position: current.city.center, route: [current.city.center], routeName: 'Custom patrol route' }] };
    return { ...current, dangerZones: [...current.dangerZones, { id: `${prefix}ZONE-${String(current.dangerZones.length + 1).padStart(2, '0')}`, name: 'New danger zone', category: 'General', severity: 0.5, coordinate: current.city.center, radiusM: 150 }] };
  });
  const updateItem = (kind: 'stations' | 'drones' | 'dangerZones', index: number, field: string, value: string | number) => setDraft((current) => ({
    ...current,
    [kind]: current[kind].map((item, itemIndex) => itemIndex === index ? { ...item, [field]: value } : item)
  } as SafetyConfig));
  const updatePlanner = (gridResolutionM: number | null) => setDraft((current) => ({ ...current, planner: { gridResolutionM } }));
  const gridMode: 'auto' | '5' | '10' | 'custom' = draft.planner.gridResolutionM === null
    ? 'auto'
    : draft.planner.gridResolutionM === 5
      ? '5'
      : draft.planner.gridResolutionM === 10
        ? '10'
        : 'custom';
  const setGridMode = (mode: string) => {
    if (mode === 'auto') updatePlanner(null);
    else if (mode === '5') updatePlanner(5);
    else if (mode === '10') updatePlanner(10);
    else updatePlanner(draft.planner.gridResolutionM ?? 7.5);
  };
  const tabKind: Partial<Record<StudioTab, StudioMapItemKind>> = { city: 'city', drones: 'drones', stations: 'stations', danger: 'dangerZones' };
  const tabItems: StudioMapItem[] = currentTab === 'city'
    ? [{ key: 'city', name: `${draft.city.name} center`, coordinate: draft.city.center, kind: 'city', index: 0 }]
    : currentTab === 'drones'
      ? draft.drones.map((drone, index) => ({ key: drone.id, name: drone.label || drone.id, coordinate: drone.position, kind: 'drones', index }))
      : currentTab === 'stations'
        ? draft.stations.map((station, index) => ({ key: station.id, name: station.name || station.id, coordinate: station.coordinate, kind: 'stations', index }))
        : currentTab === 'danger'
          ? draft.dangerZones.map((zone, index) => ({ key: zone.id, name: zone.name || zone.id, coordinate: zone.coordinate, kind: 'dangerZones', index }))
          : [];
  const activeKey = (() => {
    if (locationTarget.kind === 'city') return 'city';
    if (locationTarget.kind !== tabKind[currentTab]) return null;
    const collection = draft[locationTarget.kind] as Array<{ id: string }>;
    return collection[locationTarget.index]?.id ?? null;
  })();
  // Patrol loops are hulls around each corridor's danger zones - preview them
  // on the Danger zones tab so moving a zone shows how its loop follows.
  const patrolRings: Coordinate[][] = currentTab === 'danger'
    ? draft.drones
        .filter((drone) => !isPoolDrone(drone))
        .map((drone) => zonesForPatrolDrone(drone, draft))
        .flatMap((assignment) => assignment && assignment.zones.length >= 3 ? [patrolZoneRing(assignment.zones.map((zone) => zone.coordinate))] : [])
    : [];
  const selectItem = (item: StudioMapItem) => {
    if (item.kind === 'city') {
      setLocationTarget({ kind: 'city', index: 0 });
      return;
    }
    setLocationTarget({ kind: item.kind, index: item.index });
  };
  useEffect(() => {
    if (locationTarget.kind === 'city') return;
    const collection = draft[locationTarget.kind];
    if (collection.length === 0) {
      setLocationTarget({ kind: 'city', index: 0 });
      return;
    }
    const nextIndex = Math.min(locationTarget.index, collection.length - 1);
    if (nextIndex !== locationTarget.index) {
      setLocationTarget({ kind: locationTarget.kind, index: nextIndex });
    }
  }, [draft, locationTarget]);

  // Align the location target with the active tab so a marker is always
  // highlighted on the picker and its details are visible below the map.
  useEffect(() => {
    if (currentTab === 'city') {
      setLocationTarget((current) => (current.kind === 'city' ? current : { kind: 'city', index: 0 }));
      return;
    }
    const kind = tabKind[currentTab];
    if (!kind) return; // planner tab has no map-location editing
    const collection = draft[kind] as Array<{ id: string }>;
    if (collection.length === 0) {
      setLocationTarget((current) => (current.kind === 'city' ? current : { kind: 'city', index: 0 }));
      return;
    }
    setLocationTarget((current) => (current.kind === kind && current.index < collection.length ? current : { kind, index: 0 }));
  }, [currentTab]);

  const save = async () => { setSaving(true); await onSave(draft); setSaving(false); };

  return (
    <motion.div className="studio-shell" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <div className="studio-header">
        <div>
          <span className="studio-eyebrow">Command Studio / Neon synced</span>
          <h1>Customize your safety grid</h1>
          <p>Add cities, assign drones, place stations, define patrol points, and tune danger zones.</p>
        </div>
        <button className="studio-close" type="button" onClick={onClose} aria-label="Close Command Studio"><X size={20} /></button>
      </div>
      <div className="studio-body">
        <nav className="studio-tabs" aria-label="Command Studio sections">
          {tabs.map((tab) => <button key={tab.id} className={currentTab === tab.id ? 'studio-tab active' : 'studio-tab'} type="button" onClick={() => onTabChange(tab.id)}>{tab.icon}<span>{tab.label}</span></button>)}
        </nav>
        <section className="studio-content">
          <LocationPicker label={selectedLocationLabel} coordinate={selectedLocation} onPlace={applyLocation} items={tabItems} activeKey={activeKey} onSelectItem={selectItem} noFlyZones={noFlyZones} patrolRings={patrolRings} />
          {currentTab === 'city' && <div className="studio-section"><StudioHeading title="Cities" subtitle="Switch the active city, add a new command grid, or remove one." />{cities.length === 0 ? <p className="studio-hint">No saved cities yet - add one below.</p> : <div className="studio-city-list">{cities.map((city) => <div className={`studio-city-card${city.id === config.city.id ? ' active' : ''}`} key={city.id}><div className="studio-city-info"><strong>{city.name}</strong><span className="studio-city-meta">{city.country} · {city.stations} stations · {city.drones} drones · {city.dangerZones} zones</span></div><div className="studio-city-actions">{city.id === config.city.id ? <span className="studio-city-active">Active</span> : <button className="secondary-action" type="button" onClick={() => onSwitchCity(city.id)}>Open</button>}<button className="icon-button" type="button" disabled={cities.length <= 1} onClick={() => onDeleteCity(city.id)} aria-label={`Delete ${city.name}`} title={cities.length <= 1 ? 'Cannot delete the last city' : 'Delete city'}><Trash2 size={15} /></button></div></div>)}</div>}{addingCity ? <div className="studio-add-city"><div className="studio-form-grid"><label>Name<input value={newCityName} onChange={(event) => setNewCityName(event.target.value)} placeholder="e.g. Mumbai" /></label><label>Country<input value={newCityCountry} onChange={(event) => setNewCityCountry(event.target.value)} placeholder="e.g. India" /></label><label>Template<select value={templateId} onChange={(event) => setTemplateId(event.target.value)}><option value="">Blank grid - build it on the map</option>{cities.map((city) => <option key={city.id} value={city.id}>Copy from {city.name}</option>)}</select></label></div>{templateId === '' && <CityBuilderMap build={cityBuild} onChange={setCityBuild} noFlyZones={noFlyZones} />}{templateId !== '' && <p className="studio-hint">A template copies the source city's stations, drones, patrol points, and danger zones (re-id'd so it can't clash with the source). The city center comes from the template's grid.</p>}<div className="studio-add-city-actions"><button className="secondary-action" type="button" onClick={cancelAddCity}>Cancel</button><button className="primary-action" type="button" disabled={saving || !newCityName.trim()} onClick={createCity}>{saving ? 'Creating…' : 'Create city'}</button></div></div> : <button className="secondary-action" type="button" onClick={openAddCity}><Plus size={15} /> Add city</button>}<div style={{ marginTop: 28 }}><StudioHeading title="City profile" subtitle="Name, country, and default map view for the active command grid." /><div className="studio-form-grid"><label>Name<input value={draft.city.name} onChange={(event) => setCity('name', event.target.value)} /></label><label>Country<input value={draft.city.country} onChange={(event) => setCity('country', event.target.value)} /></label><label>Default zoom<input type="number" step="0.1" min="1" max="20" value={draft.city.zoom} onChange={(event) => setCity('zoom', Number(event.target.value))} /></label></div></div></div>}
          {currentTab === 'drones' && <StudioCollection title="Drones" count={draft.drones.length} onAdd={() => addItem('drones')}><div className="studio-list">{draft.drones.map((drone, index) => <div className="studio-card" key={drone.id} data-studio-card={drone.id}><div className="studio-card-title"><strong>{drone.id}</strong><button type="button" className="icon-button" onClick={() => removeItem('drones', index)} aria-label={`Remove ${drone.id}`}><Trash2 size={15} /></button></div><div className="studio-form-grid"><label>Label<input value={drone.label} onChange={(event) => updateItem('drones', index, 'label', event.target.value)} /></label><label>Route name<input value={drone.routeName} onChange={(event) => updateItem('drones', index, 'routeName', event.target.value)} /></label><label>Station<select value={drone.stationId || ''} onChange={(event) => updateItem('drones', index, 'stationId', event.target.value)}><option value="">Unassigned</option>{draft.stations.map((station) => <option key={station.id} value={station.id}>{station.name}</option>)}</select></label><label>Role<select value={drone.role || 'Patrol'} onChange={(event) => updateItem('drones', index, 'role', event.target.value)}><option value="Patrol">Patrol</option><option value="Reserve">Reserve</option></select></label><label>Battery %<input type="number" min="0" max="100" value={drone.battery} onChange={(event) => updateItem('drones', index, 'battery', Number(event.target.value))} /></label></div><LocationField active={locationTarget.kind === 'drones' && locationTarget.index === index} onSelect={() => selectLocation('drones', index)} /></div>)}</div></StudioCollection>}
          {currentTab === 'stations' && <StudioCollection title="Response stations" count={draft.stations.length} onAdd={() => addItem('stations')}><div className="studio-list">{draft.stations.map((station, index) => <div className="studio-card" key={station.id} data-studio-card={station.id}><div className="studio-card-title"><strong>{station.id}</strong><button type="button" className="icon-button" onClick={() => removeItem('stations', index)} aria-label={`Remove ${station.id}`}><Trash2 size={15} /></button></div><div className="studio-form-grid"><label>Name<input value={station.name} onChange={(event) => updateItem('stations', index, 'name', event.target.value)} /></label><label>Assigned drone<select value={station.droneId || ''} onChange={(event) => updateItem('stations', index, 'droneId', event.target.value)}><option value="">Unassigned</option>{draft.drones.filter((drone) => drone.role !== 'Reserve').map((drone) => <option key={drone.id} value={drone.id}>{drone.id}</option>)}</select></label><label>Reserve drone<select value={station.reserveDroneId || ''} onChange={(event) => updateItem('stations', index, 'reserveDroneId', event.target.value)}><option value="">Unassigned</option>{draft.drones.filter((drone) => drone.role === 'Reserve').map((drone) => <option key={drone.id} value={drone.id}>{drone.id}</option>)}</select></label></div><LocationField active={locationTarget.kind === 'stations' && locationTarget.index === index} onSelect={() => selectLocation('stations', index)} /></div>)}</div></StudioCollection>}
          {currentTab === 'danger' && <StudioCollection title="Danger zones" count={draft.dangerZones.length} onAdd={() => addItem('dangerZones')}><div className="studio-list">{draft.dangerZones.map((zone, index) => <div className="studio-card" key={zone.id} data-studio-card={zone.id}><div className="studio-card-title"><strong>{zone.id}</strong><button type="button" className="icon-button" onClick={() => removeItem('dangerZones', index)} aria-label={`Remove ${zone.id}`}><Trash2 size={15} /></button></div><div className="studio-form-grid"><label>Name<input value={zone.name} onChange={(event) => updateItem('dangerZones', index, 'name', event.target.value)} /></label><label>Category<input value={zone.category} onChange={(event) => updateItem('dangerZones', index, 'category', event.target.value)} /></label><label>Severity<input type="number" min="0" max="1" step="0.01" value={zone.severity} onChange={(event) => updateItem('dangerZones', index, 'severity', Number(event.target.value))} /></label><label>Radius (m)<input type="number" min="1" value={zone.radiusM} onChange={(event) => updateItem('dangerZones', index, 'radiusM', Number(event.target.value))} /></label></div><LocationField active={locationTarget.kind === 'dangerZones' && locationTarget.index === index} onSelect={() => selectLocation('dangerZones', index)} /></div>)}</div></StudioCollection>}
          {currentTab === 'planner' && <div className="studio-section"><StudioHeading title="Route planner" subtitle="How finely the planner samples the map when routing drones." /><div className="studio-form-grid"><label>Grid resolution<select value={gridMode} onChange={(event) => setGridMode(event.target.value)}><option value="auto">Auto - 10 m first, refines to 5 m if no corridor</option><option value="5">5 m - precise through dense streets</option><option value="10">10 m - fast, better for long routes</option><option value="custom">Custom…</option></select></label>{gridMode === 'custom' && <label>Custom grid (m)<input type="number" min="2" max="500" step="0.5" value={draft.planner.gridResolutionM ?? 7.5} onChange={(event) => updatePlanner(Number(event.target.value))} /></label>}</div><p className="studio-hint">Auto starts on the fast 10 m grid and only refines to 5 m (then 2.5 m) when no corridor exists at the coarser grid, so common routes stay fast and only tight ones pay the extra cost. A smaller grid finds corridors through narrow streets (fewer degraded straight-line routes) but uses more memory and takes longer per route; very large missions are capped automatically. Applies to every route from this command grid.</p></div>}
        </section>
      </div>
      <div className="studio-footer"><span><Shield size={15} /> Changes stay in this draft until you save the command grid.</span><div><button className="secondary-action" type="button" onClick={onClose}>Cancel</button><button className="primary-action studio-save" type="button" onClick={save} disabled={saving}><Save size={16} />{saving ? 'Saving…' : 'Save command grid'}</button></div></div>
    </motion.div>
  );
}

function StudioHeading({ title, subtitle }: { title: string; subtitle: string }) { return <div className="studio-heading"><h2>{title}</h2><p>{subtitle}</p></div>; }
function StudioCollection({ title, count, onAdd, children }: { title: string; count: number; onAdd: () => void; children: React.ReactNode }) { return <div className="studio-section"><div className="studio-collection-heading"><div><h2>{title} <span>{count}</span></h2><p>Manage the live records used by the map.</p></div><button className="secondary-action" type="button" onClick={onAdd}><Plus size={15} /> Add</button></div>{children}</div>; }

function DashboardDeck(props: {
  timeline: TimelineEvent[];
  openSosDemo: () => void;
  startSafeWalkSelection: () => void;
  openStudio: () => void;
  showNoFly: boolean;
  noFlyAvailable: boolean;
  onToggleNoFly: () => void;
}) {
  return (
    <>
      <PanelTitle eyebrow="Dashboard" title="Operations Deck" subtitle="Live map-first control surface for operator response." />
      <div className="quick-actions">
        <button className="primary-action danger-action" type="button" onClick={props.openSosDemo}><Siren size={17} /> SOS Demo</button>
        <button className="primary-action" type="button" onClick={props.startSafeWalkSelection} style={{ position: 'relative' }}>
          <Route size={17} /> Safe Walk Demo
          <UserRound size={13} style={{ position: 'absolute', bottom: '6px', right: '8px', color: '#ec4899' }} />
        </button>
        <button className="primary-action studio-dashboard-action" type="button" onClick={props.openStudio}><Maximize2 size={17} /> Command Studio</button>
        <button
          className={props.showNoFly && props.noFlyAvailable ? 'primary-action nofly-toggle active' : 'primary-action nofly-toggle'}
          type="button"
          onClick={props.onToggleNoFly}
          disabled={!props.noFlyAvailable}
          title={props.noFlyAvailable ? 'Toggle the DGCA no-fly / controlled-airspace overlay' : 'No-fly zones unavailable - planner offline'}
          style={{ opacity: props.noFlyAvailable ? 1 : 0.5 }}
        >
          <Shield size={17} /> {props.showNoFly && props.noFlyAvailable ? 'No-fly: On' : 'No-fly: Off'}
        </button>
      </div>
      <Timeline timeline={props.timeline} />
    </>
  );
}

function AboutPanel() {
  return (
    <>
      <PanelTitle eyebrow="About" title="Women Safety Drone System" subtitle="A real-time, map-first operator command surface." />
      <div className="about-copy">
        <p>
          This platform serves as the central dispatch and monitoring interface for a network of autonomous safety drones, designed to provide rapid emergency response and preventative escorting in urban environments.
        </p>
        <div style={{ margin: '12px 0', padding: '14px', background: 'rgba(255, 255, 255, 0.45)', borderRadius: '8px', border: '1px solid rgba(148, 163, 184, 0.15)' }}>
          <strong style={{ display: 'block', marginBottom: '8px', color: '#0f172a', fontSize: '13px' }}>Key Capabilities</strong>
          <ul style={{ margin: 0, paddingLeft: '20px', display: 'flex', flexDirection: 'column', gap: '6px', color: 'var(--muted)', fontSize: '12.5px', lineHeight: '1.5' }}>
            <li><strong>Live Drone Patrols:</strong> Optimized patrol loops over Patiala danger zones - the route planner computes building-avoiding waypoints once and the drones fly them.</li>
            <li><strong>SOS Emergency Dispatch:</strong> Immediate drone deployment to active SOS callers with predictive target orbiting.</li>
            <li><strong>Safe Walk Escorts:</strong> Real-time user escort tracking with synchronized drone trailing and destination verification.</li>
            <li><strong>Dynamic Risk Heatmaps:</strong> Interactive visualization of historical danger zones and active alert clusters.</li>
          </ul>
        </div>
        <p>
          <strong>System Architecture:</strong> React/MapLibre command surface calling a FastAPI + DuckDB route planner (Overture building data + DGCA no-fly zones) for building-avoiding waypoints, with YOLOv8 for live computer vision analysis.
        </p>
      </div>
    </>
  );
}

function Timeline({ timeline }: { timeline: TimelineEvent[] }) {
  return (
    <div className="timeline">
      {timeline.slice(0, 5).map((item, index) => (
        <motion.div className="timeline-row" key={`${item.time}-${item.label}-${index}`} initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: index * 0.035 }}>
          <span>{item.time}</span>
          <strong>{item.label}</strong>
          <small>{item.detail}</small>
        </motion.div>
      ))}
    </div>
  );
}

function PanelTitle({ eyebrow, title, subtitle }: { eyebrow: string; title: string; subtitle: string }) {
  return (
    <div className="panel-title">
      <span>{eyebrow}</span>
      <h1>{title}</h1>
      <p>{subtitle}</p>
    </div>
  );
}

function SectionTitle({ icon, label }: { icon: React.ReactNode; label: string }) {
  return <h2 className="section-title">{icon}{label}</h2>;
}

function Metric({ icon, label, value, danger = false }: { icon?: React.ReactNode; label: string; value: string; danger?: boolean }) {
  return (
    <motion.div className={danger ? 'metric danger' : 'metric'} layout>
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </motion.div>
  );
}

function stationNameForDrone(droneId: string, stations: SafetyConfig['stations'] = droneStations) {
  return stations.find((station) => station.droneId === droneId)?.name || 'Standby station';
}

function navIcon(view: NavView) {
  const props = { size: 16 };
  if (view === 'sos') return <Siren {...props} />;
  if (view === 'safewalk') return <UserRound {...props} />;
  if (view === 'about') return <Cpu {...props} />;
  return <Layers3 {...props} />;
}

function navLabel(view: NavView) {
  const labels: Record<NavView, string> = {
    dashboard: 'Dashboard',
    sos: 'SOS Demo',
    safewalk: 'Safe Walk',
    about: 'About'
  };
  return labels[view];
}
function addSourcesAndLayers(map: MapLibreMap) {
  map.addSource(sources.patrolRoutes, { type: 'geojson', data: emptyCollection, tolerance: 0 });
  map.addSource(sources.activeRoute, { type: 'geojson', data: emptyCollection, tolerance: 0 });
  map.addSource(sources.safeRoute, { type: 'geojson', data: emptyCollection, tolerance: 0 });
  map.addSource(sources.safeUser, { type: 'geojson', data: emptyCollection });
  map.addSource(sources.droneStations, { type: 'geojson', data: emptyCollection });
  map.addSource(sources.sosTarget, { type: 'geojson', data: emptyCollection });
  map.addSource(sources.safePoints, { type: 'geojson', data: emptyCollection });
  map.addSource(sources.hotspots, { type: 'geojson', data: emptyCollection });
  map.addSource(sources.riskHeatmap, { type: 'geojson', data: emptyCollection });
  map.addSource(sources.noFlyZones, { type: 'geojson', data: emptyCollection, tolerance: 0 });
  map.addSource(sources.zoneRings, { type: 'geojson', data: emptyCollection, tolerance: 0 });

  map.addLayer({
    id: 'risk-heatmap',
    type: 'heatmap',
    source: sources.riskHeatmap,
    paint: {
      'heatmap-weight': ['get', 'intensity'],
      'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 0, 0.5, 11, 0.8, 15, 3],
      'heatmap-color': [
        'interpolate',
        ['linear'],
        ['heatmap-density'],
        0, 'rgba(74, 222, 128, 0)',
        0.15, 'rgba(74, 222, 128, 0.65)',
        0.3, '#facc15',
        0.65, '#fbbf24',
        0.85, '#fb923c',
        1, '#f97316'
      ],
      'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 0, 2, 9, 150, 15, 420],
      'heatmap-opacity': 0.6
    }
  });

  // DGCA no-fly / controlled-airspace overlay (GET /no-fly-zones, scope=punjab)
  map.addLayer({ id: 'nofly-red-fill', type: 'fill', source: sources.noFlyZones, filter: ['==', ['get', 'kind'], 'red'], paint: { 'fill-color': '#dc2626', 'fill-opacity': 0.18 } });
  map.addLayer({ id: 'nofly-red-line', type: 'line', source: sources.noFlyZones, filter: ['==', ['get', 'kind'], 'red'], paint: { 'line-color': '#dc2626', 'line-width': 1.5, 'line-opacity': 0.75 } });
  map.addLayer({ id: 'nofly-amber-fill', type: 'fill', source: sources.noFlyZones, filter: ['==', ['get', 'kind'], 'amber'], paint: { 'fill-color': '#f59e0b', 'fill-opacity': 0.12 } });
  map.addLayer({ id: 'nofly-amber-line', type: 'line', source: sources.noFlyZones, filter: ['==', ['get', 'kind'], 'amber'], paint: { 'line-color': '#f59e0b', 'line-width': 1.5, 'line-opacity': 0.6, 'line-dasharray': [2, 2] } });

  // Patrol zones are convex-hull polygons around each corridor's danger
  // zones - drawn as a soft fill with a dashed boundary.
  map.addLayer({ id: 'patrol-zone-fill', type: 'fill', source: sources.patrolRoutes, paint: { 'fill-color': '#0891b2', 'fill-opacity': 0.09 } });
  map.addLayer({ id: 'patrol-routes', type: 'line', source: sources.patrolRoutes, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#0891b2', 'line-width': 2, 'line-opacity': 0.65, 'line-dasharray': [1.4, 1.8] } });
  map.addLayer({ id: 'safe-route-glow', type: 'line', source: sources.safeRoute, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#2563eb', 'line-width': 12, 'line-opacity': 0.15 } });
  map.addLayer({ id: 'safe-route', type: 'line', source: sources.safeRoute, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#2563eb', 'line-width': 5, 'line-opacity': 0.86, 'line-dasharray': [0.7, 1.1] } });
  map.addLayer({ id: 'active-route-glow', type: 'line', source: sources.activeRoute, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#050505', 'line-width': 14, 'line-opacity': 0.16 } });
  map.addLayer({ id: 'active-route', type: 'line', source: sources.activeRoute, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#050505', 'line-width': 6, 'line-opacity': 0.9 } });
  map.addLayer({ id: 'drone-station-halo', type: 'circle', source: sources.droneStations, minzoom: DETAIL_LAYER_MIN_ZOOM, paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 13, 15, 22], 'circle-color': '#0891b2', 'circle-opacity': 0.16, 'circle-blur': 0.35 } });
  map.addLayer({ id: 'drone-stations', type: 'circle', source: sources.droneStations, minzoom: DETAIL_LAYER_MIN_ZOOM, paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 6, 15, 9], 'circle-color': '#0891b2', 'circle-stroke-color': '#f8fafc', 'circle-stroke-width': 2 } });
  map.addLayer({ id: 'unclustered-hotspot', type: 'circle', source: sources.hotspots, minzoom: DETAIL_LAYER_MIN_ZOOM, paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 11.6, ['max', 4, ['*', ['get', 'radiusM'], 0.018]], 16, ['max', 8, ['*', ['get', 'radiusM'], 0.08]]], 'circle-color': '#ef4444', 'circle-opacity': ['interpolate', ['linear'], ['zoom'], 11.6, 0, 12.2, 0.9], 'circle-stroke-color': '#f8fafc', 'circle-stroke-width': 2 } });
  // Polygon-area danger zones (built from rings in the studio) - soft red fill
  // with a solid boundary, so a looped danger zone area reads as one region.
  map.addLayer({ id: 'zone-rings-fill', type: 'fill', source: sources.zoneRings, paint: { 'fill-color': '#ef4444', 'fill-opacity': 0.16 } });
  map.addLayer({ id: 'zone-rings-line', type: 'line', source: sources.zoneRings, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#dc2626', 'line-width': 2, 'line-opacity': 0.85 } });
  map.addLayer({ id: 'target-halo', type: 'circle', source: sources.sosTarget, minzoom: DETAIL_LAYER_MIN_ZOOM, paint: { 'circle-radius': 28, 'circle-color': '#a855f7', 'circle-opacity': 0.18, 'circle-blur': 0.38 } });
  map.addLayer({ id: 'target-point', type: 'circle', source: sources.sosTarget, minzoom: DETAIL_LAYER_MIN_ZOOM, paint: { 'circle-radius': 8, 'circle-color': '#a855f7', 'circle-stroke-color': '#faf5ff', 'circle-stroke-width': 2 } });
  map.addLayer({ id: 'safe-points', type: 'circle', source: sources.safePoints, minzoom: DETAIL_LAYER_MIN_ZOOM, paint: { 'circle-radius': 8, 'circle-color': ['match', ['get', 'kind'], 'origin', '#22c55e', '#2563eb'], 'circle-stroke-color': '#f8fafc', 'circle-stroke-width': 2 } });
  map.addLayer({ id: 'safe-user-halo', type: 'circle', source: sources.safeUser, minzoom: DETAIL_LAYER_MIN_ZOOM, paint: { 'circle-radius': 19, 'circle-color': '#ec4899', 'circle-opacity': 0.16, 'circle-blur': 0.35 } });
  map.addLayer({ id: 'safe-user-point', type: 'circle', source: sources.safeUser, minzoom: DETAIL_LAYER_MIN_ZOOM, paint: { 'circle-radius': 7, 'circle-color': '#ec4899', 'circle-stroke-color': '#eff6ff', 'circle-stroke-width': 2 } });
}

function createSosMarkerCollection(alerts: Alert[], activeSosIds: string[] = []) {
  const visibleAlerts = activeSosIds.length > 0 ? alerts.filter((a) => activeSosIds.includes(a.id)) : [];
  return featureCollection(
    visibleAlerts
      .map((alert) => turf.point(ensureLandCoordinate(alert.coordinate), {
        id: alert.id,
        label: alert.label,
        priority: alert.priority,
        status: alert.status,
        time: alert.time
      }))
  );
}

/** Human "x ago" label for a log entry - prefers the latest activity time. */
function logTimeAgo(entry: SosLogEntry): string {
  const raw = entry.updatedAt || entry.resolvedAt || entry.startedAt;
  if (!raw) return 'just now';
  const then = new Date(raw).getTime();
  if (!Number.isFinite(then)) return 'just now';
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function createCurvedRoute(start: Coordinate, end: Coordinate) {
  // Return a straight line between start and end, ensuring coordinates are land‑safe.
  const safeStart = ensureLandCoordinate(start);
  const safeEnd = ensureLandCoordinate(end);
  return [safeStart, safeEnd];
}

/** Which red (prohibited) zones does the straight line from → to cross?
 *  Used when the planner is unreachable, so a direct fallback never silently
 *  cuts through prohibited airspace - it is reported instead. */
function lineCrossesRedZones(from: Coordinate, to: Coordinate, redZones: NoFlyZoneInfo[]): NoFlyZoneInfo[] {
  if (!redZones.length) return [];
  const line = turf.lineString([ensureLandCoordinate(from), ensureLandCoordinate(to)]);
  return redZones.filter((zone) => turf.booleanIntersects(line, turf.polygon([zone.ring.map(([lat, lon]) => [lon, lat])])));
}

/** Offset a coordinate by a random distance (km) and bearing - used to place
 *  simulated SOS callers a few hundred metres off the patrol routes. */
function jitterCoordinate([lng, lat]: Coordinate, minKm: number, maxKm: number): Coordinate {
  const bearing = Math.random() * 360;
  const distance = minKm + Math.random() * (maxKm - minKm);
  const point = turf.destination(turf.point([lng, lat]), distance, bearing, { units: 'kilometers' });
  return ensureLandCoordinate(point.geometry.coordinates as Coordinate);
}

/** Red zone rings flipped to [lon, lat] (turf order) - zone rings arrive as
 *  [lat, lon].  Rebuilt per call; there are only a handful of local rings. */
function redZonePolys(redZones: NoFlyZoneInfo[]) {
  return redZones.map((zone) => turf.polygon([zone.ring.map(([lat, lon]) => [lon, lat])]));
}

/** Minimum metres a clamped point must keep from every red zone edge.
 *  The planner treats the polygon boundary itself as blocked (covers), and
 *  its 10 m grid also fails to route into thin pockets hugging a red polygon
 *  (verified against the Patiala DMW / central-jail zones), so the clamp
 *  demands real clearance - not just "outside". */
const RED_ZONE_CLEARANCE_M = 250;

/** True when a coordinate is inside, or closer than RED_ZONE_CLEARANCE_M to,
 *  any red (prohibited) no-fly polygon. */
function coordinateTooCloseToRedZones(coordinate: Coordinate, redZones: NoFlyZoneInfo[]): boolean {
  if (!redZones.length) return false;
  const pt = turf.point(coordinate);
  return redZonePolys(redZones).some((poly) => {
    if (turf.booleanPointInPolygon(pt, poly)) return true;
    const ring = poly.geometry.coordinates[0];
    for (let i = 0; i < ring.length - 1; i += 1) {
      const dKm = turf.pointToLineDistance(pt, turf.lineString([ring[i], ring[i + 1]]), { units: 'kilometers' });
      if (dKm * 1000 < RED_ZONE_CLEARANCE_M) return true;
    }
    return false;
  });
}

/** Move a coordinate out of every red (prohibited) no-fly zone to the
 *  nearest safe spot (>= RED_ZONE_CLEARANCE_M from every edge), so SOS
 *  callers / patrol points never sit inside or on a hard block (the planner
 *  would otherwise detour around it or stop short of it).  No-op when the
 *  point is already clear or no red zones are loaded. */
function clampToSafeCoordinate(coordinate: Coordinate, redZones: NoFlyZoneInfo[]): Coordinate {
  if (!redZones.length || !coordinateTooCloseToRedZones(coordinate, redZones)) return coordinate;
  // outward spiral: probe 5-degree bearings at growing radii until clear
  for (let radiusM = 30; radiusM <= 2000; radiusM += 30) {
    for (let bearing = 0; bearing < 360; bearing += 5) {
      const candidate = turf.destination(turf.point(coordinate), radiusM / 1000, bearing, { units: 'kilometers' }).geometry.coordinates as Coordinate;
      const clamped = ensureLandCoordinate(candidate);
      if (!coordinateTooCloseToRedZones(clamped, redZones)) return clamped;
    }
  }
  return coordinate; // give up - the planner will report the degraded route
}

function createEscortRoute(route: Coordinate[]) {
  return route.map((coordinate, index) => {
    const previous = route[Math.max(0, index - 1)] || coordinate;
    const next = route[Math.min(route.length - 1, index + 1)] || coordinate;
    const heading = turf.distance(turf.point(previous), turf.point(next), { units: 'kilometers' }) > 0.001
      ? turf.bearing(turf.point(previous), turf.point(next))
      : 0;
    return offsetEscortCoordinate(coordinate, heading);
  });
}

function getEscortSideCoordinate(
  routeLine: GeoJSON.Feature<GeoJSON.LineString>,
  userCoordinate: Coordinate,
  distanceKm: number,
  totalDistanceKm: number
): Coordinate {
  const sampleStep = Math.min(0.03, Math.max(0.005, totalDistanceKm / 10));
  const before = turf.along(routeLine, Math.max(0, distanceKm - sampleStep), { units: 'kilometers' });
  const after = turf.along(routeLine, Math.min(totalDistanceKm, distanceKm + sampleStep), { units: 'kilometers' });
  const beforeCoordinate = before.geometry.coordinates as Coordinate;
  const afterCoordinate = after.geometry.coordinates as Coordinate;
  const sampledDistance = turf.distance(turf.point(beforeCoordinate), turf.point(afterCoordinate), { units: 'kilometers' });
  let heading = sampledDistance > 0.001
    ? turf.bearing(turf.point(beforeCoordinate), turf.point(afterCoordinate))
    : 0;

  if (sampledDistance <= 0.001) {
    const routeCoordinates = routeLine.geometry.coordinates as Coordinate[];
    const firstDistinct = routeCoordinates.find((coordinate) => turf.distance(turf.point(routeCoordinates[0]), turf.point(coordinate), { units: 'kilometers' }) > 0.001);
    const lastDistinct = [...routeCoordinates].reverse().find((coordinate) => turf.distance(turf.point(routeCoordinates.at(-1) as Coordinate), turf.point(coordinate), { units: 'kilometers' }) > 0.001);
    if (distanceKm <= sampleStep && firstDistinct) {
      heading = turf.bearing(turf.point(routeCoordinates[0]), turf.point(firstDistinct));
    } else if (distanceKm >= totalDistanceKm - sampleStep && lastDistinct) {
      heading = turf.bearing(turf.point(lastDistinct), turf.point(routeCoordinates.at(-1) as Coordinate));
    }
  }

  return offsetEscortCoordinate(userCoordinate, heading);
}

function offsetEscortCoordinate([lng, lat]: Coordinate, travelBearing = 0): Coordinate {
  // Keep the drone visibly beside the user, roughly 30 meters to the right
  // of the direction of travel so the markers remain distinct when zoomed out.
  const sidePoint = turf.destination(
    turf.point([lng, lat]),
    0.03,
    travelBearing + 90,
    { units: 'kilometers' }
  );
  return ensureLandCoordinate(sidePoint.geometry.coordinates as Coordinate);
}

function setSource(map: MapLibreMap | null, sourceId: string, data: FeatureCollection) {
  const source = map?.getSource(sourceId) as GeoJSONSource | undefined;
  source?.setData(data);
}

function featureCollection(features: any[]): FeatureCollection {
  return { type: 'FeatureCollection', features };
}

function fitCollections(map: MapLibreMap, collections: FeatureCollection[]) {
  const coords: GeoJSON.Position[] = [];
  collections.forEach((collection) => collection.features.forEach((feature) => collectGeometryCoordinates(feature.geometry, coords)));
  if (!coords.length) return;
  const bounds = coords.reduce((nextBounds, coordinate) => nextBounds.extend(coordinate as Coordinate), new LngLatBounds(coords[0] as Coordinate, coords[0] as Coordinate));
  map.fitBounds(bounds, { padding: { top: 96, right: 420, bottom: 96, left: 440 }, maxZoom: 14.4, duration: 1100, easing: easeInOut });
}

function collectGeometryCoordinates(geometry: GeoJSON.Geometry | null | undefined, coords: GeoJSON.Position[]) {
  if (!geometry || geometry.type === 'GeometryCollection') return;
  collectCoordinates(geometry.coordinates, coords);
}

function collectCoordinates(value: unknown, coords: GeoJSON.Position[]) {
  if (!Array.isArray(value)) return;
  if (Number.isFinite(value[0]) && Number.isFinite(value[1])) {
    coords.push(value as GeoJSON.Position);
    return;
  }
  value.forEach((item) => collectCoordinates(item, coords));
}

function easeInOut(t: number) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function easeOut(t: number) {
  return 1 - Math.pow(1 - t, 3);
}

createRoot(document.getElementById('root')!).render(<App />);
