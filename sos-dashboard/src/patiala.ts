/**
 * Patiala scenario data - replaces the hard-coded Mangalore demo.
 *
 * Coordinates are [lng, lat] (MapLibre order).  Patrol corridors are authored
 * from real Patiala geography (Qila Mubarak, Rajindra Hospital, Punjabi
 * University, the railway station, Model Town, Tripuri Town, ...).  Each
 * corridor has a drone station somewhere along it and 3-4 danger zones along
 * the route; the optimized patrol loop (station -> zones -> station) is
 * computed once by the route planner at runtime and cached in localStorage
 * (see PATROL_CACHE_KEY in main.tsx).  Swap the coordinates here with real
 * ground-truth data whenever it becomes available - nothing else changes.
 */

export type CoordinatePair = [number, number];

export interface DangerZoneSeed {
  id: string;
  label: string;
  coordinate: CoordinatePair;
  severity: number;
  category: string;
}

export interface PatrolCorridorSeed {
  id: string;
  /** display name of the patrol loop */
  name: string;
  droneId: string;
  stationId: string;
  dangerZones: DangerZoneSeed[];
}

export interface DroneSeed {
  id: string;
  label: string;
  battery: number;
  response: string;
}

export interface StationSeed {
  id: string;
  name: string;
  coordinate: CoordinatePair;
}

export interface AlertSeed {
  id: string;
  label: string;
  priority: "Critical" | "High" | "Watch";
  status: string;
  coordinate: CoordinatePair;
  time: string;
}

export interface SafeWalkUserSeed {
  id: string;
  name: string;
  origin: CoordinatePair;
  destination: CoordinatePair;
}

export interface PatrolPointSeed {
  id: string;
  name: string;
  coordinate: CoordinatePair;
  sequence: number;
}

export interface PatialaScenario {
  /** bump when the danger zones / routes change so cached patrol loops refresh */
  version: number;
  name: string;
  center: CoordinatePair;
  initialZoom: number;
  bounds: { west: number; east: number; south: number; north: number };
  drones: DroneSeed[];
  stations: StationSeed[];
  corridors: PatrolCorridorSeed[];
  patrolPoints: PatrolPointSeed[];
  /** [lat, lng, intensity] - note the lat-first order (matches the old heat data) */
  heatPoints: Array<[number, number, number]>;
  seededAlerts: AlertSeed[];
  safeWalkUsers: SafeWalkUserSeed[];
}

