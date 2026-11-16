import { useEffect, useState } from 'react';
import { Brain, Loader2 } from 'lucide-react';
import api from '../../lib/api';
import { CLAY_COLORS as C, CLAY_CARD_STYLE as clayCard } from '../../theme/clayTheme';

interface ModelInfo { key: string; label: string; what: string; source: 'prior' | 'trained'; version: string | null; trained_at: string | null; samples: number; metrics: Record<string, any> | null; needs: string }
interface Status { models: ModelInfo[]; data: { pings_45d: number; sos_outcomes: number; reported_or_sos_incidents_45d: number } }
interface Report { name: string; status: 'trained' | 'skipped' | 'rejected'; reason?: string }

const pc = (v: unknown) => (typeof v === 'number' ? `${Math.round(v * 100)}%` : '–');
const n2 = (v: unknown) => (typeof v === 'number' ? v.toFixed(2) : '–');

/** One plain-language line per model describing how well it did on data it wasn't trained on. */
function quality(m: ModelInfo): string {
    const x = m.metrics || {};
    switch (m.key) {
        case 'behaviour_anomaly': return `Ranks simulated emergencies above normal movement ${pc(x.injected_anomaly_auc)} of the time; alerts on ${pc(x.false_alert_rate)} of normal checks.`;
        case 'safety_risk': return `Hold-out AUC ${n2(x.holdout_auc)} (built-in prior: ${n2(x.prior_auc)}).`;
        case 'sos_genuine': return `Hold-out AUC ${n2(x.holdout_auc)} on ${x.holdout_n ?? '–'} past SOS outcomes.`;
        case 'sos_text': return `Hold-out accuracy ${pc(x.holdout_accuracy)} (keywords alone: ${pc(x.lexicon_accuracy)}).`;
        case 'zone_forecast_backtest': return x.insufficient_data ? 'Not enough history to measure yet.' : `${pc(x.skill_vs_flat)} better than a flat-rate guess on the held-out week.`;
        default: return '';
    }
}

export default function ModelStatusPanel() {
    const [status, setStatus] = useState<Status | null>(null);
    const [training, setTraining] = useState(false);
    const [reports, setReports] = useState<Report[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    const load = async () => {
        try { setStatus((await api.get('/ml/status')).data.data); } catch { setError('Could not load model status.'); }
    };
    useEffect(() => { void load(); }, []);

    const retrain = async () => {
        setTraining(true); setError(null); setReports(null);
        try {
            const res = await api.post('/ml/train', {}, { timeout: 60_000 });
            setReports(res.data.data.reports);
            await load();
        } catch {
            setError('Training did not finish. Try again in a minute.');
        } finally { setTraining(false); }
    };

    return (
        <div style={{ ...clayCard, padding: 'clamp(14px, 3vw, 24px)', marginBottom: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
                <h3 style={{ fontSize: '0.78rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.1em', color: C.text, margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}><Brain size={15} /> Machine Learning Models</h3>
                <button type="button" onClick={() => void retrain()} disabled={training}
                    style={{ background: 'linear-gradient(135deg, #6C63FF, #8B85FF)', color: '#fff', border: 'none', borderRadius: 10, padding: '8px 14px', fontFamily: 'inherit', fontWeight: 800, fontSize: '0.74rem', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, opacity: training ? 0.7 : 1 }}>
                    {training && <Loader2 size={13} className="animate-spin" />}{training ? 'Training…' : 'Retrain from data'}
                </button>
            </div>
            <p style={{ margin: '0 0 12px', fontSize: '0.76rem', color: C.textSecondary, lineHeight: 1.5 }}>
                Each model starts from a built-in prior and switches to a trained version once there is enough real data. A retrained model replaces the current one only if it passes its accuracy check. Retraining also runs automatically once a day.
            </p>
            {error && <p role="alert" style={{ color: C.critical, fontWeight: 700, fontSize: '0.8rem' }}>{error}</p>}

            {status && (
                <div style={{ display: 'grid', gap: 8 }}>
                    {status.models.map((m) => (
                        <div key={m.key} style={{ border: `1px solid ${C.border}`, borderRadius: 12, padding: '10px 12px', background: C.surfaceAlt }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                <span style={{ fontWeight: 800, fontSize: '0.84rem', color: C.text }}>{m.label}</span>
                                <span style={{ fontSize: '0.64rem', fontWeight: 800, borderRadius: 999, padding: '2px 8px', background: m.source === 'trained' ? 'rgba(18,179,166,0.15)' : 'rgba(108,99,255,0.12)', color: m.source === 'trained' ? '#0F766E' : '#4B44C9' }}>
                                    {m.source === 'trained' ? 'Trained' : 'Built-in prior'}
                                </span>
                            </div>
                            <div style={{ fontSize: '0.74rem', color: C.textSecondary, marginTop: 2 }}>{m.what}</div>
                            <div style={{ fontSize: '0.72rem', color: C.textMuted, marginTop: 4 }}>
                                {m.source === 'trained'
                                    ? <>{quality(m)} {m.samples} samples · trained {m.trained_at ? new Date(m.trained_at).toLocaleString() : ''}</>
                                    : <>Trains automatically once it has: {m.needs}.</>}
                            </div>
                        </div>
                    ))}
                    <p style={{ margin: '4px 0 0', fontSize: '0.7rem', color: C.textMuted }}>
                        Data available: {status.data.pings_45d.toLocaleString()} location pings (45 days) · {status.data.reported_or_sos_incidents_45d} SOS / reported incidents · {status.data.sos_outcomes} SOS with a recorded outcome.
                    </p>
                </div>
            )}

            {reports && (
                <div style={{ marginTop: 12, display: 'grid', gap: 4 }} aria-live="polite">
                    {reports.map((r) => (
                        <div key={r.name} style={{ fontSize: '0.74rem', color: C.text }}>
                            <b>{r.name.replace(/_/g, ' ')}:</b> {r.status}{r.reason ? ` · ${r.reason}` : ''}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
