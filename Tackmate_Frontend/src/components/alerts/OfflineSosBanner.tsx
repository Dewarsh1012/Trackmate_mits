import { useEffect, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { SOS_QUEUE_EVENT, flushOfflineSosQueue, getOfflineSosQueue, startOfflineSosSync } from '../../lib/offlineSos';

const SMS_NUMBER = import.meta.env.VITE_SOS_SMS_NUMBER || '112';

/**
 * Shown while an SOS is stuck on the device (no network). It retries automatically and offers an
 * SMS fallback, which works on cellular signal alone, with no mobile data.
 */
export default function OfflineSosBanner() {
    const { user } = useAuth();
    const [count, setCount] = useState(0);
    const [retrying, setRetrying] = useState(false);

    useEffect(() => {
        if (!user) return;
        const onChange = (e: Event) => setCount((e as CustomEvent<{ count: number }>).detail.count);
        window.addEventListener(SOS_QUEUE_EVENT, onChange);
        const stop = startOfflineSosSync();
        return () => { window.removeEventListener(SOS_QUEUE_EVENT, onChange); stop(); };
    }, [user]);

    if (!user || count === 0) return null;

    const newest = getOfflineSosQueue()[0];
    const lat = newest?.payload?.latitude;
    const lng = newest?.payload?.longitude;
    const where = typeof lat === 'number' && typeof lng === 'number' ? ` My location: https://maps.google.com/?q=${lat},${lng}` : '';
    const body = encodeURIComponent(`SOS! ${user.full_name} needs urgent help.${where} (sent via TrackMate)`);

    return (
        <div role="alert" style={{ position: 'fixed', left: 0, right: 0, top: 0, zIndex: 99999, background: '#B42318', color: '#fff', padding: '10px 14px', display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', fontSize: '0.85rem', fontWeight: 700, fontFamily: "'Inter', sans-serif" }}>
            <span>
                {count} SOS alert{count > 1 ? 's' : ''} saved on this device. {navigator.onLine ? 'Retrying…' : 'No network.'} It will be sent the moment you have signal.
            </span>
            <button type="button" disabled={retrying} onClick={async () => { setRetrying(true); try { await flushOfflineSosQueue(); } finally { setRetrying(false); } }}
                style={{ background: '#fff', color: '#B42318', border: 'none', borderRadius: 999, padding: '6px 14px', fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit' }}>
                {retrying ? 'Sending…' : 'Retry now'}
            </button>
            <a href={`sms:${SMS_NUMBER}?body=${body}`}
                style={{ background: 'rgba(255,255,255,0.2)', color: '#fff', borderRadius: 999, padding: '6px 14px', fontWeight: 800, textDecoration: 'none' }}>
                Send by SMS
            </a>
        </div>
    );
}
