#!/usr/bin/env python3
"""Seed new safety cities into the Neon-backed API.

Builds a full command grid per city (stations, patrol drones, patrol points,
danger-zone AREAS as polygon rings) and PUTs it to /api/safety/config, which
upserts into Neon.  The backend auto-creates the reserve fleet and spare pool
for each patrol drone/station, so only patrol drones need to be sent.

Entity ids are globally unique primary keys, so every city prefixes its
station/drone/zone ids with its own slug (e.g. CHD-DST-01, CHD-DRN-01) -
bare DST-01/DRN-01 ids would collide with other cities on save.

Usage:
    python3 scripts/seed-cities.py [--base http://localhost:3000/api/safety]
"""

import json
import sys
import urllib.request

BASE = "http://localhost:3000/api/safety"
if "--base" in sys.argv:
    BASE = sys.argv[sys.argv.index("--base") + 1]


def ring(center, size=0.008):
    """A small closed polygon ring [lng, lat] around a coordinate."""
    lng, lat = center
    return [
        [lng - size, lat - size],
        [lng + size, lat - size],
        [lng + size, lat + size],
        [lng - size, lat + size],
        [lng - size, lat - size],
    ]


def put(city_id, config):
    req = urllib.request.Request(
        f"{BASE}/config",
        data=json.dumps(config).encode(),
        headers={"Content-Type": "application/json"},
        method="PUT",
    )
    with urllib.request.urlopen(req) as resp:
        body = json.loads(resp.read())
    saved = body.get("dangerZones") or []
    assert body.get("stations"), f"save returned no stations for {city_id}"
    assert saved, f"save returned no danger zones for {city_id}"
    roles = {}
    for d in body.get("drones") or []:
        roles[d.get("role")] = roles.get(d.get("role"), 0) + 1
    rings = sum(1 for z in saved if z.get("ring"))
    print(f"  saved {city_id}: {len(body['stations'])} stations, {roles} drones, {len(saved)} zones ({rings} with rings)")


def city_grid(city, stations, drones, danger_zones):
    return {
        "city": city,
        "stations": stations,
        "drones": drones,
        "patrolPoints": [],
        "dangerZones": danger_zones,
        "planner": {"gridResolutionM": None},
    }


