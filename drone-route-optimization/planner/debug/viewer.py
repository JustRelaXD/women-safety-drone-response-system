"""Self-contained Leaflet HTML viewer for the diagnostic layers.

Produces a single .html file with Leaflet pulled from a CDN (same public
tile/CDN services the frontend already uses) and every GeoJSON layer inlined,
so it opens straight from disk in any browser - no server required.
"""

from __future__ import annotations

import html
import json

_TEMPLATE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Route diagnosis - {mission_id}</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>
  html, body {{ height: 100%; margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; }}
  #map {{ height: 100%; width: 100%; }}
  .panel {{
    position: absolute; top: 10px; left: 10px; z-index: 1000;
    background: rgba(255,255,255,.95); border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,.25);
    padding: 10px 12px; max-width: 340px; font-size: 12px; line-height: 1.5;
  }}
  .panel h1 {{ font-size: 14px; margin: 0 0 6px; }}
  .panel .swatch {{ display: inline-block; width: 14px; height: 4px; border-radius: 2px; margin-right: 6px; vertical-align: middle; }}
  .panel .dot {{ width: 10px; height: 10px; border-radius: 50%; }}
  .panel table {{ border-collapse: collapse; }}
  .panel td {{ padding: 1px 8px 1px 0; }}
  .panel td:first-child {{ color: #64748b; }}
  .leaflet-control-layers-expanded {{ font-size: 12px; }}
</style>
</head>
<body>
<div id="map"></div>
<div class="panel">
  <h1>Route diagnosis &mdash; {mission_id}</h1>
  <table>
    <tr><td>Straight</td><td>{straight} m</td></tr>
    <tr><td>Route</td><td>{route} m</td></tr>
    <tr><td>Detour</td><td>{detour}</td></tr>
    <tr><td>Path</td><td>{path_found}</td></tr>
    <tr><td>Direct path</td><td>{direct_path}</td></tr>
    <tr><td>Real hits</td><td>{real_hits} (buildings physically on the line)</td></tr>
    <tr><td>Envelope-only</td><td>{envelope_hits} (rasterization artefact)</td></tr>
    <tr><td>Recovered cells</td><td>{recovered} (envelope - exact)</td></tr>
  </table>
  <div style="margin-top:6px;border-top:1px solid #e2e8f0;padding-top:6px">
    <div><span class="swatch" style="background:#22c55e"></span>straight line</div>
    <div><span class="swatch" style="background:#3b82f6"></span>planned route</div>
    <div><span class="swatch" style="background:#94a3b8"></span>raw A* path (cell centres)</div>
    <div><span class="swatch" style="background:#facc15"></span>building polygons</div>
    <div><span class="swatch" style="background:#fde68a"></span>building bounding boxes (unbuffered)</div>
    <div><span class="swatch" style="background:#f97316"></span>buffered envelopes (+ safety margin) - legacy footprint</div>
    <div><span class="swatch" style="background:#ec4899"></span>buffered polygons (+ polygon buffer) - exact footprint</div>
    <div><span class="swatch" style="background:#ef4444"></span>blocked cells (exact painting)</div>
    <div><span class="swatch" style="background:#a855f7"></span>blocked cells (legacy envelope painting)</div>
    <div><span class="dot" style="background:#dc2626;display:inline-block;margin-right:6px"></span>intersecting polygons (blocked the direct line)</div>
    <div><span class="dot" style="background:#dc2626;display:inline-block;margin-right:6px"></span>blocker (click for details)</div>
  </div>
</div>
<script>
const LAYERS = {LAYERS};
const map = L.map('map');
const baseMaps = {{
  'Satellite (Esri)': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{{z}}/{{y}}/{{x}}', {{
    maxZoom: 19, attribution: 'Tiles &copy; Esri'
  }}),
  'OSM': L.tileLayer('https://tile.openstreetmap.org/{{z}}/{{x}}/{{y}}.png', {{
    maxZoom: 19, attribution: '&copy; OpenStreetMap contributors'
  }}),
  'Dark (Carto)': L.tileLayer('https://{{s}}.basemaps.cartocdn.com/dark_all/{{z}}/{{x}}/{{y}}{{r}}.png', {{
    subdomains: 'abcd', maxZoom: 20, attribution: '&copy; OSM &copy; CARTO'
  }})
}};
baseMaps['Satellite (Esri)'].addTo(map);

function addLayer(name, fc, style, onEach) {{
  if (!fc || !fc.features || !fc.features.length) return;
  L.geoJSON(fc, {{ style, pointToLayer: (f, latlng) => L.circleMarker(latlng, {{
      radius: 7, color: '#fff', weight: 1.5,
      fillColor: f.properties['marker-color'] || '#dc2626', fillOpacity: 1
    }}), onEachFeature: onEach }}).addTo(map);
}}

