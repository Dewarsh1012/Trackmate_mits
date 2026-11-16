import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { Search, X, BadgeCheck } from 'lucide-react';
import api from '../../lib/api';
import IdDossier from './IdDossier';
import { CLAY_COLORS as C } from '../../theme/clayTheme';

interface Person { _id: string; full_name: string; role: string; blockchain_id?: string; email?: string }

const ID_PATTERN = /^[A-Z]{2}[0-9A-F]{16}$/;

/**
 * Header search for the authority dashboard. Type or paste a blockchain ID (or a name/email) and press Enter:
 * a window opens with everything on file for that person.
 */
export default function IdLookup() {
    const [text, setText] = useState('');
    const [open, setOpen] = useState(false);
    const [selected, setSelected] = useState<string | null>(null);
    const [results, setResults] = useState<Person[]>([]);
    const [searching, setSearching] = useState(false);
    const [message, setMessage] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);

    const run = async (value: string) => {
        const q = value.trim();
        if (q.length < 2) return;
        setOpen(true); setMessage(''); setResults([]); setSelected(null);
        const upper = q.toUpperCase();
        if (ID_PATTERN.test(upper)) { setSelected(upper); return; }

        setSearching(true);
        const lists = await Promise.all(['tourist', 'resident', 'business'].map((role) => api.get('/profiles', { params: { role, search: q, limit: 8 } }).catch(() => null)));
        const people = lists.flatMap((r) => (r?.data?.data as Person[]) || []).filter((p) => p.blockchain_id);
        setSearching(false);
        if (people.length === 1) setSelected(people[0].blockchain_id!);
        else if (people.length === 0) setMessage('No person or blockchain ID matches that search.');
        else setResults(people.slice(0, 15));
    };

    const submit = (e: FormEvent) => { e.preventDefault(); void run(text); };

    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open]);

    return (
        <>
            <form onSubmit={submit} role="search" style={{ position: 'relative', display: 'flex' }}>
                <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: C.textMuted, pointerEvents: 'none' }} />
                <input
                    ref={inputRef}
                    aria-label="Search by blockchain ID, name or email"
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder="Search blockchain ID…"
                    style={{ width: 'clamp(150px, 20vw, 230px)', padding: '9px 12px 9px 30px', borderRadius: 12, border: `1px solid ${C.border}`, background: C.surfaceAlt, fontFamily: 'inherit', fontSize: '0.8rem', fontWeight: 600, color: C.text }}
                />
            </form>

            {open && createPortal(
                <div role="dialog" aria-modal="true" aria-label="Identity details" onClick={() => setOpen(false)}
                    style={{ position: 'fixed', inset: 0, zIndex: 100050, background: 'rgba(11,27,43,0.6)', display: 'grid', placeItems: 'center', padding: 12 }}>
                    <div onClick={(e) => e.stopPropagation()} style={{ background: C.bg, borderRadius: 18, width: 'min(860px, 100%)', maxHeight: '94vh', overflowY: 'auto', padding: 'clamp(12px, 3vw, 20px)' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
                            <h2 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 900, color: C.text }}>Identity details</h2>
                            {selected && <Link to={`/authority/wallet?id=${selected}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', fontWeight: 800, color: '#B45309', textDecoration: 'none', background: 'rgba(246,133,27,0.12)', padding: '6px 12px', borderRadius: 999 }}><BadgeCheck size={14} /> Verify with wallet</Link>}
                            <button type="button" aria-label="Close" onClick={() => setOpen(false)} style={{ marginLeft: 'auto', background: C.surfaceAlt, border: `1px solid ${C.border}`, borderRadius: 10, padding: 8, cursor: 'pointer' }}><X size={16} /></button>
                        </div>

                        {searching && <p style={{ margin: 0, color: C.textMuted, fontWeight: 600 }}>Searching…</p>}
                        {message && <p role="status" style={{ margin: 0, color: '#B42318', fontWeight: 700 }}>{message}</p>}

                        {results.length > 0 && !selected && (
                            <div style={{ display: 'grid', gap: 6 }}>
                                <p style={{ margin: '0 0 4px', fontSize: '0.8rem', color: C.textSecondary }}>{results.length} matches. Choose one:</p>
                                {results.map((p) => (
                                    <button key={p._id} type="button" onClick={() => setSelected(p.blockchain_id!)}
                                        style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', padding: '10px 14px', background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}>
                                        <span style={{ minWidth: 0 }}>
                                            <span style={{ display: 'block', fontWeight: 800, color: C.text }}>{p.full_name}</span>
                                            <code style={{ fontSize: '0.7rem', color: C.textMuted }}>{p.blockchain_id}</code>
                                        </span>
                                        <span style={{ fontSize: '0.7rem', color: C.textMuted, textTransform: 'capitalize' }}>{p.role}</span>
                                    </button>
                                ))}
                            </div>
                        )}

                        {selected && <IdDossier blockchainId={selected} />}
                    </div>
                </div>,
                document.body
            )}
        </>
    );
}
