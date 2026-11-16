import { Incident } from '../models';
import { distanceInMeters } from './geofence';

export interface AreaSafety {
    score: number;
    level: 'safe' | 'caution' | 'risky' | 'danger';
    zone: { id: string; name: string; risk_level: string } | null;
    factors: { zone_base: number; incident_penalty: number; night_penalty: number; nearby_incidents: number };
    computed_at: string;
}

const ZONE_BASE: Record<string, number> = { safe: 92, moderate: 68, high: 38, restricted: 15 };
const OUTSIDE_ZONE_BASE = 55;
const SEVERITY_PENALTY: Record<string, number> = { critical: 12, high: 8, medium: 4, low: 1.5 };
const IGNORED_TYPES = new Set(['checkin', 'safe_house_request']);
const RADIUS_M = 1500;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const CACHE_MS = 45_000;

interface NearbyIncident { latitude: number; longitude: number; severity: string; created_at: Date }
const cache = new Map<string, { at: number; incidents: NearbyIncident[] }>();

async function nearbyIncidents(lat: number, lng: number): Promise<NearbyIncident[]> {
    const key = `${lat.toFixed(2)}:${lng.toFixed(2)}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.incidents;

    // Fetch a box around the 0.01° grid cell so every point inside it can reuse the same result.
    const dLat = 0.01 + RADIUS_M / 111_320;
    const dLng = 0.01 + RADIUS_M / (111_320 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
    const rows = await Incident.find({
        created_at: { $gte: new Date(Date.now() - WINDOW_MS) },
        status: { $nin: ['resolved', 'false_alarm'] },
        incident_type: { $nin: [...IGNORED_TYPES] },
        latitude: { $gte: lat - dLat, $lte: lat + dLat },
        longitude: { $gte: lng - dLng, $lte: lng + dLng },
    }).select('latitude longitude severity created_at').lean();

    const incidents = rows as unknown as NearbyIncident[];
    cache.set(key, { at: Date.now(), incidents });
    if (cache.size > 500) cache.clear();
    return incidents;
}

/**
 * Safety score for a position (0-100, higher is safer): the risk class of the zone the point is
 * in, minus a penalty for recent unresolved incidents nearby, minus a small night-time penalty.
 */
export async function computeAreaSafety(
    lat: number,
    lng: number,
    zone: { _id: unknown; name: string; risk_level: string } | null
): Promise<AreaSafety> {
    const now = Date.now();
    const incidents = await nearbyIncidents(lat, lng);

    let penalty = 0;
    let nearby = 0;
    for (const inc of incidents) {
        if (!Number.isFinite(inc.latitude) || !Number.isFinite(inc.longitude)) continue;
        if (distanceInMeters(lat, lng, inc.latitude, inc.longitude) > RADIUS_M) continue;
        nearby += 1;
        const ageHours = (now - new Date(inc.created_at).getTime()) / 3_600_000;
        const recency = Math.max(0.4, 1 - (ageHours / 24) * 0.6);
        penalty += (SEVERITY_PENALTY[inc.severity] ?? 2) * recency;
    }
    const incidentPenalty = Math.min(35, penalty);

    // Night = 22:00-05:00 India Standard Time (UTC+5:30).
    const istHour = new Date(now + 5.5 * 3_600_000).getUTCHours();
    const nightPenalty = istHour >= 22 || istHour < 5 ? 6 : 0;

    const base = zone ? (ZONE_BASE[zone.risk_level] ?? OUTSIDE_ZONE_BASE) : OUTSIDE_ZONE_BASE;
    const score = Math.max(0, Math.min(100, Math.round(base - incidentPenalty - nightPenalty)));
    const level: AreaSafety['level'] = score >= 75 ? 'safe' : score >= 50 ? 'caution' : score >= 30 ? 'risky' : 'danger';

    return {
        score,
        level,
        zone: zone ? { id: String(zone._id), name: zone.name, risk_level: zone.risk_level } : null,
        factors: { zone_base: base, incident_penalty: Math.round(incidentPenalty * 10) / 10, night_penalty: nightPenalty, nearby_incidents: nearby },
        computed_at: new Date(now).toISOString(),
    };
}
