import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Bluetooth, Loader2, Megaphone, Search, X } from 'lucide-react';
import QRCode from 'qrcode';
import api from '../../lib/api';
import { useSocket } from '../../context/SocketContext';
import { iot, isBluetoothSupported, isScanSupported } from '../../lib/iotDevice';
import { CLAY_COLORS as C } from '../../theme/clayTheme';

interface Person { _id: string; full_name: string; role: string; email?: string }
interface Props {
    open: boolean;
    onClose: () => void;
    /** Live positions from the command map, used to mark who is online. */
    liveUserIds: string[];
}

interface Owner { user_id: string; full_name: string; role: string }
type HooterState = { status: 'sending' | 'sounding' | 'error'; online?: boolean; seen?: boolean; error?: string };

const btn = (kind: 'red' | 'ghost' | 'dark' = 'ghost'): React.CSSProperties => ({
    border: kind === 'ghost' ? `1px solid ${C.border}` : 'none',
    background: kind === 'red' ? '#B42318' : kind === 'dark' ? '#0B1B2B' : C.surfaceAlt,
    color: kind === 'ghost' ? C.text : '#fff',
    borderRadius: 10, padding: '9px 14px', fontFamily: 'inherit', fontWeight: 800, fontSize: '0.78rem', cursor: 'pointer',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
});

/**
 * "Hooter": sound a siren on a person's phone (via TrackMate, over the internet) and, for devices that
 * support it, ring a Bluetooth tracker/band directly from this screen.
 */
