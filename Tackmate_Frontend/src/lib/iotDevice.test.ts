import { describe, expect, it } from 'vitest';
import { parseHeartRate, parseLocationAndSpeed, parsePulseOximeter, parseTextLine } from './iotDevice';

describe('IoT device parsing', () => {
    it('reads 8-bit and 16-bit heart rate', () => {
        expect(parseHeartRate(new DataView(new Uint8Array([0x00, 72]).buffer))).toBe(72);
        expect(parseHeartRate(new DataView(new Uint8Array([0x01, 0x2c, 0x01]).buffer))).toBe(300);
    });

    it('reads the standard Location and Speed characteristic', () => {
        const buf = new ArrayBuffer(2 + 2 + 8);
        const v = new DataView(buf);
        v.setUint16(0, 0x0005, true); // speed + location present
        v.setUint16(2, 278, true); // 2.78 m/s = 10 km/h
        v.setInt32(4, Math.round(27.5859 * 1e7), true);
        v.setInt32(8, Math.round(91.8674 * 1e7), true);
        const r = parseLocationAndSpeed(v);
        expect(r.lat).toBeCloseTo(27.5859, 4);
        expect(r.lng).toBeCloseTo(91.8674, 4);
        expect(r.speedKmh).toBeCloseTo(10, 0);
    });

    it('parses JSON from serial bands', () => {
        expect(parseTextLine('{"lat":27.5859,"lng":91.8674,"bat":82,"hr":71}')).toEqual({ lat: 27.5859, lng: 91.8674, battery: 82, heartRate: 71 });
        expect(parseTextLine('{"sos":true}')).toEqual({ sos: true });
        expect(parseTextLine('{"lat":0,"lng":0}')).toBeNull();
    });

    it('parses NMEA GGA and RMC sentences', () => {
        const gga = parseTextLine('$GPGGA,123519,2735.1540,N,09152.0440,E,1,08,0.9,545.4,M,46.9,M,,*47');
        expect(gga?.lat).toBeCloseTo(27.5859, 3);
        expect(gga?.lng).toBeCloseTo(91.8674, 3);
        const rmc = parseTextLine('$GNRMC,123519,A,2735.1540,N,09152.0440,E,5.4,084.4,230394,003.1,W*6A');
        expect(rmc?.speedKmh).toBeCloseTo(10, 0);
        expect(parseTextLine('$GPGGA,123519,,,,,0,00,,,M,,M,,*47')).toBeNull(); // no fix
    });

    it('parses plain coordinates and SOS keywords', () => {
        expect(parseTextLine('27.5859, 91.8674')).toEqual({ lat: 27.5859, lng: 91.8674 });
        expect(parseTextLine('SOS')).toEqual({ sos: true });
        expect(parseTextLine('panic button pressed')).toEqual({ sos: true });
        expect(parseTextLine('hello')).toBeNull();
    });

    it('reads SpO2 and pulse from the pulse-oximeter profile', () => {
        const v = new DataView(new ArrayBuffer(5));
        v.setUint8(0, 0);
        v.setUint16(1, 98, true); // SFLOAT 98 (exponent 0)
        v.setUint16(3, 72, true);
        expect(parsePulseOximeter(v)).toEqual({ spo2: 98, pulse: 72 });
        const withDecimal = new DataView(new ArrayBuffer(5));
        withDecimal.setUint16(1, (0xf << 12) | 975, true); // 97.5 (exponent -1)
        withDecimal.setUint16(3, 0x07ff, true); // NaN
        expect(parsePulseOximeter(withDecimal)).toEqual({ spo2: 97.5 });
    });

    it('reads steps and SpO2 from serial JSON', () => {
        expect(parseTextLine('{"steps":4210,"spo2":96,"hr":70}')).toEqual({ steps: 4210, spo2: 96, heartRate: 70 });
    });
});
