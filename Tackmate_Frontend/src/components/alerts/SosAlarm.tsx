import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useSocket } from '../../context/SocketContext';
import api from '../../lib/api';
import TriageBadge, { type Triage } from '../ml/TriageBadge';

interface SosIncident {
    _id: string;
    title?: string;
    latitude?: number;
    longitude?: number;
    reporter?: { _id?: string; full_name?: string; phone?: string } | null;
    zone?: { name?: string } | null;
    created_at?: string;
    metadata?: { triggered_at?: string; sent_from_offline_queue?: boolean; sos_triage?: Triage } | null;
}

const BEEP_HIGH = 988;
const BEEP_LOW = 740;

/**
 * Full-screen emergency alarm for authority users: a looping two-tone buzzer and a slow
 * (<= 1 Hz, so safe for photosensitive users) red flash while any SOS is unacknowledged.
 */
export default function SosAlarm() {
    const { user } = useAuth();
    const { socket } = useSocket();
    const navigate = useNavigate();
    const [alarms, setAlarms] = useState<SosIncident[]>([]);
    const [muted, setMuted] = useState(false);
    const [busy, setBusy] = useState<string | null>(null);
    const audioRef = useRef<AudioContext | null>(null);
    const isStaff = user?.role === 'authority' || user?.role === 'admin';

    // Browsers only allow audio after a user gesture; unlock it on the first interaction.
    useEffect(() => {
        if (!isStaff) return;
        const unlock = () => {
            if (!audioRef.current) {
                const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
                if (Ctor) audioRef.current = new Ctor();
            }
            void audioRef.current?.resume();
        };
        window.addEventListener('pointerdown', unlock);
        window.addEventListener('keydown', unlock);
        return () => {
            window.removeEventListener('pointerdown', unlock);
            window.removeEventListener('keydown', unlock);
        };
    }, [isStaff]);

    useEffect(() => {
        if (!socket || !isStaff) return;
        const onSos = (incident: SosIncident) => {
            if (!incident?._id) return;
            setMuted(false);
            setAlarms((prev) => (prev.some((a) => a._id === incident._id) ? prev : [incident, ...prev]));
        };
        // Triage lands a second or two after the alarm: merge it into the alarm already on screen.
        const onUpdated = (incident: SosIncident) => {
            if (!incident?._id || !incident.metadata?.sos_triage) return;
            setAlarms((prev) => prev.map((a) => (a._id === incident._id ? { ...a, metadata: { ...(a.metadata || {}), ...incident.metadata } } : a)));
        };
        socket.on('sos:triggered', onSos);
        socket.on('incident:updated', onUpdated);
        return () => { socket.off('sos:triggered', onSos); socket.off('incident:updated', onUpdated); };
    }, [socket, isStaff]);

    // Buzzer loop while there is an active, un-muted alarm.
    const active = alarms.length > 0 && !muted;
    useEffect(() => {
        if (!active) return;
        let step = 0;
        const beep = () => {
            const ctx = audioRef.current;
            if (!ctx || ctx.state !== 'running') return;
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'square';
            osc.frequency.value = step % 2 === 0 ? BEEP_HIGH : BEEP_LOW;
            gain.gain.setValueAtTime(0.0001, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.22, ctx.currentTime + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.34);
            osc.connect(gain).connect(ctx.destination);
            osc.start();
            osc.stop(ctx.currentTime + 0.36);
            step += 1;
        };
        beep();
        const timer = window.setInterval(beep, 450);
        return () => window.clearInterval(timer);
    }, [active]);

    const dismiss = useCallback((id: string) => setAlarms((prev) => prev.filter((a) => a._id !== id)), []);

    const trackOnMap = (incident: SosIncident) => {
        const person = incident.reporter?._id;
        navigate(person ? `/authority/dashboard?track=${person}&incident=${incident._id}` : '/authority/dashboard');
    };

    const acknowledge = async (incident: SosIncident) => {
        setBusy(incident._id);
        try {
            await api.patch(`/incidents/${incident._id}`, { status: 'acknowledged' });
        } catch {
            // The alarm is still dismissed locally; the incident stays active on the dashboard.
        } finally {
            setBusy(null);
            dismiss(incident._id);
            trackOnMap(incident);
        }
    };

    if (!isStaff || alarms.length === 0) return null;
    // Highest triage priority first; untriaged alarms count as P2 until scored, newest first within a tier.
    const rank = (a: SosIncident) => ({ P1: 0, P2: 1, P3: 2, P4: 3 } as Record<string, number>)[a.metadata?.sos_triage?.priority ?? 'P2'] ?? 1;
    const current = [...alarms].sort((a, b) => rank(a) - rank(b))[0];
    const who = current.reporter?.full_name || 'A user';
    const coords = current.latitude != null && current.longitude != null
        ? `${current.latitude.toFixed(5)}, ${current.longitude.toFixed(5)}` : 'Location pending';

    return (
        <div role="alertdialog" aria-live="assertive" aria-label={`SOS emergency from ${who}`}
            style={{ position: 'fixed', inset: 0, zIndex: 100000, display: 'grid', placeItems: 'center', padding: 16 }}>
            <style>{`
                @keyframes sos-flash { 0%, 100% { background: rgba(185, 28, 28, 0.94); } 50% { background: rgba(60, 4, 4, 0.94); } }
                @keyframes sos-ring { 0%, 100% { box-shadow: 0 0 0 0 rgba(255,255,255,0.7); } 50% { box-shadow: 0 0 0 18px rgba(255,255,255,0); } }
            `}</style>
            <div aria-hidden style={{ position: 'absolute', inset: 0, animation: 'sos-flash 1s steps(1, end) infinite' }} />
            <div style={{ position: 'relative', width: 'min(520px, 100%)', background: '#fff', color: '#0B1B2B', borderRadius: 16, padding: 24, textAlign: 'center', animation: 'sos-ring 1s ease-out infinite', fontFamily: "'Inter', sans-serif" }}>
                <div style={{ fontWeight: 800, letterSpacing: '0.14em', color: '#B42318', fontSize: '0.8rem' }}>
                    SOS EMERGENCY{alarms.length > 1 ? ` · ${alarms.length} ACTIVE` : ''}
                </div>
                <h2 style={{ margin: '8px 0 4px', fontSize: '1.7rem', fontWeight: 800 }}>{who} is in trouble</h2>
                <p style={{ margin: 0, color: '#51606F', fontSize: '0.92rem' }}>
                    {current.zone?.name ? `${current.zone.name} · ` : ''}{coords}
                </p>
                {current.metadata?.triggered_at && current.created_at &&
                    new Date(current.created_at).getTime() - new Date(current.metadata.triggered_at).getTime() > 20000 && (
                    <p style={{ margin: '8px 0 0', fontSize: '0.8rem', fontWeight: 700, color: '#8A5A00' }}>
                        Pressed at {new Date(current.metadata.triggered_at).toLocaleTimeString()}, delivered late: the device had no network.
                    </p>
                )}
                {current.metadata?.sos_triage
                    ? <TriageBadge triage={current.metadata.sos_triage} />
                    : <p style={{ margin: '8px 0 0', fontSize: '0.74rem', color: '#51606F' }}>AI triage in progress…</p>}
                {current.reporter?.phone && (
                    <a href={`tel:${current.reporter.phone}`} style={{ display: 'inline-block', marginTop: 8, fontWeight: 700, color: '#0F766E' }}>Call {current.reporter.phone}</a>
                )}
                <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap', marginTop: 20 }}>
                    <button type="button" disabled={busy === current._id} onClick={() => acknowledge(current)}
                        style={{ background: '#B42318', color: '#fff', border: 'none', borderRadius: 10, padding: '12px 18px', fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit' }}>
                        Acknowledge &amp; respond
                    </button>
                    <button type="button" onClick={() => { dismiss(current._id); trackOnMap(current); }}
                        style={{ background: '#0B1B2B', color: '#fff', border: 'none', borderRadius: 10, padding: '12px 18px', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>
                        Track on map
                    </button>
                    <button type="button" onClick={() => setMuted((m) => !m)}
                        style={{ background: '#fff', color: '#0B1B2B', border: '1px solid #C9D3DC', borderRadius: 10, padding: '12px 18px', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>
                        {muted ? 'Unmute buzzer' : 'Mute buzzer'}
                    </button>
                    <button type="button" onClick={() => dismiss(current._id)}
                        style={{ background: 'transparent', color: '#51606F', border: 'none', padding: '12px 8px', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>
                        Dismiss
                    </button>
                </div>
            </div>
        </div>
    );
}
