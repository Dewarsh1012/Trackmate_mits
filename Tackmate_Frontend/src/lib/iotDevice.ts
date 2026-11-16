/**
 * Bluetooth LE bridge for safety bands, trackers, phones running a BLE peripheral app, and any other
 * IoT device. Built on the browser's Web Bluetooth API only (no extra libraries).
 *
 * What it understands:
 *  - Standard GATT profiles: Battery, Heart Rate, Location & Navigation (GPS), Device Information.
 *  - Serial-over-BLE devices (Nordic UART, HM-10/JDY "FFE0", ISSC, or any custom notify characteristic):
 *    the text they send is parsed as JSON, NMEA (GGA/RMC), "lat,lng" or a plain "SOS" keyword.
 */

export type IotStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error';

export interface IotSnapshot {
    status: IotStatus;
    deviceName: string | null;
    deviceId: string | null;
    manufacturer: string | null;
    model: string | null;
    services: string[];
    battery: number | null;
    heartRate: number | null;
    spo2: number | null;
    steps: number | null;
    location: { lat: number; lng: number; at: number } | null;
    speedKmh: number | null;
    sosAt: number | null;
    lastDataAt: number | null;
    error: string | null;
    /** In-app scan: true while listening for nearby Bluetooth advertisements. */
    scanning: boolean;
    nearby: NearbyDevice[];
    /** True when the connected device accepts a remote "find me" alert (standard Immediate Alert service). */
    canRing: boolean;
    /** How a remote alarm reaches this device: standard Find-Me alert, a serial command, or the link-loss alarm. */
    ringMethod: 'immediate' | 'serial' | 'link_loss' | null;
    /** Link-loss alarm has been armed and the device was disconnected so it starts sounding. */
    alarmArmed: boolean;
}

export interface NearbyDevice {
    id: string;
    name: string;
    rssi: number | null;
    lastSeen: number;
    services: string[];
}

const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const ISSC_SERVICE = '49535343-fe7d-4ae5-8fa9-9fafd205e455';
const NUS_RX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
const ISSC_RX = '49535343-8841-43f4-a8d4-ecbe34729bb3';

/** Services the browser may touch after pairing (Web Bluetooth only exposes services listed up front). */
const OPTIONAL_SERVICES: Array<number | string> = [
    0x1800, 0x1801, 0x1802, 0x1803, 0x1804, 0x1805, 0x180a, 0x180d, 0x180f, 0x1808, 0x1809, 0x1810, 0x1811,
    0x1814, 0x1815, 0x1816, 0x1818, 0x1819, 0x181a, 0x181c, 0x181d, 0x1821, 0x1822, 0x1826,
    0xffe0, 0xfff0, 0xfee0, 0xfee7, NUS_SERVICE, ISSC_SERVICE,
];

const SERVICE_LABELS: Record<number, string> = {
    0x1802: 'Immediate Alert', 0x1803: 'Link Loss', 0x1804: 'TX Power', 0x180a: 'Device Information',
    0x180d: 'Heart Rate', 0x180f: 'Battery', 0x1809: 'Thermometer', 0x1810: 'Blood Pressure',
    0x1814: 'Running Speed', 0x1816: 'Cycling Speed', 0x1818: 'Cycling Power', 0x1819: 'Location & Navigation',
    0x181a: 'Environmental Sensing', 0x1821: 'Indoor Positioning', 0x1822: 'Pulse Oximeter', 0x1826: 'Fitness Machine',
    0xffe0: 'Serial (HM-10)', 0xfff0: 'Custom Serial',
};

const BASE_UUID_SUFFIX = '-0000-1000-8000-00805f9b34fb';
const toUuid = (n: number) => `0000${n.toString(16).padStart(4, '0')}${BASE_UUID_SUFFIX}`;
const isStandardUuid = (uuid: string) => uuid.endsWith(BASE_UUID_SUFFIX) && uuid.startsWith('0000');
const short = (uuid: string): number | null => (isStandardUuid(uuid) ? parseInt(uuid.slice(4, 8), 16) : null);

function labelFor(uuid: string): string {
    if (uuid === NUS_SERVICE) return 'Serial (Nordic UART)';
    if (uuid === ISSC_SERVICE) return 'Serial (ISSC)';
    const s = short(uuid);
    if (s !== null) return SERVICE_LABELS[s] ?? `Service 0x${s.toString(16)}`;
    return `Custom ${uuid.slice(0, 8)}`;
}

