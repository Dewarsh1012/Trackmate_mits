import { useEffect, useState } from 'react';
import { Loader2, RefreshCw, TrendingDown, TrendingUp, Minus } from 'lucide-react';
import api from '../../lib/api';
import { CLAY_COLORS as C, CLAY_CARD_STYLE as clayCard } from '../../theme/clayTheme';

interface HourCell { hour_start: string; expected: number; probability: number; band: 'low' | 'elevated' | 'high' | 'severe' }
interface ZoneRow { zone_id: string; zone_name: string; risk_level: string; trend: 'rising' | 'stable' | 'falling'; expected_next_24h: number; hours: HourCell[] }
interface Forecast {
    generated_at: string;
    model: { kind: string; incidents_in_window: number; window_days: number; note: string; backtest: { insufficient_data: boolean; skill_vs_flat: number | null; capture_top10: number | null; test_incidents: number } };
    zones: ZoneRow[];
    top_windows: Array<{ zone_id: string; zone_name: string; hour_start: string; probability: number; band: string }>;
}

// Sequential single-hue ramp (light = near zero, dark = high), from the chart palette.
const RAMP = ['#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7', '#3987e5', '#2a78d6', '#256abf', '#1c5cab', '#184f95', '#104281', '#0d366b'];
const CAP = 0.5; // 50%+ chance in an hour is the darkest step
const colorFor = (p: number) => RAMP[Math.round(Math.min(1, p / CAP) ** 0.6 * (RAMP.length - 1))];
const hourLabel = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const pct = (p: number) => (p < 0.01 ? '<1%' : `${Math.round(p * 100)}%`);

const heading: React.CSSProperties = { fontSize: '0.78rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.1em', color: C.text, margin: 0 };

