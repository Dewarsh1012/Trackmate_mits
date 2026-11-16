import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Copy, Check, Loader2 } from 'lucide-react';
import api from '../../lib/api';
import AttestationList, { type Attestation } from '../wallet/AttestationList';
import { CLAY_COLORS as C } from '../../theme/clayTheme';

interface Dossier {
    profile: {
        id: string; full_name: string; role: string; email: string; phone: string | null; blockchain_id: string;
        id_type: string | null; id_last_four: string | null; safety_score: number; is_verified: boolean; is_active: boolean;
        preferred_language: string; created_at: string; ward: { name: string; district?: string; state?: string } | null;
        wallet_address: string | null; designation: string | null; department: string | null;
    };
    current_trip: { destination_region: string; start_date: string; end_date: string; entry_point?: string; vehicle_details?: string; is_current: boolean } | null;
    trips: { _id: string; destination_region: string; start_date: string; end_date: string; is_active: boolean }[];
    itinerary: { title: string; stops: { _id: string; destination_name: string; latitude: number; longitude: number; status: string; planned_arrival?: string; safety_notes?: string; contact_name?: string; contact_phone?: string }[] } | null;
    emergency_contacts: { _id: string; name: string; phone: string; relation?: string; is_primary?: boolean }[];
    last_location: { latitude: number; longitude: number; recorded_at: string; battery_level: number | null; source: string; zone: { name: string; risk_level: string } | null } | null;
    last_seen: string | null;
    incidents: { _id: string; title: string; incident_type: string; severity: string; status: string; created_at: string }[];
    efirs: { _id: string; title: string; status: string; created_at: string; blockchain_hash?: string; ledger_anchor_status?: string }[];
    business: { _id: string; business_name: string; category: string; address?: string; phone?: string; is_verified: boolean }[] | null;
    devices: { _id: string; device_name: string; linked_by: string; last_used: string }[];
    wallet_attestations: Attestation[];
}