/* ── Parsers ─────────────────────────────────────────────────────────── */

export function parseHeartRate(view: DataView): number {
    const flags = view.getUint8(0);
    return flags & 0x01 ? view.getUint16(1, true) : view.getUint8(1);
}

/** IEEE-11073 16-bit SFLOAT, used by medical profiles (pulse oximeter, thermometer...). */
function sfloat(raw: number): number | null {
    if (raw >= 0x07fe && raw <= 0x0802) return null; // NaN / NRes / +-Infinity reserved values
    let mantissa = raw & 0x0fff;
    if (mantissa >= 0x0800) mantissa -= 0x1000;
    let exponent = raw >> 12;
    if (exponent >= 0x8) exponent -= 0x10;
    return mantissa * Math.pow(10, exponent);
}

/** Pulse Oximeter spot-check (0x2A5E) / continuous (0x2A5F) measurement: SpO2 % and pulse rate. */
export function parsePulseOximeter(view: DataView): { spo2?: number; pulse?: number } {
    if (view.byteLength < 5) return {};
    const spo2 = sfloat(view.getUint16(1, true));
    const pulse = sfloat(view.getUint16(3, true));
    return {
        ...(spo2 !== null && spo2 >= 50 && spo2 <= 100 ? { spo2: Math.round(spo2 * 10) / 10 } : {}),
        ...(pulse !== null && pulse >= 20 && pulse <= 250 ? { pulse: Math.round(pulse) } : {}),
    };
}

/** Location and Speed characteristic (0x2A67): speed, distance, then position (1e-7 degrees). */
export function parseLocationAndSpeed(view: DataView): { lat?: number; lng?: number; speedKmh?: number } {
    const flags = view.getUint16(0, true);
    let offset = 2;
    const out: { lat?: number; lng?: number; speedKmh?: number } = {};
    if (flags & 0x0001) { out.speedKmh = (view.getUint16(offset, true) / 100) * 3.6; offset += 2; }
    if (flags & 0x0002) offset += 3; // total distance (uint24)
    if (flags & 0x0004) {
        out.lat = view.getInt32(offset, true) / 1e7;
        out.lng = view.getInt32(offset + 4, true) / 1e7;
    }
    return out;
}

const validCoord = (lat: unknown, lng: unknown): lat is number =>
    typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng) &&
    Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);

function nmeaToDegrees(value: string, hemisphere: string): number | null {
    const dot = value.indexOf('.');
    if (dot < 3) return null;
    const degrees = parseInt(value.slice(0, dot - 2), 10);
    const minutes = parseFloat(value.slice(dot - 2));
    if (!Number.isFinite(degrees) || !Number.isFinite(minutes)) return null;
    const result = degrees + minutes / 60;
    return hemisphere === 'S' || hemisphere === 'W' ? -result : result;
}

export interface TextReading { lat?: number; lng?: number; battery?: number; heartRate?: number; spo2?: number; steps?: number; speedKmh?: number; sos?: boolean }