# ---------------------------------------------------------------------------
# Chandigarh - the planned city.
chandigarh = city_grid(
    {"id": "chandigarh", "name": "Chandigarh", "country": "India", "center": [76.7794, 30.7333], "zoom": 12.6},
    stations=[
        {"id": "CHD-DST-01", "name": "Sector 17 Post", "coordinate": [76.7761, 30.7418], "droneId": "CHD-DRN-01"},
        {"id": "CHD-DST-02", "name": "Sukhna Lake Post", "coordinate": [76.8102, 30.7445], "droneId": "CHD-DRN-02"},
        {"id": "CHD-DST-03", "name": "PGIMER Post", "coordinate": [76.8027, 30.7582], "droneId": "CHD-DRN-03"},
        {"id": "CHD-DST-04", "name": "Industrial Area Post", "coordinate": [76.7961, 30.7041], "droneId": "CHD-DRN-04"},
    ],
    drones=[
        {"id": "CHD-DRN-01", "label": "Sector 17 Watch", "stationId": "CHD-DST-01", "battery": 90, "response": "1.9 min", "status": "Patrol", "role": "Patrol", "position": [76.7761, 30.7418], "routeName": "Sector 17 - Rock Garden loop", "route": [[76.7761, 30.7418], [76.7847, 30.7525], [76.7975, 30.7551], [76.7761, 30.7418]]},
        {"id": "CHD-DRN-02", "label": "Sukhna Watch", "stationId": "CHD-DST-02", "battery": 84, "response": "2.6 min", "status": "Patrol", "role": "Patrol", "position": [76.8102, 30.7445], "routeName": "Sukhna - Sector 26 loop", "route": [[76.8102, 30.7445], [76.8044, 30.7355], [76.7941, 30.7331], [76.8102, 30.7445]]},
        {"id": "CHD-DRN-03", "label": "PGIMER Sentinel", "stationId": "CHD-DST-03", "battery": 79, "response": "3.0 min", "status": "Patrol", "role": "Patrol", "position": [76.8027, 30.7582], "routeName": "PGIMER - Sector 22 loop", "route": [[76.8027, 30.7582], [76.7906, 30.7522], [76.7802, 30.7441], [76.8027, 30.7582]]},
        {"id": "CHD-DRN-04", "label": "Elante Shield", "stationId": "CHD-DST-04", "battery": 87, "response": "2.2 min", "status": "Patrol", "role": "Patrol", "position": [76.7961, 30.7041], "routeName": "Industrial Area - Elante loop", "route": [[76.7961, 30.7041], [76.7948, 30.7086], [76.7812, 30.7112], [76.7961, 30.7041]]},
    ],
    danger_zones=[
        {"id": "CHD-101", "name": "Sector 17 plaza cluster", "category": "Market", "severity": 0.85, "coordinate": [76.7761, 30.7418], "radiusM": 150, "ring": ring([76.7761, 30.7418])},
        {"id": "CHD-102", "name": "Sukhna Lake promenade", "category": "Recreation", "severity": 0.62, "coordinate": [76.8102, 30.7445], "radiusM": 150, "ring": ring([76.8102, 30.7445])},
        {"id": "CHD-103", "name": "PGIMER approach", "category": "Hospital", "severity": 0.9, "coordinate": [76.8027, 30.7582], "radiusM": 150, "ring": ring([76.8027, 30.7582])},
        {"id": "CHD-104", "name": "Sector 22 market", "category": "Market", "severity": 0.78, "coordinate": [76.7802, 30.7441], "radiusM": 150, "ring": ring([76.7802, 30.7441])},
        {"id": "CHD-105", "name": "Railway station forecourt", "category": "Transit", "severity": 0.82, "coordinate": [76.7724, 30.7015], "radiusM": 150, "ring": ring([76.7724, 30.7015])},
        {"id": "CHD-106", "name": "Elante Mall crowd", "category": "Market", "severity": 0.7, "coordinate": [76.7948, 30.7086], "radiusM": 150, "ring": ring([76.7948, 30.7086])},
        {"id": "CHD-107", "name": "Kharar road stretch", "category": "Road", "severity": 0.66, "coordinate": [76.7612, 30.7188], "radiusM": 150, "ring": ring([76.7612, 30.7188])},
        {"id": "CHD-108", "name": "Sector 26 low-light block", "category": "Residential", "severity": 0.58, "coordinate": [76.7941, 30.7331], "radiusM": 150, "ring": ring([76.7941, 30.7331])},
    ],
)

