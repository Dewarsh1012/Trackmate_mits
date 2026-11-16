import { Check, HelpCircle } from 'lucide-react';

export interface Triage {
    priority: 'P1' | 'P2' | 'P3' | 'P4';
    p_genuine: number;
    category: string;
    action: string;
    reasons: Array<{ label: string; effect: 'supports' | 'doubts' }>;
    source?: 'prior' | 'trained';
}

const PRIORITY: Record<Triage['priority'], { bg: string; label: string }> = {
    P1: { bg: '#B42318', label: 'P1 · Immediate' },
    P2: { bg: '#C2410C', label: 'P2 · Urgent' },
    P3: { bg: '#A15C07', label: 'P3 · Confirm first' },
    P4: { bg: '#475467', label: 'P4 · Likely false alarm' },
};

/** The model's SOS triage: a suggestion with its reasons. The officer always decides. */
export default function TriageBadge({ triage, compact = false, onDark = false }: { triage: Triage; compact?: boolean; onDark?: boolean }) {
    const p = PRIORITY[triage.priority] ?? PRIORITY.P2;
    const pct = Math.round(triage.p_genuine * 100);
    const category = triage.category && triage.category !== 'unspecified' ? triage.category : null;
    const ink = onDark ? '#FFFFFF' : '#0B1B2B';
    const muted = onDark ? 'rgba(255,255,255,0.82)' : '#51606F';

    const pill = (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ background: p.bg, color: '#fff', borderRadius: 999, padding: '3px 10px', fontSize: '0.7rem', fontWeight: 800, letterSpacing: '0.02em', border: onDark ? '1px solid rgba(255,255,255,0.6)' : 'none' }}>{p.label}</span>
            <span style={{ fontSize: '0.74rem', fontWeight: 700, color: ink }}>{pct}% likely genuine{category ? ` · ${category}` : ''}</span>
        </span>
    );
    if (compact) return pill;

    return (
        <div style={{ textAlign: 'left', marginTop: 10, padding: '10px 12px', borderRadius: 12, background: onDark ? 'rgba(255,255,255,0.14)' : '#F4F6F8', border: onDark ? '1px solid rgba(255,255,255,0.25)' : '1px solid #E3E8EE' }}>
            <div style={{ fontSize: '0.64rem', fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: muted, marginBottom: 6 }}>AI triage (suggestion)</div>
            {pill}
            <p style={{ margin: '6px 0 4px', fontSize: '0.8rem', fontWeight: 700, color: ink }}>{triage.action}</p>
            {triage.reasons.length > 0 && (
                <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 2 }}>
                    {triage.reasons.slice(0, 4).map((r) => (
                        <li key={r.label} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.74rem', color: muted }}>
                            {r.effect === 'supports' ? <Check size={12} aria-label="supports" /> : <HelpCircle size={12} aria-label="raises doubt" />}
                            {r.label}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