/** Understands the line formats serial IoT devices commonly emit. */
export function parseTextLine(rawLine: string): TextReading | null {
    const line = rawLine.trim();
    if (!line) return null;

    if (line.startsWith('{')) {
        try {
            const j = JSON.parse(line);
            const lat = j.lat ?? j.latitude;
            const lng = j.lng ?? j.lon ?? j.long ?? j.longitude;
            const out: TextReading = {};
            if (validCoord(lat, lng)) { out.lat = lat; out.lng = lng; }
            const battery = j.battery ?? j.bat ?? j.batt;
            if (typeof battery === 'number') out.battery = Math.max(0, Math.min(100, Math.round(battery)));
            const hr = j.hr ?? j.heart_rate ?? j.heartRate ?? j.bpm;
            if (typeof hr === 'number') out.heartRate = Math.round(hr);
            const spo2 = j.spo2 ?? j.SpO2 ?? j.oxygen ?? j.blood_oxygen;
            if (typeof spo2 === 'number' && spo2 >= 50 && spo2 <= 100) out.spo2 = spo2;
            const steps = j.steps ?? j.step ?? j.step_count ?? j.stepCount;
            if (typeof steps === 'number' && steps >= 0) out.steps = Math.round(steps);
            const speed = j.speed ?? j.speed_kmh;
            if (typeof speed === 'number') out.speedKmh = speed;
            if (j.sos === true || j.sos === 1 || j.panic === true || j.panic === 1 || j.alert === 'sos' || j.type === 'sos') out.sos = true;
            return Object.keys(out).length ? out : null;
        } catch { /* not JSON: fall through to the other formats */ }
    }

    if (line.startsWith('$')) {
        const f = line.split('*')[0].split(',');
        const kind = f[0].slice(3);
        if (kind === 'GGA' && Number(f[6]) > 0) {
            const lat = nmeaToDegrees(f[2], f[3]);
            const lng = nmeaToDegrees(f[4], f[5]);
            if (lat !== null && lng !== null && validCoord(lat, lng)) return { lat, lng };
        }
        if (kind === 'RMC' && f[2] === 'A') {
            const lat = nmeaToDegrees(f[3], f[4]);
            const lng = nmeaToDegrees(f[5], f[6]);
            if (lat !== null && lng !== null && validCoord(lat, lng)) {
                const knots = parseFloat(f[7]);
                return { lat, lng, ...(Number.isFinite(knots) ? { speedKmh: knots * 1.852 } : {}) };
            }
        }
        return null;
    }

    const pair = line.match(/^(-?\d{1,3}\.\d+)\s*[,;\s]\s*(-?\d{1,3}\.\d+)$/);
    if (pair && validCoord(Number(pair[1]), Number(pair[2]))) return { lat: Number(pair[1]), lng: Number(pair[2]) };

    if (/\b(SOS|PANIC|EMERGENCY|HELP)\b/i.test(line)) return { sos: true };
    return null;
}

/* ── Connection manager (singleton, so the link survives the modal closing) ── */

const initial: IotSnapshot = {
    status: 'idle', deviceName: null, deviceId: null, manufacturer: null, model: null, services: [],
    battery: null, heartRate: null, spo2: null, steps: null, location: null, speedKmh: null, sosAt: null, lastDataAt: null, error: null,
    scanning: false, nearby: [], canRing: false, ringMethod: null, alarmArmed: false,
};

const MAX_RECONNECTS = 6;

class IotManager {
    private snapshot: IotSnapshot = { ...initial };
    private listeners = new Set<() => void>();
    private device: any = null;
    private manualDisconnect = false;
    private textBuffer = '';
    private scanHandle: any = null;
    private scanListener: ((e: any) => void) | null = null;
    private scanPruneTimer: ReturnType<typeof setInterval> | null = null;
    private scanStopTimer: ReturnType<typeof setTimeout> | null = null;
    private seen = new Map<string, NearbyDevice>();
    private alertChar: any = null;
    private linkLossChar: any = null;
    private serialWriteChar: any = null;

    subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
    getSnapshot = () => this.snapshot;

    private set(patch: Partial<IotSnapshot>) {
        this.snapshot = { ...this.snapshot, ...patch };
        this.listeners.forEach((fn) => fn());
    }

    static supported(): boolean {
        return typeof navigator !== 'undefined' && 'bluetooth' in navigator;
    }

    /** True when the browser can list nearby devices inside the page (Chrome with experimental web-platform features on). */
    static scanSupported(): boolean {
        return typeof navigator !== 'undefined' && !!(navigator as any).bluetooth && typeof (navigator as any).bluetooth.requestLEScan === 'function';
    }

