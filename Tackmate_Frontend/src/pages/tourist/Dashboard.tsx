import { useState, useEffect, useCallback, useRef } from 'react';
import api from '../../lib/api';
import { useSocket } from '../../context/SocketContext';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../i18n';
import TouristMap from '../../components/maps/TouristMap';
import type { ZoneData } from '../../components/maps/TouristMap';
import { Link } from 'react-router-dom';
import {
    Map as MapIcon, AlertTriangle, ShieldAlert,
    Watch, Shield, Loader2, Check, RefreshCw,
    Navigation as NearMe, Calendar, CheckCircle2,
    X, Send, MapPin, Radio, Bluetooth
} from 'lucide-react';
import AlertPanel from '../../components/alerts/AlertPanel';
import { findZone } from '../../lib/geofence';
import { useIotDevice } from '../../hooks/useIotDevice';
import HealthPanel from '../../components/health/HealthPanel';
import SafetyScoreChip from '../../components/ml/SafetyScoreChip';
import { enqueueOfflineSos, flushOfflineSosQueue, getOfflineSosQueueCount } from '../../lib/offlineSos';
import {
    CLAY_COLORS as C,
    CLAY_CARD_STYLE as clayCard,
    CLAY_CARD_INNER_STYLE as clayCardInner,
} from '../../theme/clayTheme';

function haversine(lat1: number, lon1: number, lat2: number, lon2: number) {
    const R = 6371000; const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1); const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function ClayToast({ message, type, onClose }: { message: string; type: 'success' | 'error' | 'info'; onClose: () => void }) {
    useEffect(() => { const t = setTimeout(onClose, 4000); return () => clearTimeout(t); }, [onClose]);
    const bg = type === 'success' ? 'linear-gradient(135deg, #34D399, #2DD4BF)' : type === 'error' ? 'linear-gradient(135deg, #F87171, #EF4444)' : 'linear-gradient(135deg, #6C63FF, #8B85FF)';
    return (
        <div style={{ position: 'fixed', top: 20, right: 20, zIndex: 9999, background: bg, color: '#FFFFFF', borderRadius: 16, boxShadow: '0 8px 24px rgba(0,0,0,0.15)', padding: '14px 22px', display: 'flex', alignItems: 'center', gap: 10, fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 700, fontSize: '0.88rem', animation: 'clay-slide-up 0.3s ease-out' }}>
            {type === 'success' ? <Check size={16} /> : type === 'error' ? <X size={16} /> : <Radio size={16} />}
            {message}
            <button onClick={onClose} style={{ background: 'rgba(255,255,255,0.25)', border: 'none', color: '#FFF', cursor: 'pointer', borderRadius: 8, padding: '2px 6px', marginLeft: 8 }}><X size={12} /></button>
        </div>
    );
}

