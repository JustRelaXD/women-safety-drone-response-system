import React, { useEffect, useMemo, useRef, useState } from 'react';
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
  PanelLeftOpen,
  Layers3,
  MapPin,
  Radio,
  Route,
  Shield,
  Siren,
  Timer,
  UserRound,
  Zap
} from 'lucide-react';
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles.css';

type FeatureCollection = GeoJSON.FeatureCollection<GeoJSON.Geometry, Record<string, unknown>>;
type PointFeature = GeoJSON.Feature<GeoJSON.Point, Record<string, unknown>>;
type Coordinate = [number, number];

type Drone = {
  id: string;
  label: string;
  stationId: string;
  status: 'Patrol' | 'Dispatching' | 'Monitoring' | 'Charging';
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

const emptyCollection: FeatureCollection = { type: 'FeatureCollection', features: [] };
const center: Coordinate = [74.856, 12.914];

const sources = {
  patrolRoutes: 'patrolRoutes',
  activeRoute: 'activeRoute',
  safeRoute: 'safeRoute',
  safeUser: 'safeUser',
  droneStations: 'droneStations',
  sosTarget: 'sosTarget',
  hotspots: 'hotspots',
  safePoints: 'safePoints',
  riskHeatmap: 'riskHeatmap'
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

const initialDrones: Drone[] = [
  {
    id: 'DRN-01',
    label: 'Falcon North',
    stationId: 'DST-01',
    status: 'Patrol',
    battery: 92,
    response: '1.8 min',
    position: [74.845, 12.936],
    routeName: 'Ladyhill - Lalbagh loop',
    route: [[74.839, 12.943], [74.851, 12.938], [74.861, 12.929], [74.855, 12.921], [74.843, 12.926], [74.839, 12.943]]
  },
  {
    id: 'DRN-02',
    label: 'Netravati Watch',
    stationId: 'DST-02',
    status: 'Patrol',
    battery: 78,
    response: '2.4 min',
    position: [74.851, 12.884],
    routeName: 'Pumpwell - Kankanady corridor',
    route: [[74.846, 12.895], [74.861, 12.891], [74.866, 12.881], [74.853, 12.873], [74.842, 12.882], [74.846, 12.895]]
  },
  {
    id: 'DRN-03',
    label: 'Coastal Shield',
    stationId: 'DST-03',
    status: 'Patrol',
    battery: 85,
    response: '3.1 min',
    position: [74.835, 12.917],
    routeName: 'Panambur inland watch',
    route: [[74.828, 12.935], [74.839, 12.927], [74.846, 12.909], [74.836, 12.893], [74.826, 12.908], [74.828, 12.935]]
  },
  {
    id: 'DRN-04',
    label: 'Campus Escort',
    stationId: 'DST-04',
    status: 'Patrol',
    battery: 64,
    response: '4.0 min',
    position: [74.88, 12.923],
    routeName: 'University - Bejai loop',
    route: [[74.874, 12.934], [74.891, 12.929], [74.895, 12.916], [74.88, 12.907], [74.868, 12.917], [74.874, 12.934]]
  },
  {
    id: 'DRN-05',
    label: 'Ullal Shore Watch',
    stationId: 'DST-05',
    status: 'Patrol',
    battery: 88,
    response: '2.1 min',
    position: [74.860, 12.808],
    routeName: 'Ullal - Someshwara loop',
    route: [[74.858, 12.815], [74.868, 12.812], [74.872, 12.798], [74.861, 12.795], [74.855, 12.805], [74.858, 12.815]]
  }
];

const droneStations = [
  { id: 'DST-01', name: 'Ladyhill Standby Post', coordinate: [74.845, 12.936] as Coordinate, droneId: 'DRN-01' },
  { id: 'DST-02', name: 'Pumpwell Response Post', coordinate: [74.851, 12.884] as Coordinate, droneId: 'DRN-02' },
  { id: 'DST-03', name: 'Panambur Inland Post', coordinate: [74.835, 12.917] as Coordinate, droneId: 'DRN-03' },
  { id: 'DST-04', name: 'Bejai Campus Post', coordinate: [74.88, 12.923] as Coordinate, droneId: 'DRN-04' },
  { id: 'DST-05', name: 'Drone Station', coordinate: [74.860, 12.808] as Coordinate, droneId: 'DRN-05' }
];

const hotspots: Array<{ id: string; label: string; coordinate: Coordinate; severity: number; category: string }> = [
  { id: 'HS-101', label: 'Late-night transit cluster', coordinate: [74.855, 12.919], severity: 0.96, category: 'Transit' },
  { id: 'HS-102', label: 'Unlit walkway reports', coordinate: [74.843, 12.929], severity: 0.72, category: 'Walkway' },
  { id: 'HS-103', label: 'Market crowd pressure', coordinate: [74.862, 12.875], severity: 0.82, category: 'Market' },
  { id: 'HS-104', label: 'Beach road watch zone', coordinate: [74.832, 12.907], severity: 0.64, category: 'Beach' },
  { id: 'HS-105', label: 'Hostel return corridor', coordinate: [74.889, 12.923], severity: 0.77, category: 'Campus' },
  { id: 'HS-106', label: 'Bus stop incident history', coordinate: [74.846, 12.894], severity: 0.88, category: 'Transit' },
  { id: 'HS-107', label: 'Low visibility junction', coordinate: [74.871, 12.938], severity: 0.66, category: 'Junction' },
  { id: 'HS-108', label: 'Rail approach cluster', coordinate: [74.835, 12.881], severity: 0.7, category: 'Transit' },
  { id: 'HS-109', label: 'Ullal beach late reports', coordinate: [74.8608, 12.8054], severity: 0.85, category: 'Beach' }
];

const heatPoints = [
  [12.9159, 74.8559, 1],
  [12.9896, 74.7938, 0.78],
  [12.8054, 74.8608, 0.72],
  [12.8912, 75.0342, 0.7],
  [13.0669, 74.9952, 0.84],
  [13.2146, 74.9954, 0.62],
  [12.7597, 75.2017, 0.66],
  [12.4996, 74.9869, 0.58],
  [13.3409, 74.7421, 0.76],
  [13.175, 74.777, 0.48],
  [12.64, 75.04, 0.5],
  [12.98, 75.18, 0.46],
  [13.42, 74.8, 0.44],
  [12.58, 75.06, 0.42],
  [13.11, 75.08, 0.4],
  [12.72, 75.08, 0.38],
  [12.812, 74.858, 5], // Restored Ullal danger zone heat
];

const seededAlerts: Alert[] = [
  { id: 'SOS-2409', label: 'Phone shake SOS near Kankanady', priority: 'Critical', status: 'Drone dispatched', coordinate: [74.86, 12.888], time: '00:42 ago', droneId: 'DRN-02' },
  { id: 'SOS-2416', label: 'Emergency call near Lalbagh', priority: 'High', status: 'Awaiting drone', coordinate: [74.849, 12.931], time: '01:28 ago' },
  { id: 'SW-117', label: 'Safe Walk monitoring near Bejai', priority: 'Watch', status: 'Live escort', coordinate: [74.879, 12.926], time: '03:18 ago', droneId: 'DRN-04' },
  { id: 'SOS-2455', label: 'Danger zone', priority: 'Critical', status: 'Awaiting drone', coordinate: [74.868, 12.880], time: '00:14 ago' }
];

const seededSafeWalkUsers: SafeWalkUser[] = [
  { id: 'SW-U1', name: 'Priya', origin: [74.879, 12.926], destination: [74.845, 12.936], status: 'waiting', progress: 0 },
  { id: 'SW-U2', name: 'Ananya', origin: [74.860, 12.888], destination: [74.851, 12.884], status: 'waiting', progress: 0 },
  { id: 'SW-U3', name: 'Meera', origin: [74.828, 12.935], destination: [74.870, 12.920], status: 'waiting', progress: 0 },
  { id: 'SW-U4', name: 'Sneha', origin: [74.850, 12.900], destination: [74.845, 12.910], status: 'waiting', progress: 0 }
];

const demoBounds = {
  west: 74.82,
  east: 74.91,
  south: 12.79,
  north: 12.955
};

const DETAIL_LAYER_MIN_ZOOM = 11.6;

function ensureLandCoordinate([lng, lat]: Coordinate): Coordinate {
  const safeLat = clamp(lat, demoBounds.south, demoBounds.north);
  const coastGuardLng = coastlineGuardLongitude(safeLat);
  return [
    clamp(Math.max(lng, coastGuardLng), demoBounds.west, demoBounds.east),
    safeLat
  ];
}

function ensureLandRoute(route: Coordinate[]) {
  return route.map(ensureLandCoordinate);
}

// Inject hotspots into the nearest drone's initial route using cheapest insertion
hotspots.forEach((hotspot) => {
  let nearestDrone = initialDrones[0];
  let minDistance = Infinity;
  
  // Find which drone should cover this hotspot based on proximity to its station
  initialDrones.forEach((drone) => {
    const dist = turf.distance(turf.point(drone.position), turf.point(hotspot.coordinate));
    if (dist < minDistance) {
      minDistance = dist;
      nearestDrone = drone;
    }
  });

  // Find the optimal segment in the drone's route to insert the hotspot
  let insertIndex = 1;
  let minAddedDistance = Infinity;

  for (let i = 0; i < nearestDrone.route.length - 1; i++) {
    const p1 = nearestDrone.route[i];
    const p2 = nearestDrone.route[i + 1];
    
    const distToP1 = turf.distance(turf.point(p1), turf.point(hotspot.coordinate));
    const distToP2 = turf.distance(turf.point(p2), turf.point(hotspot.coordinate));
    const distP1toP2 = turf.distance(turf.point(p1), turf.point(p2));
    
    // The cost of inserting the hotspot between p1 and p2 is the detour distance
    const addedDistance = distToP1 + distToP2 - distP1toP2;
    
    if (addedDistance < minAddedDistance) {
      minAddedDistance = addedDistance;
      insertIndex = i + 1;
    }
  }

  // Insert the hotspot into the route
  nearestDrone.route.splice(insertIndex, 0, hotspot.coordinate);
});

function coastlineGuardLongitude(lat: number) {
  if (lat >= 12.93) return 74.826;
  if (lat >= 12.91) return 74.823;
  if (lat >= 12.89) return 74.828;
  return 74.835;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function App() {
  const mapNode = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const droneMarkersRef = useRef(new globalThis.Map<string, maplibregl.Marker>());
  const patrolTweensRef = useRef(new globalThis.Map<string, gsap.core.Tween>());
  const dispatchTweenRef = useRef<gsap.core.Tween | null>(null);
  const liveTickerRef = useRef(0);
  const safeClickModeRef = useRef<'origin' | 'destination' | null>(null);

  const [activeView, setActiveView] = useState<NavView>('dashboard');
  const [mapReady, setMapReady] = useState(false);
  const [drones, setDrones] = useState<Drone[]>(initialDrones);
  const [alerts, setAlerts] = useState<Alert[]>(() => seededAlerts.map((alert) => ({ ...alert, coordinate: ensureLandCoordinate(alert.coordinate) })));
  const [timeline, setTimeline] = useState<TimelineEvent[]>([
    { time: 'Now', label: 'Operations online', detail: 'Drone patrol grid synced with high-risk zones.' },
    { time: '01:12', label: 'Patrol route refresh', detail: '4 drones assigned to safety corridors.' },
    { time: '02:48', label: 'Video AI standby', detail: 'YOLOv8 service listed for backend integration.' }
  ]);
  const [toast, setToast] = useState('Women safety drone command center online');
  const [routeProgress, setRouteProgress] = useState(0);
  const [safeWalk, setSafeWalk] = useState<SafeWalk>({ origin: null, destination: null, eta: 0, status: 'Select origin on map' });
  const [operationsOpen, setOperationsOpen] = useState(false);
  const [sosTargetVisible, setSosTargetVisible] = useState(false);
  const [sosBanner, setSosBanner] = useState<string | null>(null);
  const [sosRunning, setSosRunning] = useState(false);
  const [activeSosId, setActiveSosId] = useState<string | null>(null);
  const sosBannerTimersRef = useRef<number[]>([]);
  const [safeWalkUsers, setSafeWalkUsers] = useState<SafeWalkUser[]>(() => seededSafeWalkUsers.map((u) => ({ ...u, origin: ensureLandCoordinate(u.origin), destination: ensureLandCoordinate(u.destination) })));
  const [selectedSafeWalkUserId, setSelectedSafeWalkUserId] = useState<string | null>(null);
  const safeWalkTweensRef = useRef(new globalThis.Map<string, gsap.core.Tween>());

  const activeDrones = drones.filter((drone) => drone.status !== 'Charging').length;
  const criticalAlerts = alerts.filter((alert) => alert.priority === 'Critical').length;
  const responseMetric = criticalAlerts ? '01:46' : '02:18';

  const patrolRouteCollection = useMemo(
    () => featureCollection(initialDrones.map((drone) => turf.lineString(ensureLandRoute(drone.route), { id: drone.id, label: drone.routeName }))),
    []
  );

  const droneStationCollection = useMemo(
    () => featureCollection(droneStations.map((station) => turf.point(ensureLandCoordinate(station.coordinate), station))),
    []
  );

  const hotspotCollection = useMemo(
    () => featureCollection(hotspots.map((hotspot) => turf.point(ensureLandCoordinate(hotspot.coordinate), { ...hotspot, coordinate: ensureLandCoordinate(hotspot.coordinate) }))),
    []
  );

  const riskHeatmapCollection = useMemo(() => {
    const points = heatPoints.map((point) => turf.point([point[1], point[0]], { intensity: point[2] * 0.4 }));
    const alertPoints = alerts.map((alert) => turf.point(alert.coordinate, { intensity: alert.priority === 'Critical' ? 2 : 1.5 }));
    return featureCollection([...points, ...alertPoints]);
  }, [alerts]);

  useEffect(() => {
    if (!mapNode.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: mapNode.current,
      style: lightOsmStyle,
      center,
      zoom: 12.2,
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
      renderDroneMarkers(map, initialDrones);
      bindMap(map);
      fitCollections(map, [patrolRouteCollection, hotspotCollection, droneStationCollection]);
      startPatrols(initialDrones);
      setMapReady(true);
    });

    return () => {
      patrolTweensRef.current.forEach((tween) => tween.kill());
      dispatchTweenRef.current?.kill();
      droneMarkersRef.current.forEach((marker) => marker.remove());
      map.remove();
      mapRef.current = null;
      setMapReady(false);
    };
  }, [droneStationCollection, hotspotCollection, patrolRouteCollection]);

  useEffect(() => {
    if (!mapReady) return;
    if (activeView === 'sos') {
      setSosTargetVisible(true);
      setSource(mapRef.current, sources.sosTarget, createSosMarkerCollection(alerts, activeSosId));
    } else {
      setSosTargetVisible(false);
      setSource(mapRef.current, sources.sosTarget, emptyCollection);
    }
  }, [activeView, alerts, mapReady, activeSosId]);

  useEffect(() => {
    if (!mapReady) return;
    setSource(mapRef.current, sources.riskHeatmap, riskHeatmapCollection);
  }, [riskHeatmapCollection, mapReady]);

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
      const visible = map.getZoom() >= DETAIL_LAYER_MIN_ZOOM ? 'visible' : 'none';
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
        if (map.getLayer(layerId)) map.setLayoutProperty(layerId, 'visibility', visible);
      });
      droneMarkersRef.current.forEach((marker) => {
        const el = marker.getElement();
        el.style.opacity = visible === 'visible' ? '1' : '0';
        el.style.pointerEvents = visible === 'visible' ? 'auto' : 'none';
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
      pulseAt(coordinate);
    });

    map.on('click', 'drone-stations', (event) => {
      const feature = event.features?.[0] as PointFeature | undefined;
      if (!feature) return;
      const coordinate = ensureLandCoordinate(feature.geometry.coordinates as Coordinate);
      new maplibregl.Popup({ className: 'ops-popup', offset: 16 })
        .setLngLat(coordinate)
        .setHTML(`<strong>${feature.properties.name}</strong><span>Standby station for ${feature.properties.droneId}<br/>Responds to nearby SOS calls.</span>`)
        .addTo(map);
      pulseAt(coordinate);
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
      pulseAt(coordinate);
    });

    map.on('click', (event) => {
      if (!safeClickModeRef.current) return;
      const rawCoordinate: Coordinate = [event.lngLat.lng, event.lngLat.lat];
      const coordinate = ensureLandCoordinate(rawCoordinate);
      const wasAdjusted = coordinate[0] !== rawCoordinate[0] || coordinate[1] !== rawCoordinate[1];
      if (safeClickModeRef.current === 'origin') {
        setSafeWalk({ origin: coordinate, destination: null, eta: 0, status: 'Select destination on map' });
        safeClickModeRef.current = 'destination';
        setToast(wasAdjusted ? 'Origin snapped to nearest supported land point. Choose destination.' : 'Origin locked. Choose destination.');
      } else {
        setSafeWalk((current) => buildSafeWalk(current.origin || [74.857, 12.909], coordinate));
        safeClickModeRef.current = null;
      }
    });
  }

  function renderDroneMarkers(map: MapLibreMap, nextDrones: Drone[]) {
    nextDrones.forEach((drone) => {
      const markerNode = document.createElement('button');
      markerNode.className = 'drone-marker';
      markerNode.type = 'button';
      markerNode.title = `${drone.id} ${drone.label}`;
      markerNode.innerHTML = '<span></span>';
      markerNode.addEventListener('click', () => {
        new maplibregl.Popup({ className: 'ops-popup', offset: 18 })
          .setLngLat(ensureLandCoordinate(drone.position))
          .setHTML(`<strong>${drone.id} / ${drone.label}</strong><span>${drone.status} on ${drone.routeName}<br/>Battery ${drone.battery}%</span>`)
          .addTo(map);
      });
      const marker = new maplibregl.Marker({
        element: markerNode,
        anchor: 'center',
        pitchAlignment: 'map',
        rotationAlignment: 'map'
      })
        .setLngLat(ensureLandCoordinate(drone.position))
        .addTo(map);
      droneMarkersRef.current.set(drone.id, marker);
    });
  }

  function startPatrols(nextDrones: Drone[]) {
    nextDrones.forEach((drone, index) => {
      if (drone.status === 'Charging') return;
      const safeRoute = ensureLandRoute(drone.route);
      const line = turf.lineString(safeRoute);
      const distance = turf.length(line, { units: 'kilometers' });
      if (distance < 0.001) return;
      
      const startOffset = (index / nextDrones.length) * distance;
      const startPos = turf.along(line, startOffset, { units: 'kilometers' }).geometry.coordinates as Coordinate;
      const flyToStart = turf.lineString([drone.position, startPos]);
      const flyDist = turf.length(flyToStart, { units: 'kilometers' });

      function startLoop() {
        const progress = { value: startOffset };
        const tween = gsap.to(progress, {
          value: startOffset + distance * 100, // Run for 100 laps
          duration: (24 + index * 5) * 100,
          ease: 'none',
          onUpdate: () => {
            const distAlongRoute = ((progress.value % distance) + distance) % distance;
            const point = turf.along(line, distAlongRoute, { units: 'kilometers' });
            updateDronePosition(drone.id, point.geometry.coordinates as Coordinate);
          }
        });
        patrolTweensRef.current.set(drone.id, tween);
      }

      if (flyDist > 0.05) {
        const flyProgress = { value: 0 };
        const flyTween = gsap.to(flyProgress, {
          value: 1,
          duration: Math.max(2, flyDist * 2.5),
          ease: 'power1.inOut',
          onUpdate: () => {
            const pt = turf.along(flyToStart, flyProgress.value * flyDist, { units: 'kilometers' });
            updateDronePosition(drone.id, pt.geometry.coordinates as Coordinate);
          },
          onComplete: startLoop
        });
        patrolTweensRef.current.set(drone.id, flyTween);
      } else {
        startLoop();
      }
    });
  }

  function updateDronePosition(droneId: string, coordinate: Coordinate): Coordinate {
    const safeCoordinate = ensureLandCoordinate(coordinate);
    droneMarkersRef.current.get(droneId)?.setLngLat(safeCoordinate);
    setDrones((current) => current.map((drone) => drone.id === droneId ? { ...drone, position: safeCoordinate } : drone));
    return safeCoordinate;
  }

  function beginSosSequence(alert: Alert, showPostArrivalBanners = false) {
    const target = ensureLandCoordinate(alert.coordinate);
    const nearest = getNearestDrone(target);
    const nextAlert: Alert = { ...alert, status: 'Drone dispatching', coordinate: target, droneId: nearest.id };
    setAlerts((current) => {
      const exists = current.some((item) => item.id === nextAlert.id);
      return exists
        ? current.map((item) => item.id === nextAlert.id ? nextAlert : item)
        : [nextAlert, ...current].slice(0, 6);
    });
    setTimeline((current) => [
      { time: 'Now', label: `${nextAlert.id} selected`, detail: `Nearest drone ${nearest.id} assigned to ${nextAlert.label}.` },
      { time: '+04s', label: 'Route generated', detail: 'pgRouting dispatch path simulated to SOS caller location.' },
      { time: '+12s', label: 'Live tracking', detail: 'Operator timeline and drone position updating.' },
      ...current
    ].slice(0, 8));
    setToast(`${nearest.id} dispatched to ${nextAlert.id}`);
    dispatchDrone(nearest.id, target, 'Dispatching', showPostArrivalBanners);
    setSosTargetVisible(true);
    pulseAt(target);
  }

  function runSosDemo() {
    // Clear any previous banner timers
    sosBannerTimersRef.current.forEach((t) => window.clearTimeout(t));
    sosBannerTimersRef.current = [];
    setSosRunning(true);
    setActiveView('sos');

    // Pick a random SOS caller from seeded alerts
    const sosAlerts = alerts.filter((a) => a.id.startsWith('SOS'));
    const randomAlert = sosAlerts[Math.floor(Math.random() * sosAlerts.length)] || alerts[0];
    setActiveSosId(randomAlert.id);

    // Phase 1: SOS Received
    setSosBanner('🚨 SOS Received');
    setToast(`SOS received from ${randomAlert.label}`);

    // Phase 2: Alerted Authorities (after 2s)
    sosBannerTimersRef.current.push(window.setTimeout(() => {
      setSosBanner('🔔 Alerted Authorities');
      setTimeline((current) => [{ time: 'Now', label: 'Authorities alerted', detail: `Police and emergency services notified for ${randomAlert.id}.` }, ...current].slice(0, 8));
    }, 2000));

    // Phase 3: Dispatch drone (after 4s)
    sosBannerTimersRef.current.push(window.setTimeout(() => {
      setSosBanner('🚁 Dispatching Drone');
      beginSosSequence(randomAlert, true);
    }, 4000));
  }

  function dispatchDrone(droneId: string, target: Coordinate, status: Drone['status'], showPostArrivalBanners = false) {
    const drone = drones.find((item) => item.id === droneId) || initialDrones.find((item) => item.id === droneId);
    const map = mapRef.current;
    if (!drone || !map) return;
    const safeTarget = ensureLandCoordinate(target);
    const safePosition = ensureLandCoordinate(drone.position);

    patrolTweensRef.current.get(droneId)?.pause();
    dispatchTweenRef.current?.kill();
    const route = createCurvedRoute(safePosition, safeTarget);
    const routeLine = turf.lineString(route, { droneId, target: status });
    const distance = turf.length(routeLine, { units: 'kilometers' });
    setSource(map, sources.activeRoute, featureCollection([])); // Start empty so it draws dynamically
    fitCollections(map, [featureCollection([routeLine])]);

    const progress = { value: 0 };
    dispatchTweenRef.current = gsap.to(progress, {
      value: 1,
      duration: Math.min(15, Math.max(6, distance * 2.8)),
      ease: 'power1.inOut',
      onStart: () => {
        setRouteProgress(0);
        setDrones((current) => current.map((item) => item.id === droneId ? { ...item, status, response: 'en route' } : item));
      },
      onUpdate: () => {
        const currentDist = distance * progress.value;
        const point = turf.along(routeLine, currentDist, { units: 'kilometers' });
        const currentCoord = point.geometry.coordinates as Coordinate;
        updateDronePosition(droneId, currentCoord);
        setRouteProgress(progress.value);

        if (currentDist > 0.001) {
          try {
            const trailedRoute = turf.lineSlice(turf.point(safePosition), point, routeLine);
            trailedRoute.properties = { droneId, target: status };
            setSource(map, sources.activeRoute, featureCollection([trailedRoute as GeoJSON.Feature<GeoJSON.LineString>]));
          } catch (e) {
            // Fallback for identical points
            const trailedRoute = turf.lineString([safePosition, currentCoord], { droneId, target: status });
            setSource(map, sources.activeRoute, featureCollection([trailedRoute]));
          }
        }
      },
      onComplete: () => {
        setDrones((current) => current.map((item) => item.id === droneId ? { ...item, status: 'Monitoring', response: 'on scene' } : item));
        setTimeline((current) => [{ time: 'Now', label: `${droneId} arrived`, detail: 'Drone is holding position over target.' }, ...current].slice(0, 8));
        setToast(`${droneId} arrived at target`);

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
        dispatchTweenRef.current = gsap.to(transitionProgress, {
          value: 1,
          duration: 2.5,
          ease: 'power1.inOut',
          onUpdate: () => {
            const point = turf.along(transitionRoute, transitionProgress.value * transitionDist, { units: 'kilometers' });
            updateDronePosition(droneId, point.geometry.coordinates as Coordinate);
          },
          onComplete: () => {
            const circleProgress = { value: 0 };
            dispatchTweenRef.current = gsap.to(circleProgress, {
              value: 1,
              duration: 10, // Faster orbit
              repeat: -1,
              ease: 'none',
              onUpdate: () => {
                const point = turf.along(circleLine, (circleProgress.value % 1) * circleDistance, { units: 'kilometers' });
                updateDronePosition(droneId, point.geometry.coordinates as Coordinate);
              }
            });
          }
        });

        if (showPostArrivalBanners) {
          // Sequential post-arrival banners
          setSosBanner('🎙️ Recording Audio');
          setTimeline((current) => [{ time: 'Now', label: 'Audio recording', detail: 'Drone microphone activated, recording ambient audio.' }, ...current].slice(0, 8));

          sosBannerTimersRef.current.push(window.setTimeout(() => {
            setSosBanner('📡 Broadcasting Video');
            setTimeline((current) => [{ time: 'Now', label: 'Video broadcast', detail: 'Live HD video feed streaming to control center.' }, ...current].slice(0, 8));
          }, 2500));

          sosBannerTimersRef.current.push(window.setTimeout(() => {
            setSosBanner('📲 Sending Data to Close Contacts');
            setTimeline((current) => [{ time: 'Now', label: 'Contacts notified', detail: 'Location and live status sent to emergency contacts.' }, ...current].slice(0, 8));
          }, 5000));

          sosBannerTimersRef.current.push(window.setTimeout(() => {
            setSosBanner(null);
            setSosRunning(false);
            setToast('SOS response sequence complete');
          }, 7500));
        }
      }
    });
  }

  function getNearestDrone(target: Coordinate) {
    const safeTarget = ensureLandCoordinate(target);
    return drones
      .filter((drone) => drone.status !== 'Charging')
      .map((drone) => ({ drone, distance: turf.distance(turf.point(ensureLandCoordinate(drone.position)), turf.point(safeTarget), { units: 'kilometers' }) }))
      .sort((a, b) => a.distance - b.distance)[0].drone;
  }

  function startSafeWalkSelection() {
    setActiveView('safewalk');
    const resetUsers = seededSafeWalkUsers.map((u) => ({ ...u, origin: ensureLandCoordinate(u.origin), destination: ensureLandCoordinate(u.destination), status: 'waiting' as const, progress: 0, assignedDroneId: undefined }));
    setSafeWalkUsers(resetUsers);
    setSelectedSafeWalkUserId(null);
    setSource(mapRef.current, sources.activeRoute, emptyCollection);
    setSource(mapRef.current, sources.safeRoute, emptyCollection);
    setSource(mapRef.current, sources.safePoints, emptyCollection);
    
    // Display all waiting user markers on the map
    const userPoints = resetUsers.map((u) => turf.point(u.origin, { label: u.name, id: u.id }));
    setSource(mapRef.current, sources.safeUser, featureCollection(userPoints));
    
    setToast('Select a user to start Safe Walk escort');
  }

  function selectSafeWalkUser(userId: string) {
    const user = safeWalkUsers.find((u) => u.id === userId);
    if (!user) return;
    setSelectedSafeWalkUserId(userId);
    const map = mapRef.current;
    if (!map) return;
    const route = createCurvedRoute(user.origin, user.destination);
    const routeLine = turf.lineString(route, { type: 'Safe Walk' });
    setSource(map, sources.safeRoute, featureCollection([routeLine]));
    setSource(map, sources.safeUser, featureCollection([turf.point(user.origin, { label: `${user.name}'s position` })]));
    setSource(map, sources.safePoints, featureCollection([
      turf.point(user.origin, { label: 'Origin', kind: 'origin' }),
      turf.point(user.destination, { label: 'Destination', kind: 'destination' })
    ]));
    fitCollections(map, [featureCollection([routeLine])]);
  }

  function beginSafeWalkForUser(userId: string) {
    const user = safeWalkUsers.find((u) => u.id === userId);
    if (!user || user.status !== 'waiting') return;
    const map = mapRef.current;
    if (!map) return;

    // Find the station closest to user's origin; dispatch drone from station
    const stationForDrone = (droneId: string) => droneStations.find((s) => s.droneId === droneId);
    const nearest = getNearestDrone(user.origin);
    const station = stationForDrone(nearest.id);
    const stationCoord = station ? ensureLandCoordinate(station.coordinate) : ensureLandCoordinate(nearest.position);

    // Assign drone
    setSafeWalkUsers((prev) => prev.map((u) => u.id === userId ? { ...u, status: 'pickup', assignedDroneId: nearest.id, progress: 0 } : u));
    setSafeWalk({ origin: user.origin, destination: user.destination, eta: 0, status: 'Drone en route to user', activeDroneId: nearest.id });
    setTimeline((current) => [
      { time: 'Now', label: 'Safe Walk started', detail: `${nearest.id} dispatched from station to ${user.name}.` },
      ...current
    ].slice(0, 8));
    setToast(`${nearest.id} dispatched to escort ${user.name}`);

    // Stop patrol
    patrolTweensRef.current.get(nearest.id)?.pause();
    dispatchTweenRef.current?.kill();
    safeWalkTweensRef.current.get(userId)?.kill();

    // Build route segments
    const userRoute = createCurvedRoute(user.origin, user.destination);
    const userRouteLine = turf.lineString(userRoute, { type: 'Safe Walk' });
    const userRouteDistance = turf.length(userRouteLine, { units: 'kilometers' });

    // Phase 1: Drone flies from station to user's origin
    const pickupRoute = turf.lineString(createCurvedRoute(stationCoord, user.origin), { droneId: nearest.id, mode: 'pickup' });
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
        
        updateDronePosition(nearest.id, currentCoord);
        setSafeWalkUsers((prev) => prev.map((u) => u.id === userId ? { ...u, progress: pickupProgress.value * 0.15 } : u));
        setRouteProgress(pickupProgress.value * 0.15);
      },
      onComplete: () => {
        // Phase 2: Escort along user route
        setSafeWalkUsers((prev) => prev.map((u) => u.id === userId ? { ...u, status: 'escorting' } : u));
        setDrones((current) => current.map((d) => d.id === nearest.id ? { ...d, status: 'Monitoring', response: 'escort' } : d));
        setTimeline((current) => [{ time: 'Now', label: `${nearest.id} reached ${user.name}`, detail: 'Drone is now escorting beside the user.' }, ...current].slice(0, 8));
        setToast(`${nearest.id} is escorting ${user.name}`);

        const escortRoute = turf.lineString(createEscortRoute(userRoute), { droneId: nearest.id, mode: 'escort' });

        const escortProgress = { value: 0 };
        
        const escortTween = gsap.to(escortProgress, {
          value: 1,
          duration: Math.min(24, Math.max(9, userRouteDistance * 4.2)),
          ease: 'none',
          onUpdate: () => {
            const currentDist = userRouteDistance * escortProgress.value;
            const userPoint = turf.along(userRouteLine, currentDist, { units: 'kilometers' });
            const userCoord = ensureLandCoordinate(userPoint.geometry.coordinates as Coordinate);
            const droneCoord = offsetEscortCoordinate(userCoord);
            
            setSource(map, sources.safeUser, featureCollection([turf.point(userCoord, { label: `${user.name}'s position` })]));
            updateDronePosition(nearest.id, droneCoord);
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

              const returnRoute = turf.lineString(createCurvedRoute(dest, stationCoord), { droneId: nearest.id, mode: 'return' });
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
                  
                  updateDronePosition(nearest.id, currentCoord);
                  setSafeWalkUsers((prev) => prev.map((u) => u.id === userId ? { ...u, progress: 0.85 + returnProgress.value * 0.15 } : u));
                  setRouteProgress(0.85 + returnProgress.value * 0.15);
                },
                onComplete: () => {
                  // Done — resume patrol
                  setSafeWalkUsers((prev) => prev.map((u) => u.id === userId ? { ...u, status: 'complete', progress: 1 } : u));
                  setDrones((current) => current.map((d) => d.id === nearest.id ? { ...d, status: 'Patrol', response: 'complete' } : d));
                  setSafeWalk((current) => ({ ...current, status: 'Escort complete' }));
                  setSource(map, sources.activeRoute, emptyCollection);
                  setTimeline((current) => [{ time: 'Now', label: `${nearest.id} at station`, detail: 'Drone returned and resuming patrol.' }, ...current].slice(0, 8));
                  setToast(`${nearest.id} returned to station`);
                  // Restart patrol
                  const droneData = initialDrones.find((d) => d.id === nearest.id);
                  if (droneData) {
                    patrolTweensRef.current.get(nearest.id)?.kill();
                    const safeRoute = ensureLandRoute(droneData.route);
                    const line = turf.lineString(safeRoute);
                    const dist = turf.length(line, { units: 'kilometers' });
                    
                    const flyToStart = turf.lineString([stationCoord, safeRoute[0]]);
                    const flyDist = turf.length(flyToStart, { units: 'kilometers' });

                    function startLoop() {
                      const progress = { value: 0 };
                      const tween = gsap.to(progress, {
                        value: dist * 100,
                        duration: 24 * 100,
                        ease: 'none',
                        onUpdate: () => {
                          const distAlongRoute = ((progress.value % dist) + dist) % dist;
                          const pt = turf.along(line, distAlongRoute, { units: 'kilometers' });
                          updateDronePosition(nearest.id, pt.geometry.coordinates as Coordinate);
                        }
                      });
                      patrolTweensRef.current.set(nearest.id, tween);
                    }

                    if (flyDist > 0.05) {
                      const flyProgress = { value: 0 };
                      const flyTween = gsap.to(flyProgress, {
                        value: 1,
                        duration: Math.max(2, flyDist * 2.5),
                        ease: 'power1.inOut',
                        onUpdate: () => {
                          const pt = turf.along(flyToStart, flyProgress.value * flyDist, { units: 'kilometers' });
                          updateDronePosition(nearest.id, pt.geometry.coordinates as Coordinate);
                        },
                        onComplete: startLoop
                      });
                      patrolTweensRef.current.set(nearest.id, flyTween);
                    } else {
                      startLoop();
                    }
                  }
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

  function buildSafeWalk(origin: Coordinate, destination: Coordinate): SafeWalk {
    const safeOrigin = ensureLandCoordinate(origin);
    const safeDestination = ensureLandCoordinate(destination);
    const route = createCurvedRoute(safeOrigin, safeDestination);
    const routeLine = turf.lineString(route, { type: 'Safe Walk' });
    const distance = turf.length(routeLine, { units: 'kilometers' });
    const nearest = getNearestDrone(safeOrigin);
    const map = mapRef.current;
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

  function startSafeWalkEscort(droneId: string, userRouteLine: GeoJSON.Feature<GeoJSON.LineString>) {
    const drone = drones.find((item) => item.id === droneId) || initialDrones.find((item) => item.id === droneId);
    const map = mapRef.current;
    if (!drone || !map) return;

    patrolTweensRef.current.get(droneId)?.pause();
    dispatchTweenRef.current?.kill();

    const userRouteDistance = turf.length(userRouteLine, { units: 'kilometers' });
    const origin = ensureLandCoordinate(userRouteLine.geometry.coordinates[0] as Coordinate);
    const dispatchRoute = turf.lineString(createCurvedRoute(ensureLandCoordinate(drone.position), origin), { droneId, mode: 'pickup' });
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
        updateDronePosition(droneId, point.geometry.coordinates as Coordinate);
        setRouteProgress(pickupProgress.value * 0.35);
      },
      onComplete: () => {
        const escortRoute = turf.lineString(createEscortRoute(userRouteLine.geometry.coordinates as Coordinate[]), { droneId, mode: 'escort' });
        setTimeline((current) => [{ time: 'Now', label: `${droneId} reached user`, detail: 'Drone is now escorting beside the user route.' }, ...current].slice(0, 8));
        setDrones((current) => current.map((item) => item.id === droneId ? { ...item, status: 'Monitoring', response: 'escort' } : item));

        const escortProgress = { value: 0 };
        dispatchTweenRef.current = gsap.to(escortProgress, {
          value: 1,
          duration: Math.min(24, Math.max(9, userRouteDistance * 4.2)),
          ease: 'none',
          onUpdate: () => {
            const userPoint = turf.along(userRouteLine, userRouteDistance * escortProgress.value, { units: 'kilometers' });
            const userCoordinate = ensureLandCoordinate(userPoint.geometry.coordinates as Coordinate);
            const droneCoordinate = offsetEscortCoordinate(userCoordinate);
            setSource(map, sources.safeUser, featureCollection([turf.point(userCoordinate, { label: 'User live position' })]));
            updateDronePosition(droneId, droneCoordinate);
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

  function pulseAt(coordinate: Coordinate) {
    const map = mapRef.current;
    if (!map) return;
    const safeCoordinate = ensureLandCoordinate(coordinate);
    const node = document.createElement('div');
    node.className = 'click-pulse';
    const marker = new maplibregl.Marker({ element: node }).setLngLat(safeCoordinate).addTo(map);
    gsap.fromTo(node, { scale: 0.35, opacity: 1 }, { scale: 3.2, opacity: 0, duration: 1.2, ease: 'power2.out', onComplete: () => marker.remove() });
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
              <Metric icon={<Bot size={16} />} label="Available drones" value={`${activeDrones}/${drones.length}`} />
              <Metric icon={<Siren size={16} />} label="Active SOS" value={String(criticalAlerts)} danger={criticalAlerts > 0} />
              <Metric icon={<UserRound size={16} />} label="Safe Walk" value={safeWalk.activeDroneId ? '1 live' : 'standby'} />
              <Metric icon={<Timer size={16} />} label="Avg response" value={responseMetric} />
            </div>

            <SectionTitle icon={<Radio size={15} />} label="Available Drones" />
            <div className="drone-list">
              {drones.map((drone) => (
                <button className="drone-row" key={drone.id} type="button" onClick={() => mapRef.current?.easeTo({ center: drone.position, zoom: 14.6, duration: 800, easing: easeOut })}>
                  <span className={`status-dot ${drone.status.toLowerCase()}`} />
                  <span>
                    <strong>{drone.id}</strong>
                    <small>{drone.label} / {stationNameForDrone(drone.id)}</small>
                  </span>
                  <em>{drone.battery}%</em>
                </button>
              ))}
            </div>

            <SectionTitle icon={<AlertTriangle size={15} />} label="Active SOS Alerts" />
            <div className="alert-list">
              {alerts.map((alert) => (
                <button className="alert-row" key={alert.id} type="button" onClick={() => mapRef.current?.easeTo({ center: alert.coordinate, zoom: 15, duration: 850, easing: easeOut })}>
                  <strong>{alert.id}</strong>
                  <span>{alert.label}</span>
                  <small>{alert.priority} / {alert.status}</small>
                </button>
              ))}
            </div>
          </motion.aside>
        )}
      </AnimatePresence>

      <motion.header className="glass-panel top-dock" initial={{ y: -26, opacity: 0 }} animate={{ y: 0, opacity: 1 }}>
        <div className="top-title">
          <strong>Women Safety Drone Response</strong>
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
        {!operationsOpen && (
          <motion.section className="glass-panel action-deck" initial={{ x: -28, opacity: 0, filter: 'blur(8px)' }} animate={{ x: 0, opacity: 1, filter: 'blur(0px)' }} exit={{ x: -22, opacity: 0, filter: 'blur(8px)' }}>
            {activeView === 'sos' ? (
              <SosDemo timeline={timeline} progress={routeProgress} runSosDemo={runSosDemo} sosRunning={sosRunning} />
            ) : activeView === 'safewalk' ? (
              <SafeWalkDemo safeWalk={safeWalk} safeWalkUsers={safeWalkUsers} selectedUserId={selectedSafeWalkUserId} startSafeWalkSelection={startSafeWalkSelection} selectUser={selectSafeWalkUser} beginWalk={beginSafeWalkForUser} routeProgress={routeProgress} />
            ) : activeView === 'about' ? (
              <AboutPanel />
            ) : (
              <DashboardDeck timeline={timeline} openSosDemo={runSosDemo} startSafeWalkSelection={startSafeWalkSelection} />
            )}
          </motion.section>
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
        <div className="legend-item"><span className="legend-dot sos" />Danger zones</div>
        {sosTargetVisible && <div className="legend-item"><span className="legend-dot target" />SOS caller</div>}
        {activeView === 'safewalk' && <div className="legend-item"><span className="legend-dot safewalk-user" />Safe Walk User</div>}
        <div className="legend-heat"><span className="heat-swatch" />Risk heat</div>
      </motion.section>

      <AnimatePresence>
        <motion.div className="toast" key={toast} initial={{ y: 18, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 12, opacity: 0 }}>
          {toast}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

function SosDemo({ timeline, progress, runSosDemo, sosRunning }: { timeline: TimelineEvent[]; progress: number; runSosDemo: () => void; sosRunning: boolean }) {
  return (
    <>
      <PanelTitle eyebrow="SOS Demo" title="Emergency Dispatch" subtitle="Click below to simulate an SOS emergency response sequence." />
      <button className="primary-action danger-action" type="button" onClick={runSosDemo} disabled={sosRunning} style={{ opacity: sosRunning ? 0.5 : 1 }}>
        <Siren size={17} /> {sosRunning ? 'SOS In Progress...' : 'Simulate SOS'}
      </button>
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

function DashboardDeck(props: {
  timeline: TimelineEvent[];
  openSosDemo: () => void;
  startSafeWalkSelection: () => void;
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
            <li><strong>Live Drone Patrols:</strong> Automated routing along high-risk corridors with strict coastline geofencing.</li>
            <li><strong>SOS Emergency Dispatch:</strong> Immediate drone deployment to active SOS callers with predictive target orbiting.</li>
            <li><strong>Safe Walk Escorts:</strong> Real-time user escort tracking with synchronized drone trailing and destination verification.</li>
            <li><strong>Dynamic Risk Heatmaps:</strong> Interactive visualization of historical danger zones and active alert clusters.</li>
          </ul>
        </div>
        <p>
          <strong>System Architecture:</strong> Frontend prototype designed for seamless integration with a FastAPI backend, PostGIS/pgRouting for pathfinding, and YOLOv8 for live computer vision analysis.
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

function stationNameForDrone(droneId: string) {
  return droneStations.find((station) => station.droneId === droneId)?.name || 'Standby station';
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

  map.addLayer({ id: 'patrol-routes', type: 'line', source: sources.patrolRoutes, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#050505', 'line-width': 3, 'line-opacity': 0.54, 'line-dasharray': [1.4, 1.8] } });
  map.addLayer({ id: 'safe-route-glow', type: 'line', source: sources.safeRoute, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#2563eb', 'line-width': 12, 'line-opacity': 0.15 } });
  map.addLayer({ id: 'safe-route', type: 'line', source: sources.safeRoute, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#2563eb', 'line-width': 5, 'line-opacity': 0.86, 'line-dasharray': [0.7, 1.1] } });
  map.addLayer({ id: 'active-route-glow', type: 'line', source: sources.activeRoute, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#050505', 'line-width': 14, 'line-opacity': 0.16 } });
  map.addLayer({ id: 'active-route', type: 'line', source: sources.activeRoute, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#050505', 'line-width': 6, 'line-opacity': 0.9 } });
  map.addLayer({ id: 'drone-station-halo', type: 'circle', source: sources.droneStations, minzoom: DETAIL_LAYER_MIN_ZOOM, paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 13, 15, 22], 'circle-color': '#0891b2', 'circle-opacity': 0.16, 'circle-blur': 0.35 } });
  map.addLayer({ id: 'drone-stations', type: 'circle', source: sources.droneStations, minzoom: DETAIL_LAYER_MIN_ZOOM, paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 6, 15, 9], 'circle-color': '#0891b2', 'circle-stroke-color': '#f8fafc', 'circle-stroke-width': 2 } });
  map.addLayer({ id: 'unclustered-hotspot', type: 'circle', source: sources.hotspots, minzoom: DETAIL_LAYER_MIN_ZOOM, paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 11.6, 5, 16, 10], 'circle-color': '#ef4444', 'circle-opacity': ['interpolate', ['linear'], ['zoom'], 11.6, 0, 12.2, 0.9], 'circle-stroke-color': '#f8fafc', 'circle-stroke-width': 2 } });
  map.addLayer({ id: 'target-halo', type: 'circle', source: sources.sosTarget, minzoom: DETAIL_LAYER_MIN_ZOOM, paint: { 'circle-radius': 28, 'circle-color': '#a855f7', 'circle-opacity': 0.18, 'circle-blur': 0.38 } });
  map.addLayer({ id: 'target-point', type: 'circle', source: sources.sosTarget, minzoom: DETAIL_LAYER_MIN_ZOOM, paint: { 'circle-radius': 8, 'circle-color': '#a855f7', 'circle-stroke-color': '#faf5ff', 'circle-stroke-width': 2 } });
  map.addLayer({ id: 'safe-points', type: 'circle', source: sources.safePoints, minzoom: DETAIL_LAYER_MIN_ZOOM, paint: { 'circle-radius': 8, 'circle-color': ['match', ['get', 'kind'], 'origin', '#22c55e', '#2563eb'], 'circle-stroke-color': '#f8fafc', 'circle-stroke-width': 2 } });
  map.addLayer({ id: 'safe-user-halo', type: 'circle', source: sources.safeUser, minzoom: DETAIL_LAYER_MIN_ZOOM, paint: { 'circle-radius': 19, 'circle-color': '#ec4899', 'circle-opacity': 0.16, 'circle-blur': 0.35 } });
  map.addLayer({ id: 'safe-user-point', type: 'circle', source: sources.safeUser, minzoom: DETAIL_LAYER_MIN_ZOOM, paint: { 'circle-radius': 7, 'circle-color': '#ec4899', 'circle-stroke-color': '#eff6ff', 'circle-stroke-width': 2 } });
}

function createSosMarkerCollection(alerts: Alert[], activeSosId: string | null = null) {
  const visibleAlerts = activeSosId ? alerts.filter((a) => a.id === activeSosId) : [];
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

function createCurvedRoute(start: Coordinate, end: Coordinate) {
  // Return a straight line between start and end, ensuring coordinates are land‑safe.
  const safeStart = ensureLandCoordinate(start);
  const safeEnd = ensureLandCoordinate(end);
  return [safeStart, safeEnd];
}

function createEscortRoute(route: Coordinate[]) {
  return route.map((coordinate) => offsetEscortCoordinate(coordinate));
}

function offsetEscortCoordinate([lng, lat]: Coordinate): Coordinate {
  // Use a very tiny offset so the drone visually flies closely attached to the user route
  return ensureLandCoordinate([lng + 0.00008, lat + 0.00004]);
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