    /**
     * Scans for nearby Bluetooth devices and keeps a live list (name, signal strength) in the snapshot.
     * Where the browser cannot scan inside the page, falls back to its own device picker.
     */
    async startScan(): Promise<void> {
        const bt = (navigator as any).bluetooth;
        if (!bt) { await this.connect(); return; }
        if (!IotManager.scanSupported()) { await this.connect(); return; }
        if (this.scanHandle) return;

        this.seen.clear();
        this.set({ scanning: true, nearby: [], error: null, status: this.snapshot.status === 'error' ? 'idle' : this.snapshot.status });
        try {
            this.scanListener = (event: any) => {
                const id: string = event.device?.id;
                if (!id) return;
                const uuids: string[] = Array.from(event.uuids ?? []).map((u: any) => labelFor(String(u)));
                const previous = this.seen.get(id);
                this.seen.set(id, {
                    id,
                    name: event.name || event.device?.name || previous?.name || 'Unnamed device',
                    rssi: typeof event.rssi === 'number' ? event.rssi : previous?.rssi ?? null,
                    lastSeen: Date.now(),
                    services: uuids.length ? uuids : previous?.services ?? [],
                });
                this.publishNearby();
            };
            bt.addEventListener('advertisementreceived', this.scanListener);
            this.scanHandle = await bt.requestLEScan({ acceptAllAdvertisements: true, keepRepeatedDevices: true });
            // Forget devices that stopped advertising, and stop on our own after a minute (battery).
            this.scanPruneTimer = setInterval(() => this.publishNearby(), 3000);
            this.scanStopTimer = setTimeout(() => this.stopScan(), 60_000);
        } catch (err: any) {
            this.stopScan();
            // Permission refused or scanning unavailable: use the browser's picker instead.
            if (err?.name === 'NotAllowedError' || err?.name === 'NotSupportedError' || err?.name === 'SecurityError') {
                await this.connect();
                return;
            }
            this.set({ status: 'error', error: err?.message || 'Bluetooth scan failed.' });
        }
    }

    stopScan(): void {
        const bt = (navigator as any).bluetooth;
        try { this.scanHandle?.stop(); } catch { /* already stopped */ }
        if (bt && this.scanListener) bt.removeEventListener('advertisementreceived', this.scanListener);
        if (this.scanPruneTimer) clearInterval(this.scanPruneTimer);
        if (this.scanStopTimer) clearTimeout(this.scanStopTimer);
        this.scanHandle = null; this.scanListener = null; this.scanPruneTimer = null; this.scanStopTimer = null;
        if (this.snapshot.scanning) this.set({ scanning: false });
    }

    private publishNearby() {
        const cutoff = Date.now() - 20_000;
        for (const [id, d] of this.seen) if (d.lastSeen < cutoff) this.seen.delete(id);
        const list = [...this.seen.values()].sort((a, b) => (b.rssi ?? -127) - (a.rssi ?? -127));
        this.set({ nearby: list });
    }

    /** Connects to a device picked from the in-app list. The browser still asks permission once, narrowed to that device. */
    async connectNearby(id: string): Promise<void> {
        const entry = this.seen.get(id) ?? this.snapshot.nearby.find((d) => d.id === id);
        this.stopScan();
        await this.connect(entry && entry.name !== 'Unnamed device' ? entry.name : undefined);
    }

    /** Opens the browser's own device picker (it lists every nearby BLE device), then connects to the chosen one. */
    async connect(onlyName?: string): Promise<void> {
        const bt = (navigator as any).bluetooth;
        if (!bt) {
            this.set({ status: 'error', error: 'This browser has no Bluetooth access. Use Chrome or Edge on Android, Windows, macOS or Linux (iPhone browsers do not support it).' });
            return;
        }
        this.manualDisconnect = false;
        let device: any;
        try {
            device = await bt.requestDevice(
                onlyName
                    ? { filters: [{ name: onlyName }], optionalServices: OPTIONAL_SERVICES }
                    : { acceptAllDevices: true, optionalServices: OPTIONAL_SERVICES }
            );
        } catch (err: any) {
            // Closing the picker without choosing is not an error.
            if (err?.name === 'NotFoundError') return;
            this.set({ status: 'error', error: err?.message || 'Could not open the Bluetooth device list.' });
            return;
        }
        this.stopScan();
        this.detach();
        this.device = device;
        device.addEventListener('gattserverdisconnected', this.onDisconnected);
        this.set({ ...initial, status: 'connecting', deviceName: device.name || 'Unnamed device', deviceId: device.id });
        await this.openLink(false);
    }