# ---------------------------------------------------------------------------
# Amritsar.
amritsar = city_grid(
    {"id": "amritsar", "name": "Amritsar", "country": "India", "center": [74.8723, 31.6340], "zoom": 12.4},
    stations=[
        {"id": "ASR-DST-01", "name": "Golden Temple Post", "coordinate": [74.8773, 31.6200], "droneId": "ASR-DRN-01"},
        {"id": "ASR-DST-02", "name": "Railway Post", "coordinate": [74.8656, 31.6337], "droneId": "ASR-DRN-02"},
        {"id": "ASR-DST-03", "name": "Ranjit Avenue Post", "coordinate": [74.8838, 31.6452], "droneId": "ASR-DRN-03"},
        {"id": "ASR-DST-04", "name": "Hall Bazaar Post", "coordinate": [74.8741, 31.6232], "droneId": "ASR-DRN-04"},
    ],
    drones=[
        {"id": "ASR-DRN-01", "label": "Golden Temple Watch", "stationId": "ASR-DST-01", "battery": 91, "response": "1.8 min", "status": "Patrol", "role": "Patrol", "position": [74.8773, 31.6200], "routeName": "Golden Temple - Jallianwala loop", "route": [[74.8773, 31.6200], [74.8782, 31.6217], [74.8749, 31.6221], [74.8773, 31.6200]]},
        {"id": "ASR-DRN-02", "label": "Railway Sentinel", "stationId": "ASR-DST-02", "battery": 82, "response": "2.8 min", "status": "Patrol", "role": "Patrol", "position": [74.8656, 31.6337], "routeName": "Railway - bus stand loop", "route": [[74.8656, 31.6337], [74.8682, 31.6283], [74.8636, 31.6281], [74.8656, 31.6337]]},
        {"id": "ASR-DRN-03", "label": "Ranjit Shield", "stationId": "ASR-DST-03", "battery": 86, "response": "2.3 min", "status": "Patrol", "role": "Patrol", "position": [74.8838, 31.6452], "routeName": "Ranjit Avenue loop", "route": [[74.8838, 31.6452], [74.8874, 31.6398], [74.8794, 31.6401], [74.8838, 31.6452]]},
        {"id": "ASR-DRN-04", "label": "Hall Bazaar Shield", "stationId": "ASR-DST-04", "battery": 77, "response": "3.1 min", "status": "Patrol", "role": "Patrol", "position": [74.8741, 31.6232], "routeName": "Hall Bazaar - Town Hall loop", "route": [[74.8741, 31.6232], [74.8774, 31.6254], [74.8714, 31.6258], [74.8741, 31.6232]]},
    ],
    danger_zones=[
        {"id": "ASR-101", "name": "Golden Temple approach", "category": "Religious", "severity": 0.88, "coordinate": [74.8773, 31.6200], "radiusM": 150, "ring": ring([74.8773, 31.6200])},
        {"id": "ASR-102", "name": "Jallianwala Bagh", "category": "Memorial", "severity": 0.8, "coordinate": [74.8782, 31.6217], "radiusM": 150, "ring": ring([74.8782, 31.6217])},
        {"id": "ASR-103", "name": "Hall Bazaar crowd", "category": "Market", "severity": 0.84, "coordinate": [74.8741, 31.6232], "radiusM": 150, "ring": ring([74.8741, 31.6232])},
        {"id": "ASR-104", "name": "Railway station forecourt", "category": "Transit", "severity": 0.83, "coordinate": [74.8656, 31.6337], "radiusM": 150, "ring": ring([74.8656, 31.6337])},
        {"id": "ASR-105", "name": "Ranjit Avenue night strip", "category": "Road", "severity": 0.64, "coordinate": [74.8838, 31.6452], "radiusM": 150, "ring": ring([74.8838, 31.6452])},
        {"id": "ASR-106", "name": "Bus stand terminal", "category": "Transit", "severity": 0.75, "coordinate": [74.8682, 31.6283], "radiusM": 150, "ring": ring([74.8682, 31.6283])},
    ],
)

# ---------------------------------------------------------------------------
# Ludhiana.
ludhiana = city_grid(
    {"id": "ludhiana", "name": "Ludhiana", "country": "India", "center": [75.8573, 30.9010], "zoom": 12.3},
    stations=[
        {"id": "LDH-DST-01", "name": "Model Town Post", "coordinate": [75.8624, 30.8886], "droneId": "LDH-DRN-01"},
        {"id": "LDH-DST-02", "name": "Railway Post", "coordinate": [75.8499, 30.9005], "droneId": "LDH-DRN-02"},
        {"id": "LDH-DST-03", "name": "PAU Gate Post", "coordinate": [75.7995, 30.9003], "droneId": "LDH-DRN-03"},
        {"id": "LDH-DST-04", "name": "Sarabha Nagar Post", "coordinate": [75.8377, 30.8935], "droneId": "LDH-DRN-04"},
    ],
    drones=[
        {"id": "LDH-DRN-01", "label": "Model Town Watch", "stationId": "LDH-DST-01", "battery": 89, "response": "2.0 min", "status": "Patrol", "role": "Patrol", "position": [75.8624, 30.8886], "routeName": "Model Town loop", "route": [[75.8624, 30.8886], [75.8685, 30.8927], [75.8602, 30.8958], [75.8624, 30.8886]]},
        {"id": "LDH-DRN-02", "label": "Railway Sentinel", "stationId": "LDH-DST-02", "battery": 80, "response": "2.9 min", "status": "Patrol", "role": "Patrol", "position": [75.8499, 30.9005], "routeName": "Railway - Ghumar Mandi loop", "route": [[75.8499, 30.9005], [75.8563, 30.9074], [75.8621, 30.9031], [75.8499, 30.9005]]},
        {"id": "LDH-DRN-03", "label": "PAU Shield", "stationId": "LDH-DST-03", "battery": 85, "response": "2.5 min", "status": "Patrol", "role": "Patrol", "position": [75.7995, 30.9003], "routeName": "PAU campus loop", "route": [[75.7995, 30.9003], [75.8052, 30.9044], [75.7947, 30.9071], [75.7995, 30.9003]]},
        {"id": "LDH-DRN-04", "label": "Sarabha Shield", "stationId": "LDH-DST-04", "battery": 88, "response": "2.1 min", "status": "Patrol", "role": "Patrol", "position": [75.8377, 30.8935], "routeName": "Sarabha Nagar loop", "route": [[75.8377, 30.8935], [75.8432, 30.8972], [75.8335, 30.8988], [75.8377, 30.8935]]},
    ],
    danger_zones=[
        {"id": "LDH-101", "name": "Model Town market", "category": "Market", "severity": 0.79, "coordinate": [75.8624, 30.8886], "radiusM": 150, "ring": ring([75.8624, 30.8886])},
        {"id": "LDH-102", "name": "Railway station area", "category": "Transit", "severity": 0.85, "coordinate": [75.8499, 30.9005], "radiusM": 150, "ring": ring([75.8499, 30.9005])},
        {"id": "LDH-103", "name": "Ghumar Mandi crowd", "category": "Market", "severity": 0.82, "coordinate": [75.8563, 30.9074], "radiusM": 150, "ring": ring([75.8563, 30.9074])},
        {"id": "LDH-104", "name": "PAU gate stretch", "category": "Campus", "severity": 0.6, "coordinate": [75.7995, 30.9003], "radiusM": 150, "ring": ring([75.7995, 30.9003])},
        {"id": "LDH-105", "name": "Sarabha Nagar lanes", "category": "Residential", "severity": 0.68, "coordinate": [75.8377, 30.8935], "radiusM": 150, "ring": ring([75.8377, 30.8935])},
        {"id": "LDH-106", "name": "Ferozepur road stretch", "category": "Road", "severity": 0.65, "coordinate": [75.8488, 30.9174], "radiusM": 150, "ring": ring([75.8488, 30.9174])},
    ],
)