const date = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const dateTime = (iso?: string | null) => (iso ? new Date(iso).toLocaleString() : '—');
const ago = (iso?: string | null) => {
    if (!iso) return 'never';
    const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (s < 90) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} d ago`;
};

const card: React.CSSProperties = { border: `1px solid ${C.border}`, borderRadius: 14, padding: '14px 16px', background: C.surface, minWidth: 0 };
const h: React.CSSProperties = { margin: '0 0 10px', fontSize: '0.7rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.09em', color: C.textMuted };

function Row({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
    return (
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '5px 0', fontSize: '0.8rem', borderBottom: `1px dashed ${C.border}` }}>
            <span style={{ color: C.textMuted, fontWeight: 600, flexShrink: 0 }}>{label}</span>
            <span style={{ fontWeight: 700, textAlign: 'right', wordBreak: 'break-word', fontFamily: mono ? "'JetBrains Mono', monospace" : undefined }}>{value}</span>
        </div>
    );
}

const empty = (text: string) => <p style={{ margin: 0, fontSize: '0.78rem', color: C.textMuted }}>{text}</p>;

/** Everything on file for one blockchain ID, for authority users. */
export default function IdDossier({ blockchainId, onLoaded }: { blockchainId: string; onLoaded?: (d: Dossier) => void }) {
    const [data, setData] = useState<Dossier | null>(null);
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(true);
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        let cancelled = false;
        setLoading(true); setError(''); setData(null);
        api.get(`/profiles/lookup/${encodeURIComponent(blockchainId)}`)
            .then((r) => { if (!cancelled) { setData(r.data.data); onLoaded?.(r.data.data); } })
            .catch((err) => { if (!cancelled) setError(err.response?.data?.message || 'Could not load this ID.'); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [blockchainId]);

    if (loading) return <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: 16, color: C.textMuted }}><Loader2 size={16} style={{ animation: 'spin-slow 1s linear infinite' }} /> Loading details…</div>;
    if (error || !data) return <p role="alert" style={{ margin: 0, padding: 12, color: '#B42318', fontWeight: 700 }}>{error || 'Not found.'}</p>;

    const p = data.profile;
    const scoreColor = p.safety_score >= 85 ? C.safe : p.safety_score >= 60 ? C.moderate : C.high;
    const copyId = async () => { try { await navigator.clipboard.writeText(p.blockchain_id); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* blocked */ } };

    return (
        <div style={{ display: 'grid', gap: 12 }}>
            {/* Header */}
            <div style={{ ...card, background: '#0B1B2B', color: '#fff', border: 'none' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: '1.2rem', fontWeight: 900 }}>{p.full_name}</div>
                        <div style={{ fontSize: '0.74rem', opacity: 0.75, textTransform: 'capitalize' }}>{p.role}{p.designation ? ` · ${p.designation}` : ''} · member since {date(p.created_at)}</div>
                    </div>
                    <span style={{ fontSize: '0.7rem', fontWeight: 800, padding: '4px 10px', borderRadius: 999, background: p.is_verified ? 'rgba(18,179,166,0.25)' : 'rgba(251,191,36,0.25)', color: p.is_verified ? '#7EE7DE' : '#FDE68A' }}>
                        {p.is_verified ? 'VERIFIED' : 'NOT VERIFIED'}
                    </span>
                    {!p.is_active && <span style={{ fontSize: '0.7rem', fontWeight: 800, padding: '4px 10px', borderRadius: 999, background: 'rgba(239,68,68,0.3)' }}>DEACTIVATED</span>}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, background: 'rgba(255,255,255,0.08)', borderRadius: 10, padding: '8px 10px' }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: '0.58rem', textTransform: 'uppercase', letterSpacing: '0.1em', opacity: 0.6, fontWeight: 700 }}>Blockchain ID</div>
                        <code style={{ fontWeight: 800, wordBreak: 'break-all' }}>{p.blockchain_id}</code>
                    </div>
                    <button type="button" aria-label="Copy blockchain ID" onClick={() => void copyId()} style={{ background: 'rgba(255,255,255,0.15)', color: '#fff', border: 'none', borderRadius: 8, padding: 8, cursor: 'pointer' }}>{copied ? <Check size={14} /> : <Copy size={14} />}</button>
                </div>
            </div>

            <div className="responsive-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(280px, 100%), 1fr))', gap: 12 }}>
                {/* Identity */}
                <div style={card}>
                    <h4 style={h}>Identity and contact</h4>
                    <Row label="Email" value={p.email} />
                    <Row label="Phone" value={p.phone || 'Not provided'} />
                    <Row label="ID document" value={p.id_type ? `${p.id_type.replace('_', ' ')} · ••••${p.id_last_four ?? ''}` : 'None on file'} />
                    <Row label="Ward" value={p.ward ? [p.ward.name, p.ward.district].filter(Boolean).join(', ') : 'Not assigned'} />
                    <Row label="Language" value={p.preferred_language?.toUpperCase()} />
                    <Row label="Registered wallet" value={p.wallet_address ? `${p.wallet_address.slice(0, 8)}…${p.wallet_address.slice(-6)}` : 'None'} mono />
                </div>

                {/* Safety & location */}
                <div style={card}>
                    <h4 style={h}>Safety and last known location</h4>
                    <Row label="Safety score" value={<span style={{ color: scoreColor }}>{p.safety_score}%</span>} />
                    <Row label="Last seen" value={ago(data.last_seen)} />
                    {data.last_location ? (
                        <>
                            <Row label="Position" value={`${data.last_location.latitude.toFixed(5)}, ${data.last_location.longitude.toFixed(5)}`} mono />
                            <Row label="Zone" value={data.last_location.zone ? `${data.last_location.zone.name} (${data.last_location.zone.risk_level})` : 'Outside mapped zones'} />
                            <Row label="Battery" value={data.last_location.battery_level !== null ? `${data.last_location.battery_level}%` : 'Not reported'} />
                            <Row label="Source" value={data.last_location.source.replace('_', ' ')} />
                            <Row label="Recorded" value={dateTime(data.last_location.recorded_at)} />
                            <a href={`https://www.openstreetmap.org/?mlat=${data.last_location.latitude}&mlon=${data.last_location.longitude}#map=16/${data.last_location.latitude}/${data.last_location.longitude}`} target="_blank" rel="noreferrer" style={{ display: 'inline-block', marginTop: 8, fontSize: '0.76rem', fontWeight: 800, color: C.primary }}>Open on map</a>
                            {' · '}
                            <Link to={`/authority/dashboard?track=${p.id}`} style={{ fontSize: '0.76rem', fontWeight: 800, color: C.primary }}>Track live</Link>
                        </>
                    ) : empty('No location has been shared yet.')}
                </div>

                {/* Trip */}
                {p.role === 'tourist' && (
                    <div style={card}>
                        <h4 style={h}>Trip</h4>
                        {data.current_trip ? (
                            <>
                                <Row label="Status" value={<span style={{ color: data.current_trip.is_current ? '#0F766E' : '#8A5A00' }}>{data.current_trip.is_current ? 'Active now' : 'Not active'}</span>} />
                                <Row label="Destination" value={data.current_trip.destination_region} />
                                <Row label="Dates" value={`${date(data.current_trip.start_date)} → ${date(data.current_trip.end_date)}`} />
                                <Row label="Entry point" value={data.current_trip.entry_point || '—'} />
                                <Row label="Vehicle" value={data.current_trip.vehicle_details || '—'} />
                                {data.trips.length > 1 && <p style={{ margin: '8px 0 0', fontSize: '0.72rem', color: C.textMuted }}>{data.trips.length} trips on record.</p>}
                            </>
                        ) : empty('No trip planned.')}
                    </div>
                )}

                {/* Emergency contacts */}
                <div style={card}>
                    <h4 style={h}>Emergency contacts</h4>
                    {data.emergency_contacts.length === 0 ? empty('None added.') : data.emergency_contacts.map((c) => (
                        <Row key={c._id} label={`${c.name}${c.relation ? ` · ${c.relation}` : ''}${c.is_primary ? ' · primary' : ''}`} value={<a href={`tel:${c.phone}`} style={{ color: C.primary }}>{c.phone}</a>} />
                    ))}
                </div>
            </div>

            {/* Itinerary */}
            {data.itinerary && (
                <div style={card}>
                    <h4 style={h}>Itinerary · {data.itinerary.title}</h4>
                    {data.itinerary.stops.length === 0 ? empty('No stops planned.') : (
                        <div style={{ display: 'grid', gap: 6 }}>
                            {data.itinerary.stops.map((s, i) => (
                                <div key={s._id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: '0.8rem' }}>
                                    <span style={{ width: 22, height: 22, borderRadius: '50%', background: `${C.primary}1a`, color: C.primary, display: 'grid', placeItems: 'center', fontWeight: 800, fontSize: '0.7rem', flexShrink: 0 }}>{i + 1}</span>
                                    <div style={{ minWidth: 0 }}>
                                        <div style={{ fontWeight: 800 }}>{s.destination_name} <span style={{ fontWeight: 600, color: C.textMuted, textTransform: 'capitalize' }}>· {s.status}</span></div>
                                        <div style={{ color: C.textMuted, fontSize: '0.72rem' }}>
                                            {s.latitude.toFixed(4)}, {s.longitude.toFixed(4)}{s.planned_arrival ? ` · ${dateTime(s.planned_arrival)}` : ''}
                                            {s.safety_notes ? ` · ${s.safety_notes}` : ''}{s.contact_name ? ` · contact ${s.contact_name} ${s.contact_phone ?? ''}` : ''}
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {/* Business */}
            {data.business && (
                <div style={card}>
                    <h4 style={h}>Business</h4>
                    {data.business.map((b) => (
                        <div key={b._id}>
                            <Row label="Name" value={b.business_name} />
                            <Row label="Category" value={b.category.replace('_', ' ')} />
                            <Row label="Address" value={b.address || '—'} />
                            <Row label="Phone" value={b.phone || '—'} />
                            <Row label="Listing" value={b.is_verified ? 'Verified' : 'Not verified'} />
                        </div>
                    ))}
                </div>
            )}

            <div className="responsive-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(280px, 100%), 1fr))', gap: 12 }}>
                {/* Incidents */}
                <div style={card}>
                    <h4 style={h}>Incidents reported ({data.incidents.length})</h4>
                    {data.incidents.length === 0 ? empty('No incidents.') : data.incidents.slice(0, 8).map((i) => (
                        <Row key={i._id} label={`${i.title}`} value={<span style={{ textTransform: 'capitalize' }}>{i.severity} · {i.status} · {ago(i.created_at)}</span>} />
                    ))}
                </div>

                {/* E-FIRs */}
                <div style={card}>
                    <h4 style={h}>E-FIRs ({data.efirs.length})</h4>
                    {data.efirs.length === 0 ? empty('No E-FIRs filed.') : data.efirs.map((f) => (
                        <Row key={f._id} label={f.title} value={<span style={{ textTransform: 'capitalize' }}>{f.status.replace('_', ' ')} · {date(f.created_at)}</span>} />
                    ))}
                </div>

                {/* Devices */}
                <div style={card}>
                    <h4 style={h}>Paired devices</h4>
                    {data.devices.length === 0 ? empty('No Bluetooth devices registered.') : data.devices.map((d) => (
                        <Row key={d._id} label={d.device_name} value={`${d.linked_by === 'self' ? 'added by user' : 'linked by authority'} · ${ago(d.last_used)}`} />
                    ))}
                </div>
            </div>

            {/* Wallet verification */}
            <div style={card}>
                <h4 style={h}>Wallet verification</h4>
                <AttestationList items={data.wallet_attestations} />
            </div>
        </div>
    );
}