    /**
     * Sounds (level 2) or silences (level 0) a remote alarm on the connected device. Tries, in order:
     *  1. the standard Immediate Alert ("Find Me") service that most bands and trackers implement;
     *  2. a text command on a serial channel: "ALARM:ON\n" / "ALARM:OFF\n" (for custom firmware);
     *  3. the Link Loss alarm: arms the alert level and disconnects, which makes supporting devices sound.
     */
    async ring(level: 0 | 1 | 2): Promise<boolean> {
        const write = async (ch: any, bytes: Uint8Array) => {
            if (typeof ch.writeValueWithoutResponse === 'function') await ch.writeValueWithoutResponse(bytes);
            else await ch.writeValue(bytes);
        };
        try {
            if (this.alertChar) { await write(this.alertChar, new Uint8Array([level])); return true; }
            if (this.serialWriteChar) { await write(this.serialWriteChar, new TextEncoder().encode(level > 0 ? 'ALARM:ON\n' : 'ALARM:OFF\n')); return true; }
            if (this.linkLossChar && this.device) {
                if (level > 0) {
                    await write(this.linkLossChar, new Uint8Array([2]));
                    this.manualDisconnect = true; // an intentional drop: don't auto-reconnect
                    try { this.device.gatt.disconnect(); } catch { /* already closed */ }
                    this.set({ alarmArmed: true });
                    return true;
                }
                // Silence: reconnect, then reset the alert level so the device stops sounding.
                this.manualDisconnect = false;
                const server = await this.device.gatt.connect();
                const service = await server.getPrimaryService(0x1803);
                const ch = await service.getCharacteristic(0x2a06);
                await write(ch, new Uint8Array([0]));
                this.set({ alarmArmed: false });
                void this.openLink(true);
                return true;
            }
        } catch {
            return false;
        }
        return false;
    }

    disconnect(): void {
        this.manualDisconnect = true;
        try { this.device?.gatt?.disconnect(); } catch { /* already closed */ }
        this.detach();
        this.device = null;
        this.set({ ...initial });
    }

    private detach() {
        if (this.device) this.device.removeEventListener('gattserverdisconnected', this.onDisconnected);
    }

    private onDisconnected = () => {
        if (this.manualDisconnect || !this.device) return;
        void this.reconnect();
    };

    private async reconnect() {
        for (let attempt = 1; attempt <= MAX_RECONNECTS; attempt++) {
            if (this.manualDisconnect || !this.device) return;
            this.set({ status: 'reconnecting', error: null });
            await new Promise((r) => setTimeout(r, Math.min(15000, 1500 * attempt)));
            if (this.manualDisconnect || !this.device) return;
            if (await this.openLink(true)) return;
        }
        this.set({ status: 'error', error: 'The device went out of range. Move closer and press "Connect device" again.' });
    }

    /** Connects GATT and subscribes to everything useful. Returns true on success. */
    private async openLink(isRetry: boolean): Promise<boolean> {
        try {
            const server = await this.device.gatt.connect();
            let services: any[] = [];
            try { services = await server.getPrimaryServices(); } catch { /* none of the allowed services exist: still connected */ }

            this.textBuffer = '';
            this.alertChar = null;
            this.linkLossChar = null;
            this.serialWriteChar = null;
            const names: string[] = [];
            for (const service of services) {
                names.push(labelFor(service.uuid));
                await this.attachService(service).catch(() => undefined);
            }
            this.set({ status: 'connected', services: [...new Set(names)], error: null, lastDataAt: Date.now(), canRing: Boolean(this.alertChar || this.serialWriteChar || this.linkLossChar), ringMethod: this.alertChar ? 'immediate' : this.serialWriteChar ? 'serial' : this.linkLossChar ? 'link_loss' : null, alarmArmed: false });
            return true;
        } catch (err: any) {
            if (!isRetry) this.set({ status: 'error', error: err?.message || 'Could not connect to the device.' });
            return false;
        }
    }