# ---------------------------------------------------------------------------
# Jalandhar.
jalandhar = city_grid(
    {"id": "jalandhar", "name": "Jalandhar", "country": "India", "center": [75.5762, 31.3260], "zoom": 12.4},
    stations=[
        {"id": "JAL-DST-01", "name": "Model Town Post", "coordinate": [75.5901, 31.3194], "droneId": "JAL-DRN-01"},
        {"id": "JAL-DST-02", "name": "Railway Post", "coordinate": [75.5796, 31.3255], "droneId": "JAL-DRN-02"},
        {"id": "JAL-DST-03", "name": "BMC Chowk Post", "coordinate": [75.5782, 31.3340], "droneId": "JAL-DRN-03"},
        {"id": "JAL-DST-04", "name": "Defence Colony Post", "coordinate": [75.5678, 31.3077], "droneId": "JAL-DRN-04"},
    ],
    drones=[
        {"id": "JAL-DRN-01", "label": "Model Town Watch", "stationId": "JAL-DST-01", "battery": 90, "response": "2.0 min", "status": "Patrol", "role": "Patrol", "position": [75.5901, 31.3194], "routeName": "Model Town loop", "route": [[75.5901, 31.3194], [75.5944, 31.3236], [75.5858, 31.3243], [75.5901, 31.3194]]},
        {"id": "JAL-DRN-02", "label": "Railway Sentinel", "stationId": "JAL-DST-02", "battery": 83, "response": "2.7 min", "status": "Patrol", "role": "Patrol", "position": [75.5796, 31.3255], "routeName": "Railway - bus stand loop", "route": [[75.5796, 31.3255], [75.5833, 31.3298], [75.5764, 31.3305], [75.5796, 31.3255]]},
        {"id": "JAL-DRN-03", "label": "BMC Shield", "stationId": "JAL-DST-03", "battery": 84, "response": "2.4 min", "status": "Patrol", "role": "Patrol", "position": [75.5782, 31.3340], "routeName": "BMC Chowk loop", "route": [[75.5782, 31.3340], [75.5837, 31.3368], [75.5745, 31.3382], [75.5782, 31.3340]]},
        {"id": "JAL-DRN-04", "label": "Defence Shield", "stationId": "JAL-DST-04", "battery": 87, "response": "2.3 min", "status": "Patrol", "role": "Patrol", "position": [75.5678, 31.3077], "routeName": "Defence Colony loop", "route": [[75.5678, 31.3077], [75.5734, 31.3115], [75.5637, 31.3131], [75.5678, 31.3077]]},
    ],
    danger_zones=[
        {"id": "JAL-101", "name": "Model Town market", "category": "Market", "severity": 0.77, "coordinate": [75.5901, 31.3194], "radiusM": 150, "ring": ring([75.5901, 31.3194])},
        {"id": "JAL-102", "name": "Railway junction", "category": "Transit", "severity": 0.84, "coordinate": [75.5796, 31.3255], "radiusM": 150, "ring": ring([75.5796, 31.3255])},
        {"id": "JAL-103", "name": "Bus stand terminal", "category": "Transit", "severity": 0.78, "coordinate": [75.5833, 31.3298], "radiusM": 150, "ring": ring([75.5833, 31.3298])},
        {"id": "JAL-104", "name": "BMC Chowk junction", "category": "Junction", "severity": 0.72, "coordinate": [75.5782, 31.3340], "radiusM": 150, "ring": ring([75.5782, 31.3340])},
        {"id": "JAL-105", "name": "Defence Colony lanes", "category": "Residential", "severity": 0.6, "coordinate": [75.5678, 31.3077], "radiusM": 150, "ring": ring([75.5678, 31.3077])},
    ],
)

