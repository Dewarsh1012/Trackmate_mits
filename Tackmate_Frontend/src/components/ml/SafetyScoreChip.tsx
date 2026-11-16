import { useEffect, useRef, useState } from 'react';
import api from '../../lib/api';

interface Factor { label: string; effect: 'raises' | 'lowers' }

/** The existing safety-score chip; tapping it explains what is affecting the score right now. */
export default function SafetyScoreChip({ label, score }: { label: string; score: number }) {
    const [open, setOpen] = useState(false);
    const [factors, setFactors] = useState<Factor[] | null>(null);
    const [loading, setLoading] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        setLoading(true);
        api.get('/ml/me/risk')
            .then((res) => setFactors(res.data.data?.factors ?? []))
            .catch(() => setFactors([]))
            .finally(() => setLoading(false));
        const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
        const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
        document.addEventListener('mousedown', close);
        document.addEventListener('keydown', esc);
        return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
    }, [open, score]);

    return (
        <div ref={ref} style={{ position: 'relative' }}>
            <button type="button" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((o) => !o)}
                style={{ background: 'linear-gradient(135deg, #6C63FF, #8B85FF)', borderRadius: 12, padding: '8px 16px', fontWeight: 700, fontSize: '0.78rem', color: '#FFFFFF', boxShadow: '0 4px 12px rgba(108,99,255,0.3)', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
                {label}: {score}%
            </button>
            {open && (
                <div role="dialog" aria-label="What affects your safety score"
                    style={{ position: 'absolute', right: 0, top: 'calc(100% + 8px)', zIndex: 1200, width: 'min(280px, 86vw)', background: '#FFFFFF', color: '#1B1D2A', borderRadius: 14, padding: 14, boxShadow: '0 12px 30px rgba(0,0,0,0.2)', fontSize: '0.8rem' }}>
                    <div style={{ fontWeight: 800, marginBottom: 6 }}>What affects your score now</div>
                    {loading && <div style={{ color: '#6B7280' }}>Checking…</div>}
                    {!loading && factors && factors.length === 0 && <div style={{ color: '#6B7280' }}>Share your location to get a live assessment.</div>}
                    {!loading && factors && factors.length > 0 && (
                        <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 4 }}>
                            {factors.map((f) => (
                                <li key={f.label} style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                                    <span aria-hidden style={{ fontWeight: 900, color: f.effect === 'raises' ? '#C2410C' : '#0F766E' }}>{f.effect === 'raises' ? '!' : '✓'}</span>
                                    <span>{f.label}</span>
                                </li>
                            ))}
                        </ul>
                    )}
                    <div style={{ marginTop: 8, fontSize: '0.7rem', color: '#6B7280' }}>Updated every few minutes from your location, the area and recent reports.</div>
                </div>
            )}
        </div>
    );
}