function ClayModal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: React.ReactNode }) {
    if (!open) return null;
    return (
        <div style={{ position: 'fixed', inset: 0, zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
            <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(27,29,42,0.4)', backdropFilter: 'blur(4px)' }} />
            <div style={{ position: 'relative', width: '100%', maxWidth: 484, background: C.surface, borderRadius: 24, boxShadow: '0 20px 60px rgba(27,29,42,0.2)', fontFamily: "'Plus Jakarta Sans', sans-serif", overflow: 'hidden' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 24px', borderBottom: `1px solid ${C.border}`, background: 'linear-gradient(135deg, rgba(108,99,255,0.08), rgba(139,133,255,0.04))' }}>
                    <h3 style={{ fontWeight: 800, color: C.text, margin: 0, fontSize: '1rem' }}>{title}</h3>
                    <button onClick={onClose} style={{ background: C.surfaceAlt, border: 'none', cursor: 'pointer', borderRadius: 10, padding: 6, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><X size={16} color={C.textMuted} /></button>
                </div>
                <div style={{ padding: 24 }}>{children}</div>
            </div>
        </div>
    );
}

export default function TouristDashboard() {
    const { user } = useAuth();
    const { socket, isConnected } = useSocket();
    const { t } = useLanguage();
    const [activeTrip, setActiveTrip] = useState<any>(null);
    const [alerts, setAlerts] = useState<any[]>([]);
    const [zones, setZones] = useState<ZoneData[]>([]);
    const [loading, setLoading] = useState(true);
    const [userLat, setUserLat] = useState<number | null>(null);
    const [userLng, setUserLng] = useState<number | null>(null);
    const watchIdRef = useRef<number | null>(null);
    const [sosLoading, setSosLoading] = useState(false);
    const [sosSuccess, setSosSuccess] = useState(false);
    const sosIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const [countdown, setCountdown] = useState(0);
    const [checkinLoading, setCheckinLoading] = useState(false);
    const [checkinDone, setCheckinDone] = useState(false);
    const [verifyLoading, setVerifyLoading] = useState(false);
    const [verifyResult, setVerifyResult] = useState<string | null>(null);
    const [highlightZoneId, setHighlightZoneId] = useState<string | null>(null);
    const [searchQuery, setSearchQuery] = useState('');
    const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);
    const [reportModalOpen, setReportModalOpen] = useState(false);
    const [updateTripModalOpen, setUpdateTripModalOpen] = useState(false);
    const [iotModalOpen, setIotModalOpen] = useState(false);
    const [proximityAlerts, setProximityAlerts] = useState<any[]>([]);

    /* ── GPS tracking ── */
    useEffect(() => {
        if ('geolocation' in navigator) {
            watchIdRef.current = navigator.geolocation.watchPosition(
                (pos) => { setUserLat(pos.coords.latitude); setUserLng(pos.coords.longitude); },
                () => { setUserLat(27.5855); setUserLng(91.8594); },
                { enableHighAccuracy: true, maximumAge: 10000 }
            );
        } else { setUserLat(27.5855); setUserLng(91.8594); }
        return () => { if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current); };
    }, []);

    /* Emit location: every 4s normally, every 1.5s while an SOS is active so authorities see live movement. */
    const latestPosRef = useRef<{ lat: number; lng: number } | null>(null);
    useEffect(() => { if (userLat && userLng) latestPosRef.current = { lat: userLat, lng: userLng }; }, [userLat, userLng]);
    const hasPosition = Boolean(userLat && userLng);

    // Bluetooth device (band / tracker / other IoT): feeds location, battery and SOS into the same pipeline.
    const iotDevice = useIotDevice({
        phonePos: userLat && userLng ? { lat: userLat, lng: userLng } : null,
        onSos: () => { setToast({ message: 'SOS pressed on your connected device', type: 'error' }); void triggerSOS(); },
    });
    // Re-render once a second while the IoT panel is open so the "x seconds ago" labels stay true.
    const [, setIotTick] = useState(0);
    useEffect(() => {
        if (!iotModalOpen) return;
        const id = setInterval(() => setIotTick((n) => n + 1), 1000);
        return () => clearInterval(id);
    }, [iotModalOpen]);
    const iotDevicePositionRef = useRef(iotDevice.devicePosition);
    iotDevicePositionRef.current = iotDevice.devicePosition;
    useEffect(() => {
        if (!socket || !user || !hasPosition) return;
        let timer: ReturnType<typeof setTimeout>;
        const tick = () => {
            // A fresh fix from the connected device (its own GPS) wins over the phone's.
            const pos = iotDevicePositionRef.current() ?? latestPosRef.current;
            if (pos) {
                const userId = user.id || (user as any)._id;
                socket.emit('location_update', { userId, latitude: pos.lat, longitude: pos.lng, role: 'tourist', name: user.full_name });
            }
            const sosUntil = Number(localStorage.getItem('trackmate.sosActiveUntil') || 0);
            timer = setTimeout(tick, sosUntil > Date.now() ? 1500 : 4000);
        };
        tick();
        return () => clearTimeout(timer);
    }, [socket, user, hasPosition]);

    /* Safety score for the current position (server pushes updates; this seeds and refreshes it) */
    const [areaSafety, setAreaSafety] = useState<{ score: number; level: string; zone?: { name: string } | null } | null>(null);
    useEffect(() => {
        if (!socket) return;
        const onArea = (d: any) => setAreaSafety(d);
        socket.on('area_safety', onArea);
        return () => { socket.off('area_safety', onArea); };
    }, [socket]);
    useEffect(() => {
        if (!hasPosition) return;
        let cancelled = false;
        const load = async () => {
            const pos = latestPosRef.current;
            if (!pos) return;
            try {
                const res = await api.get('/analytics/area-safety', { params: { lat: pos.lat, lng: pos.lng } });
                if (!cancelled) setAreaSafety(res.data.data);
            } catch { /* keep the last known value */ }
        };
        void load();
        const timer = setInterval(load, 60000);
        return () => { cancelled = true; clearInterval(timer); };
    }, [hasPosition]);

    /* Offline geofencing: with no connection the server can't warn us, so check cached zones locally. */
    const lastLocalZoneRef = useRef<string | null>(null);
    useEffect(() => {
        if (isConnected || !userLat || !userLng || zones.length === 0) return;
        const zone = findZone(zones as any, userLat, userLng);
        const id = zone?._id ?? null;
        if (id === lastLocalZoneRef.current) return;
        lastLocalZoneRef.current = id;
        if (zone && (zone.risk_level === 'high' || zone.risk_level === 'restricted')) {
            setToast({ message: `You have entered ${zone.name} (${zone.risk_level} zone)`, type: 'error' });
            if ('vibrate' in navigator) navigator.vibrate?.([200, 100, 200]);
        }
    }, [isConnected, userLat, userLng, zones]);

    /* Zone alerts from backend */
    useEffect(() => {
        if (!socket) return;
        const handleZoneAlert = (data: any) => {
            const color = data.zone?.risk_level === 'high' || data.zone?.risk_level === 'restricted' ? 'error' : 'info';
            setToast({ message: data.message, type: color as any });
        };
        const handleRedZoneProximity = (data: any) => {
            setProximityAlerts(prev => {
                const exists = prev.some(a => a.zone?.id === data.zone?.id);
                if (exists) return prev.map(a => a.zone?.id === data.zone?.id ? { ...data, _id: `prox-${data.zone.id}`, receivedAt: Date.now() } : a);
                return [{ ...data, _id: `prox-${data.zone?.id || Date.now()}`, receivedAt: Date.now() }, ...prev].slice(0, 5);
            });
            setToast({ message: data.message, type: 'error' });
        };
        socket.on('zone_alert', handleZoneAlert);
        socket.on('red_zone_proximity', handleRedZoneProximity);
        return () => { socket.off('zone_alert', handleZoneAlert); socket.off('red_zone_proximity', handleRedZoneProximity); };
    }, [socket]);

    const fetchTouristData = useCallback(async () => {
        try {
            const [tripRes, alertsRes, zonesRes] = await Promise.all([api.get('/trips/active'), api.get('/incidents?limit=10'), api.get('/zones')]);
            if (tripRes.data.success) setActiveTrip(tripRes.data.data);
            if (alertsRes.data.success) setAlerts(alertsRes.data.data || []);
            if (zonesRes.data.success) setZones(zonesRes.data.data || []);
        } catch { } finally { setLoading(false); }
    }, []);

    useEffect(() => {
        fetchTouristData();
        const interval = setInterval(fetchTouristData, 30000);
        const onNewIncident = (inc: any) => setAlerts(prev => [inc, ...prev]);
        const onZonesChanged = () => { void fetchTouristData(); };
        if (socket) {
            socket.on('new-incident', onNewIncident);
            socket.on('zones:changed', onZonesChanged);
        }
        return () => {
            clearInterval(interval);
            if (socket) { socket.off('new-incident', onNewIncident); socket.off('zones:changed', onZonesChanged); }
        };
    }, [socket, fetchTouristData]);

    useEffect(() => {
        const flushQueuedSos = async () => {
            if (!navigator.onLine) return;
            const result = await flushOfflineSosQueue();
            if (result.sent > 0) {
                setToast({ message: `${result.sent} offline SOS alert(s) sent`, type: 'success' });
            }
        };

        void flushQueuedSos();

        const onOnline = () => {
            void flushQueuedSos();
        };

        window.addEventListener('online', onOnline);
        return () => {
            window.removeEventListener('online', onOnline);
        };
    }, []);

    const handleCheckin = async () => {
        if (!userLat || !userLng) { setToast({ message: t('unableGetLocation'), type: 'error' }); return; }
        setCheckinLoading(true);
        try {
            const res = await api.post('/locations', { latitude: userLat, longitude: userLng, source: 'gps' });
            setCheckinDone(true);
            const zone = res.data.data?.zone;
            await api.post('/incidents', { title: 'Tourist Checked In', description: `User checked in at ${userLat.toFixed(4)}, ${userLng.toFixed(4)}` + (zone ? ` (${zone.name})` : ''), incident_type: 'checkin', severity: 'low', source: 'user_report', latitude: userLat, longitude: userLng, is_public: false }).catch(() => { });
            setToast({ message: zone ? `${t('checkedInAt')} ${zone.name}` : t('dailyCheckinRecorded'), type: 'success' });
            setTimeout(() => setCheckinDone(false), 5000);
        } catch { setToast({ message: t('checkinFailed'), type: 'error' }); } finally { setCheckinLoading(false); }
    };

    const handleVerifyStay = async () => {
        if (!userLat || !userLng) { setToast({ message: t('unableGetLocation'), type: 'error' }); return; }
        setVerifyLoading(true);
        try {
            const res = await api.post('/locations', { latitude: userLat, longitude: userLng, source: 'gps' });
            const zone = res.data.data?.zone;
            if (zone) {
                setVerifyResult(`${t('youAreIn')} "${zone.name}" — ${zone.risk_level} ${t('zone')}`);
                setHighlightZoneId(zone._id);
                setTimeout(() => setHighlightZoneId(null), 8000);
                api.post('/incidents', { title: 'Stay Verified', description: `User verified stay in ${zone.name}`, incident_type: 'checkin', severity: 'low', source: 'user_report', latitude: userLat, longitude: userLng, is_public: false }).catch(() => { });
            }
            else {
                setVerifyResult(t('notInAnyZone'));
                api.post('/incidents', { title: 'Stay Verification Failed', description: `User not in any registered zone`, incident_type: 'checkin', severity: 'medium', source: 'user_report', latitude: userLat, longitude: userLng, is_public: false }).catch(() => { });
            }
            setTimeout(() => setVerifyResult(null), 6000);
        } catch { setToast({ message: t('verificationFailed'), type: 'error' }); } finally { setVerifyLoading(false); }
    };

    const handleSafeHouse = () => {
        if (!userLat || !userLng) { setToast({ message: t('unableGetLocation'), type: 'error' }); return; }
        const safeZones = zones.filter(z => z.risk_level === 'safe');
        if (safeZones.length === 0) { setToast({ message: t('noSafeZones'), type: 'info' }); return; }
        let nearest = safeZones[0]; let minDist = haversine(userLat, userLng, nearest.center_lat, nearest.center_lng);
        for (const z of safeZones) { const d = haversine(userLat, userLng, z.center_lat, z.center_lng); if (d < minDist) { nearest = z; minDist = d; } }
        setHighlightZoneId(nearest._id);
        api.post('/incidents', { title: 'Safe House Requested', description: `User navigating to ${nearest.name}`, incident_type: 'safe_house_request', severity: 'low', source: 'user_report', latitude: userLat, longitude: userLng, is_public: false }).catch(() => { });
        setToast({ message: `${t('nearestSafeZone')}: ${nearest.name} (${Math.round(minDist)}m)`, type: 'success' });
        setTimeout(() => setHighlightZoneId(null), 10000);
    };

    const handleSOSStart = () => {
        if (sosIntervalRef.current) clearInterval(sosIntervalRef.current);
        setCountdown(3);
        sosIntervalRef.current = setInterval(() => { setCountdown((prev) => prev - 1); }, 1000);
    };

    const handleSOSEnd = () => {
        if (sosIntervalRef.current) { clearInterval(sosIntervalRef.current); sosIntervalRef.current = null; }
        setCountdown(0);
    };

    useEffect(() => {
        if (countdown === 0 && sosIntervalRef.current) {
            clearInterval(sosIntervalRef.current);
            sosIntervalRef.current = null;
            triggerSOS();
        }
    }, [countdown]);

    const triggerSOS = async () => {
        setSosLoading(true);
        // Switches location sharing to the fast cadence for the next 30 minutes.
        localStorage.setItem('trackmate.sosActiveUntil', String(Date.now() + 30 * 60 * 1000));
        const payload: Record<string, any> = {
            title: 'EMERGENCY SOS TRIGGERED',
            incident_type: 'sos_emergency',
            severity: 'critical',
            source: 'sos_panic',
            latitude: iotDevice.devicePosition()?.lat ?? (userLat || 27.5855),
            longitude: iotDevice.devicePosition()?.lng ?? (userLng || 91.8594),
            is_public: true,
            metadata: {
                triggered_by_role: 'tourist',
                triggered_by_name: user?.full_name || 'Tourist User',
                ...(iotDevice.snapshot.status === 'connected' ? { iot_device: { name: iotDevice.snapshot.deviceName, battery: iotDevice.snapshot.battery, heart_rate: iotDevice.snapshot.heartRate } } : {}),
            },
        };

        try {
            const pos = await new Promise<GeolocationPosition>((res, rej) => navigator.geolocation.getCurrentPosition(res, rej, { timeout: 2000, maximumAge: 60000, enableHighAccuracy: false })).catch(() => null);

            payload.latitude = pos?.coords.latitude || payload.latitude;
            payload.longitude = pos?.coords.longitude || payload.longitude;

            if (!navigator.onLine) {
                enqueueOfflineSos(payload, 'tourist');
                setToast({
                    message: `No network. SOS saved offline (${getOfflineSosQueueCount()} queued).`,
                    type: 'info',
                });
                return;
            }

            await api.post('/incidents', payload, { timeout: 6000 });
            setSosSuccess(true); setTimeout(() => setSosSuccess(false), 5000);
        } catch {
            enqueueOfflineSos(payload, 'tourist');
            setToast({
                message: `Network unstable. SOS cached safely (${getOfflineSosQueueCount()} queued).`,
                type: 'info',
            });
        } finally { setSosLoading(false); }
    };

    const filteredZones = searchQuery.trim() ? zones.filter(z => z.name.toLowerCase().includes(searchQuery.toLowerCase())) : zones;
    const safetyScore = user?.safety_score ?? 85;

    return (
        <div style={{ background: C.bg, minHeight: '100vh', fontFamily: "'Plus Jakarta Sans', sans-serif", padding: '0 0 80px' }}>
            {toast && <ClayToast {...toast} onClose={() => setToast(null)} />}

            {/* Safety Banner */}
            <div className="top-header responsive-container" style={{ background: 'linear-gradient(135deg, #1B1D2A, #252840)', borderBottom: 'none', padding: '16px 28px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderRadius: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                    <div style={{ width: 40, height: 40, background: 'linear-gradient(135deg, #34D399, #2DD4BF)', borderRadius: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 4px 12px rgba(52,211,153,0.3)' }}><Shield size={20} color="#FFFFFF" /></div>
                    <div>
                        <h2 style={{ color: '#FFFFFF', fontWeight: 800, fontSize: '0.95rem', margin: 0 }}>{t('systemProtected')}</h2>
                        <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: '0.75rem', margin: 0, fontWeight: 500 }}>{t('locationMonitored')} {activeTrip?.destination_region || t('localAuthorities')}.</p>
                    </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                    <AlertPanel />
                    <SafetyScoreChip label={t('safetyScore')} score={safetyScore} />
                    {areaSafety && (
                        <div title={areaSafety.zone?.name ? `Current area: ${areaSafety.zone.name}` : 'Outside mapped zones'} style={{ borderRadius: 12, padding: '8px 16px', fontWeight: 700, fontSize: '0.78rem', color: areaSafety.level === 'caution' ? '#3B2A00' : '#FFFFFF', background: areaSafety.level === 'safe' ? '#12B3A6' : areaSafety.level === 'caution' ? '#FBBF24' : areaSafety.level === 'risky' ? '#F97316' : '#EF4444' }}>
                            Area safety: {areaSafety.score}% · {areaSafety.level}
                        </div>
                    )}
                </div>
            </div>

            <div className="responsive-grid responsive-container" style={{ display: 'grid', gridTemplateColumns: '1fr 380px', gap: 20, padding: '20px 24px', maxWidth: 1440, margin: '0 auto' }}>
                {/* Map column */}
                <div style={{ ...clayCard, overflow: 'hidden', minHeight: 450, display: 'flex', flexDirection: 'column' }}>
                    <div style={{ padding: '14px 20px', borderBottom: `1px solid ${C.border}`, background: C.surfaceAlt, display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderRadius: '20px 20px 0 0', flexWrap: 'wrap', gap: 10 }}>
                        <h3 style={{ fontWeight: 800, color: C.text, margin: 0, display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.9rem' }}><MapIcon size={16} color={C.primary} /> {t('liveSafetyGIS')}</h3>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            <button
                                onClick={() => {
                                    setToast({ message: t('fetchingLocation'), type: 'info' });
                                    navigator.geolocation.getCurrentPosition(
                                        (pos) => { setUserLat(pos.coords.latitude); setUserLng(pos.coords.longitude); setToast({ message: t('locationUpdated'), type: 'success' }); },
                                        () => setToast({ message: t('locationDenied'), type: 'error' }),
                                        { enableHighAccuracy: true }
                                    );
                                }}
                                style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: '0.68rem', fontWeight: 700, padding: '5px 12px', background: 'linear-gradient(135deg, #6C63FF, #8B85FF)', color: '#FFFFFF', border: 'none', cursor: 'pointer', borderRadius: 10, boxShadow: '0 2px 8px rgba(108,99,255,0.25)' }}
                            >
                                <NearMe size={10} /> {t('locateMe')}
                            </button>
                            {[{ label: t('safe'), color: C.safe }, { label: t('moderate'), color: C.moderate }, { label: t('restricted'), color: C.high }].map(l => (
                                <div key={l.label} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: '0.65rem', fontWeight: 700, padding: '5px 10px', background: C.surfaceAlt, color: C.text, borderRadius: 10, border: `1px solid ${C.border}` }}>
                                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: l.color }} />{l.label}
                                </div>
                            ))}
                        </div>
                    </div>
                    <div className="responsive-map-container" style={{ position: 'relative', flex: 1, minHeight: 380, height: 420 }}>
                        <TouristMap lat={userLat} lng={userLng} zones={zones} highlightZoneId={highlightZoneId} height="100%" />
                        {/* Search */}
                        <div style={{ position: 'absolute', top: 12, left: 12, zIndex: 100, width: 'calc(100% - 24px)', maxWidth: 260 }}>
                            <div style={{ position: 'relative' }}>
                                <MapPin size={13} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: C.textMuted }} />
                                <input value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder={t('searchZones')} style={{ width: '100%', padding: '10px 14px 10px 32px', background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, boxShadow: '0 4px 12px rgba(27,29,42,0.08)', fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: '0.82rem', fontWeight: 600, outline: 'none', color: C.text }} />
                            </div>
                            {searchQuery.trim() && filteredZones.length > 0 && (
                                <div style={{ background: C.surface, borderRadius: '0 0 14px 14px', border: `1px solid ${C.border}`, borderTop: 'none', maxHeight: 180, overflowY: 'auto', boxShadow: '0 4px 12px rgba(27,29,42,0.08)' }}>
                                    {filteredZones.map(zone => (
                                        <button key={zone._id} onClick={() => { setHighlightZoneId(zone._id); setSearchQuery(''); setTimeout(() => setHighlightZoneId(null), 8000); }} style={{ width: '100%', textAlign: 'left', padding: '10px 14px', background: 'none', border: 'none', borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontFamily: 'inherit' }}>
                                            <div style={{ width: 8, height: 8, borderRadius: '50%', background: zone.risk_level === 'safe' ? C.safe : zone.risk_level === 'moderate' ? C.moderate : C.high }} />
                                            <span style={{ fontWeight: 600, fontSize: '0.82rem', color: C.text }}>{zone.name}</span>
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                </div>

                {/* Info column */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                    {/* Trip info */}
                    <div style={{ ...clayCard, overflow: 'hidden', padding: 0 }}>
                        <div style={{ padding: '14px 20px', borderBottom: `1px solid ${C.border}`, background: 'linear-gradient(135deg, rgba(108,99,255,0.08), rgba(139,133,255,0.04))', display: 'flex', alignItems: 'center', gap: 8, borderRadius: '20px 20px 0 0' }}>
                            <Calendar size={15} color={C.primary} /><h3 style={{ fontWeight: 800, color: C.text, margin: 0, fontSize: '0.88rem' }}>{t('activeItinerary')}</h3>
                        </div>
                        <div style={{ padding: 18 }}>
                            {activeTrip ? (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', ...clayCardInner, padding: '12px 14px' }}>
                                        <div><p style={{ fontSize: '0.62rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: C.textMuted, margin: 0 }}>{t('destination')}</p><p style={{ fontWeight: 700, color: C.text, margin: '2px 0 0', fontSize: '0.9rem' }}>{activeTrip.destination_region}</p></div>
                                        <div style={{ textAlign: 'right' }}><p style={{ fontSize: '0.62rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: C.textMuted, margin: 0 }}>{t('duration')}</p><p style={{ fontWeight: 600, color: C.text, margin: '2px 0 0', fontSize: '0.78rem' }}>{new Date(activeTrip.start_date).toLocaleDateString()} – {new Date(activeTrip.end_date).toLocaleDateString()}</p></div>
                                    </div>
                                    {verifyResult && <div style={{ padding: '10px 14px', background: 'rgba(108,99,255,0.06)', borderRadius: 12, border: `1px solid rgba(108,99,255,0.15)`, fontSize: '0.82rem', fontWeight: 600, color: C.primary }}>{verifyResult}</div>}
                                    <div style={{ display: 'flex', gap: 8 }}>
                                        <button onClick={() => setUpdateTripModalOpen(true)} style={{ flex: 1, padding: 10, background: 'linear-gradient(135deg, #6C63FF, #8B85FF)', border: 'none', borderRadius: 12, fontFamily: 'inherit', fontWeight: 700, fontSize: '0.72rem', cursor: 'pointer', textTransform: 'uppercase', color: '#FFFFFF', boxShadow: '0 4px 12px rgba(108,99,255,0.25)' }}>{t('updatePlan')}</button>
                                        <button onClick={handleVerifyStay} disabled={verifyLoading} style={{ flex: 1, padding: 10, background: C.surfaceAlt, border: `1px solid ${C.border}`, borderRadius: 12, fontFamily: 'inherit', fontWeight: 700, fontSize: '0.72rem', cursor: verifyLoading ? 'default' : 'pointer', textTransform: 'uppercase', color: C.text, boxShadow: '4px 4px 8px rgba(27,29,42,0.08), -2px -2px 6px rgba(255,255,255,0.9)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, opacity: verifyLoading ? 0.7 : 1 }}>
                                            {verifyLoading ? <Loader2 size={14} className="animate-spin" /> : t('verifyStay')}
                                        </button>
                                    </div>
                                </div>
                            ) : (
                                <div style={{ padding: 24, textAlign: 'center', border: `2px dashed ${C.border}`, borderRadius: 14 }}>
                                    <p style={{ fontSize: '0.85rem', color: C.textMuted, marginBottom: 14, fontWeight: 500 }}>{t('noActiveTrip')}</p>
                                    <Link to="/tourist/plan" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'linear-gradient(135deg, #6C63FF, #8B85FF)', borderRadius: 12, padding: '10px 20px', textDecoration: 'none', color: '#FFFFFF', fontWeight: 700, fontSize: '0.78rem', textTransform: 'uppercase', boxShadow: '0 4px 12px rgba(108,99,255,0.25)' }}>
                                        <NearMe size={14} /> {t('startPlanning')}
                                    </Link>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Quick Actions */}
                    <div style={{ ...clayCard, padding: 18 }}>
                        <h3 style={{ fontWeight: 800, color: C.text, margin: '0 0 14px', fontSize: '0.88rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{t('safetyServices')}</h3>
                        <div className="responsive-flex-col" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                            {[
                                { icon: checkinDone ? <Check size={22} color={C.safe} /> : checkinLoading ? <Loader2 size={22} style={{ animation: 'spin-slow 1s linear infinite' }} /> : <CheckCircle2 size={22} color={C.primary} />, label: checkinDone ? t('checkedIn') : t('dailyCheckin'), action: handleCheckin, gradient: 'rgba(108,99,255,0.06)' },
                                { icon: <AlertTriangle size={22} color={C.moderate} />, label: t('reportAnomaly'), action: () => setReportModalOpen(true), gradient: 'rgba(251,191,36,0.08)' },
                                iotDevice.snapshot.status === 'connected' || iotDevice.snapshot.status === 'reconnecting'
                                    ? { icon: <span style={{ position: 'relative', display: 'inline-flex' }}><Watch size={22} color={iotDevice.snapshot.status === 'connected' ? C.safeDark : C.moderate} /><span aria-hidden style={{ position: 'absolute', top: -3, right: -5, width: 9, height: 9, borderRadius: '50%', background: iotDevice.snapshot.status === 'connected' ? C.safe : C.moderate, border: '2px solid #fff' }} /></span>, label: iotDevice.snapshot.status === 'connected' ? 'Connected' : 'Reconnecting…', sub: iotDevice.snapshot.deviceName || undefined, action: () => setIotModalOpen(true), gradient: iotDevice.snapshot.status === 'connected' ? 'rgba(52,211,153,0.14)' : 'rgba(251,191,36,0.12)' }
                                    : { icon: <Watch size={22} color={C.primary} />, label: t('iotSync'), sub: undefined as string | undefined, action: () => setIotModalOpen(true), gradient: 'rgba(108,99,255,0.06)' },
                                { icon: <ShieldAlert size={22} color={C.restricted} />, label: t('safeHouse'), action: handleSafeHouse, gradient: 'rgba(167,139,250,0.08)' },
                            ].map((btn, i) => (
                                <button key={i} onClick={btn.action} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '16px 8px', background: btn.gradient, border: `1px solid ${C.border}`, borderRadius: 16, cursor: 'pointer', fontFamily: 'inherit', transition: 'all 0.15s', boxShadow: '4px 4px 8px rgba(27,29,42,0.06), -2px -2px 6px rgba(255,255,255,0.9)' }}
                                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.transform = 'translateY(-2px)'; (e.currentTarget as HTMLElement).style.boxShadow = '6px 6px 14px rgba(27,29,42,0.1), -3px -3px 10px rgba(255,255,255,0.9)'; }}
                                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.transform = ''; (e.currentTarget as HTMLElement).style.boxShadow = '4px 4px 8px rgba(27,29,42,0.06), -2px -2px 6px rgba(255,255,255,0.9)'; }}
                                >
                                    {btn.icon}
                                    <span style={{ fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: C.text }}>{btn.label}</span>
                                    {(btn as { sub?: string }).sub && <span style={{ fontSize: '0.6rem', fontWeight: 600, color: C.textMuted, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{(btn as { sub?: string }).sub}</span>}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Health: steps, heart rate, SpO2 */}
                    <HealthPanel device={iotDevice.snapshot} />

                    {/* Alerts */}
                    <div style={{ ...clayCard, flex: 1, overflow: 'hidden', padding: 0 }}>
                        <div style={{ padding: '14px 18px', borderBottom: `1px solid ${C.border}`, background: C.surfaceAlt, display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderRadius: '20px 20px 0 0' }}>
                            <h3 style={{ fontWeight: 800, color: C.text, margin: 0, fontSize: '0.88rem' }}>{t('safetyBroadcasts')}</h3>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <button onClick={fetchTouristData} style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.textMuted }}><RefreshCw size={13} className={loading ? 'animate-spin' : ''} /></button>
                                {(alerts.length + proximityAlerts.length) > 0 && <span style={{ padding: '3px 10px', background: 'linear-gradient(135deg, #F87171, #EF4444)', color: '#FFFFFF', fontSize: '0.62rem', fontWeight: 700, textTransform: 'uppercase', borderRadius: 20 }}>{alerts.length + proximityAlerts.length} {t('active')}</span>}
                            </div>
                        </div>
                        <div style={{ padding: 14, maxHeight: 280, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
                            {/* Red Zone Proximity Alerts */}
                            {proximityAlerts.map(pa => (
                                <div key={pa._id} style={{ padding: '12px 14px', background: 'linear-gradient(135deg, rgba(239,68,68,0.08), rgba(248,113,113,0.04))', border: `1px solid rgba(239,68,68,0.25)`, borderRadius: 14, display: 'flex', gap: 10, animation: 'nb-pulse 2s infinite' }}>
                                    <div style={{ width: 32, height: 32, background: 'linear-gradient(135deg, #EF4444, #DC2626)', borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                                        <ShieldAlert size={16} color="#FFFFFF" />
                                    </div>
                                    <div style={{ flex: 1 }}>
                                        <p style={{ fontWeight: 800, color: C.critical, margin: 0, fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{t('redZoneNearby')}</p>
                                        <p style={{ fontWeight: 700, color: C.text, margin: '2px 0 0', fontSize: '0.82rem' }}>{pa.zone?.name} — {pa.distance_meters}m away</p>
                                        <p style={{ fontSize: '0.68rem', color: C.textMuted, margin: '2px 0 0', fontWeight: 500 }}>{pa.zone?.risk_level} zone · {new Date(pa.timestamp).toLocaleTimeString()}</p>
                                    </div>
                                    <button onClick={() => setProximityAlerts(prev => prev.filter(a => a._id !== pa._id))} style={{ background: 'rgba(239,68,68,0.1)', border: 'none', borderRadius: 8, padding: '4px 6px', cursor: 'pointer', alignSelf: 'flex-start' }}><X size={12} color={C.critical} /></button>
                                </div>
                            ))}
                            {/* Regular alerts */}
                            {alerts.length > 0 ? alerts.map(alert => {
                                const col = alert.severity === 'critical' ? C.critical : alert.severity === 'high' ? C.high : C.primary;
                                const bgCol = alert.severity === 'critical' ? 'rgba(239,68,68,0.06)' : alert.severity === 'high' ? 'rgba(248,113,113,0.06)' : 'rgba(108,99,255,0.06)';
                                return (
                                    <div key={alert._id} style={{ padding: '12px 14px', background: bgCol, border: `1px solid ${col}20`, borderRadius: 14, display: 'flex', gap: 10 }}>
                                        <AlertTriangle size={16} color={col} style={{ flexShrink: 0, marginTop: 1 }} />
                                        <div>
                                            <p style={{ fontWeight: 700, color: C.text, margin: 0, fontSize: '0.82rem' }}>{alert.title}</p>
                                            <p style={{ fontSize: '0.72rem', color: C.textMuted, margin: '2px 0 0', fontWeight: 500 }}>{alert.description || alert.zone?.name || new Date(alert.created_at).toLocaleString()}</p>
                                        </div>
                                    </div>
                                );
                            }) : proximityAlerts.length === 0 && (
                                <div style={{ padding: 24, textAlign: 'center', border: `2px dashed ${C.border}`, borderRadius: 14 }}>
                                    <Check size={20} color={C.safe} style={{ margin: '0 auto 6px' }} />
                                    <p style={{ fontSize: '0.78rem', color: C.textMuted, fontWeight: 600 }}>{t('allSectorsClear')}</p>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>

            {/* SOS Button */}
            <div style={{ position: 'fixed', bottom: 85, right: 20, zIndex: 1000 }}>
                {sosSuccess ? (
                    <div style={{ width: 80, height: 80, background: 'linear-gradient(135deg, #34D399, #2DD4BF)', borderRadius: '50%', boxShadow: '0 8px 24px rgba(52,211,153,0.3)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4, color: '#FFFFFF' }}>
                        <Check size={28} /><span style={{ fontSize: '0.55rem', fontWeight: 800, textTransform: 'uppercase' }}>{t('alertSent')}</span>
                    </div>
                ) : (
                    <button onMouseDown={handleSOSStart} onMouseUp={handleSOSEnd} onMouseLeave={handleSOSEnd} onTouchStart={handleSOSStart} onTouchEnd={handleSOSEnd}
                        style={{ width: 80, height: 80, background: 'linear-gradient(135deg, #F87171, #EF4444)', border: 'none', borderRadius: '50%', boxShadow: countdown > 0 ? '0 0 0 10px rgba(239,68,68,0.3), 0 8px 24px rgba(239,68,68,0.4)' : '0 8px 24px rgba(239,68,68,0.3)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4, cursor: 'pointer', color: '#FFFFFF', transform: countdown > 0 ? 'scale(1.1)' : undefined, transition: 'all 0.2s', outline: 'none', animation: countdown === 0 ? 'pulse-glow 2s ease-in-out infinite' : undefined }}
                    >
                        {sosLoading ? <Loader2 size={28} style={{ animation: 'spin-slow 1s linear infinite' }} /> : countdown > 0 ? <span style={{ fontSize: '1.8rem', fontWeight: 800 }}>{countdown}</span> : <><ShieldAlert size={28} /><span style={{ fontSize: '0.55rem', fontWeight: 800, textTransform: 'uppercase' }}>{t('holdSOS')}</span></>}
                    </button>
                )}
                {countdown > 0 && <div style={{ position: 'absolute', top: 10, right: '110%', whiteSpace: 'nowrap', background: 'linear-gradient(135deg, #F87171, #EF4444)', color: '#FFFFFF', borderRadius: 12, padding: '8px 16px', fontWeight: 800, fontSize: '0.78rem', boxShadow: '0 4px 12px rgba(239,68,68,0.3)' }}>{t('holding')} ({countdown}s)</div>}
            </div>

            {/* Report Modal */}
            <ReportAnomalyModal open={reportModalOpen} onClose={() => setReportModalOpen(false)} userLat={userLat} userLng={userLng}
                onSuccess={(t) => { setToast({ message: `Anomaly "${t}" reported`, type: 'success' }); fetchTouristData(); }}
                onError={(m) => setToast({ message: m, type: 'error' })}
            />
            <UpdateTripModal open={updateTripModalOpen} onClose={() => setUpdateTripModalOpen(false)} trip={activeTrip}
                onSuccess={() => { setToast({ message: 'Trip updated', type: 'success' }); fetchTouristData(); }}
                onError={(m) => setToast({ message: m, type: 'error' })}
            />
            <ClayModal open={iotModalOpen} onClose={() => { iotDevice.stopScan(); setIotModalOpen(false); }} title="IoT Device Sync">
                {(() => {
                    const d = iotDevice.snapshot;
                    const linked = d.status === 'connected' || d.status === 'reconnecting';
                    const ago = (t: number | null) => (t ? `${Math.max(0, Math.round((Date.now() - t) / 1000))}s ago` : 'no data yet');
                    const dot = d.status === 'connected' ? C.safe : d.status === 'reconnecting' || d.status === 'connecting' ? C.moderate : C.high;
                    const row = (label: string, value: string) => (
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: '0.8rem' }}>
                            <span style={{ color: C.textMuted, fontWeight: 600 }}>{label}</span>
                            <span style={{ color: C.text, fontWeight: 700, textAlign: 'right', wordBreak: 'break-word' }}>{value}</span>
                        </div>
                    );
                    const primaryBtn: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, padding: '13px 16px', background: C.primary, color: '#fff', border: 'none', borderRadius: 14, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 800, width: '100%', fontSize: '0.9rem' };
                    const ghostBtn: React.CSSProperties = { ...primaryBtn, background: C.surfaceAlt, color: C.text, border: `1px solid ${C.border}`, fontWeight: 700 };

                    if (!iotDevice.supported) {
                        return (
                            <p style={{ margin: 0, color: C.text, fontSize: '0.88rem', lineHeight: 1.5 }}>
                                This browser cannot use Bluetooth. Open TrackMate in <b>Chrome or Edge</b> on Android, Windows, macOS or Linux.
                                (iPhone and iPad browsers do not allow Bluetooth for websites.)
                            </p>
                        );
                    }
                    return (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                            {!linked && (
                                <>
                                    <p style={{ margin: 0, color: C.textMuted, fontSize: '0.82rem', lineHeight: 1.5 }}>
                                        Turn on your band, tracker or other Bluetooth device and keep it close, then scan. Choose a device from the list to
                                        connect: its battery, location and SOS button start syncing with the command centre.
                                    </p>

                                    {d.status === 'connecting' ? (
                                        <div style={{ ...primaryBtn, cursor: 'default', opacity: 0.8 }}>
                                            <Loader2 size={18} style={{ animation: 'spin-slow 1s linear infinite' }} /> Connecting to {d.deviceName ?? 'device'}…
                                        </div>
                                    ) : d.scanning ? (
                                        <>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.8rem', fontWeight: 700, color: C.text }}>
                                                <Loader2 size={15} style={{ animation: 'spin-slow 1s linear infinite', color: C.primary }} />
                                                Scanning… {d.nearby.length} device{d.nearby.length === 1 ? '' : 's'} nearby
                                                <button type="button" onClick={() => iotDevice.stopScan()} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: C.primary, fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit' }}>Stop</button>
                                            </div>
                                            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 260, overflowY: 'auto' }}>
                                                {d.nearby.length === 0 && (
                                                    <p style={{ margin: 0, fontSize: '0.78rem', color: C.textMuted }}>No devices seen yet. Make sure Bluetooth is on and the device is switched on and advertising.</p>
                                                )}
                                                {d.nearby.map((n) => {
                                                    const bars = n.rssi === null ? 1 : n.rssi > -60 ? 4 : n.rssi > -70 ? 3 : n.rssi > -80 ? 2 : 1;
                                                    return (
                                                        <button key={n.id} type="button" onClick={() => void iotDevice.connectNearby(n.id)}
                                                            style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 14px', background: C.surfaceAlt, border: `1px solid ${C.border}`, borderRadius: 12, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left', width: '100%' }}>
                                                            <Bluetooth size={18} color={C.primary} style={{ flexShrink: 0 }} />
                                                            <span style={{ flex: 1, minWidth: 0 }}>
                                                                <span style={{ display: 'block', fontWeight: 700, color: C.text, fontSize: '0.88rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.name}</span>
                                                                <span style={{ display: 'block', fontSize: '0.68rem', color: C.textMuted }}>
                                                                    {n.rssi !== null ? `${n.rssi} dBm` : 'signal unknown'}{n.services.length ? ` · ${n.services.slice(0, 2).join(', ')}` : ''}
                                                                </span>
                                                            </span>
                                                            <span aria-label={`Signal ${bars} of 4`} style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 16, flexShrink: 0 }}>
                                                                {[1, 2, 3, 4].map((i) => <span key={i} style={{ width: 3, height: 4 + i * 3, borderRadius: 1, background: i <= bars ? C.safe : C.border }} />)}
                                                            </span>
                                                            <span style={{ fontSize: '0.72rem', fontWeight: 800, color: '#fff', background: C.primary, padding: '5px 10px', borderRadius: 999, flexShrink: 0 }}>Connect</span>
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                            <button type="button" onClick={() => { iotDevice.stopScan(); void iotDevice.connect(); }} style={ghostBtn}>Device not listed? Open the browser's full list</button>
                                        </>
                                    ) : (
                                        <>
                                            <button type="button" onClick={() => void iotDevice.startScan()} style={primaryBtn}>
                                                <Bluetooth size={18} /> Scan for devices
                                            </button>
                                            {!iotDevice.scanSupported && (
                                                <p style={{ margin: 0, fontSize: '0.72rem', color: C.textMuted, lineHeight: 1.5 }}>
                                                    Your browser shows nearby devices in its own pop-up. For a live list inside TrackMate, open <b>chrome://flags/#enable-experimental-web-platform-features</b> in Chrome, set it to Enabled, and restart the browser.
                                                </p>
                                            )}
                                        </>
                                    )}
                                </>
                            )}

                            {linked && (
                                <div style={{ padding: '14px 16px', background: C.surfaceAlt, border: `1px solid ${C.border}`, borderRadius: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                        <span style={{ width: 10, height: 10, borderRadius: '50%', background: dot, flexShrink: 0 }} />
                                        <b style={{ color: C.text, fontSize: '0.95rem' }}>{d.deviceName}</b>
                                        <span style={{ marginLeft: 'auto', fontSize: '0.7rem', fontWeight: 800, textTransform: 'uppercase', color: dot }}>
                                            {d.status === 'connected' ? 'Connected' : 'Reconnecting…'}
                                        </span>
                                    </div>
                                    {(d.manufacturer || d.model) && row('Device', [d.manufacturer, d.model].filter(Boolean).join(' '))}
                                    {row('Battery', typeof d.battery === 'number' ? `${d.battery}%` : 'not reported')}
                                    {typeof d.heartRate === 'number' && row('Heart rate', `${d.heartRate} bpm`)}
                                    {typeof d.spo2 === 'number' && row('SpO₂', `${d.spo2}%`)}
                                    {typeof d.steps === 'number' && row('Steps', d.steps.toLocaleString())}
                                    {row('Location source', iotDevice.devicePosition() ? 'Device GPS' : 'This phone')}
                                    {d.location && row('Device position', `${d.location.lat.toFixed(5)}, ${d.location.lng.toFixed(5)}`)}
                                    {typeof d.speedKmh === 'number' && row('Speed', `${d.speedKmh.toFixed(1)} km/h`)}
                                    {row('Last data from device', ago(d.lastDataAt))}
                                    {row('Last sync to command centre', iotDevice.lastSyncAt ? ago(iotDevice.lastSyncAt) : 'not yet')}
                                    {d.services.length > 0 && (
                                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                                            {d.services.map((name) => (
                                                <span key={name} style={{ fontSize: '0.66rem', fontWeight: 700, background: `${C.primary}1a`, color: C.primary, padding: '3px 8px', borderRadius: 999 }}>{name}</span>
                                            ))}
                                        </div>
                                    )}
                                    {d.services.length === 0 && d.status === 'connected' && (
                                        <p style={{ margin: 0, fontSize: '0.72rem', color: C.textMuted }}>
                                            Connected, but this device exposes no readable data. It still counts as paired, and this phone's location is shared on its behalf.
                                        </p>
                                    )}
                                    {iotDevice.syncError && <p role="alert" style={{ margin: 0, fontSize: '0.74rem', color: C.critical, fontWeight: 700 }}>{iotDevice.syncError}</p>}
                                </div>
                            )}

                            {d.status === 'error' && d.error && <p role="alert" style={{ margin: 0, fontSize: '0.8rem', color: C.critical, fontWeight: 700 }}>{d.error}</p>}

                            {linked && (
                                <>
                                    <button type="button" onClick={() => void iotDevice.syncNow()} disabled={iotDevice.syncing || d.status !== 'connected'} style={primaryBtn}>
                                        {iotDevice.syncing ? <Loader2 size={18} style={{ animation: 'spin-slow 1s linear infinite' }} /> : <RefreshCw size={18} />} Sync now
                                    </button>
                                    <div style={{ display: 'flex', gap: 10 }}>
                                        <button type="button" onClick={() => void iotDevice.connect()} style={ghostBtn}>Choose another device</button>
                                        <button type="button" onClick={() => iotDevice.disconnect()} style={{ ...ghostBtn, color: C.critical }}>Disconnect</button>
                                    </div>
                                </>
                            )}
                            {d.status === 'error' && (
                                <button type="button" onClick={() => void iotDevice.startScan()} style={primaryBtn}><Bluetooth size={18} /> Scan again</button>
                            )}
                        </div>
                    );
                })()}
            </ClayModal>
        </div>
    );
}

const clayInputStyle: React.CSSProperties = { width: '100%', padding: '11px 14px', background: '#F7F5FF', border: '1px solid rgba(27,29,42,0.08)', borderRadius: 14, fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: '0.88rem', fontWeight: 500, outline: 'none', color: '#1B1D2A', boxShadow: 'inset 3px 3px 6px rgba(27,29,42,0.06), inset -2px -2px 4px rgba(255,255,255,0.8)' };

function ReportAnomalyModal({ open, onClose, userLat, userLng, onSuccess, onError }: { open: boolean; onClose: () => void; userLat: number | null; userLng: number | null; onSuccess: (title: string) => void; onError: (msg: string) => void; }) {
    const [title, setTitle] = useState(''); const [description, setDescription] = useState(''); const [incidentType, setIncidentType] = useState('suspicious_activity'); const [severity, setSeverity] = useState('medium'); const [submitting, setSubmitting] = useState(false);
    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault(); if (!title.trim()) return; setSubmitting(true);
        try {
            await api.post('/incidents', { title, description, incident_type: incidentType, severity, source: 'ai_anomaly', latitude: userLat || 27.5855, longitude: userLng || 91.8594, is_public: true });
            onSuccess(title); setTitle(''); setDescription(''); onClose();
        } catch (err: any) { onError(err.response?.data?.message || 'Failed to submit'); } finally { setSubmitting(false); }
    };
    return (
        <ClayModal open={open} onClose={onClose} title="Report Safety Anomaly">
            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div><label style={{ fontSize: '0.65rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#6B6B6B', display: 'block', marginBottom: 6 }}>Incident Type</label>
                    <select value={incidentType} onChange={e => setIncidentType(e.target.value)} style={clayInputStyle}><option value="suspicious_activity">Suspicious Activity</option><option value="crime">Crime (Theft/Harassment)</option><option value="medical_emergency">Medical Emergency</option><option value="natural_disaster">Natural Disaster</option><option value="infrastructure_hazard">Infrastructure Hazard</option><option value="accident">Accident / Other</option></select>
                </div>
                <div><label style={{ fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: C.textMuted, display: 'block', marginBottom: 6 }}>Title</label><input value={title} onChange={e => setTitle(e.target.value)} style={clayInputStyle} placeholder="Brief summary" required /></div>
                <div><label style={{ fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: C.textMuted, display: 'block', marginBottom: 6 }}>Description</label><textarea value={description} onChange={e => setDescription(e.target.value)} style={{ ...clayInputStyle, resize: 'vertical' as const, minHeight: 80 }} rows={3} placeholder="Details about what you observed..." /></div>
                <div><label style={{ fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: C.textMuted, display: 'block', marginBottom: 6 }}>Severity</label>
                    <div style={{ display: 'flex', gap: 8 }}>
                        {(['low', 'medium', 'high', 'critical'] as const).map(s => {
                            const col = s === 'low' ? C.safe : s === 'medium' ? C.primary : s === 'high' ? C.moderate : C.critical;
                            return <button key={s} type="button" onClick={() => setSeverity(s)} style={{ flex: 1, padding: '8px 4px', background: severity === s ? col : C.surfaceAlt, color: severity === s ? '#FFFFFF' : C.text, border: severity === s ? 'none' : `1px solid ${C.border}`, borderRadius: 10, fontFamily: 'inherit', fontWeight: 700, fontSize: '0.68rem', textTransform: 'uppercase', cursor: 'pointer', boxShadow: severity === s ? `0 4px 12px ${col}40` : '4px 4px 8px rgba(27,29,42,0.06), -2px -2px 6px rgba(255,255,255,0.9)' }}>{s}</button>;
                        })}
                    </div>
                </div>
                <div style={{ padding: '10px 14px', background: C.surfaceAlt, borderRadius: 12, border: `1px solid ${C.border}`, fontSize: '0.75rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8, color: C.textMuted }}>
                    <MapPin size={12} color={C.primary} /> {userLat?.toFixed(4)}, {userLng?.toFixed(4)} (auto-detected)
                </div>
                <button type="submit" disabled={submitting || !title.trim()} style={{ width: '100%', padding: 13, background: 'linear-gradient(135deg, #FBBF24, #F59E0B)', border: 'none', borderRadius: 14, fontFamily: 'inherit', fontWeight: 800, fontSize: '0.88rem', cursor: 'pointer', textTransform: 'uppercase', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, color: '#FFFFFF', boxShadow: '0 4px 12px rgba(251,191,36,0.3)', opacity: (submitting || !title.trim()) ? 0.6 : 1 }}>
                    {submitting ? <Loader2 size={16} style={{ animation: 'spin-slow 1s linear infinite' }} /> : <Send size={16} />} Submit Report
                </button>
            </form>
        </ClayModal>
    );
}

function UpdateTripModal({ open, onClose, trip, onSuccess, onError }: { open: boolean; onClose: () => void; trip: any; onSuccess: () => void; onError: (msg: string) => void; }) {
    const [destination, setDestination] = useState(''); const [startDate, setStartDate] = useState(''); const [endDate, setEndDate] = useState(''); const [submitting, setSubmitting] = useState(false);
    useEffect(() => { if (trip) { setDestination(trip.destination_region || ''); setStartDate(trip.start_date ? trip.start_date.split('T')[0] : ''); setEndDate(trip.end_date ? trip.end_date.split('T')[0] : ''); } }, [trip]);
    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault(); if (!trip?._id) return; setSubmitting(true);
        try { await api.patch(`/trips/${trip._id}`, { destination_region: destination, start_date: startDate, end_date: endDate }); onSuccess(); onClose(); }
        catch (err: any) { onError(err.response?.data?.message || 'Failed to update trip'); } finally { setSubmitting(false); }
    };
    return (
        <ClayModal open={open} onClose={onClose} title="Update Travel Plan">
            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div><label style={{ fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: C.textMuted, display: 'block', marginBottom: 6 }}>Destination Region</label><input value={destination} onChange={e => setDestination(e.target.value)} style={clayInputStyle} placeholder="e.g. Tawang District" required /></div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <div><label style={{ fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: C.textMuted, display: 'block', marginBottom: 6 }}>Start Date</label><input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} style={clayInputStyle} required /></div>
                    <div><label style={{ fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: C.textMuted, display: 'block', marginBottom: 6 }}>End Date</label><input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} style={clayInputStyle} required /></div>
                </div>
                <button type="submit" disabled={submitting} style={{ width: '100%', padding: 13, background: 'linear-gradient(135deg, #6C63FF, #8B85FF)', border: 'none', borderRadius: 14, fontFamily: 'inherit', fontWeight: 800, fontSize: '0.88rem', cursor: 'pointer', textTransform: 'uppercase', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, color: '#FFFFFF', boxShadow: '0 4px 12px rgba(108,99,255,0.25)' }}>
                    {submitting ? <Loader2 size={16} style={{ animation: 'spin-slow 1s linear infinite' }} /> : <Check size={16} />} Save Changes
                </button>
            </form>
        </ClayModal>
    );
}