# ---------------------------------------------------------------------------
# Mohali.
mohali = city_grid(
    {"id": "mohali", "name": "Mohali", "country": "India", "center": [76.7326, 30.7046], "zoom": 12.5},
    stations=[
        {"id": "MOH-DST-01", "name": "Phase 3B2 Post", "coordinate": [76.7308, 30.7012], "droneId": "MOH-DRN-01"},
        {"id": "MOH-DST-02", "name": "Stadium Post", "coordinate": [76.7169, 30.6940], "droneId": "MOH-DRN-02"},
        {"id": "MOH-DST-03", "name": "ISBT Post", "coordinate": [76.7452, 30.6892], "droneId": "MOH-DRN-03"},
        {"id": "MOH-DST-04", "name": "Sector 70 Post", "coordinate": [76.7029, 30.7098], "droneId": "MOH-DRN-04"},
    ],
    drones=[
        {"id": "MOH-DRN-01", "label": "Phase 3B2 Watch", "stationId": "MOH-DST-01", "battery": 88, "response": "2.1 min", "status": "Patrol", "role": "Patrol", "position": [76.7308, 30.7012], "routeName": "Phase 3B2 loop", "route": [[76.7308, 30.7012], [76.7351, 30.7056], [76.7264, 30.7063], [76.7308, 30.7012]]},
        {"id": "MOH-DRN-02", "label": "Stadium Sentinel", "stationId": "MOH-DST-02", "battery": 82, "response": "2.6 min", "status": "Patrol", "role": "Patrol", "position": [76.7169, 30.6940], "routeName": "Stadium - Kharar road loop", "route": [[76.7169, 30.6940], [76.7223, 30.6992], [76.7108, 30.6998], [76.7169, 30.6940]]},
        {"id": "MOH-DRN-03", "label": "ISBT Shield", "stationId": "MOH-DST-03", "battery": 86, "response": "2.3 min", "status": "Patrol", "role": "Patrol", "position": [76.7452, 30.6892], "routeName": "ISBT - airport road loop", "route": [[76.7452, 30.6892], [76.7508, 30.6932], [76.7404, 30.6941], [76.7452, 30.6892]]},
        {"id": "MOH-DRN-04", "label": "Sector 70 Shield", "stationId": "MOH-DST-04", "battery": 85, "response": "2.4 min", "status": "Patrol", "role": "Patrol", "position": [76.7029, 30.7098], "routeName": "Sector 70 loop", "route": [[76.7029, 30.7098], [76.7084, 30.7135], [76.6987, 30.7149], [76.7029, 30.7098]]},
    ],
    danger_zones=[
        {"id": "MOH-101", "name": "Phase 3B2 market", "category": "Market", "severity": 0.71, "coordinate": [76.7308, 30.7012], "radiusM": 150, "ring": ring([76.7308, 30.7012])},
        {"id": "MOH-102", "name": "Stadium match-day crowd", "category": "Stadium", "severity": 0.88, "coordinate": [76.7169, 30.6940], "radiusM": 150, "ring": ring([76.7169, 30.6940])},
        {"id": "MOH-103", "name": "ISBT terminal", "category": "Transit", "severity": 0.76, "coordinate": [76.7452, 30.6892], "radiusM": 150, "ring": ring([76.7452, 30.6892])},
        {"id": "MOH-104", "name": "Kharar road stretch", "category": "Road", "severity": 0.63, "coordinate": [76.7223, 30.6992], "radiusM": 150, "ring": ring([76.7223, 30.6992])},
    ],
)

