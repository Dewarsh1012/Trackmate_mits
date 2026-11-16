import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { useSocket } from '../../context/SocketContext';
import api from '../../lib/api';
import { ensureAudio, installAudioUnlock, startSiren } from '../../lib/audio';
import { compassPoint, findZone, nearestSafeZone, type FenceZone } from '../../lib/geofence';

export interface Hooter { hooter_id: string; message: string | null; issued_by: string }

const formatDistance = (m: number) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);

/**
 * The hooter screen itself: flashing warning, siren, and live distance + direction to the nearest safe zone.
 * Used both for hooters pushed to a signed-in phone and for the public link an authority can share.
 * With `requireTap`, the siren starts on the first touch (browsers don't allow sound before a tap).
 */
export function HooterScreen({ hooter, onAcknowledge, requireTap = false }: { hooter: Hooter; onAcknowledge: () => void; requireTap?: boolean }) {
    const [muted, setMuted] = useState(false);
    const [armed, setArmed] = useState(!requireTap);
    const [pos, setPos] = useState<{ lat: number; lng: number } | null>(null);
    const [heading, setHeading] = useState<number | null>(null);
    const [zones, setZones] = useState<FenceZone[]>([]);
    const [gpsDenied, setGpsDenied] = useState(false);

    useEffect(() => {
        if (armed) return;
        const arm = () => { ensureAudio(); setArmed(true); };
        window.addEventListener('pointerdown', arm, { once: true });
        window.addEventListener('keydown', arm, { once: true });
        return () => { window.removeEventListener('pointerdown', arm); window.removeEventListener('keydown', arm); };
    }, [armed]);

    useEffect(() => {
        let cancelled = false;
        api.get('/zones').then((r) => { if (!cancelled) setZones(r.data.data || []); }).catch(() => undefined);

        let watchId: number | null = null;
        if ('geolocation' in navigator) {
            watchId = navigator.geolocation.watchPosition(
                (p) => { setGpsDenied(false); setPos({ lat: p.coords.latitude, lng: p.coords.longitude }); },
                () => setGpsDenied(true),
                { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
            );
        }
        const onOrientation = (e: Event) => {
            const ev = e as DeviceOrientationEvent & { webkitCompassHeading?: number };
            if (typeof ev.webkitCompassHeading === 'number') setHeading(ev.webkitCompassHeading);
            else if (ev.absolute && typeof ev.alpha === 'number') setHeading((360 - ev.alpha) % 360);
        };
        window.addEventListener('deviceorientationabsolute', onOrientation as EventListener);
        window.addEventListener('deviceorientation', onOrientation as EventListener);
        const buzz = window.setInterval(() => { if ('vibrate' in navigator) navigator.vibrate?.([400, 200, 400]); }, 1500);

        return () => {
            cancelled = true;
            if (watchId !== null) navigator.geolocation.clearWatch(watchId);
            window.removeEventListener('deviceorientationabsolute', onOrientation as EventListener);
            window.removeEventListener('deviceorientation', onOrientation as EventListener);
            window.clearInterval(buzz);
            if ('vibrate' in navigator) navigator.vibrate?.(0);
        };
    }, []);

    // Siren runs while armed and not silenced.
    useEffect(() => {
        if (!armed || muted) return;
        const stop = startSiren();
        return () => stop();
    }, [armed, muted]);

    const zone = useMemo(() => (pos ? findZone(zones, pos.lat, pos.lng) : null), [pos, zones]);
    const guidance = useMemo(() => (pos ? nearestSafeZone(zones, pos.lat, pos.lng) : null), [pos, zones]);
    const inRed = zone ? zone.risk_level === 'high' || zone.risk_level === 'restricted' : false;
    const arrowRotation = guidance ? (guidance.bearing - (heading ?? 0) + 360) % 360 : 0;
    const title = inRed ? 'YOU ARE IN A RED ZONE' : 'ALERT FROM AUTHORITIES';

    return (
        <div role="alertdialog" aria-live="assertive" aria-label={title} style={{ position: 'fixed', inset: 0, zIndex: 100001, display: 'grid', placeItems: 'center', padding: 14, overflowY: 'auto' }}>
            <style>{`
                @keyframes hooter-flash { 0%, 100% { background: rgba(200, 20, 20, 0.97); } 50% { background: rgba(255, 255, 255, 0.97); } }
                @keyframes hooter-text { 0%, 100% { color: #fff; } 50% { color: #B42318; } }
            `}</style>
            <div aria-hidden style={{ position: 'fixed', inset: 0, animation: 'hooter-flash 1s steps(1, end) infinite' }} />
            <div style={{ position: 'relative', width: 'min(560px, 100%)', textAlign: 'center', fontFamily: "'Inter', sans-serif" }}>
                <h1 style={{ margin: 0, fontSize: 'clamp(1.8rem, 8vw, 3rem)', fontWeight: 900, letterSpacing: '0.02em', animation: 'hooter-text 1s steps(1, end) infinite' }}>{title}</h1>
                {!armed && <p style={{ margin: '12px 0 0', fontSize: '1.15rem', fontWeight: 900, color: '#0B1B2B', background: '#fff', borderRadius: 10, padding: '10px 14px' }}>TAP ANYWHERE TO SOUND THE SIREN</p>}
                <p style={{ margin: '8px 0 0', fontSize: '1.05rem', fontWeight: 800, color: '#0B1B2B' }}>
                    {zone ? `${zone.name} · ${zone.risk_level} zone` : pos ? 'Outside the mapped zones' : 'Finding your location…'}
                </p>
                {hooter.message && <p style={{ margin: '10px 0 0', fontSize: '1rem', fontWeight: 700, color: '#0B1B2B' }}>“{hooter.message}” — {hooter.issued_by}</p>}

                <div style={{ marginTop: 18, background: '#fff', color: '#0B1B2B', borderRadius: 18, padding: '18px 16px', boxShadow: '0 12px 40px rgba(0,0,0,0.35)' }}>
                    {gpsDenied && !pos && (
                        <p style={{ margin: 0, fontWeight: 700, color: '#B42318' }}>Turn on location for this page to get directions to safety.</p>
                    )}
                    {!guidance && !gpsDenied && <p style={{ margin: 0, fontWeight: 700 }}>Working out the way to the nearest safe zone…</p>}
                    {guidance && guidance.inside && (
                        <p style={{ margin: 0, fontWeight: 800, fontSize: '1.2rem', color: '#0F766E' }}>You are inside a safe zone: {guidance.zone.name}</p>
                    )}
                    {guidance && !guidance.inside && (
                        <>
                            <div style={{ fontSize: '0.8rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#51606F' }}>Go to the nearest safe zone</div>
                            <div style={{ fontSize: '1.35rem', fontWeight: 900, marginTop: 2 }}>{guidance.zone.name}</div>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 20, marginTop: 12, flexWrap: 'wrap' }}>
                                <svg width="110" height="110" viewBox="0 0 100 100" role="img" aria-label={`Direction: ${compassPoint(guidance.bearing)}`} style={{ transform: `rotate(${arrowRotation}deg)`, transition: 'transform 0.3s' }}>
                                    <circle cx="50" cy="50" r="46" fill="#F4F6F8" stroke="#C9D3DC" strokeWidth="2" />
                                    <polygon points="50,10 72,62 50,52 28,62" fill="#0F766E" />
                                </svg>
                                <div style={{ textAlign: 'left' }}>
                                    <div style={{ fontSize: '2.2rem', fontWeight: 900, fontFamily: "'JetBrains Mono', monospace", lineHeight: 1 }}>{formatDistance(guidance.distanceM)}</div>
                                    <div style={{ fontSize: '1rem', fontWeight: 800, marginTop: 4, textTransform: 'capitalize' }}>Head {compassPoint(guidance.bearing)}</div>
                                    <div style={{ fontSize: '0.72rem', color: '#51606F', marginTop: 4 }}>
                                        {heading === null ? 'Arrow points north-up: turn so the arrow points ahead.' : 'Arrow follows your phone’s compass.'}
                                    </div>
                                </div>
                            </div>
                        </>
                    )}
                </div>

                <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap', marginTop: 16 }}>
                    <button type="button" onClick={onAcknowledge} style={{ background: '#0B1B2B', color: '#fff', border: 'none', borderRadius: 12, padding: '14px 22px', fontWeight: 800, fontSize: '0.95rem', cursor: 'pointer', fontFamily: 'inherit' }}>
                        I understand, moving to safety
                    </button>
                    <button type="button" onClick={() => setMuted((m) => !m)} style={{ background: '#fff', color: '#0B1B2B', border: '2px solid #0B1B2B', borderRadius: 12, padding: '14px 18px', fontWeight: 800, fontSize: '0.95rem', cursor: 'pointer', fontFamily: 'inherit' }}>
                        {muted ? 'Sound on' : 'Silence siren'}
                    </button>
                </div>
            </div>
        </div>
    );
}

/**
 * Hooter pushed to a signed-in phone by an authority (tourists, residents, businesses).
 */
export default function HooterOverlay() {
    const { user } = useAuth();
    const { socket } = useSocket();
    const [hooter, setHooter] = useState<Hooter | null>(null);
    const isCivilian = user && user.role !== 'authority' && user.role !== 'admin';

    useEffect(() => { if (isCivilian) installAudioUnlock(); }, [isCivilian]);

    useEffect(() => {
        if (!socket || !isCivilian) return;
        const onStart = (h: Hooter) => setHooter(h);
        const onStop = () => setHooter(null);
        socket.on('hooter:start', onStart);
        socket.on('hooter:stop', onStop);
        return () => { socket.off('hooter:start', onStart); socket.off('hooter:stop', onStop); };
    }, [socket, isCivilian]);

    const acknowledge = async () => {
        const id = hooter?.hooter_id;
        setHooter(null);
        try { await api.post('/hooter/ack', { hooter_id: id }); } catch { /* authority still sees the stop on their side */ }
    };

    if (!isCivilian || !hooter) return null;
    return <HooterScreen hooter={hooter} onAcknowledge={acknowledge} />;
}