const styleFn = (color, fillOpacity) => (f) => ({{
  color: f.properties.color || color,
  weight: f.properties.weight || 3,
  fillColor: f.properties.fill || color,
  fillOpacity: fillOpacity ?? 0.15,
}});

addLayer('straight', LAYERS.straight_line, styleFn('#22c55e', 0));
addLayer('route', LAYERS.route, styleFn('#3b82f6', 0));
addLayer('raw', LAYERS.raw_path, styleFn('#94a3b8', 0));
addLayer('buildings', LAYERS.buildings, styleFn('#facc15', 0.15));
addLayer('bbox', LAYERS.bbox, styleFn('#fde68a', 0.1));
addLayer('buffered', LAYERS.buffered, styleFn('#f97316', 0.2));
addLayer('buffered_polys', LAYERS.buffered_polygons, styleFn('#ec4899', 0.25));
addLayer('cells', LAYERS.blocked_cells, styleFn('#ef4444', 0.35));
addLayer('old_cells', LAYERS.old_blocked_cells, styleFn('#a855f7', 0.25));
addLayer('hits', LAYERS.hit_polygons, styleFn('#dc2626', 0.35), (f, layer) => {{
  const p = f.properties;
  layer.bindPopup('<b>' + htmlEsc(p.kind) + '</b><br/>id: ' + htmlEsc(p.id));
}});
addLayer('blockers', LAYERS.blockers, styleFn('#dc2626', 1), (f, layer) => {{
  const p = f.properties;
  layer.bindPopup(
    '<b>' + htmlEsc(p.id) + '</b><br/>height: ' + (p.height ?? 'n/a') + ' m' +
    '<br/>dist along line: ' + Math.round(p.dist_m ?? 0) + ' m' +
    '<br/>kind: ' + htmlEsc(p.kind)
  );
}});

const all = [LAYERS.straight_line, LAYERS.route, LAYERS.raw_path, LAYERS.buildings,
             LAYERS.bbox, LAYERS.buffered, LAYERS.buffered_polygons,
             LAYERS.blocked_cells, LAYERS.old_blocked_cells, LAYERS.blockers,
             LAYERS.hit_polygons].filter(Boolean);
if (all.length) {{
  const b = L.geoJSON(all).getBounds();
  if (b.isValid()) map.fitBounds(b, {{ padding: [40, 40] }});
}}
map.setZoom(Math.max(map.getZoom(), 14));

L.control.layers(baseMaps, null, {{ position: 'topright' }}).addTo(map);

function htmlEsc(s) {{
  return String(s).replace(/[&<>"']/g, c => ({{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}})[c]);
}}
</script>
</body>
</html>
"""


def render_viewer(layers: dict, report: dict) -> str:
    """Render the self-contained viewer with the given GeoJSON layers inlined."""
    straight = report.get("straight_distance_m")
    route = report.get("route_distance_m")
    detour = (
        f"+{report['detour_ratio'] * 100:.1f} %"
        if report.get("detour_ratio") is not None
        else "n/a"
    )
    sl = report.get("straight_line", {})
    dp = report.get("direct_path", {})
    if dp.get("accepted") is True:
        direct_path = "ACCEPTED"
    elif dp.get("accepted") is False:
        why = ", ".join(
            [
                name
                for hit, name in (
                    (dp.get("building_hit"), "buildings"),
                    (dp.get("water_hit"), "water"),
                    (dp.get("no_fly_hit"), "no-fly"),
                )
                if hit
            ]
        )
        direct_path = f"rejected ({why or 'obstacles'})"
    else:
        direct_path = "n/a"
    ra = report.get("rasterization", {})
    recovered = ra.get("recovered_cells", 0)
    return _TEMPLATE.format(
        mission_id=html.escape(str(report.get("mission_id", "mission"))),
        straight=f"{straight:,.0f}" if straight is not None else "n/a",
        route=f"{route:,.0f}" if route is not None else "no route",
        detour=detour,
        path_found="yes" if report.get("path_found") else "NO",
        direct_path=direct_path,
        real_hits=sl.get("blocked_by_real_geometry", 0),
        envelope_hits=sl.get("blocked_by_envelope_only", 0),
        recovered=f"{recovered:,}",
        # escape '<' so a property string can never break out of the <script>
        # block (json.dumps does not escape it by default)
        LAYERS=json.dumps(
            {name: fc for name, fc in layers.items() if fc is not None}
        ).replace("<", "\\u003c"),
    )
