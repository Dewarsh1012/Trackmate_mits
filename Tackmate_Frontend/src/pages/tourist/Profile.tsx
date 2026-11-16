import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import QRCode from 'qrcode';
import { useAuth } from '../../context/AuthContext';
import { useSocket } from '../../context/SocketContext';
import { useLanguage, LANGUAGES } from '../../i18n';
import api from '../../lib/api';
import AttestationList, { type Attestation } from '../../components/wallet/AttestationList';
import { CheckCircle, Phone, Languages, Copy, QrCode, Check, Plus, Trash2 } from 'lucide-react';
import { CLAY_COLORS as C, CLAY_CARD_STYLE as clayCard, CLAY_CARD_INNER_STYLE as clayCardInner } from '../../theme/clayTheme';

interface Contact { _id: string; name: string; phone: string; relation?: string; is_primary?: boolean }
interface Trip { _id: string }
interface Incident { _id: string; title: string; status: string; severity: string; created_at: string; zone?: { name?: string } | null }
interface ProfileData { full_name: string; blockchain_id?: string; safety_score?: number; created_at?: string; is_verified?: boolean; phone?: string; id_type?: string; id_last_four?: string }

const inputStyle = { width: '100%', boxSizing: 'border-box' as const, borderRadius: 12, border: `1px solid ${C.border}`, padding: '8px 10px', background: C.surfaceAlt, color: C.text, fontFamily: 'inherit', fontWeight: 600, fontSize: '0.78rem' };
const smallBtn = { border: `1px solid ${C.border}`, background: C.surfaceAlt, fontWeight: 800, cursor: 'pointer', color: C.text, fontFamily: 'inherit' };

const severityColor = (sev: string) => (sev === 'critical' || sev === 'high' ? C.high : sev === 'medium' ? C.orange : C.safe);

