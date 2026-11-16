import { useEffect, useMemo, useState } from 'react';
import { MapContainer, TileLayer, Circle, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import api from '../../lib/api';
import { CLAY_COLORS as C } from '../../theme/clayTheme';

interface Point { lat: number; lng: number; weight: number }
interface ZoneLoad { id: string; name: string; risk_level: string; tourists_now: number; incidents: number }
interface HeatData {
    hours: number;
    incidents: Point[];
    tourist_density: Point[];
    tourists_live: { lat: number; lng: number }[];
    zone_load: ZoneLoad[];
}

type Layer = 'incidents' | 'tourists' | 'live';

const RANGES = [{ label: '24 h', hours: 24 }, { label: '7 days', hours: 168 }, { label: '30 days', hours: 720 }];
const GRADIENTS: Record<Layer, Record<number, string>> = {
    incidents: { 0.2: '#FDE68A', 0.5: '#FB923C', 0.8: '#EF4444', 1: '#7F1D1D' },
    tourists: { 0.2: '#BAE6FD', 0.5: '#38BDF8', 0.8: '#6366F1', 1: '#312E81' },
    live: { 0.2: '#A7F3D0', 0.5: '#34D399', 0.8: '#059669', 1: '#064E3B' },
};

function HeatLayer({ points, layer }: { points: Point[]; layer: Layer }) {
    const map = useMap();
    useEffect(() => {
        if (points.length === 0) return;
        let heat: L.Layer | null = null;
        let cancelled = false;
        (async () => {
            const mod: any = await import('leaflet.heat');
            if (cancelled) return;
            const max = Math.max(...points.map((p) => p.weight), 1);
            heat = new mod.HeatLayer(
                points.map((p) => [p.lat, p.lng, p.weight / max]),
                { radius: 32, blur: 24, maxZoom: 14, minOpacity: 0.35, gradient: GRADIENTS[layer] }
            );
            heat!.addTo(map);
        })();
        return () => { cancelled = true; if (heat) map.removeLayer(heat); };
    }, [map, points, layer]);
    return null;
}

/**
 * Frames the busiest area: the median of all zones/points, then everything within 120 km of it.
 * (Fitting every coordinate let stray test data zoom the map out to half a country.)
 */
function FitBounds({ zones, points }: { zones: { center_lat: number; center_lng: number }[]; points: Point[] }) {
    const map = useMap();
    const count = zones.length + points.length;
    useEffect(() => {
        const all: [number, number][] = [...zones.map((z) => [z.center_lat, z.center_lng] as [number, number]), ...points.map((p) => [p.lat, p.lng] as [number, number])];
        const t = setTimeout(() => {
            map.invalidateSize();
            if (all.length === 0) return;
            const median = (values: number[]) => [...values].sort((x, y) => x - y)[Math.floor(values.length / 2)];
            const center = L.latLng(median(all.map((p) => p[0])), median(all.map((p) => p[1])));
            const near = all.filter((p) => center.distanceTo(L.latLng(p[0], p[1])) <= 120_000);
            if (near.length > 0) map.fitBounds(L.latLngBounds(near), { padding: [40, 40], maxZoom: 12 });
        }, 200);
        return () => clearTimeout(t);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [map, count]);
    return null;
}

const RISK_COLOR: Record<string, string> = { safe: '#12B3A6', moderate: '#F59E0B', high: '#EF4444', restricted: '#7C3AED' };

/** Incident-distribution and tourist-load heatmaps for the authority analytics page. */
export default function HeatMap({ zones }: { zones: { _id: string; center_lat: number; center_lng: number; radius_meters: number; risk_level: string }[] }) {
    const [data, setData] = useState<HeatData | null>(null);
    const [layer, setLayer] = useState<Layer>('incidents');
    const [hours, setHours] = useState(168);
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let cancelled = false;
        const load = async () => {
            try {
                const res = await api.get('/analytics/heatmap', { params: { hours } });
                if (!cancelled) { setData(res.data.data); setError(''); }
            } catch {
                if (!cancelled) setError('Could not load heatmap data.');
            } finally {
                if (!cancelled) setLoading(false);
            }
        };
        setLoading(true);
        void load();
        const timer = setInterval(load, 30000); // keeps "live" load current
        return () => { cancelled = true; clearInterval(timer); };
    }, [hours]);

    const points: Point[] = useMemo(() => {
        if (!data) return [];
        if (layer === 'incidents') return data.incidents;
        if (layer === 'tourists') return data.tourist_density;
        return data.tourists_live.map((t) => ({ lat: t.lat, lng: t.lng, weight: 1 }));
    }, [data, layer]);

    const tab = (active: boolean) => ({
        background: active ? C.primary : C.surfaceAlt, color: active ? '#fff' : C.text, border: `1px solid ${active ? C.primary : C.border}`,
        borderRadius: 999, padding: '7px 14px', fontFamily: 'inherit', fontWeight: 800, fontSize: '0.72rem', cursor: 'pointer',
    } as const);

    const labels: Record<Layer, string> = { incidents: 'Incident distribution', tourists: 'Tourist load (history)', live: 'Tourists right now' };

    return (
        <div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }} role="tablist" aria-label="Heatmap layer">
                    {(Object.keys(labels) as Layer[]).map((l) => (
                        <button key={l} type="button" role="tab" aria-selected={layer === l} style={tab(layer === l)} onClick={() => setLayer(l)}>{labels[l]}</button>
                    ))}
                </div>
                {layer !== 'live' && (
                    <div style={{ display: 'flex', gap: 6 }} role="group" aria-label="Time range">
                        {RANGES.map((r) => <button key={r.hours} type="button" style={tab(hours === r.hours)} onClick={() => setHours(r.hours)}>{r.label}</button>)}
                    </div>
                )}
            </div>

            <div style={{ position: 'relative', height: 'clamp(300px, 55vw, 460px)', borderRadius: 14, overflow: 'hidden', border: `1px solid ${C.border}` }}>
                <MapContainer center={[27.5866, 91.8698]} zoom={10} style={{ height: '100%', width: '100%' }} scrollWheelZoom>
                    <TileLayer attribution="&copy; OpenStreetMap contributors" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" maxZoom={19} />
                    {zones.map((z) => (
                        <Circle key={z._id} center={[z.center_lat, z.center_lng]} radius={z.radius_meters}
                            pathOptions={{ color: RISK_COLOR[z.risk_level] || '#64748B', weight: 1.2, fillOpacity: 0.04, dashArray: '4 4' }} />
                    ))}
                    <HeatLayer points={points} layer={layer} />
                    <FitBounds zones={zones} points={points} />
                </MapContainer>
                {(loading || points.length === 0) && (
                    <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', pointerEvents: 'none', zIndex: 500 }}>
                        <span style={{ background: 'rgba(255,255,255,0.92)', borderRadius: 10, padding: '8px 14px', fontWeight: 700, fontSize: '0.82rem', color: C.textSecondary }}>
                            {loading ? 'Loading heatmap…' : 'No data for this layer and range'}
                        </span>
                    </div>
                )}
                <div style={{ position: 'absolute', left: 10, bottom: 10, zIndex: 500, background: 'rgba(255,255,255,0.94)', borderRadius: 10, padding: '8px 12px', fontSize: '0.68rem', fontWeight: 700, color: C.textSecondary }}>
                    <div style={{ height: 8, width: 120, borderRadius: 4, background: `linear-gradient(90deg, ${Object.values(GRADIENTS[layer]).join(',')})` }} />
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2 }}><span>Low</span><span>High</span></div>
                </div>
            </div>
            {error && <p role="alert" style={{ color: C.critical, fontWeight: 700, fontSize: '0.8rem' }}>{error}</p>}

            {data && (
                <div style={{ marginTop: 14, overflowX: 'auto' }}>
                    <table className="geo-table" style={{ minWidth: 420 }}>
                        <thead><tr><th>Zone</th><th>Risk</th><th>Tourists now</th><th>Incidents ({hours >= 168 ? `${Math.round(hours / 24)}d` : `${hours}h`})</th></tr></thead>
                        <tbody>
                            {[...data.zone_load].sort((a, b) => b.tourists_now - a.tourists_now || b.incidents - a.incidents).map((z) => (
                                <tr key={z.id}>
                                    <td style={{ fontWeight: 700 }}>{z.name}</td>
                                    <td style={{ textTransform: 'capitalize' }}>{z.risk_level}</td>
                                    <td style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 800 }}>{z.tourists_now}</td>
                                    <td style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 800 }}>{z.incidents}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
