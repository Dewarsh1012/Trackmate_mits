/** Client-side geofencing, so zone warnings keep working with no network (zones are cached in memory). */

export interface FenceZone {
    _id: string;
    name: string;
    risk_level: 'safe' | 'moderate' | 'high' | 'restricted';
    center_lat: number;
    center_lng: number;
    radius_meters: number;
    geojson?: any;
}

const RISK_RANK: Record<string, number> = { safe: 0, moderate: 1, high: 2, restricted: 3 };

export function distanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function inRing(x: number, y: number, ring: number[][]): boolean {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-12) + xi) inside = !inside;
    }
    return inside;
}

function polygons(geojson: any): number[][][][] {
    if (!geojson) return [];
    const geom = geojson.type === 'Feature' ? geojson.geometry : geojson;
    if (geom?.type === 'Polygon') return [geom.coordinates];
    if (geom?.type === 'MultiPolygon') return geom.coordinates;
    if (geojson.type === 'FeatureCollection') return (geojson.features || []).flatMap((f: any) => polygons(f));
    return [];
}

export function zoneContains(zone: FenceZone, lat: number, lng: number): boolean {
    const polys = polygons(zone.geojson);
    if (polys.length > 0) {
        return polys.some(([outer, ...holes]) => inRing(lng, lat, outer) && !holes.some((h) => inRing(lng, lat, h)));
    }
    return distanceMeters(lat, lng, zone.center_lat, zone.center_lng) <= zone.radius_meters;
}

/** Most restrictive zone containing the point (a safe zone never masks a restricted one). */
export function findZone(zones: FenceZone[], lat: number, lng: number): FenceZone | null {
    const hits = zones.filter((z) => zoneContains(z, lat, lng));
    if (hits.length === 0) return null;
    return hits.sort((a, b) => (RISK_RANK[b.risk_level] ?? 0) - (RISK_RANK[a.risk_level] ?? 0))[0];
}

/** Initial compass bearing (0-360, clockwise from north) from one point to another. */
export function bearingDegrees(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const toRad = (d: number) => (d * Math.PI) / 180;
    const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
    const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
    return (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
}

const POINTS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
export function compassPoint(deg: number): string {
    return POINTS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

export interface SafeZoneGuidance { zone: FenceZone; distanceM: number; bearing: number; inside: boolean }

/** Nearest safe zone (distance to its edge, bearing to its centre) from a position. */
export function nearestSafeZone(zones: FenceZone[], lat: number, lng: number): SafeZoneGuidance | null {
    let best: SafeZoneGuidance | null = null;
    for (const zone of zones) {
        if (zone.risk_level !== 'safe') continue;
        const inside = zoneContains(zone, lat, lng);
        const centreDist = distanceMeters(lat, lng, zone.center_lat, zone.center_lng);
        const distanceM = inside ? 0 : Math.max(0, centreDist - (zone.radius_meters || 0));
        if (!best || distanceM < best.distanceM) {
            best = { zone, distanceM, bearing: bearingDegrees(lat, lng, zone.center_lat, zone.center_lng), inside };
        }
    }
    return best;
}