    private async attachService(service: any) {
        const s = short(service.uuid);
        const characteristics: any[] = await service.getCharacteristics().catch(() => []);

        for (const ch of characteristics) {
            const c = short(ch.uuid);
            const canNotify = ch.properties?.notify || ch.properties?.indicate;
            const canWrite = ch.properties?.write || ch.properties?.writeWithoutResponse;

            // Writable serial channels (Nordic UART RX, HM-10 FFE1, ISSC): used to send the alarm command.
            if (canWrite && (ch.uuid === NUS_RX || (s === 0xffe0 && c === 0xffe1) || ch.uuid === ISSC_RX)) this.serialWriteChar = ch;

            if (s === 0x1802 && c === 0x2a06) {
                this.alertChar = ch; // Immediate Alert, Alert Level: 0 off, 1 mild, 2 high
            } else if (s === 0x1803 && c === 0x2a06) {
                this.linkLossChar = ch; // Link Loss, Alert Level: what the device does when the link drops
            } else if (s === 0x180f && c === 0x2a19) {
                await this.readInto(ch, (v) => this.set({ battery: v.getUint8(0), lastDataAt: Date.now() }));
                if (canNotify) await this.listen(ch, (v) => this.set({ battery: v.getUint8(0), lastDataAt: Date.now() }));
            } else if (s === 0x180d && c === 0x2a37) {
                if (canNotify) await this.listen(ch, (v) => this.set({ heartRate: parseHeartRate(v), lastDataAt: Date.now() }));
            } else if (s === 0x1822 && (c === 0x2a5e || c === 0x2a5f)) {
                const apply = (v: DataView) => {
                    const r = parsePulseOximeter(v);
                    if (r.spo2 !== undefined || r.pulse !== undefined) {
                        this.set({
                            ...(r.spo2 !== undefined ? { spo2: r.spo2 } : {}),
                            ...(r.pulse !== undefined ? { heartRate: r.pulse } : {}),
                            lastDataAt: Date.now(),
                        });
                    }
                };
                if (canNotify) await this.listen(ch, apply);
                else await this.readInto(ch, apply);
            } else if (s === 0x1819 && c === 0x2a67) {
                if (canNotify) await this.listen(ch, (v) => this.onLocation(parseLocationAndSpeed(v)));
            } else if (s === 0x180a && (c === 0x2a29 || c === 0x2a24)) {
                await this.readInto(ch, (v) => {
                    const text = new TextDecoder().decode(v).replace(/\0/g, '').trim();
                    this.set(c === 0x2a29 ? { manufacturer: text || null } : { model: text || null });
                });
            } else if (s === null && canNotify) {
                // Vendor-defined / serial services: treat the stream as text.
                await this.listen(ch, (v) => this.onText(new TextDecoder().decode(v)));
            } else if ((s === 0xffe0 || s === 0xfff0) && canNotify) {
                await this.listen(ch, (v) => this.onText(new TextDecoder().decode(v)));
            }
        }
    }

    private async readInto(ch: any, handler: (v: DataView) => void) {
        if (!ch.properties?.read) return;
        try { handler(await ch.readValue()); } catch { /* characteristic not readable right now */ }
    }

    private async listen(ch: any, handler: (v: DataView) => void) {
        ch.addEventListener('characteristicvaluechanged', (e: any) => handler(e.target.value as DataView));
        await ch.startNotifications();
    }

    private onLocation(r: { lat?: number; lng?: number; speedKmh?: number }) {
        const patch: Partial<IotSnapshot> = { lastDataAt: Date.now() };
        if (validCoord(r.lat, r.lng)) patch.location = { lat: r.lat as number, lng: r.lng as number, at: Date.now() };
        if (typeof r.speedKmh === 'number') patch.speedKmh = r.speedKmh;
        this.set(patch);
    }

    private onText(chunk: string) {
        this.textBuffer += chunk;
        const lines = this.textBuffer.split(/\r?\n/);
        this.textBuffer = lines.pop() ?? '';
        // Devices that don't end lines with a newline: accept a complete-looking JSON object straight away.
        if (this.textBuffer.trim().startsWith('{') && this.textBuffer.trim().endsWith('}')) {
            lines.push(this.textBuffer);
            this.textBuffer = '';
        }
        if (this.textBuffer.length > 512) this.textBuffer = '';
        for (const line of lines) {
            const r = parseTextLine(line);
            if (!r) continue;
            const patch: Partial<IotSnapshot> = { lastDataAt: Date.now() };
            if (validCoord(r.lat, r.lng)) patch.location = { lat: r.lat as number, lng: r.lng as number, at: Date.now() };
            if (typeof r.battery === 'number') patch.battery = r.battery;
            if (typeof r.heartRate === 'number') patch.heartRate = r.heartRate;
            if (typeof r.spo2 === 'number') patch.spo2 = r.spo2;
            if (typeof r.steps === 'number') patch.steps = r.steps;
            if (typeof r.speedKmh === 'number') patch.speedKmh = r.speedKmh;
            if (r.sos) patch.sosAt = Date.now();
            this.set(patch);
        }
    }
}

export const iot = new IotManager();
export const isBluetoothSupported = IotManager.supported;
export const isScanSupported = IotManager.scanSupported;
export { toUuid };