export default function HooterPanel({ open, onClose, liveUserIds }: Props) {
    const { socket } = useSocket();
    const [people, setPeople] = useState<Person[]>([]);
    const [loading, setLoading] = useState(false);
    const [search, setSearch] = useState('');
    const [message, setMessage] = useState('');
    const [states, setStates] = useState<Record<string, HooterState>>({});
    const [ringError, setRingError] = useState('');
    const device = useSyncExternalStore(iot.subscribe, iot.getSnapshot);

    // Who does the paired device belong to? Found by its name; an authority can link it once and it is remembered.
    const [owners, setOwners] = useState<Owner[]>([]);
    const [ownerId, setOwnerId] = useState('');
    const [linkPick, setLinkPick] = useState('');
    const [combined, setCombined] = useState<{ device: string; phone: string } | null>(null);
    const [combinedBusy, setCombinedBusy] = useState(false);

    // Shareable hooter link: opens the siren page on any phone, no sign-in.
    const [qr, setQr] = useState<string | null>(null);
    const [linkNote, setLinkNote] = useState('');
    const hooterUrl = `${window.location.origin}/hooter${message.trim() ? `?m=${encodeURIComponent(message.trim())}` : ''}`;
    const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
    const shareLink = async () => {
        setLinkNote('');
        try {
            await navigator.share({ title: 'Safety alert', text: message.trim() || 'Open this link: safety alert from the authorities', url: hooterUrl });
        } catch (err: any) {
            if (err?.name !== 'AbortError') setLinkNote('Sharing was blocked. Copy the link instead.');
        }
    };
    const copyLink = async () => {
        try { await navigator.clipboard.writeText(hooterUrl); setLinkNote('Link copied.'); } catch { setLinkNote('Copy was blocked by your browser.'); }
    };
    const toggleQr = async () => {
        if (qr) { setQr(null); return; }
        setQr(await QRCode.toDataURL(hooterUrl, { margin: 1, width: 220 }));
    };
    useEffect(() => { setQr(null); }, [hooterUrl]);
    const deviceName = device.status === 'connected' ? device.deviceName : null;
    useEffect(() => {
        setOwners([]); setOwnerId(''); setCombined(null);
        if (!deviceName) return;
        let cancelled = false;
        api.get('/hooter/devices/owners', { params: { name: deviceName } })
            .then((r) => { if (!cancelled) { const list: Owner[] = r.data.data || []; setOwners(list); setOwnerId(list[0]?.user_id ?? ''); } })
            .catch(() => undefined);
        return () => { cancelled = true; };
    }, [deviceName]);

    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        setLoading(true);
        Promise.all(['tourist', 'resident', 'business'].map((role) => api.get('/profiles', { params: { role, limit: 200 } }).catch(() => null)))
            .then((results) => {
                if (cancelled) return;
                setPeople(results.flatMap((r) => (r?.data?.data as Person[]) || []));
            })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [open]);

    // The person acknowledged on their phone.
    useEffect(() => {
        if (!socket || !open) return;
        const onAck = (d: { user_id: string }) => setStates((prev) => (prev[d.user_id] ? { ...prev, [d.user_id]: { ...prev[d.user_id], seen: true } } : prev));
        socket.on('hooter:ack', onAck);
        return () => { socket.off('hooter:ack', onAck); };
    }, [socket, open]);

    // Leaving the panel stops any scan in progress.
    useEffect(() => { if (!open) iot.stopScan(); }, [open]);

    const live = useMemo(() => new Set(liveUserIds), [liveUserIds]);
    const visible = useMemo(() => {
        const q = search.trim().toLowerCase();
        return people
            .filter((p) => !q || p.full_name?.toLowerCase().includes(q) || p.email?.toLowerCase().includes(q))
            .sort((a, b) => Number(live.has(b._id)) - Number(live.has(a._id)) || a.full_name.localeCompare(b.full_name));
    }, [people, search, live]);

    const sound = async (p: Person) => {
        setStates((s) => ({ ...s, [p._id]: { status: 'sending' } }));
        try {
            const res = await api.post('/hooter/start', { user_id: p._id, ...(message.trim() ? { message: message.trim() } : {}) });
            setStates((s) => ({ ...s, [p._id]: { status: 'sounding', online: res.data.data.online } }));
        } catch (err: any) {
            setStates((s) => ({ ...s, [p._id]: { status: 'error', error: err.response?.data?.message || 'Could not send' } }));
        }
    };

    const stop = async (p: Person) => {
        try { await api.post('/hooter/stop', { user_id: p._id }); } catch { /* the phone also has its own stop */ }
        setStates((s) => { const next = { ...s }; delete next[p._id]; return next; });
    };

    const linkOwner = async () => {
        if (!deviceName || !linkPick) return;
        try {
            const res = await api.post('/hooter/devices/link', { device_name: deviceName, user_id: linkPick });
            const o: Owner = res.data.data;
            setOwners((prev) => [o, ...prev.filter((x) => x.user_id !== o.user_id)]);
            setOwnerId(o.user_id);
            setLinkPick('');
        } catch { setRingError('Could not link this device to that person.'); }
    };

    /** One press: alarm on the paired device (if it supports one) AND the hooter on its owner's phone. */
    const soundBoth = async () => {
        setCombinedBusy(true); setRingError('');
        const deviceOk = device.canRing ? await iot.ring(2) : null;
        let phone = 'No owner chosen';
        if (ownerId) {
            try {
                const res = await api.post('/hooter/start', { user_id: ownerId, ...(message.trim() ? { message: message.trim() } : {}) });
                phone = res.data.data.online ? 'Hooter sent to their phone' : 'Hooter sent: their phone is offline and will sound when it reconnects';
            } catch { phone = 'Could not reach their phone'; }
        }
        setCombined({ device: deviceOk === null ? 'This device has no remote alarm' : deviceOk ? 'Alarm sounding on the device' : 'The device did not accept the alarm', phone });
        setCombinedBusy(false);
    };

    const stopBoth = async () => {
        if (device.canRing) await iot.ring(0);
        if (ownerId) { try { await api.post('/hooter/stop', { user_id: ownerId }); } catch { /* the phone also has its own stop */ } }
        setCombined(null);
    };

    if (!open) return null;
    const connected = device.status === 'connected';

    return (
        <div role="dialog" aria-modal="true" aria-label="Hooter" style={{ position: 'fixed', inset: 0, zIndex: 9000, background: 'rgba(11,27,43,0.6)', display: 'grid', placeItems: 'center', padding: 12 }} onClick={onClose}>
            <div onClick={(e) => e.stopPropagation()} style={{ background: C.surface, borderRadius: 18, width: 'min(680px, 100%)', maxHeight: '92vh', overflowY: 'auto', padding: 'clamp(14px, 3vw, 22px)', fontFamily: "'Inter', sans-serif", color: C.text }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <Megaphone size={22} color="#B42318" />
                    <h2 style={{ margin: 0, fontSize: '1.2rem', fontWeight: 900 }}>Hooter</h2>
                    <button type="button" aria-label="Close" onClick={onClose} style={{ ...btn(), marginLeft: 'auto', padding: 8 }}><X size={16} /></button>
                </div>

                {/* ── 1. A person's phone ── */}
                <section style={{ marginTop: 14 }}>
                    <h3 style={{ margin: 0, fontSize: '0.8rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.06em', color: C.textMuted }}>1 · Sound the hooter on a phone</h3>
                    <p style={{ margin: '4px 0 10px', fontSize: '0.78rem', color: C.textSecondary, lineHeight: 1.5 }}>
                        Their phone plays a siren and flashes <b>“You are in a red zone”</b> (or a general authority alert), with the distance and direction to the nearest safe zone.
                        It works for anyone with TrackMate open or running in the background.
                    </p>
                    <input aria-label="Message to show (optional)" value={message} maxLength={200} onChange={(e) => setMessage(e.target.value)} placeholder="Optional message, e.g. Evacuate towards the monastery"
                        style={{ width: '100%', boxSizing: 'border-box', padding: '10px 12px', border: `1px solid ${C.border}`, borderRadius: 10, background: C.surfaceAlt, fontFamily: 'inherit', fontSize: '0.85rem', marginBottom: 8 }} />
                    <div style={{ position: 'relative', marginBottom: 8 }}>
                        <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: C.textMuted }} />
                        <input aria-label="Search people" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name or email"
                            style={{ width: '100%', boxSizing: 'border-box', padding: '10px 12px 10px 32px', border: `1px solid ${C.border}`, borderRadius: 10, background: C.surfaceAlt, fontFamily: 'inherit', fontSize: '0.85rem' }} />
                    </div>
                    <div style={{ display: 'grid', gap: 6, maxHeight: 280, overflowY: 'auto' }}>
                        {loading && <div style={{ display: 'flex', gap: 8, alignItems: 'center', color: C.textMuted, fontSize: '0.8rem' }}><Loader2 size={14} style={{ animation: 'spin-slow 1s linear infinite' }} /> Loading people…</div>}
                        {!loading && visible.length === 0 && <p style={{ margin: 0, fontSize: '0.8rem', color: C.textMuted }}>No matching people.</p>}
                        {visible.map((p) => {
                            const st = states[p._id];
                            return (
                                <div key={p._id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', border: `1px solid ${st?.status === 'sounding' ? '#B42318' : C.border}`, borderRadius: 12, background: st?.status === 'sounding' ? '#FEF3F2' : C.surfaceAlt }}>
                                    <div style={{ minWidth: 0, flex: 1 }}>
                                        <div style={{ fontWeight: 800, fontSize: '0.86rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.full_name}</div>
                                        <div style={{ fontSize: '0.68rem', color: C.textMuted, fontWeight: 600 }}>
                                            <span style={{ textTransform: 'capitalize' }}>{p.role}</span>
                                            {live.has(p._id) && <span style={{ color: '#0F766E', fontWeight: 800 }}> · Live now</span>}
                                            {st?.status === 'sounding' && <span style={{ color: '#B42318', fontWeight: 800 }}> · Hooter sounding{st.seen ? ' · seen by user' : st.online === false ? ' · phone offline: plays when it reconnects' : ''}</span>}
                                            {st?.status === 'error' && <span style={{ color: '#B42318', fontWeight: 800 }}> · {st.error}</span>}
                                        </div>
                                    </div>
                                    {st?.status === 'sounding' ? (
                                        <button type="button" onClick={() => void stop(p)} style={btn('dark')}>Stop</button>
                                    ) : (
                                        <button type="button" disabled={st?.status === 'sending'} onClick={() => void sound(p)} style={btn('red')}>
                                            {st?.status === 'sending' ? <Loader2 size={14} style={{ animation: 'spin-slow 1s linear infinite' }} /> : <Megaphone size={14} />} Hooter
                                        </button>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </section>

                {/* ── 2. Bluetooth device ── */}
                <section style={{ marginTop: 20, paddingTop: 16, borderTop: `1px solid ${C.border}` }}>
                    <h3 style={{ margin: 0, fontSize: '0.8rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.06em', color: C.textMuted }}>2 · Ring a Bluetooth device nearby</h3>
                    <p style={{ margin: '4px 0 10px', fontSize: '0.78rem', color: C.textSecondary, lineHeight: 1.5 }}>
                        Scan for devices near <b>this computer</b>, pair with a band or tracker, and make it beep. This uses the standard “find me” alert, which most bands and
                        trackers support. A normal phone does not accept it: use section 1 for phones.
                    </p>

                    {!isBluetoothSupported() ? (
                        <p style={{ margin: 0, fontSize: '0.8rem', fontWeight: 700, color: '#B42318' }}>This browser has no Bluetooth access. Use Chrome or Edge.</p>
                    ) : (
                        <>
                            {!connected && !device.scanning && device.status !== 'connecting' && (
                                <button type="button" onClick={() => void iot.startScan()} style={btn('dark')}><Bluetooth size={15} /> Scan for devices</button>
                            )}
                            {!connected && !device.scanning && !isScanSupported() && device.status !== 'connecting' && (
                                <p style={{ margin: '8px 0 0', fontSize: '0.7rem', color: C.textMuted, lineHeight: 1.5 }}>
                                    Your browser lists devices in its own pop-up. For a live list here, enable <b>chrome://flags/#enable-experimental-web-platform-features</b> and restart Chrome.
                                </p>
                            )}
                            {device.status === 'connecting' && <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: '0.82rem', fontWeight: 700 }}><Loader2 size={15} style={{ animation: 'spin-slow 1s linear infinite' }} /> Connecting to {device.deviceName}…</div>}

                            {device.scanning && (
                                <div style={{ display: 'grid', gap: 6 }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.8rem', fontWeight: 700 }}>
                                        <Loader2 size={14} style={{ animation: 'spin-slow 1s linear infinite', color: C.primary }} /> Scanning… {device.nearby.length} found
                                        <button type="button" onClick={() => iot.stopScan()} style={{ ...btn(), marginLeft: 'auto', padding: '5px 10px' }}>Stop</button>
                                    </div>
                                    {device.nearby.map((n) => (
                                        <button key={n.id} type="button" onClick={() => void iot.connectNearby(n.id)} style={{ ...btn(), justifyContent: 'space-between', textAlign: 'left', width: '100%' }}>
                                            <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}><Bluetooth size={15} /><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.name}</span></span>
                                            <span style={{ fontSize: '0.68rem', color: C.textMuted }}>{n.rssi !== null ? `${n.rssi} dBm` : ''} · Pair</span>
                                        </button>
                                    ))}
                                    <button type="button" onClick={() => { iot.stopScan(); void iot.connect(); }} style={btn()}>Device not listed? Open the browser's full list</button>
                                </div>
                            )}

                            {connected && (
                                <div style={{ border: `1px solid ${C.border}`, borderRadius: 12, padding: 12, background: C.surfaceAlt, display: 'grid', gap: 10 }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 800, flexWrap: 'wrap' }}>
                                        <span style={{ width: 9, height: 9, borderRadius: '50%', background: C.safe }} /> {device.deviceName}
                                        <span style={{ fontSize: '0.68rem', color: C.safeDark, textTransform: 'uppercase' }}>Paired · connected</span>
                                    </div>

                                    {/* Owner */}
                                    <div style={{ fontSize: '0.78rem', display: 'grid', gap: 6 }}>
                                        <div style={{ fontWeight: 800, color: C.textMuted, textTransform: 'uppercase', fontSize: '0.66rem', letterSpacing: '0.06em' }}>Belongs to</div>
                                        {owners.length > 0 ? (
                                            <select aria-label="Device owner" value={ownerId} onChange={(e) => setOwnerId(e.target.value)} style={{ padding: '9px 10px', borderRadius: 10, border: `1px solid ${C.border}`, fontFamily: 'inherit', fontWeight: 700, background: C.surface }}>
                                                {owners.map((o) => <option key={o.user_id} value={o.user_id}>{o.full_name} ({o.role})</option>)}
                                            </select>
                                        ) : (
                                            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                                <select aria-label="Choose the owner" value={linkPick} onChange={(e) => setLinkPick(e.target.value)} style={{ flex: 1, minWidth: 160, padding: '9px 10px', borderRadius: 10, border: `1px solid ${C.border}`, fontFamily: 'inherit', fontWeight: 600, background: C.surface }}>
                                                    <option value="">Not linked yet: choose the person…</option>
                                                    {visible.map((p) => <option key={p._id} value={p._id}>{p.full_name} ({p.role})</option>)}
                                                </select>
                                                <button type="button" disabled={!linkPick} onClick={() => void linkOwner()} style={btn('dark')}>Link</button>
                                            </div>
                                        )}
                                        <div style={{ fontSize: '0.68rem', color: C.textMuted }}>
                                            {owners.length > 0 ? 'Found automatically. People link their own band when they connect it in IoT Sync.' : 'Link once and this device is recognised from then on.'}
                                        </div>
                                    </div>

                                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                        <button type="button" disabled={combinedBusy || (!device.canRing && !ownerId)} onClick={() => void soundBoth()} style={btn('red')}>
                                            {combinedBusy ? <Loader2 size={15} style={{ animation: 'spin-slow 1s linear infinite' }} /> : <Megaphone size={15} />} {combined ? 'Sounding…' : 'Sound hooter'}
                                        </button>
                                        <button type="button" onClick={() => void stopBoth()} style={btn('dark')}>Stop</button>
                                    </div>
                                    {combined && (
                                        <ul style={{ margin: 0, paddingLeft: 18, fontSize: '0.76rem', fontWeight: 700, lineHeight: 1.6, color: C.text }}>
                                            <li>{combined.device}</li>
                                            <li>{combined.phone}</li>
                                        </ul>
                                    )}
                                    {!device.canRing && (
                                        <div style={{ fontSize: '0.7rem', color: C.textSecondary, lineHeight: 1.5 }}>
                                            <b>Why only the phone sounds:</b> a Bluetooth connection from a browser can’t make an ordinary phone play a sound. This device exposes{' '}
                                            {device.services.length ? device.services.join(', ') : 'no readable services'}, with no alarm command, so the hooter goes to the owner’s phone through TrackMate
                                            (it must have TrackMate open). Bands and trackers with a “find me” alert, a serial <code>ALARM:ON</code> command or a link-loss alarm sound directly.
                                        </div>
                                    )}
                                    {device.canRing && (
                                        <p style={{ margin: 0, fontSize: '0.7rem', color: C.textMuted, lineHeight: 1.5 }}>
                                            {device.ringMethod === 'immediate' && 'Device alarm: standard “Find Me” alert.'}
                                            {device.ringMethod === 'serial' && 'Device alarm: ALARM:ON / ALARM:OFF over the serial channel.'}
                                            {device.ringMethod === 'link_loss' && 'Device alarm: link-loss. The device is disconnected to make it sound; Stop reconnects and silences it.'}
                                        </p>
                                    )}
                                    {ringError && <p role="alert" style={{ margin: 0, fontSize: '0.76rem', color: '#B42318', fontWeight: 700 }}>{ringError}</p>}
                                    <button type="button" onClick={() => { void iot.ring(0); iot.disconnect(); setCombined(null); }} style={btn()}>Disconnect</button>
                                </div>
                            )}
                            {device.status === 'error' && device.error && <p role="alert" style={{ margin: '8px 0 0', fontSize: '0.78rem', color: '#B42318', fontWeight: 700 }}>{device.error}</p>}
                        </>
                    )}
                </section>

                {/* ── 3. Shareable link ── */}
                <section style={{ marginTop: 20, paddingTop: 16, borderTop: `1px solid ${C.border}` }}>
                    <h3 style={{ margin: 0, fontSize: '0.8rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.06em', color: C.textMuted }}>3 · Send a hooter link</h3>
                    <p style={{ margin: '4px 0 10px', fontSize: '0.78rem', color: C.textSecondary, lineHeight: 1.5 }}>
                        Works on <b>any phone</b>, even without TrackMate. When the link opens, the screen flashes “Alert from authorities” (or “You are in a red zone”) with the way to the nearest safe zone,
                        and the siren starts on the first tap. Send it with the phone’s share sheet: on Android, <b>Quick Share</b> sends it over Bluetooth to a nearby phone; on a Mac or iPhone,
                        AirDrop; or use WhatsApp, SMS or the QR code. (A browser can’t push a link over Bluetooth by itself; the share sheet does it.)
                    </p>
                    <code style={{ display: 'block', fontSize: '0.7rem', wordBreak: 'break-all', background: C.surfaceAlt, border: `1px solid ${C.border}`, borderRadius: 10, padding: '8px 10px' }}>{hooterUrl}</code>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                        {canShare && <button type="button" onClick={() => void shareLink()} style={btn('red')}><Megaphone size={14} /> Share link</button>}
                        <button type="button" onClick={() => void copyLink()} style={btn('dark')}>Copy link</button>
                        <button type="button" onClick={() => void toggleQr()} style={btn()}>{qr ? 'Hide QR code' : 'Show QR code'}</button>
                        <a href={hooterUrl} target="_blank" rel="noreferrer" style={{ ...btn(), textDecoration: 'none' }}>Preview</a>
                    </div>
                    {!canShare && <p style={{ margin: '8px 0 0', fontSize: '0.7rem', color: C.textMuted }}>This browser has no share sheet. Copy the link or use the QR code. Chrome on Android and Safari on Mac/iPhone have one.</p>}
                    {linkNote && <p role="status" style={{ margin: '8px 0 0', fontSize: '0.76rem', fontWeight: 700 }}>{linkNote}</p>}
                    {qr && <img src={qr} alt="QR code that opens the hooter page" width={200} height={200} style={{ marginTop: 10, borderRadius: 10, background: '#fff', border: `1px solid ${C.border}` }} />}
                </section>
            </div>
        </div>
    );
}