export default function TouristProfile() {
    const { user, updateUser } = useAuth();
    const { socket } = useSocket();
    const { language, setLanguage } = useLanguage();
    const [profile, setProfile] = useState<ProfileData | null>(null);
    const [contacts, setContacts] = useState<Contact[]>([]);
    const [trips, setTrips] = useState<Trip[]>([]);
    const [activity, setActivity] = useState<Incident[]>([]);
    const [copied, setCopied] = useState(false);
    const [attestations, setAttestations] = useState<Attestation[]>([]);
    const [qr, setQr] = useState<string | null>(null);
    const [adding, setAdding] = useState(false);
    const [form, setForm] = useState({ name: '', phone: '', relation: '' });
    const [error, setError] = useState('');

    const load = useCallback(async () => {
        const [me, ec, tr, inc] = await Promise.allSettled([
            api.get('/profiles/me'), api.get('/emergency-contacts'), api.get('/trips'), api.get('/incidents', { params: { limit: 5 } }),
        ]);
        if (me.status === 'fulfilled') setProfile(me.value.data.data);
        if (ec.status === 'fulfilled') setContacts(ec.value.data.data || []);
        if (tr.status === 'fulfilled') setTrips(tr.value.data.data || []);
        if (inc.status === 'fulfilled') setActivity(inc.value.data.data || []);
    }, []);

    useEffect(() => { void load(); }, [load]);

    // Live: refresh the activity feed when this user's incidents change.
    useEffect(() => {
        if (!socket) return;
        const refresh = () => { void load(); };
        socket.on('incident-updated', refresh);
        socket.on('crisis:timeline', refresh);
        return () => { socket.off('incident-updated', refresh); socket.off('crisis:timeline', refresh); };
    }, [socket, load]);

    // Who has verified this ID with a wallet (public record, re-checked by the server each time).
    const attestId = profile?.blockchain_id || user?.blockchain_id;
    useEffect(() => {
        if (!attestId) return;
        api.get(`/verify/${attestId}`).then((r) => setAttestations(r.data.data?.wallet_attestations || [])).catch(() => undefined);
    }, [attestId, user?.is_verified]);

    const name = profile?.full_name || user?.full_name || 'TrackMate User';
    const initials = name.split(' ').map((n: string) => n[0]).join('').slice(0, 2).toUpperCase() || 'TM';
    const safetyScore = user?.safety_score ?? profile?.safety_score ?? 0;
    const blockchainId = profile?.blockchain_id || user?.blockchain_id;
    const verifyUrl = blockchainId ? `${window.location.origin}/verify/${blockchainId}` : '';
    const memberSince = profile?.created_at ? new Date(profile.created_at).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }) : '—';
    const reportsFiled = activity.length;

    const copyId = async () => {
        if (!blockchainId) return;
        try { await navigator.clipboard.writeText(blockchainId); setCopied(true); setTimeout(() => setCopied(false), 2000); }
        catch { setError('Copy is blocked by your browser.'); }
    };

    const toggleQr = async () => {
        if (qr) { setQr(null); return; }
        if (!verifyUrl) return;
        setQr(await QRCode.toDataURL(verifyUrl, { margin: 1, width: 220 }));
    };

    const addContact = async (e: FormEvent) => {
        e.preventDefault();
        setError('');
        try {
            const res = await api.post('/emergency-contacts', {
                name: form.name.trim(), phone: form.phone.trim(),
                relation: form.relation.trim() || undefined, is_primary: contacts.length === 0,
            });
            setContacts((c) => [...c, res.data.data]);
            setForm({ name: '', phone: '', relation: '' });
            setAdding(false);
        } catch (err: any) {
            setError(err.response?.data?.errors?.[0]?.message || err.response?.data?.message || 'Could not add contact.');
        }
    };

    const removeContact = async (id: string) => {
        try { await api.delete(`/emergency-contacts/${id}`); setContacts((c) => c.filter((x) => x._id !== id)); }
        catch { setError('Could not remove contact.'); }
    };

    const changeLanguage = async (code: string) => {
        setLanguage(code as any);
        try { await api.patch('/profiles/me', { preferred_language: code }); updateUser({ preferred_language: code }); }
        catch { setError('Language changed here, but could not be saved to your profile.'); }
    };

    return (
        <div style={{ maxWidth: 1360, margin: '0 auto', padding: 24, fontFamily: "'Inter', sans-serif", color: C.text }}>
            <div style={{ ...clayCard, padding: '20px 24px', marginBottom: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
                <div>
                    <h1 style={{ margin: 0, fontSize: '1.6rem', fontWeight: 800, letterSpacing: '-0.02em' }}>Traveler Identity</h1>
                    <p style={{ margin: '4px 0 0', fontSize: '0.86rem', color: C.textMuted, fontWeight: 600 }}>Manage verified profile, blockchain identity, and safety posture.</p>
                </div>
                <div style={{ background: `${C.safe}1f`, border: `1px solid ${C.safe}55`, borderRadius: 12, padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 8 }}>
                    <CheckCircle size={16} color={C.safe} />
                    <span style={{ fontSize: '0.78rem', fontWeight: 800, color: C.safeDark, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{profile?.is_verified ? 'Verified Profile' : 'Profile'}</span>
                </div>
            </div>

            {error && <p role="alert" style={{ margin: '0 0 12px', color: C.critical, fontWeight: 700, fontSize: '0.82rem' }}>{error}</p>}

            <div className="responsive-grid" style={{ display: 'grid', gridTemplateColumns: '320px minmax(0, 1fr)', gap: 20, alignItems: 'start' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                    <div style={{ ...clayCard, padding: 22 }}>
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
                            <div style={{ width: 96, height: 96, borderRadius: '50%', background: 'linear-gradient(135deg, #6C63FF, #8B85FF)', color: '#FFFFFF', fontSize: '2.1rem', fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 10px 24px rgba(108,99,255,0.28)' }}>
                                {initials}
                            </div>
                            <h2 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 800, textAlign: 'center' }}>{name}</h2>
                            <span style={{ background: C.surfaceAlt, border: `1px solid ${C.border}`, padding: '4px 10px', borderRadius: 999, textTransform: 'uppercase', fontSize: '0.65rem', fontWeight: 800, color: C.primary, letterSpacing: '0.08em' }}>{user?.role || 'tourist'}</span>
                        </div>

                        <div style={{ marginTop: 16, display: 'grid', gap: 8 }}>
                            {[
                                ['Member Since', memberSince],
                                ['Trips', String(trips.length)],
                                ['ID on file', profile?.id_last_four ? `${(profile.id_type || 'ID').toUpperCase()} ••••${profile.id_last_four}` : 'None'],
                            ].map(([label, value]) => (
                                <div key={label} style={{ ...clayCardInner, padding: '10px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                    <span style={{ fontSize: '0.7rem', color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700 }}>{label}</span>
                                    <span style={{ fontSize: '0.84rem', fontWeight: 700, color: C.text }}>{value}</span>
                                </div>
                            ))}
                        </div>
                    </div>

                    <div style={{ ...clayCard, padding: 22 }}>
                        <h3 style={{ margin: '0 0 14px', fontSize: '0.95rem', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 800, color: C.text }}>Safety Standing</h3>
                        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 14 }}>
                            <div style={{ position: 'relative', width: 120, height: 120 }}>
                                <svg width="120" height="120" style={{ transform: 'rotate(-90deg)' }}>
                                    <circle cx="60" cy="60" r="48" fill="none" stroke={C.surfaceAlt} strokeWidth="10" />
                                    <circle cx="60" cy="60" r="48" fill="none" stroke={safetyScore >= 85 ? C.safe : safetyScore >= 70 ? C.moderate : C.high} strokeWidth="10" strokeDasharray="301.6" strokeDashoffset={301.6 - (301.6 * safetyScore / 100)} strokeLinecap="round" style={{ transition: 'stroke-dashoffset 0.6s ease' }} />
                                </svg>
                                <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
                                    <span style={{ fontSize: '1.5rem', fontWeight: 800, lineHeight: 1 }}>{safetyScore}%</span>
                                    <span style={{ fontSize: '0.62rem', fontWeight: 700, color: C.textMuted, textTransform: 'uppercase' }}>Score</span>
                                </div>
                            </div>
                        </div>
                        <div style={{ display: 'grid', gap: 8 }}>
                            {[
                                ['Verified Identity', profile?.is_verified ? 'Yes' : 'Pending', C.safe],
                                ['Reports Filed', String(reportsFiled), C.primary],
                                ['Emergency Contacts', String(contacts.length), C.orange],
                            ].map(([label, value, color]) => (
                                <div key={label} style={{ ...clayCardInner, padding: '8px 10px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                    <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.78rem', fontWeight: 600 }}>
                                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: color as string }} />
                                        {label}
                                    </span>
                                    <span style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 800, fontSize: '0.8rem' }}>{value}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                    <div style={{ ...clayCard, padding: 22 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 14 }}>
                            <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 800 }}>Blockchain Digital ID</h3>
                            <div style={{ display: 'flex', gap: 8 }}>
                                <button type="button" onClick={copyId} disabled={!blockchainId} style={{ background: C.surfaceAlt, border: `1px solid ${C.border}`, borderRadius: 10, padding: '7px 10px', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontWeight: 700, fontSize: '0.75rem', color: C.text }}>
                                    {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy'}
                                </button>
                                <button type="button" onClick={toggleQr} disabled={!verifyUrl} style={{ background: 'linear-gradient(135deg, #6C63FF, #8B85FF)', border: 'none', borderRadius: 10, padding: '7px 10px', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontWeight: 700, fontSize: '0.75rem', color: '#FFFFFF', boxShadow: '0 6px 14px rgba(108,99,255,0.25)' }}>
                                    <QrCode size={14} /> {qr ? 'Hide QR' : 'Show QR'}
                                </button>
                            </div>
                        </div>

                        <div style={{ borderRadius: 16, overflow: 'hidden', background: 'linear-gradient(135deg, #1B1D2A, #252840)', padding: 18, color: '#FFFFFF' }}>
                            <p style={{ margin: '0 0 4px', fontSize: '0.65rem', textTransform: 'uppercase', letterSpacing: '0.12em', color: 'rgba(255,255,255,0.6)', fontWeight: 700 }}>TrackMate Ledger Identity</p>
                            <h4 style={{ margin: '0 0 14px', fontSize: '1.2rem', fontWeight: 800, color: '#FFFFFF' }}>{name}</h4>
                            <div style={{ ...clayCardInner, padding: '10px 12px', background: 'rgba(255,255,255,0.09)', border: '1px solid rgba(255,255,255,0.2)', boxShadow: 'none' }}>
                                <p style={{ margin: '0 0 4px', fontSize: '0.62rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'rgba(255,255,255,0.7)', fontWeight: 700 }}>Blockchain Hash</p>
                                <code style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '0.8rem', fontWeight: 700, wordBreak: 'break-all', color: '#FFFFFF' }}>{blockchainId || 'Not issued yet'}</code>
                            </div>
                            <div style={{ marginTop: 14 }}>
                                <div style={{ fontSize: '0.62rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'rgba(255,255,255,0.7)', fontWeight: 700, marginBottom: 6 }}>Wallet verification</div>
                                <div style={{ color: C.text }}><AttestationList items={attestations} compact /></div>
                            </div>
                            {qr && (
                                <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                                    <img src={qr} alt="QR code for your public verification page" width={130} height={130} style={{ borderRadius: 8, background: '#fff' }} />
                                    <a href={verifyUrl} target="_blank" rel="noreferrer" style={{ color: '#C9C5FF', fontSize: '0.75rem', fontWeight: 700, wordBreak: 'break-all' }}>{verifyUrl}</a>
                                </div>
                            )}
                        </div>
                    </div>

                    <div className="responsive-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(260px, 100%), 1fr))', gap: 20 }}>
                        <div style={{ ...clayCard, padding: 18 }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                                <h3 style={{ margin: 0, fontSize: '0.92rem', fontWeight: 800 }}>Emergency Contacts</h3>
                                <button type="button" aria-label="Add emergency contact" onClick={() => setAdding((a) => !a)} style={{ ...smallBtn, width: 24, height: 24, borderRadius: 8 }}>{adding ? '×' : '+'}</button>
                            </div>
                            {adding && (
                                <form onSubmit={addContact} style={{ display: 'grid', gap: 6, marginBottom: 10 }}>
                                    <input aria-label="Contact name" required minLength={2} placeholder="Name" style={inputStyle} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                                    <input aria-label="Contact phone" required minLength={7} maxLength={20} inputMode="tel" placeholder="Phone" style={inputStyle} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
                                    <input aria-label="Relation" placeholder="Relation (optional)" style={inputStyle} value={form.relation} onChange={(e) => setForm({ ...form, relation: e.target.value })} />
                                    <button type="submit" style={{ ...smallBtn, borderRadius: 10, padding: '8px 10px', display: 'inline-flex', alignItems: 'center', gap: 6, justifyContent: 'center' }}><Plus size={14} /> Save contact</button>
                                </form>
                            )}
                            <div style={{ display: 'grid', gap: 8 }}>
                                {contacts.length === 0 && <p style={{ margin: 0, fontSize: '0.78rem', color: C.textMuted }}>No emergency contacts yet.</p>}
                                {contacts.map((c) => (
                                    <div key={c._id} style={{ ...clayCardInner, padding: '10px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                                        <span style={{ fontSize: '0.78rem', fontWeight: 700, color: C.text, minWidth: 0 }}>
                                            {c.name}{c.relation ? ` · ${c.relation}` : ''}{c.is_primary ? ' · Primary' : ''}
                                            <span style={{ display: 'block', fontSize: '0.68rem', color: C.textMuted, fontWeight: 600 }}>{c.phone}</span>
                                        </span>
                                        <span style={{ display: 'flex', gap: 6 }}>
                                            <a href={`tel:${c.phone}`} aria-label={`Call ${c.name}`} style={{ width: 28, height: 28, borderRadius: 8, background: `${C.primary}20`, color: C.primary, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                                <Phone size={14} />
                                            </a>
                                            <button type="button" aria-label={`Remove ${c.name}`} onClick={() => removeContact(c._id)} style={{ width: 28, height: 28, borderRadius: 8, border: 'none', background: `${C.high}20`, color: C.critical, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
                                                <Trash2 size={14} />
                                            </button>
                                        </span>
                                    </div>
                                ))}
                            </div>
                        </div>

                        <div style={{ ...clayCard, padding: 18 }}>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                                <h3 style={{ margin: 0, fontSize: '0.92rem', fontWeight: 800 }}>Language Preferences</h3>
                                <Languages size={16} color={C.primary} />
                            </div>
                            <label htmlFor="pf-lang" style={{ display: 'block', marginBottom: 6, fontSize: '0.65rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: C.textMuted, fontWeight: 700 }}>Primary Language</label>
                            <select id="pf-lang" value={language} onChange={(e) => changeLanguage(e.target.value)} style={{ width: '100%', borderRadius: 12, border: `1px solid ${C.border}`, padding: '10px 12px', background: C.surfaceAlt, color: C.text, fontFamily: 'inherit', fontWeight: 700, marginBottom: 12 }}>
                                {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.name} ({l.nativeName})</option>)}
                            </select>
                        </div>
                    </div>

                    <div style={{ ...clayCard, padding: 18 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                            <h3 style={{ margin: 0, fontSize: '0.92rem', fontWeight: 800 }}>Recent Security Activity</h3>
                            <Link to="/tourist/dashboard" style={{ color: C.primary, fontSize: '0.72rem', fontWeight: 700, textDecoration: 'none' }}>View All</Link>
                        </div>
                        <div style={{ display: 'grid', gap: 8 }}>
                            {activity.length === 0 && <p style={{ margin: 0, fontSize: '0.78rem', color: C.textMuted }}>No activity yet.</p>}
                            {activity.map((a) => (
                                <div key={a._id} style={{ ...clayCardInner, padding: '10px 12px', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                                    <span style={{ width: 10, height: 10, borderRadius: '50%', marginTop: 5, flexShrink: 0, background: severityColor(a.severity) }} />
                                    <div>
                                        <p style={{ margin: 0, fontWeight: 700, fontSize: '0.82rem', color: C.text }}>{a.title}</p>
                                        <p style={{ margin: '2px 0 0', fontSize: '0.7rem', color: C.textMuted, fontFamily: "'JetBrains Mono', monospace" }}>
                                            {a.zone?.name ? `${a.zone.name} · ` : ''}{new Date(a.created_at).toLocaleString()} · {a.status}
                                        </p>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