export const patialaConfig: PatialaScenario = {
  version: 3,
  name: "Patiala",
  center: [76.3865, 30.3385],
  initialZoom: 12.6,
  bounds: {
    west: 76.3,
    east: 76.47,
    south: 30.28,
    north: 30.39,
  },
  drones: [
    { id: "DRN-01", label: "Qila Guardian", battery: 92, response: "1.8 min" },
    { id: "DRN-02", label: "University Watch", battery: 78, response: "2.4 min" },
    { id: "DRN-03", label: "Railway Sentinel", battery: 85, response: "3.1 min" },
    { id: "DRN-04", label: "Tripuri Shield", battery: 88, response: "2.1 min" },
  ],
  // Stations sit at the centroid of their corridor's danger zones (near the
  // center of each patrol polygon) - a home pad inside the zone, not a
  // waypoint on the route.  Coordinates are kept OUTSIDE the DGCA red
  // (prohibited) no-fly polygons so a drone can always take off / land / pass
  // through its own station (checked against no_fly_zones_india.json).
  stations: [
    { id: "DST-01", name: "City Core Post", coordinate: [76.398, 30.3337] },
    { id: "DST-02", name: "Sirhind Road Post", coordinate: [76.4199, 30.3384] },
    { id: "DST-03", name: "South City Post", coordinate: [76.3998, 30.3262] },
    { id: "DST-04", name: "Tripuri Post", coordinate: [76.3887, 30.3467] },
  ],
  corridors: [
    {
      id: "corridor-city-core",
      name: "City Core - Qila loop",
      droneId: "DRN-01",
      stationId: "DST-01",
      dangerZones: [
        { id: "HS-101", label: "Qila Mubarak old city cluster", coordinate: [76.3978, 30.3286], severity: 0.96, category: "Old City" },
        { id: "HS-102", label: "Rajindra Hospital approach", coordinate: [76.3952, 30.3321], severity: 0.88, category: "Hospital" },
        { id: "HS-103", label: "Adalat Bazar market pressure", coordinate: [76.3986, 30.3394], severity: 0.82, category: "Market" },
        { id: "HS-104", label: "Chowk / Anardana Bazar", coordinate: [76.4005, 30.3345], severity: 0.9, category: "Market" },
      ],
    },
    {
      id: "corridor-university",
      name: "University - Sirhind Rd corridor",
      droneId: "DRN-02",
      stationId: "DST-02",
      dangerZones: [
        { id: "HS-105", label: "Model Town market crossing", coordinate: [76.405, 30.338], severity: 0.84, category: "Market" },
        { id: "HS-106", label: "Sirhind Road late-night stretch", coordinate: [76.421, 30.334], severity: 0.72, category: "Road" },
        { id: "HS-107", label: "Punjabi University gate area", coordinate: [76.437, 30.339], severity: 0.7, category: "Campus" },
        { id: "HS-108", label: "Urban Estate walkway reports", coordinate: [76.414, 30.3425], severity: 0.76, category: "Residential" },
      ],
    },
    {
      id: "corridor-railway",
      name: "Railway - South corridor",
      droneId: "DRN-03",
      stationId: "DST-03",
      dangerZones: [
        { id: "HS-109", label: "New Bus Stand terminal", coordinate: [76.4055, 30.333], severity: 0.86, category: "Transit" },
        { id: "HS-110", label: "Railway approach / Dak Ghar", coordinate: [76.409, 30.328], severity: 0.8, category: "Transit" },
        { id: "HS-111", label: "Nabha Road crossing", coordinate: [76.385, 30.3175], severity: 0.68, category: "Road" },
        { id: "HS-112", label: "Bhupindra Colony lanes", coordinate: [76.3925, 30.323], severity: 0.74, category: "Residential" },
      ],
    },
    {
      id: "corridor-tripuri",
      name: "Tripuri - North loop",
      droneId: "DRN-04",
      stationId: "DST-04",
      dangerZones: [
        { id: "HS-113", label: "Tripuri town market", coordinate: [76.3904, 30.3506], severity: 0.78, category: "Market" },
        { id: "HS-114", label: "Sheranwala Gate junction", coordinate: [76.392, 30.342], severity: 0.66, category: "Junction" },
        { id: "HS-115", label: "Chandan Nagar low-light block", coordinate: [76.3796, 30.3455], severity: 0.7, category: "Residential" },
        { id: "HS-116", label: "New Lal Bagh Colony", coordinate: [76.3945, 30.3525], severity: 0.64, category: "Residential" },
      ],
    },
  ],
  heatPoints: [
    [30.339, 76.394, 1],
    [30.329, 76.398, 0.85],
    [30.349, 76.405, 0.78],
    [30.357, 76.444, 0.7],
    [30.325, 76.41, 0.72],
    [30.317, 76.385, 0.66],
    [30.355, 76.384, 0.68],
    [30.352, 76.418, 0.6],
    [30.331, 76.372, 0.55],
    [30.366, 76.402, 0.52],
  ],
  patrolPoints: [
    { id: "PAT-01", name: "Baradari Gardens Gate", coordinate: [76.399, 30.3465], sequence: 1 },
    { id: "PAT-02", name: "Qila Mubarak East", coordinate: [76.4015, 30.3286], sequence: 2 },
    { id: "PAT-03", name: "Sirhind Road Turn", coordinate: [76.423, 30.336], sequence: 3 },
    { id: "PAT-04", name: "Bus Stand Junction", coordinate: [76.4055, 30.333], sequence: 4 },
    { id: "PAT-05", name: "Tripuri Market Gate", coordinate: [76.3904, 30.3506], sequence: 5 },
    { id: "PAT-06", name: "Punjabi University Gate", coordinate: [76.4435, 30.357], sequence: 6 },
  ],
  // SOS callers sit OFF the patrol loops - a real emergency is rarely at a
  // patrolled waypoint. Each coordinate is a few hundred metres from its
  // nearest corridor so dispatch always routes through the planner instead
  // of falling on a patrol point.
  seededAlerts: [
    { id: "SOS-2409", label: "Phone shake SOS near Rajindra Hospital", priority: "Critical", status: "Drone dispatched", coordinate: [76.3938, 30.3312], time: "00:42 ago" },
    { id: "SOS-2416", label: "Emergency call near Model Town Market", priority: "High", status: "Awaiting drone", coordinate: [76.4053, 30.3482], time: "01:28 ago" },
    { id: "SW-117", label: "Safe Walk monitoring near Baradari Gardens", priority: "Watch", status: "Live escort", coordinate: [76.3972, 30.3452], time: "03:18 ago" },
    { id: "SOS-2455", label: "Emergency call near New Bus Stand", priority: "Critical", status: "Awaiting drone", coordinate: [76.4028, 30.3352], time: "00:14 ago" },
  ],
  safeWalkUsers: [
    { id: "SW-U1", name: "Priya", origin: [76.404, 30.3495], destination: [76.399, 30.3465] },
    { id: "SW-U2", name: "Ananya", origin: [76.4095, 30.325], destination: [76.3978, 30.3286] },
    { id: "SW-U3", name: "Meera", origin: [76.3909, 30.3568], destination: [76.3895, 30.338] },
    { id: "SW-U4", name: "Sneha", origin: [76.4024, 30.3668], destination: [76.4045, 30.349] },
  ],
};
