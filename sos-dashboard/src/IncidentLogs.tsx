import React, { useEffect, useMemo, useState } from 'react';
import { Search, ArrowRight, MapPin, Shield, Camera, Video } from 'lucide-react';

/** Media stays local during demos and can later point at a remote storage adapter. */
type MediaAsset = {
  type: 'screenshot' | 'recording';
  src: string;
  poster?: string;
};

/** Core incident fields per spec */
type Incident = {
  id: string;
  title: string;
  category: 'Harassment' | 'Stalking' | 'Poor Lighting' | 'Assault' | 'Unsafe Transport' | 'Other';
  severity: 'Low' | 'Medium' | 'High' | 'Critical';
  status: 'Open' | 'Dispatched' | 'Resolved';
  timestamp: string;
  date: string;
  time: string;
  location: {
    street: string;
    landmark: string;
    lat: number;
    lng: number;
  };
  reporterId: string;
  responderNotes: string;
  media?: MediaAsset;
};

/** API shape returned by GET /api/safety/incidents */
type ApiIncident = {
  id: string;
  title: string;
  category: string;
  severity: string;
  status: string;
  coordinate: [number, number];
  street: string | null;
  landmark: string | null;
  reporterId: string | null;
  responderNotes: string | null;
  media: { type: 'screenshot' | 'recording'; src: string; poster?: string } | null;
  occurredAt: string;
  updatedAt: string;
};

const DEMO_INCIDENTS: Incident[] = [
  {
    id: 'INC-2408',
    title: 'Street harassment reported',
    category: 'Harassment',
    severity: 'Critical',
    status: 'Dispatched',
    timestamp: '2026-08-22T10:42:00',
    date: 'Aug 22, 2026',
    time: '10:42 AM',
    location: { street: 'North Beach / Pier 39', landmark: 'Near Fisherman\'s Wharf', lat: 37.8087, lng: -122.4098 },
    reporterId: 'USR-A4F2K',
    responderNotes: 'Unit S-14 dispatched. Caller guided to well-lit cafe pending arrival.',
    media: { type: 'screenshot', src: '/media/incidents/INC-2408/snapshot-001.jpg' },
  },
  {
    id: 'INC-2407',
    title: 'Followed home from transit station',
    category: 'Stalking',
    severity: 'High',
    status: 'Open',
    timestamp: '2026-08-22T10:28:00',
    date: 'Aug 22, 2026',
    time: '10:28 AM',
    location: { street: 'Union Square / Stockton St', landmark: 'Powell Station exit', lat: 37.7879, lng: -122.4074 },
    reporterId: 'USR-B8C3D',
    responderNotes: 'Helpline volunteer on call, guiding user to nearest safe zone.',
  },
  {
    id: 'INC-2406',
    title: 'Assault near park entrance',
    category: 'Assault',
    severity: 'Critical',
    status: 'Dispatched',
    timestamp: '2026-08-22T09:56:00',
    date: 'Aug 22, 2026',
    time: '09:56 AM',
    location: { street: 'Civic Center / Grove St', landmark: 'Civic Center Plaza', lat: 37.7796, lng: -122.4177 },
    reporterId: 'USR-C2E9F',
    responderNotes: 'EMS + patrol dispatched. Scene secured, victim receiving aid.',
    media: { type: 'recording', src: '/media/incidents/INC-2406/recording-001.mp4', poster: '/media/incidents/INC-2406/poster.jpg' },
  },
  {
    id: 'INC-2405',
    title: 'Poor lighting on walking route',
    category: 'Poor Lighting',
    severity: 'Medium',
    status: 'Resolved',
    timestamp: '2026-08-22T09:41:00',
    date: 'Aug 22, 2026',
    time: '09:41 AM',
    location: { street: 'Embarcadero / Ferry Building', landmark: 'Ferry Plaza', lat: 37.7955, lng: -122.3937 },
    reporterId: 'USR-D7A1B',
    responderNotes: 'City maintenance notified, streetlight repaired within 2 hrs.',
    media: { type: 'screenshot', src: '/media/incidents/INC-2405/snapshot-001.jpg' },
  },
  {
    id: 'INC-2404',
    title: 'Unsafe taxi — driver taking detour',
    category: 'Unsafe Transport',
    severity: 'High',
    status: 'Open',
    timestamp: '2026-08-22T09:18:00',
    date: 'Aug 22, 2026',
    time: '09:18 AM',
    location: { street: 'Mission District / 16th St', landmark: '16th & Mission BART', lat: 37.7651, lng: -122.4197 },
    reporterId: 'USR-E5F4C',
    responderNotes: 'Live tracking shared with helpline. Driver rerouting confirmed via GPS.',
  },
  {
    id: 'INC-2403',
    title: 'Stalking pattern over 3 days',
    category: 'Stalking',
    severity: 'Low',
    status: 'Open',
    timestamp: '2026-08-22T08:56:00',
    date: 'Aug 22, 2026',
    time: '08:56 AM',
    location: { street: 'Dogpatch / 3rd Street', landmark: 'Minnesota St', lat: 37.7582, lng: -122.3878 },
    reporterId: 'USR-F9D2A',
    responderNotes: 'Pattern report logged, flagged for patrol attention in corridor.',
    media: { type: 'recording', src: '/media/incidents/INC-2403/recording-001.mp4', poster: '/media/incidents/INC-2403/poster.jpg' },
  },
];

