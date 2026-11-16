import { useEffect, useState, type FormEvent } from 'react';
import { Footprints, HeartPulse, Droplets, Plus, Copy, Check, X, Smartphone, RefreshCw } from 'lucide-react';
import api from '../../lib/api';
import { useHealth, type VitalValue } from '../../hooks/useHealth';
import type { IotSnapshot } from '../../lib/iotDevice';
import { CLAY_COLORS as C, CLAY_CARD_STYLE as clayCard } from '../../theme/clayTheme';

const STEP_GOAL = 10000;

const SOURCE_LABEL: Record<VitalValue['source'], string> = { bluetooth: 'Bluetooth device', health_app: 'Health app', manual: 'Entered by you' };

function ago(iso: string): string {
    const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} d ago`;
}

function hrColor(v: number) { return v > 150 || v < 40 ? C.critical : v > 120 || v < 50 ? C.moderate : C.safe; }
function spo2Color(v: number) { return v < 90 ? C.critical : v < 95 ? C.moderate : C.safe; }

const field: React.CSSProperties = { width: '100%', boxSizing: 'border-box', padding: '9px 10px', background: C.surfaceAlt, border: `1px solid ${C.border}`, borderRadius: 10, fontFamily: 'inherit', fontSize: '0.85rem', fontWeight: 600, color: C.text };
const chip: React.CSSProperties = { border: `1px solid ${C.border}`, background: C.surfaceAlt, color: C.text, borderRadius: 999, padding: '6px 12px', fontFamily: 'inherit', fontWeight: 700, fontSize: '0.72rem', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 };

function Sparkline({ values, color }: { values: number[]; color: string }) {
    if (values.length < 2) return null;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = Math.max(1, max - min);
    const pts = values.map((v, i) => `${(i / (values.length - 1)) * 100},${28 - ((v - min) / span) * 24}`).join(' ');
    return (
        <svg viewBox="0 0 100 30" preserveAspectRatio="none" style={{ width: '100%', height: 30, display: 'block' }} aria-hidden>
            <polyline points={pts} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        </svg>
    );
}

/** Steps, heart rate and SpO2 on the tourist dashboard, plus every way of getting them in. */
export default function HealthPanel({ device }: { device: IotSnapshot }) {
    const { today, loading, refresh, addManual } = useHealth(device);
    const [, tick] = useState(0);
    const [manualOpen, setManualOpen] = useState(false);
    const [appOpen, setAppOpen] = useState(false);
    const [form, setForm] = useState({ steps: '', hr: '', spo2: '' });
    const [formError, setFormError] = useState('');
    const [saving, setSaving] = useState(false);

    // Keeps "x min ago" labels honest.
    useEffect(() => { const id = setInterval(() => tick((n) => n + 1), 30000); return () => clearInterval(id); }, []);

    const submitManual = async (e: FormEvent) => {
        e.preventDefault();
        setFormError('');
        const values: { steps?: number; heart_rate?: number; spo2?: number } = {};
        if (form.steps.trim()) values.steps = Number(form.steps);
        if (form.hr.trim()) values.heart_rate = Number(form.hr);
        if (form.spo2.trim()) values.spo2 = Number(form.spo2);
        if (Object.keys(values).length === 0) { setFormError('Enter at least one value.'); return; }
        if (values.steps !== undefined && !(values.steps >= 0 && values.steps <= 200000)) { setFormError('Steps must be between 0 and 200,000.'); return; }
        if (values.heart_rate !== undefined && !(values.heart_rate >= 20 && values.heart_rate <= 250)) { setFormError('Heart rate must be between 20 and 250 bpm.'); return; }
        if (values.spo2 !== undefined && !(values.spo2 >= 50 && values.spo2 <= 100)) { setFormError('SpO₂ must be between 50 and 100 %.'); return; }
        setSaving(true);
        try {
            await addManual(values);
            setForm({ steps: '', hr: '', spo2: '' });
            setManualOpen(false);
        } catch {
            setFormError('Could not save. Check your connection and try again.');
        } finally {
            setSaving(false);
        }
    };

    const steps = today?.steps;
    const hr = today?.heart_rate;
    const spo2 = today?.spo2;
    const hrSeries = (today?.series ?? []).map((p) => p.heart_rate).filter((v): v is number => typeof v === 'number');
    const stepPct = steps ? Math.min(100, Math.round((steps.value / STEP_GOAL) * 100)) : 0;

    const tile = (icon: React.ReactNode, label: string, value: string, unit: string, meta: VitalValue | null | undefined, color: string, extra?: React.ReactNode) => (
        <div style={{ background: C.surfaceAlt, border: `1px solid ${C.border}`, borderRadius: 14, padding: '12px 12px 10px', minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, color, fontSize: '0.66rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{icon}{label}</div>
            <div style={{ marginTop: 6, fontFamily: "'JetBrains Mono', monospace", fontWeight: 800, fontSize: '1.35rem', color: meta ? C.text : C.textMuted }}>
                {meta ? value : '—'}<span style={{ fontSize: '0.68rem', fontWeight: 700, color: C.textMuted, marginLeft: 3 }}>{meta ? unit : ''}</span>
            </div>
            {extra}
            <div style={{ marginTop: 4, fontSize: '0.62rem', color: C.textMuted, fontWeight: 600, lineHeight: 1.35 }}>
                {meta ? `${meta.device || SOURCE_LABEL[meta.source]} · ${ago(meta.at)}` : 'No data yet'}
            </div>
        </div>
    );

    return (
        <div style={{ ...clayCard, padding: 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
                <h3 style={{ fontWeight: 800, color: C.text, margin: 0, fontSize: '0.88rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Health</h3>
                <button type="button" aria-label="Refresh health data" onClick={() => void refresh()} style={{ ...chip, padding: 6 }}><RefreshCw size={13} /></button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }}>
                {tile(<Footprints size={13} />, 'Steps', steps ? steps.value.toLocaleString() : '', '', steps, C.primary,
                    steps && (
                        <div style={{ marginTop: 6, height: 5, background: C.border, borderRadius: 999 }} title={`${stepPct}% of ${STEP_GOAL.toLocaleString()} steps`}>
                            <div style={{ width: `${stepPct}%`, height: '100%', background: C.primary, borderRadius: 999 }} />
                        </div>
                    ))}
                {tile(<HeartPulse size={13} />, 'Heart rate', hr ? String(hr.value) : '', 'bpm', hr, hr ? hrColor(hr.value) : C.critical,
                    hrSeries.length > 1 && <div style={{ marginTop: 4 }}><Sparkline values={hrSeries} color={hr ? hrColor(hr.value) : C.critical} /></div>)}
                {tile(<Droplets size={13} />, 'SpO₂', spo2 ? String(spo2.value) : '', '%', spo2, spo2 ? spo2Color(spo2.value) : C.primary)}
            </div>
            {loading && !today && <p style={{ margin: '10px 0 0', fontSize: '0.72rem', color: C.textMuted }}>Loading…</p>}
            {spo2 && spo2.value < 90 && (
                <p role="alert" style={{ margin: '10px 0 0', fontSize: '0.74rem', fontWeight: 700, color: C.critical }}>
                    Low blood oxygen. Rest, and get medical help if you feel unwell or are at altitude.
                </p>
            )}

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
                <button type="button" style={chip} onClick={() => { setManualOpen((o) => !o); setAppOpen(false); }}>
                    {manualOpen ? <X size={13} /> : <Plus size={13} />} Add reading
                </button>
                <button type="button" style={chip} onClick={() => { setAppOpen((o) => !o); setManualOpen(false); }}>
                    <Smartphone size={13} /> Connect health app
                </button>
            </div>

            {manualOpen && (
                <form onSubmit={submitManual} style={{ marginTop: 12, display: 'grid', gap: 8 }}>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }}>
                        <label style={{ fontSize: '0.62rem', fontWeight: 700, color: C.textMuted, textTransform: 'uppercase' }}>Steps
                            <input style={field} inputMode="numeric" value={form.steps} onChange={(e) => setForm({ ...form, steps: e.target.value })} placeholder="4200" />
                        </label>
                        <label style={{ fontSize: '0.62rem', fontWeight: 700, color: C.textMuted, textTransform: 'uppercase' }}>Heart rate
                            <input style={field} inputMode="numeric" value={form.hr} onChange={(e) => setForm({ ...form, hr: e.target.value })} placeholder="72" />
                        </label>
                        <label style={{ fontSize: '0.62rem', fontWeight: 700, color: C.textMuted, textTransform: 'uppercase' }}>SpO₂ %
                            <input style={field} inputMode="decimal" value={form.spo2} onChange={(e) => setForm({ ...form, spo2: e.target.value })} placeholder="97" />
                        </label>
                    </div>
                    {formError && <p role="alert" style={{ margin: 0, fontSize: '0.74rem', color: C.critical, fontWeight: 700 }}>{formError}</p>}
                    <button type="submit" disabled={saving} style={{ ...chip, justifyContent: 'center', background: C.primary, color: '#fff', border: 'none', padding: '10px 12px' }}>{saving ? 'Saving…' : 'Save reading'}</button>
                </form>
            )}

            {appOpen && <HealthAppSetup />}
        </div>
    );
}

/** Personal key + instructions so a phone's health app (via an automation/export app) can push data. */
function HealthAppSetup() {
    const [hasKey, setHasKey] = useState<boolean | null>(null);
    const [key, setKey] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [copied, setCopied] = useState<string | null>(null);
    const [error, setError] = useState('');
    const endpoint = `${String(api.defaults.baseURL || '').replace(/\/$/, '')}/health/ingest`;

    useEffect(() => {
        api.get('/health/key').then((r) => setHasKey(Boolean(r.data.data.has_key))).catch(() => setHasKey(false));
    }, []);

    const generate = async () => {
        setBusy(true); setError('');
        try {
            const res = await api.post('/health/key');
            setKey(res.data.data.key);
            setHasKey(true);
        } catch { setError('Could not create a key. Try again.'); } finally { setBusy(false); }
    };

    const revoke = async () => {
        if (!window.confirm('Turn off health-app syncing? Apps using this key will stop working.')) return;
        setBusy(true);
        try { await api.delete('/health/key'); setKey(null); setHasKey(false); } catch { setError('Could not revoke the key.'); } finally { setBusy(false); }
    };

    const copy = async (what: string, text: string) => {
        try { await navigator.clipboard.writeText(text); setCopied(what); setTimeout(() => setCopied(null), 1800); } catch { setError('Copy was blocked by your browser.'); }
    };

    const row = (label: string, value: string, id: string) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: C.surfaceAlt, border: `1px solid ${C.border}`, borderRadius: 10, padding: '8px 10px' }}>
            <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: '0.6rem', fontWeight: 800, color: C.textMuted, textTransform: 'uppercase' }}>{label}</div>
                <code style={{ fontSize: '0.7rem', wordBreak: 'break-all', color: C.text }}>{value}</code>
            </div>
            <button type="button" aria-label={`Copy ${label}`} onClick={() => void copy(id, value)} style={{ ...chip, padding: 7 }}>{copied === id ? <Check size={13} /> : <Copy size={13} />}</button>
        </div>
    );

    return (
        <div style={{ marginTop: 12, display: 'grid', gap: 10 }}>
            <p style={{ margin: 0, fontSize: '0.76rem', color: C.textMuted, lineHeight: 1.5 }}>
                Apple Health and Android Health Connect cannot be read by a website directly. Instead, an app on your phone sends your steps,
                heart rate and SpO₂ to TrackMate using your personal key. Create the key, then paste the address and key into that app.
            </p>

            {hasKey === null ? null : !key ? (
                <button type="button" disabled={busy} onClick={() => void generate()} style={{ ...chip, justifyContent: 'center', background: C.primary, color: '#fff', border: 'none', padding: '10px 12px' }}>
                    {busy ? 'Working…' : hasKey ? 'Create a new key (replaces the old one)' : 'Create my health key'}
                </button>
            ) : null}

            {key && (
                <>
                    {row('Address (POST)', endpoint, 'url')}
                    {row('Header  X-Health-Key', key, 'key')}
                    <p style={{ margin: 0, fontSize: '0.68rem', color: C.critical, fontWeight: 700 }}>Copy the key now. It is shown only once.</p>
                </>
            )}

            <details style={{ fontSize: '0.74rem', color: C.text, lineHeight: 1.55 }}>
                <summary style={{ cursor: 'pointer', fontWeight: 800 }}>How to set it up</summary>
                <div style={{ marginTop: 6 }}>
                    <b>iPhone:</b> use an app that exports Apple Health data to a web address on a schedule (for example Health Auto Export, REST API
                    automation) or a Shortcuts automation with "Get Contents of URL". Method POST, JSON body, header <code>X-Health-Key</code> with your key,
                    and include Step Count, Heart Rate and Blood Oxygen Saturation.<br />
                    <b>Android:</b> use an automation app that can read Health Connect (or your watch's app) and send an HTTP POST with the same header.<br />
                    <b>Simple body</b> that always works: <code>{'{"steps": 4210, "heart_rate": 72, "spo2": 97}'}</code>. Any of the three can be left out.
                </div>
            </details>

            {error && <p role="alert" style={{ margin: 0, fontSize: '0.74rem', color: C.critical, fontWeight: 700 }}>{error}</p>}
            {hasKey && !key && (
                <button type="button" disabled={busy} onClick={() => void revoke()} style={{ ...chip, color: C.critical, justifyContent: 'center' }}>Turn off health-app syncing</button>
            )}
        </div>
    );
}