# ---------------------------------------------------------------------------
# Patiala restore - the reference grid.  Re-saving it is safe (idempotent) and
# guarantees the base city's stations/patrol drones are always present even if
# an earlier buggy save deleted them.
patiala = city_grid(
    {"id": "patiala", "name": "Patiala", "country": "India", "center": [76.3865, 30.3385], "zoom": 12.6},
    stations=[
        {"id": "DST-01", "name": "City Core Post", "coordinate": [76.398, 30.3337], "droneId": "DRN-01", "reserveDroneId": "RSV-01"},
        {"id": "DST-02", "name": "Sirhind Road Post", "coordinate": [76.4199, 30.3384], "droneId": "DRN-02", "reserveDroneId": "RSV-02"},
        {"id": "DST-03", "name": "South City Post", "coordinate": [76.3998, 30.3262], "droneId": "DRN-03", "reserveDroneId": "RSV-03"},
        {"id": "DST-04", "name": "Tripuri Post", "coordinate": [76.3887, 30.3467], "droneId": "DRN-04", "reserveDroneId": "RSV-04"},
    ],
    drones=[
        {"id": "DRN-01", "label": "Qila Guardian", "status": "Patrol", "battery": 92, "response": "1.8 min", "stationId": "DST-01", "position": [76.398, 30.3337], "routeName": "City Core - Qila loop", "route": [[76.3978, 30.3286], [76.3952, 30.3321], [76.3986, 30.3394], [76.4005, 30.3345], [76.3978, 30.3286]]},
        {"id": "DRN-02", "label": "University Watch", "status": "Patrol", "battery": 78, "response": "2.4 min", "stationId": "DST-02", "position": [76.4199, 30.3384], "routeName": "University - Sirhind Rd corridor", "route": [[76.405, 30.338], [76.421, 30.334], [76.437, 30.339], [76.414, 30.3425], [76.405, 30.338]]},
        {"id": "DRN-03", "label": "Railway Sentinel", "status": "Patrol", "battery": 85, "response": "3.1 min", "stationId": "DST-03", "position": [76.3998, 30.3262], "routeName": "Railway - South corridor", "route": [[76.4055, 30.333], [76.409, 30.328], [76.385, 30.3175], [76.3925, 30.323], [76.4055, 30.333]]},
        {"id": "DRN-04", "label": "Tripuri Shield", "status": "Patrol", "battery": 88, "response": "2.1 min", "stationId": "DST-04", "position": [76.3887, 30.3467], "routeName": "Tripuri - North loop", "route": [[76.3904, 30.3506], [76.392, 30.342], [76.3796, 30.3455], [76.3945, 30.3525], [76.3904, 30.3506]]},
        {"id": "RSV-01", "label": "Qila Guardian Reserve", "status": "Standby", "battery": 100, "response": "standby", "stationId": "DST-01", "role": "Reserve", "coverageForDroneId": "DRN-01", "position": [76.398, 30.3337], "routeName": "City Core - Qila loop coverage", "route": [[76.3978, 30.3286], [76.3952, 30.3321], [76.3986, 30.3394], [76.4005, 30.3345], [76.3978, 30.3286]]},
        {"id": "RSV-02", "label": "University Watch Reserve", "status": "Standby", "battery": 100, "response": "standby", "stationId": "DST-02", "role": "Reserve", "coverageForDroneId": "DRN-02", "position": [76.4199, 30.3384], "routeName": "University - Sirhind Rd corridor coverage", "route": [[76.405, 30.338], [76.421, 30.334], [76.437, 30.339], [76.414, 30.3425], [76.405, 30.338]]},
        {"id": "RSV-03", "label": "Railway Sentinel Reserve", "status": "Standby", "battery": 100, "response": "standby", "stationId": "DST-03", "role": "Reserve", "coverageForDroneId": "DRN-03", "position": [76.3998, 30.3262], "routeName": "Railway - South corridor coverage", "route": [[76.4055, 30.333], [76.409, 30.328], [76.385, 30.3175], [76.3925, 30.323], [76.4055, 30.333]]},
        {"id": "RSV-04", "label": "Tripuri Shield Reserve", "status": "Standby", "battery": 100, "response": "standby", "stationId": "DST-04", "role": "Reserve", "coverageForDroneId": "DRN-04", "position": [76.3887, 30.3467], "routeName": "Tripuri - North loop coverage", "route": [[76.3904, 30.3506], [76.392, 30.342], [76.3796, 30.3455], [76.3945, 30.3525], [76.3904, 30.3506]]},
    ],
    danger_zones=[
        {"id": "HS-101", "name": "Qila Mubarak old city cluster", "category": "Old City", "severity": 0.96, "coordinate": [76.3978, 30.3286], "radiusM": 170},
        {"id": "HS-102", "name": "Rajindra Hospital approach", "category": "Hospital", "severity": 0.88, "coordinate": [76.3952, 30.3321], "radiusM": 170},
        {"id": "HS-103", "name": "Adalat Bazar market pressure", "category": "Market", "severity": 0.82, "coordinate": [76.3986, 30.3394], "radiusM": 170},
        {"id": "HS-104", "name": "Chowk / Anardana Bazar", "category": "Market", "severity": 0.9, "coordinate": [76.4005, 30.3345], "radiusM": 170},
        {"id": "HS-105", "name": "Model Town market crossing", "category": "Market", "severity": 0.84, "coordinate": [76.405, 30.338], "radiusM": 170},
        {"id": "HS-106", "name": "Sirhind Road late-night stretch", "category": "Road", "severity": 0.72, "coordinate": [76.421, 30.334], "radiusM": 170},
        {"id": "HS-107", "name": "Punjabi University gate area", "category": "Campus", "severity": 0.7, "coordinate": [76.437, 30.339], "radiusM": 170},
        {"id": "HS-108", "name": "Urban Estate walkway reports", "category": "Residential", "severity": 0.76, "coordinate": [76.414, 30.3425], "radiusM": 170},
        {"id": "HS-109", "name": "New Bus Stand terminal", "category": "Transit", "severity": 0.86, "coordinate": [76.4055, 30.333], "radiusM": 170},
        {"id": "HS-110", "name": "Railway approach / Dak Ghar", "category": "Transit", "severity": 0.8, "coordinate": [76.409, 30.328], "radiusM": 170},
        {"id": "HS-111", "name": "Nabha Road crossing", "category": "Road", "severity": 0.68, "coordinate": [76.385, 30.3175], "radiusM": 170},
        {"id": "HS-112", "name": "Bhupindra Colony lanes", "category": "Residential", "severity": 0.74, "coordinate": [76.3925, 30.323], "radiusM": 170},
        {"id": "HS-113", "name": "Tripuri town market", "category": "Market", "severity": 0.78, "coordinate": [76.3904, 30.3506], "radiusM": 170},
        {"id": "HS-114", "name": "Sheranwala Gate junction", "category": "Junction", "severity": 0.66, "coordinate": [76.392, 30.342], "radiusM": 170},
        {"id": "HS-115", "name": "Chandan Nagar low-light block", "category": "Residential", "severity": 0.7, "coordinate": [76.3796, 30.3455], "radiusM": 170},
        {"id": "HS-116", "name": "New Lal Bagh Colony", "category": "Residential", "severity": 0.64, "coordinate": [76.3945, 30.3525], "radiusM": 170},
    ],
)

# New cities first (their re-save with prefixed ids frees any bare DST-01/DRN-01
# ids a buggy earlier run left on them), then restore patiala's reference grid.
for city in [chandigarh, amritsar, ludhiana, jalandhar, mohali]:
    put(city["city"]["id"], city)

print("Restoring patiala...")
put("patiala", patiala)

print("\nAll cities seeded. Refresh the Command Studio -> Cities list.")
