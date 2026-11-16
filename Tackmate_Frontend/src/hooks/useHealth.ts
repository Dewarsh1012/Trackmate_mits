import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../lib/api';
import { useSocket } from '../context/SocketContext';
import type { IotSnapshot } from '../lib/iotDevice';

export interface VitalValue { value: number; at: string; source: 'bluetooth' | 'health_app' | 'manual'; device: string | null }
export interface HealthToday {
    steps: VitalValue | null;
    heart_rate: VitalValue | null;
    spo2: VitalValue | null;
    series: { at: string; heart_rate: number | null; spo2: number | null }[];
}

const REFRESH_MS = 60_000;
const DEVICE_PUSH_GAP_MS = 30_000;

/**
 * Today's steps, heart rate and SpO2 for the dashboard. Values come from three places and all
 * land in the same store: a connected Bluetooth device, a health app via the personal key, and manual entry.
 */
export function useHealth(device: IotSnapshot) {
    const { socket } = useSocket();
    const [today, setToday] = useState<HealthToday | null>(null);
    const [loading, setLoading] = useState(true);

    const refresh = useCallback(async () => {
        try {
            const res = await api.get('/health/today');
            setToday(res.data.data);
        } catch { /* keep the last values */ } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void refresh();
        const timer = setInterval(refresh, REFRESH_MS);
        return () => clearInterval(timer);
    }, [refresh]);

    // A health app (or another session) pushed something: update at once.
    useEffect(() => {
        if (!socket) return;
        const onUpdate = () => { void refresh(); };
        socket.on('health:update', onUpdate);
        return () => { socket.off('health:update', onUpdate); };
    }, [socket, refresh]);

    // Vitals reported by the connected Bluetooth device are stored as they change (at most every 30 s).
    const sentRef = useRef<{ at: number; hr: number | null; spo2: number | null; steps: number | null }>({ at: 0, hr: null, spo2: null, steps: null });
    const { status, heartRate, spo2, steps, deviceName } = device;
    useEffect(() => {
        if (status !== 'connected') return;
        const changed = heartRate !== sentRef.current.hr || spo2 !== sentRef.current.spo2 || steps !== sentRef.current.steps;
        if (!changed || (heartRate === null && spo2 === null && steps === null)) return;
        const wait = Math.max(0, DEVICE_PUSH_GAP_MS - (Date.now() - sentRef.current.at));
        const timer = setTimeout(async () => {
            sentRef.current = { at: Date.now(), hr: heartRate, spo2, steps };
            try {
                await api.post('/health', {
                    ...(heartRate !== null ? { heart_rate: heartRate } : {}),
                    ...(spo2 !== null ? { spo2 } : {}),
                    ...(steps !== null ? { steps } : {}),
                    source: 'bluetooth',
                    device_name: deviceName ?? undefined,
                });
                void refresh();
            } catch { sentRef.current.at = 0; /* retry on the next change */ }
        }, wait);
        return () => clearTimeout(timer);
    }, [status, heartRate, spo2, steps, deviceName, refresh]);

    const addManual = useCallback(async (values: { steps?: number; heart_rate?: number; spo2?: number }) => {
        await api.post('/health', { ...values, source: 'manual' });
        await refresh();
    }, [refresh]);

    return { today, loading, refresh, addManual };
}
