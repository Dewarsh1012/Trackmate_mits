import { afterEach, describe, expect, it } from 'vitest';
import { iot } from './iotDevice';

const U = (n: number) => `0000${n.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`;

function fakeChar(uuid: string, props: Record<string, boolean>, log: (string | number)[]) {
    const c: any = new EventTarget();
    c.uuid = uuid; c.properties = props;
    c.writeValueWithoutResponse = async (d: Uint8Array) => { log.push(d.length === 1 ? d[0] : new TextDecoder().decode(d)); };
    c.writeValue = c.writeValueWithoutResponse;
    c.readValue = async () => new DataView(new ArrayBuffer(1));
    c.startNotifications = async () => c;
    return c;
}

function installDevice(services: { uuid: string; chars: any[] }[]) {
    const dev: any = new EventTarget();
    dev.id = 'd1'; dev.name = 'Test Device';
    let connects = 0;
    dev.gatt = {
        connect: async () => { connects += 1; return { getPrimaryServices: async () => services.map((s) => ({ uuid: s.uuid, getCharacteristics: async () => s.chars, getCharacteristic: async (u: number) => s.chars.find((c: any) => c.uuid === U(u)) })), getPrimaryService: async (u: number) => { const s = services.find((x) => x.uuid === U(u)); return { getCharacteristic: async (cu: number) => s!.chars.find((c: any) => c.uuid === U(cu)) }; } }; },
        disconnect: () => undefined,
    };
    Object.defineProperty(navigator, 'bluetooth', { value: { requestDevice: async () => dev }, configurable: true });
    return { connects: () => connects };
}

afterEach(() => iot.disconnect());

describe('remote alarm on a connected device', () => {
    it('uses the standard Immediate Alert service', async () => {
        const log: (string | number)[] = [];
        installDevice([{ uuid: U(0x1802), chars: [fakeChar(U(0x2a06), { writeWithoutResponse: true }, log)] }]);
        await iot.connect();
        expect(iot.getSnapshot().canRing).toBe(true);
        expect(iot.getSnapshot().ringMethod).toBe('immediate');
        expect(await iot.ring(2)).toBe(true);
        expect(await iot.ring(0)).toBe(true);
        expect(log).toEqual([2, 0]);
    });

    it('sends a text command over a serial service', async () => {
        const log: (string | number)[] = [];
        installDevice([{ uuid: '6e400001-b5a3-f393-e0a9-e50e24dcca9e', chars: [fakeChar('6e400002-b5a3-f393-e0a9-e50e24dcca9e', { write: true }, log)] }]);
        await iot.connect();
        expect(iot.getSnapshot().ringMethod).toBe('serial');
        await iot.ring(2);
        await iot.ring(0);
        expect(log).toEqual(['ALARM:ON\n', 'ALARM:OFF\n']);
    });

    it('arms the Link Loss alarm and can silence it again', async () => {
        const log: (string | number)[] = [];
        const dev = installDevice([{ uuid: U(0x1803), chars: [fakeChar(U(0x2a06), { write: true }, log)] }]);
        await iot.connect();
        expect(iot.getSnapshot().ringMethod).toBe('link_loss');
        expect(await iot.ring(2)).toBe(true);
        expect(iot.getSnapshot().alarmArmed).toBe(true);
        expect(await iot.ring(0)).toBe(true);
        expect(iot.getSnapshot().alarmArmed).toBe(false);
        expect(log).toEqual([2, 0]);
        expect(dev.connects()).toBeGreaterThanOrEqual(2); // reconnected to silence it
    });

    it('reports that a device with no alarm support cannot be rung', async () => {
        installDevice([{ uuid: U(0x180f), chars: [fakeChar(U(0x2a19), { read: true }, [])] }]);
        await iot.connect();
        expect(iot.getSnapshot().canRing).toBe(false);
        expect(await iot.ring(2)).toBe(false);
        expect(iot.getSnapshot().services).toContain('Battery');
    });
});