const CATEGORIES: Incident['category'][] = ['Harassment', 'Stalking', 'Poor Lighting', 'Assault', 'Unsafe Transport', 'Other'];
const SEVERITIES: Incident['severity'][] = ['Critical', 'High', 'Medium', 'Low'];

/** Geofenced high-risk zones — clusters of incidents auto-flagged by density */
type GeofenceZone = {
  id: string;
  name: string;
  center: { lat: number; lng: number };
  radiusM: number;
  incidentIds: string[];
  riskLevel: 'High Risk' | 'Moderate' | 'Watch';
};

/** Auto-derive geofence zones: group incidents by proximity (within 500m) */
function deriveGeofenceZones(incidents: Incident[]): GeofenceZone[] {
  const RADIUS_M = 500;
  const zones: GeofenceZone[] = [];
  const assigned = new Set<string>();

  incidents.forEach((incident) => {
    if (assigned.has(incident.id)) return;
    const nearby = incidents.filter((other) => {
      if (assigned.has(other.id)) return false;
      const dist = haversineMeters(incident.location.lat, incident.location.lng, other.location.lat, other.location.lng);
      return dist <= RADIUS_M;
    });
    nearby.forEach((n) => assigned.add(n.id));
    if (nearby.length < 1) return;

    const avgLat = nearby.reduce((s, i) => s + i.location.lat, 0) / nearby.length;
    const avgLng = nearby.reduce((s, i) => s + i.location.lng, 0) / nearby.length;
    const criticalCount = nearby.filter((i) => i.severity === 'Critical' || i.severity === 'High').length;
    const riskLevel: GeofenceZone['riskLevel'] = criticalCount >= 2 ? 'High Risk' : criticalCount >= 1 ? 'Moderate' : 'Watch';

    zones.push({
      id: `ZONE-${String(zones.length + 1).padStart(2, '0')}`,
      name: incident.location.street.split(' / ')[0],
      center: { lat: avgLat, lng: avgLng },
      radiusM: RADIUS_M,
      incidentIds: nearby.map((n) => n.id),
      riskLevel,
    });
  });

  return zones;
}

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const severityClass = (severity: string) => severity.toLowerCase();
const statusClass = (status: string) => status.toLowerCase();

/** Format an ISO timestamp into the panel's display strings. */
function formatTimestamp(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return { timestamp: iso, date: iso.slice(0, 10), time: iso.slice(11, 16) };
  return {
    timestamp: date.toISOString(),
    date: date.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }),
    time: date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  };
}

