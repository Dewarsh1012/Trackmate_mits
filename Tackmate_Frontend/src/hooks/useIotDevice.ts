import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import api from '../lib/api';
import { iot, isBluetoothSupported, isScanSupported, type IotSnapshot } from '../lib/iotDevice';

const SYNC_EVERY_MS = 20_000;
const MIN_GAP_MS = 5_000;
const FRESH_MS = 60_000;
const SOS_COOLDOWN_MS = 60_000;

interface Options {
    /** The phone's own position, used whenever the device doesn't report one. */
    phonePos: { lat: number; lng: number } | null;
    /** Called when the connected device raises an SOS (panic button / "SOS" message). */
    onSos: (device: IotSnapshot) => void;
}

/**
 * Keeps the connected Bluetooth device's data flowing to the command centre: location (from the device
 * when it has GPS, otherwise the phone), battery, and SOS presses.
 */
export function useIotDevice({ phonePos, onSos }: Options) {
    const snapshot = useSyncExternalStore(iot.subscribe, iot.getSnapshot);
    const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
    const [syncError, setSyncError] = useState<string | null>(null);
    const [syncing, setSyncing] = useState(false);

    const phoneRef = useRef(phonePos);
    phoneRef.current = phonePos;
    const onSosRef = useRef(onSos);
    onSosRef.current = onSos;
    const lastPushRef = useRef(0);

    /** The device's own fix when it is recent, else null. */
    const devicePosition = useCallback((): { lat: number; lng: number } | null => {
        const loc = iot.getSnapshot().location;
        return loc && Date.now() - loc.at < FRESH_MS ? { lat: loc.lat, lng: loc.lng } : null;
    }, []);

    const push = useCallback(async (force = false) => {
        const snap = iot.getSnapshot();
        if (snap.status !== 'connected') return;
        if (!force && Date.now() - lastPushRef.current < MIN_GAP_MS) return;
        const pos = devicePosition() ?? phoneRef.current;
        if (!pos) { setSyncError('Waiting for a location from the device or this phone.'); return; }

        lastPushRef.current = Date.now();
        setSyncing(true);
        try {
            await api.post('/locations', {
                latitude: pos.lat,
                longitude: pos.lng,
                source: 'iot_band',
                ...(typeof snap.battery === 'number' ? { battery_level: Math.round(snap.battery) } : {}),
                ...(typeof snap.speedKmh === 'number' && Number.isFinite(snap.speedKmh) ? { speed: snap.speedKmh } : {}),
            });
            setLastSyncAt(Date.now());
            setSyncError(null);
        } catch {
            setSyncError('Could not reach the server. Will retry automatically.');
        } finally {
            setSyncing(false);
        }
    }, [devicePosition]);

    const connected = snapshot.status === 'connected';

    // Tell the server which device is mine, so an authority who pairs with it knows who to alert.
    const registeredRef = useRef<string | null>(null);
    useEffect(() => {
        const name = snapshot.deviceName;
        if (!connected || !name || registeredRef.current === name) return;
        registeredRef.current = name;
        api.post('/hooter/devices', { device_name: name }).catch(() => { registeredRef.current = null; });
    }, [connected, snapshot.deviceName]);

    // Periodic sync while connected, plus an immediate one on connect.
    useEffect(() => {
        if (!connected) return;
        void push(true);
        const timer = setInterval(() => { void push(); }, SYNC_EVERY_MS);
        return () => clearInterval(timer);
    }, [connected, push]);

    // New device GPS fix: send right away (rate-limited).
    const locationAt = snapshot.location?.at ?? 0;
    // If the last sync was under 5 s ago, the new fix is sent as soon as that gap has passed (never dropped).
    useEffect(() => {
        if (!connected || !locationAt) return;
        const wait = Math.max(0, MIN_GAP_MS - (Date.now() - lastPushRef.current));
        const timer = setTimeout(() => { void push(true); }, wait);
        return () => clearTimeout(timer);
    }, [connected, locationAt, push]);

    // Panic press on the device.
    const lastSosRef = useRef(0);
    useEffect(() => {
        if (!snapshot.sosAt || snapshot.sosAt === lastSosRef.current) return;
        if (Date.now() - lastSosRef.current < SOS_COOLDOWN_MS && lastSosRef.current !== 0) return;
        lastSosRef.current = snapshot.sosAt;
        onSosRef.current(snapshot);
    }, [snapshot]);

    return {
        snapshot,
        supported: isBluetoothSupported(),
        scanSupported: isScanSupported(),
        startScan: () => iot.startScan(),
        stopScan: () => iot.stopScan(),
        connectNearby: (id: string) => iot.connectNearby(id),
        connect: () => iot.connect(),
        disconnect: () => iot.disconnect(),
        syncNow: () => push(true),
        devicePosition,
        lastSyncAt,
        syncError,
        syncing,
    };
}