/** Next-24-hour incident forecast per zone, as a heat strip with a hover/tap readout and a ranked list. */
export default function ForecastPanel() {
    const [data, setData] = useState<Forecast | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [hover, setHover] = useState<{ zone: string; cell: HourCell } | null>(null);
    const [showAll, setShowAll] = useState(false);
    const VISIBLE = 8;

    const load = async () => {
        setLoading(true); setError(null);
        try {
            const res = await api.get('/ml/forecast', { params: { hours: 24 } });
            setData(res.data.data);
        } catch {
            setError('Could not load the forecast.');
        } finally { setLoading(false); }
    };
    useEffect(() => { void load(); }, []);

    const bt = data?.model.backtest;
    const accuracy = !bt || bt.insufficient_data
        ? 'Accuracy is measured once there are enough incidents to test against.'
        : `On the last week held out: ${bt.skill_vs_flat != null && bt.skill_vs_flat > 0 ? `${Math.round(bt.skill_vs_flat * 100)}% better than a flat-rate guess` : 'no better than a flat-rate guess yet'}${bt.capture_top10 != null ? `; the 10% of hours it ranked riskiest held ${Math.round(bt.capture_top10 * 100)}% of incidents` : ''}.`;

    return (
        <div style={{ ...clayCard, padding: 'clamp(14px, 3vw, 24px)', marginBottom: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
                <h3 style={heading}>AI Risk Forecast · Next 24 Hours</h3>
                <button type="button" onClick={() => void load()} disabled={loading} aria-label="Refresh forecast"
                    style={{ background: C.surfaceAlt, border: `1px solid ${C.border}`, borderRadius: 10, padding: '6px 10px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: 'inherit', fontWeight: 700, fontSize: '0.72rem', color: C.text }}>
                    {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Refresh
                </button>
            </div>
            {data && <p style={{ margin: '0 0 12px', fontSize: '0.76rem', color: C.textSecondary, lineHeight: 1.5 }}>Chance of at least one incident in each zone, hour by hour. {data.model.note}</p>}
            {error && <p role="alert" style={{ color: C.critical, fontWeight: 700, fontSize: '0.8rem' }}>{error}</p>}
            {loading && !data && <p style={{ color: C.textMuted, fontWeight: 600, fontSize: '0.8rem' }}>Loading forecast…</p>}

            {data && data.zones.length === 0 && <p style={{ color: C.textMuted, fontWeight: 600 }}>No active zones to forecast.</p>}
            {data && data.zones.length > 0 && (
                <>
                    {/* Readout: the hover/tap layer for the strip. */}
                    <div aria-live="polite" style={{ minHeight: 20, fontSize: '0.78rem', fontWeight: 700, color: C.text, marginBottom: 8 }}>
                        {hover
                            ? `${hover.zone} · ${hourLabel(hover.cell.hour_start)} · ${pct(hover.cell.probability)} chance (${hover.cell.band}) · ${hover.cell.expected.toFixed(2)} expected`
                            : <span style={{ color: C.textMuted, fontWeight: 600 }}>Hover or tap a cell for details.</span>}
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(84px, 150px) 1fr', gap: '6px 10px', alignItems: 'center' }}>
                        <span />
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(24, 1fr)', fontSize: '0.62rem', color: C.textMuted, fontWeight: 700 }}>
                            {data.zones[0].hours.map((h, i) => <span key={h.hour_start} style={{ gridColumn: `${i + 1}`, whiteSpace: 'nowrap', overflow: 'visible' }}>{i % 6 === 0 ? hourLabel(h.hour_start) : ''}</span>)}
                        </div>
                        {(showAll ? data.zones : data.zones.slice(0, VISIBLE)).map((z) => (
                            <div key={z.zone_id} style={{ display: 'contents' }}>
                                <div style={{ minWidth: 0 }}>
                                    <div style={{ fontSize: '0.78rem', fontWeight: 800, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={z.zone_name}>{z.zone_name}</div>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.66rem', color: C.textMuted, fontWeight: 700 }}>
                                        {z.trend === 'rising' ? <TrendingUp size={11} aria-label="rising" /> : z.trend === 'falling' ? <TrendingDown size={11} aria-label="falling" /> : <Minus size={11} aria-label="stable" />}
                                        {z.expected_next_24h.toFixed(1)} expected · {z.risk_level}
                                    </div>
                                </div>
                                <div role="list" aria-label={`${z.zone_name} hourly forecast`} style={{ display: 'grid', gridTemplateColumns: 'repeat(24, 1fr)', gap: 2 }}>
                                    {z.hours.map((cell) => (
                                        <button key={cell.hour_start} role="listitem" type="button"
                                            aria-label={`${z.zone_name} ${hourLabel(cell.hour_start)}: ${pct(cell.probability)} chance`}
                                            onMouseEnter={() => setHover({ zone: z.zone_name, cell })}
                                            onFocus={() => setHover({ zone: z.zone_name, cell })}
                                            onClick={() => setHover({ zone: z.zone_name, cell })}
                                            style={{ height: 22, minWidth: 0, padding: 0, border: hover?.cell === cell ? `2px solid ${C.text}` : 'none', borderRadius: 3, background: colorFor(cell.probability), cursor: 'pointer' }} />
                                    ))}
                                </div>
                            </div>
                        ))}
                    </div>

                    {data.zones.length > VISIBLE && (
                        <button type="button" onClick={() => setShowAll((v) => !v)}
                            style={{ marginTop: 8, background: 'none', border: 'none', padding: 0, color: C.primary, fontWeight: 800, fontSize: '0.74rem', cursor: 'pointer', fontFamily: 'inherit' }}>
                            {showAll ? `Show top ${VISIBLE} zones` : `Show all ${data.zones.length} zones`}
                        </button>
                    )}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, fontSize: '0.66rem', color: C.textMuted, fontWeight: 700 }}>
                        <span>Lower</span>
                        <span aria-hidden style={{ display: 'flex', gap: 2 }}>{RAMP.filter((_, i) => i % 2 === 0).map((c) => <span key={c} style={{ width: 14, height: 8, background: c, borderRadius: 2 }} />)}</span>
                        <span>50%+ chance in an hour</span>
                    </div>

                    {data.top_windows.length > 0 && (
                        <div style={{ marginTop: 14 }}>
                            <div style={{ fontSize: '0.7rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.08em', color: C.textSecondary, marginBottom: 6 }}>Highest-risk windows</div>
                            <ol style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 3 }}>
                                {data.top_windows.slice(0, 5).map((w) => (
                                    <li key={w.zone_id + w.hour_start} style={{ fontSize: '0.78rem', color: C.text }}>
                                        <b>{hourLabel(w.hour_start)}</b> · {w.zone_name} · {pct(w.probability)} chance ({w.band})
                                    </li>
                                ))}
                            </ol>
                        </div>
                    )}
                    <p style={{ margin: '12px 0 0', fontSize: '0.72rem', color: C.textMuted, lineHeight: 1.5 }}>
                        {data.model.incidents_in_window} incidents over {data.model.window_days} days. {accuracy}
                    </p>
                </>
            )}
        </div>
    );
}