/** Map an API incident row onto the panel's Incident model. */
function apiToIncident(entry: ApiIncident): Incident {
  const when = formatTimestamp(entry.occurredAt);
  const category = (['Harassment', 'Stalking', 'Poor Lighting', 'Assault', 'Unsafe Transport', 'Other'] as const)
    .find((c) => c === entry.category) ?? 'Other';
  const severity = (['Low', 'Medium', 'High', 'Critical'] as const)
    .find((s) => s === entry.severity) ?? 'Medium';
  const status = (['Open', 'Dispatched', 'Resolved'] as const)
    .find((s) => s === entry.status) ?? 'Open';
  return {
    id: entry.id,
    title: entry.title,
    category,
    severity,
    status,
    timestamp: when.timestamp,
    date: when.date,
    time: when.time,
    location: {
      street: entry.street || 'Unknown street',
      landmark: entry.landmark || 'Unknown area',
      lat: entry.coordinate[1],
      lng: entry.coordinate[0]
    },
    reporterId: entry.reporterId || '—',
    responderNotes: entry.responderNotes || '',
    media: entry.media ? { type: entry.media.type, src: entry.media.src, poster: entry.media.poster } : undefined
  };
}

export function IncidentLogs({ cityId = 'patiala' }: { cityId?: string }) {
  const [searchTerm, setSearchTerm] = useState('');
  const [incidents, setIncidents] = useState<Incident[]>(DEMO_INCIDENTS);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeCategories, setActiveCategories] = useState<Set<string>>(new Set());
  const [activeSeverities, setActiveSeverities] = useState<Set<string>>(new Set());
  const [hoveredMedia, setHoveredMedia] = useState<string | null>(null);
  const [failedMedia, setFailedMedia] = useState<Set<string>>(new Set());

  /** Load incident reports for the active city from Neon
   *  (GET /api/safety/incidents?cityId=...), falling back to the embedded demo
   *  list when the API is unavailable (e.g. on Vercel).  Refetches whenever a
   *  simulated SOS call POSTs a new report or the active city changes. */
  const refreshIncidents = React.useCallback(() => {
    fetch(`/api/safety/incidents?cityId=${encodeURIComponent(cityId)}&limit=50`)
      .then((response) => response.ok ? response.json() : Promise.reject(new Error('incidents unavailable')))
      .then((data: { entries: ApiIncident[] }) => {
        if (Array.isArray(data.entries)) {
          const mapped = data.entries.map(apiToIncident);
          setIncidents(mapped);
          setSelectedId((current) => (current && mapped.some((e) => e.id === current)) ? current : (mapped[0]?.id ?? null));
        }
      })
      .catch(() => { /* keep demo data when the API is down */ });
  }, [cityId]);

  useEffect(() => {
    refreshIncidents();
    const onUpdate = () => refreshIncidents();
    window.addEventListener('sos-incident-updated', onUpdate);
    return () => window.removeEventListener('sos-incident-updated', onUpdate);
  }, [refreshIncidents]);

  const markMediaFailed = (incidentId: string) => {
    setFailedMedia((current) => new Set(current).add(incidentId));
  };

  const toggleCategory = (cat: string) => {
    setActiveCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat); else next.add(cat);
      return next;
    });
  };

  const toggleSeverity = (sev: string) => {
    setActiveSeverities((prev) => {
      const next = new Set(prev);
      if (next.has(sev)) next.delete(sev); else next.add(sev);
      return next;
    });
  };

  const clearFilters = () => {
    setActiveCategories(new Set());
    setActiveSeverities(new Set());
    setSearchTerm('');
  };

  const filtered = useMemo(() => {
    return incidents.filter((incident) => {
      const catMatch = activeCategories.size === 0 || activeCategories.has(incident.category);
      const sevMatch = activeSeverities.size === 0 || activeSeverities.has(incident.severity);
      const haystack = `${incident.id} ${incident.title} ${incident.category} ${incident.location.street} ${incident.reporterId}`.toLowerCase();
      return catMatch && sevMatch && haystack.includes(searchTerm.toLowerCase());
    });
  }, [searchTerm, activeCategories, activeSeverities]);

  const geofenceZones = useMemo(() => deriveGeofenceZones(filtered), [filtered]);
  const highRiskZones = geofenceZones.filter((z) => z.riskLevel === 'High Risk').length;

  const hasFilters = activeCategories.size > 0 || activeSeverities.size > 0 || searchTerm.length > 0;

  const criticalCount = incidents.filter((i) => i.severity === 'Critical' && i.status !== 'Resolved').length;
  const openCount = incidents.filter((i) => i.status !== 'Resolved').length;
  const resolvedCount = incidents.filter((i) => i.status === 'Resolved').length;

  return (
    <aside className="incident-logs-panel">
      <div className="il-header">
        <div className="il-header-text">
          <span className="il-eyebrow">EVENT STREAM</span>
          <div className="il-title-row">
            <h2>Incident logs</h2>
            <span className="il-count">{String(filtered.length).padStart(2, '0')}</span>
          </div>
          <p className="il-subtitle">Live safety incident reports and response activity.</p>
        </div>
      </div>

      <div className="il-summary-strip">
        <div className="il-summary-item">
          <span className="il-summary-icon red">!</span>
          <span>
            <b>{String(criticalCount).padStart(2, '0')}</b>
            <small>Critical</small>
          </span>
        </div>
        <div className="il-summary-item">
          <span className="il-summary-icon amber">●</span>
          <span>
            <b>{String(openCount).padStart(2, '0')}</b>
            <small>Open</small>
          </span>
        </div>
        <div className="il-summary-item">
          <span className="il-summary-icon green">✓</span>
          <span>
            <b>{String(resolvedCount).padStart(2, '0')}</b>
            <small>Resolved</small>
          </span>
        </div>
      </div>

      <div className="il-filter-bar">
        <div className="il-search-field">
          <Search size={16} />
          <input
            type="search"
            placeholder="Search incidents..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>
        {hasFilters && (
          <button className="il-clear-filters" type="button" onClick={clearFilters}>
            Clear ({activeCategories.size + activeSeverities.size})
          </button>
        )}
      </div>

      <div className="il-filter-toggles">
        <div className="il-filter-group">
          <span className="il-filter-group-label">Severity</span>
          <div className="il-filter-chips">
            {SEVERITIES.map((sev) => (
              <button
                key={sev}
                className={`il-filter-chip severity-${sev.toLowerCase()}${activeSeverities.has(sev) ? ' active' : ''}`}
                type="button"
                onClick={() => toggleSeverity(sev)}
              >
                <span className={`il-severity-dot ${severityClass(sev)}`} />
                {sev}
              </button>
            ))}
          </div>
        </div>
        <div className="il-filter-group">
          <span className="il-filter-group-label">Incident type</span>
          <div className="il-filter-chips">
            {CATEGORIES.map((cat) => (
              <button
                key={cat}
                className={`il-filter-chip${activeCategories.has(cat) ? ' active' : ''}`}
                type="button"
                onClick={() => toggleCategory(cat)}
              >
                {cat}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="il-logs-list">
        {filtered.length ? (
          filtered.map((incident) => (
            <div
              key={incident.id}
              className="il-log-card-wrapper"
              onMouseEnter={() => setHoveredMedia(incident.id)}
              onMouseLeave={() => setHoveredMedia(null)}
            >
              <button
                className={`il-log-card${selectedId === incident.id ? ' selected' : ''}`}
                type="button"
                onClick={() => setSelectedId(incident.id)}
              >
                <span className={`il-priority-bar ${severityClass(incident.severity)}`} />
                <span className="il-log-main">
                  <span className="il-log-topline">
                    <span className="il-log-title">{incident.title}</span>
                    <span className="il-log-time">{incident.date} · {incident.time}</span>
                  </span>
                  <span className="il-log-meta">
                    <span><MapPin size={10} /> {incident.location.street}</span>
                    <span>{incident.category}</span>
                    <span className="il-log-coords-inline">GPS: {incident.location.lat.toFixed(4)}, {incident.location.lng.toFixed(4)}</span>
                  </span>
                  {incident.responderNotes && (
                    <span className="il-responder-notes">
                      <Shield size={10} /> {incident.responderNotes}
                    </span>
                  )}
                </span>
                <span className={`il-status-pill ${statusClass(incident.status)}`}>
                  <span className={`il-severity-dot ${severityClass(incident.severity)}`} />
                  {incident.status}
                </span>
              </button>

              {incident.media && (
                <button
                  className="il-media-btn"
                  type="button"
                  title={incident.media.type === 'screenshot' ? 'View local screenshot' : 'View local recording'}
                  aria-label={incident.media.type === 'screenshot' ? 'View local screenshot' : 'View local recording'}
                >
                  {incident.media.type === 'screenshot' ? <Camera size={13} /> : <Video size={13} />}
                </button>
              )}

              {hoveredMedia === incident.id && (
                <div className={`il-media-popover${incident.media ? '' : ' text-only'}`}>
                  {incident.media && (
                    <div className="il-media-visual">
                      <span className="il-media-badge">
                        {incident.media.type === 'screenshot' ? 'LOCAL SNAPSHOT' : 'LOCAL REC 00:38 / 02:14'}
                      </span>
                      <div className="il-media-placeholder">
                        {!failedMedia.has(incident.id) && incident.media.type === 'screenshot' && (
                          <img
                            className="il-local-media"
                            src={incident.media.src}
                            alt={`Incident ${incident.id} local screenshot`}
                            loading="lazy"
                            onError={() => markMediaFailed(incident.id)}
                          />
                        )}
                        {!failedMedia.has(incident.id) && incident.media.type === 'recording' && (
                          <video
                            className="il-local-media"
                            src={incident.media.src}
                            poster={incident.media.poster}
                            muted
                            autoPlay
                            loop
                            playsInline
                            preload="metadata"
                            onError={() => markMediaFailed(incident.id)}
                          />
                        )}
                        {failedMedia.has(incident.id) && (
                          incident.media.type === 'screenshot' ? (
                            <div className="il-placeholder-screenshot">
                              <span className="il-placeholder-label">CAM 04 / {incident.location.landmark.toUpperCase()}</span>
                              <span className="il-placeholder-id">LOCAL FILE UNAVAILABLE</span>
                            </div>
                          ) : (
                            <div className="il-placeholder-recording">
                              <span className="il-placeholder-play">▶</span>
                              <span className="il-placeholder-label">LOCAL FILE UNAVAILABLE</span>
                            </div>
                          )
                        )}
                      </div>
                      <div className="il-media-footer">
                        <span>{incident.location.street}</span>
                        <span>{incident.time}</span>
                      </div>
                    </div>
                  )}
                  <div className="il-media-details">
                    <div className="il-media-detail-heading">
                      <span className="il-filter-group-label">Incident detail</span>
                      <strong>{incident.id}</strong>
                    </div>
                    <h3>{incident.title}</h3>
                    <div className="il-media-detail-row"><span>Status</span><b>{incident.status}</b></div>
                    <div className="il-media-detail-row"><span>Severity</span><b className={`severity-text ${severityClass(incident.severity)}`}>{incident.severity}</b></div>
                    <div className="il-media-detail-row"><span>Category</span><b>{incident.category}</b></div>
                    <div className="il-media-detail-row"><span>Location</span><b>{incident.location.landmark}</b></div>
                    <div className="il-media-detail-row"><span>Reported</span><b>{incident.date} · {incident.time}</b></div>
                    <p className="il-media-notes"><Shield size={11} /> {incident.responderNotes}</p>
                  </div>
                </div>
              )}
            </div>
          ))
        ) : (
          <div className="il-no-results">No incidents match your current filters.</div>
        )}
      </div>

      {geofenceZones.length > 0 && (
        <div className="il-geofence-section">
          <div className="il-geofence-header">
            <span className="il-filter-group-label">Geofenced risk zones</span>
            <span className={`il-geofence-count ${highRiskZones > 0 ? 'danger' : ''}`}>{geofenceZones.length} zones · {highRiskZones} high risk</span>
          </div>
          <div className="il-geofence-list">
            {geofenceZones.map((zone) => (
              <div key={zone.id} className={`il-geofence-row risk-${zone.riskLevel.toLowerCase().replace(' ', '-')}`}>
                <span className={`il-geofence-dot risk-${zone.riskLevel.toLowerCase().replace(' ', '-')}`} />
                <span className="il-geofence-name">{zone.name}</span>
                <span className="il-geofence-detail">
                  {zone.incidentIds.length} incidents · {zone.radiusM}m radius · {zone.center.lat.toFixed(4)}, {zone.center.lng.toFixed(4)}
                </span>
                <span className={`il-geofence-badge risk-${zone.riskLevel.toLowerCase().replace(' ', '-')}`}>{zone.riskLevel}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="il-footer">
        <span>
          <i className="il-footer-pulse" /> Streaming updates
        </span>
        <button type="button">
          Load older events <ArrowRight size={12} />
        </button>
      </div>
    </aside>
  );
}
