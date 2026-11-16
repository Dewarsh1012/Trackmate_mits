/**
 * End-to-end check of the ML pipeline against a THROWAWAY database.
 *
 * Fills a scratch database with simulated tourists, movement and incidents (with relationships planted
 * on purpose), trains every model through the real training code, prints the metrics and sample
 * predictions, then drops the scratch database. It never touches the application's own data.
 *
 *   npm run ml:simulate            # run and clean up
 *   npm run ml:simulate -- --keep  # leave the scratch database in place for inspection
 */
import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { Incident, LocationLog, Profile, Zone } from '../models';
import { mulberry32, sigmoid, haversineMeters } from '../ml/math';
import { trainAll, getMlStatus } from '../ml/training';
import { evaluateTourists, buildSosTriage, getZoneForecast, invalidateForecastCache } from '../ml/runtime';
import { invalidateModelCache } from '../ml/modelStore';

const SCRATCH_DB = 'trackmate_ml_sim_tmp';
const rand = mulberry32(2024);
const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
const MS_H = 3600_000;
const MS_D = 24 * MS_H;
const IST = 330 * 60_000;
const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];

const ZONES = [
    { name: 'Market Square', risk_level: 'safe', lat: 27.586, lng: 91.859, r: 700, risk: 0 },
    { name: 'Monastery Hill', risk_level: 'moderate', lat: 27.599, lng: 91.865, r: 700, risk: 0.35 },
    { name: 'Border Road', risk_level: 'high', lat: 27.570, lng: 91.880, r: 800, risk: 0.7 },
    { name: 'Ridge Pass', risk_level: 'restricted', lat: 27.610, lng: 91.845, r: 700, risk: 1 },
];

const GENUINE_TEXT: Record<string, string[]> = {
    medical: ['severe chest pain and cannot breathe please help', 'my friend fainted and is unconscious need ambulance', 'bleeding badly from a fall help'],
    crime: ['two men robbed my bag and threatened me with a knife', 'someone is following me and trying to grab my phone'],
    accident: ['our car crashed on the bend please send help', 'bike skidded and I fell, leg is broken'],
    harassment: ['a drunk group is harassing me and will not leave', 'being stalked since the market, feel unsafe'],
    lost: ['we are lost and stranded on the trail it is getting dark', 'separated from group, cannot find the route'],
    disaster: ['landslide blocked the road and smoke from the hill', 'fire in the guest house please help'],
};
const FALSE_TEXT = ['pressed by mistake sorry', 'testing the sos button', 'oops accidentally pressed, nothing wrong', 'trial test'];
const TYPE_BY_CATEGORY: Record<string, string> = { medical: 'medical_emergency', crime: 'crime', accident: 'accident', harassment: 'suspicious_activity', lost: 'missing_person', disaster: 'natural_disaster' };

function zoneAt(lat: number, lng: number, zoneIds: string[]): number {
    let best = -1;
    let bestRisk = -1;
    ZONES.forEach((z, i) => {
        if (haversineMeters(lat, lng, z.lat, z.lng) <= z.r && z.risk > bestRisk) { best = i; bestRisk = z.risk; }
    });
    void zoneIds;
    return best;
}

async function main() {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGODB_URI is not set');
    const keep = process.argv.includes('--keep');
    await mongoose.connect(uri, { dbName: SCRATCH_DB, serverSelectionTimeoutMS: 8000 });
    if (mongoose.connection.db?.databaseName !== SCRATCH_DB) throw new Error('Refusing to run: not connected to the scratch database.');
    await mongoose.connection.dropDatabase();
    console.log(`Scratch database "${SCRATCH_DB}" ready.\n`);

    // ── zones and people ──
    const zoneDocs = await Zone.insertMany(ZONES.map((z) => ({ name: z.name, risk_level: z.risk_level, center_lat: z.lat, center_lng: z.lng, radius_meters: z.r, is_active: true })));
    const zoneIds = zoneDocs.map((z: any) => String(z._id));
    const people = await Profile.insertMany(Array.from({ length: 14 }, (_, i) => ({
        email: `sim_tourist_${i}@ml-sim.test`, password: 'x', role: 'tourist', full_name: `Sim Tourist ${i}`, is_active: true,
    })));
    const userIds = people.map((p: any) => String(p._id));

    // ── movement + planted hazards ──
    const now = Date.now();
    const DAYS = 21;
    const logs: any[] = [];
    const incidents: any[] = [];
    const sosByUser = new Map<string, Array<{ t: number; falseAlarm: boolean }>>();

    for (const uid of userIds) {
        const home = pick([0, 0, 1, 1, 2]);
        for (let d = DAYS; d >= 1; d--) {
            const dayStart = Math.floor((now - d * MS_D + IST) / MS_D) * MS_D - IST; // local midnight
            let zi = home;
            let lat = ZONES[zi].lat; let lng = ZONES[zi].lng;
            const episodeAt = rand() < 0.22 ? dayStart + (11 + rand() * 8) * MS_H : null; // 90-min trouble window
            let nextHop = 0;
            for (let t = dayStart + 8 * MS_H; t < dayStart + 21 * MS_H; t += 2 * 60_000) {
                if (t > now - 20 * 60_000) break;
                if (t >= nextHop) { zi = rand() < 0.65 ? home : rand() < 0.75 ? pick([0, 1, 2]) : 3; nextHop = t + (60 + rand() * 60) * 60_000; lat = ZONES[zi].lat + gauss() * 0.002; lng = ZONES[zi].lng + gauss() * 0.002; }
                lat += gauss() * 0.00035; lng += gauss() * 0.00035;
                const inEpisode = episodeAt !== null && t >= episodeAt && t < episodeAt + 90 * 60_000;
                if (inEpisode && t > episodeAt + 40 * 60_000) continue; // went silent
                const z = zoneAt(lat, lng, zoneIds);
                const zoneRisk = z >= 0 ? ZONES[z].risk : 0.55;
                logs.push({ user: uid, latitude: lat, longitude: lng, battery_level: Math.max(5, 90 - (t - dayStart) / MS_H * 3 - (inEpisode ? 20 : 0)), current_zone: z >= 0 ? zoneDocs[z]._id : undefined, is_in_safe_zone: z === 0, source: 'gps', recorded_at: new Date(t) });

                const hourLocal = new Date(t + IST).getUTCHours();
                const logit = -7.5 + 2.6 * zoneRisk + 1.0 * (hourLocal >= 19 && hourLocal <= 22 ? 1 : 0) + 2.2 * (inEpisode ? 1 : 0);
                if (rand() < sigmoid(logit)) {
                    const prior = sosByUser.get(uid) ?? [];
                    const isSos = rand() < 0.7;
                    if (isSos) {
                        const pGenuine = sigmoid(-0.2 + 2.4 * zoneRisk + 1.6 * (inEpisode ? 1 : 0) - 0.9 * Math.min(3, prior.filter((p) => t - p.t < MS_D).length));
                        const genuine = rand() < pGenuine;
                        const cat = pick(Object.keys(GENUINE_TEXT));
                        const description = genuine ? pick(GENUINE_TEXT[cat]) : pick(FALSE_TEXT);
                        const last24 = prior.filter((p) => t - p.t < MS_D).length + 1;
                        const week = prior.filter((p) => t - p.t < 7 * MS_D);
                        prior.push({ t, falseAlarm: !genuine });
                        sosByUser.set(uid, prior);
                        incidents.push({
                            reporter: uid, incident_type: 'sos_emergency', title: 'Emergency SOS', description, latitude: lat, longitude: lng, zone: z >= 0 ? zoneDocs[z]._id : undefined,
                            severity: 'critical', source: 'sos_panic', status: genuine ? pick(['resolved', 'resolved', 'assigned']) : 'false_alarm', created_at: new Date(t),
                            metadata: {
                                sos_risk_metrics: { isOutsideZone: z < 0, nearbyIncidents15m: 0, userAnomalies24h: inEpisode ? 1 : 0, inactivityMinutes: inEpisode ? 40 : 2 },
                                sos_misuse_signals: { sos_last_24h: last24, false_alarm_rate_7d: week.length ? week.filter((p) => p.falseAlarm).length / week.length : 0, minutes_since_last_sos: prior.length > 1 ? (t - prior[prior.length - 2].t) / 60_000 : 9999 },
                            },
                        });
                    } else {
                        const cat = pick(Object.keys(GENUINE_TEXT));
                        incidents.push({ reporter: uid, incident_type: TYPE_BY_CATEGORY[cat], title: `Reported: ${cat}`, description: pick(GENUINE_TEXT[cat]), latitude: lat, longitude: lng, zone: z >= 0 ? zoneDocs[z]._id : undefined, severity: 'high', source: 'user_report', status: 'resolved', created_at: new Date(t) });
                    }
                }
            }
            if (episodeAt && rand() < 0.6) {
                incidents.push({ reporter: uid, incident_type: 'inactivity', title: 'Tourist Prolonged Inactivity', latitude: lat, longitude: lng, severity: 'high', source: 'ai_anomaly', status: pick(['resolved', 'resolved', 'active']), created_at: new Date(episodeAt + 75 * 60_000) });
            }
        }
    }
    // Extra described incidents from officers/residents: more text for the category model.
    for (let i = 0; i < 70; i++) {
        const cat = pick(Object.keys(GENUINE_TEXT));
        const z = pick([0, 1, 2, 3]);
        incidents.push({ reporter: pick(userIds), incident_type: TYPE_BY_CATEGORY[cat], title: `Report: ${cat}`, description: pick(GENUINE_TEXT[cat]), latitude: ZONES[z].lat, longitude: ZONES[z].lng, zone: zoneDocs[z]._id, severity: 'medium', source: 'resident_report', status: 'resolved', created_at: new Date(now - rand() * 30 * MS_D) });
    }

    for (let i = 0; i < logs.length; i += 5000) await LocationLog.insertMany(logs.slice(i, i + 5000), { timestamps: false } as any);
    await Incident.insertMany(incidents, { timestamps: false } as any);
    console.log(`Simulated ${userIds.length} tourists, ${logs.length} pings, ${incidents.length} incidents (${incidents.filter((i) => i.source === 'sos_panic').length} SOS, ${incidents.filter((i) => i.status === 'false_alarm').length} false alarms).\n`);

    // ── train through the real code path ──
    invalidateModelCache(); invalidateForecastCache();
    console.log('Training...');
    const t0 = Date.now();
    const reports = await trainAll();
    console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
    for (const r of reports) {
        console.log(`• ${r.name}: ${r.status.toUpperCase()}${r.samples != null ? ` (${r.samples} samples)` : ''}`);
        if (r.reason) console.log(`    ${r.reason}`);
        if (r.metrics) console.log(`    ${JSON.stringify(r.metrics)}`);
    }

    invalidateModelCache(); invalidateForecastCache();
    const status = await getMlStatus();
    console.log('\nModel sources now:', status.models.map((m) => `${m.key}=${m.source}`).join(', '));

    // ── forecast ──
    const forecast = await getZoneForecast(24);
    console.log('\nForecast (next 24h), riskiest zones:');
    for (const z of forecast.zones) console.log(`  ${z.zone_name.padEnd(16)} expected ${z.expected_next_24h.toFixed(2)} incidents, peak ${z.peak ? new Date(z.peak.hour_start).toISOString().slice(11, 16) + 'Z p=' + z.peak.probability : '-'}, trend ${z.trend}`);
    console.log('  backtest:', JSON.stringify(forecast.model.backtest));

    // ── live scoring: one normal, one silent-and-far, one fast-moving ──
    const live = userIds.slice(0, 3);
    await LocationLog.deleteMany({ user: { $in: live }, recorded_at: { $gte: new Date(now - 6 * MS_H) } });
    const mk = (uid: string, t: number, lat: number, lng: number, z: number, battery = 70) => ({ user: uid, latitude: lat, longitude: lng, battery_level: battery, current_zone: z >= 0 ? zoneDocs[z]._id : undefined, source: 'gps', recorded_at: new Date(t) });
    const liveLogs: any[] = [];
    // Each person's usual spot (median of their simulated pings), so "calm" really means "like themselves".
    const homeOf = (uid: string) => {
        const mine = logs.filter((l) => l.user === uid);
        const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
        return { lat: med(mine.map((l) => l.latitude)), lng: med(mine.map((l) => l.longitude)) };
    };
    const [h0, h1, h2] = live.map(homeOf);
    for (let k = 120; k >= 0; k--) liveLogs.push(mk(live[0], now - k * 30_000, h0.lat + k * 0.000005, h0.lng, 0)); // calm, at their usual spot
    for (let k = 200; k >= 70; k--) liveLogs.push(mk(live[1], now - k * 60_000, h1.lat + 0.05 + (200 - k) * 0.0001, h1.lng + 0.06, -1, 12)); // far outside, then silent for 70 min
    for (let k = 20; k >= 0; k--) liveLogs.push(mk(live[2], now - k * 30_000, h2.lat + (20 - k) * 0.004, h2.lng, 1)); // ~50 km/h burst
    await LocationLog.insertMany(liveLogs);
    const scored = await evaluateTourists({ userIds: live });
    console.log('\nLive scoring:');
    for (const [label, uid] of [['calm in market', live[0]], ['silent, far away, low battery', live[1]], ['fast burst', live[2]]] as const) {
        const r = scored.get(uid);
        if (!r) { console.log(`  ${label}: (skipped: stale)`); continue; }
        console.log(`  ${label.padEnd(30)} score ${r.assessment.score} (p3h ${(r.assessment.p_incident_3h * 100).toFixed(1)}%), behaviour ${r.behaviour.score}${r.behaviour.anomalous ? ' ANOMALOUS' : ''} [${r.behaviour.source}]  ${r.behaviour.reasons.join('; ')}`);
        console.log(`      why: ${r.assessment.factors.map((f) => f.label).join(' | ')}`);
    }

    // ── SOS triage ──
    const base = { reporterId: live[0], latitude: ZONES[0].lat, longitude: ZONES[0].lng };
    const real = await buildSosTriage({ ...base, text: 'Emergency SOS. chest pain cannot breathe please help', latitude: ZONES[3].lat, longitude: ZONES[3].lng, metrics: { isOutsideZone: false, nearbyIncidents15m: 1 }, misuse: { sos_last_24h: 1, false_alarm_rate_7d: 0, minutes_since_last_sos: 9999 } });
    const slip = await buildSosTriage({ ...base, text: 'Emergency SOS. sorry pressed by mistake', metrics: { isOutsideZone: false }, misuse: { sos_last_24h: 3, false_alarm_rate_7d: 0.7, minutes_since_last_sos: 6 } });
    for (const [label, t] of [['genuine-looking', real], ['probable slip', slip]] as const) {
        console.log(`\nTriage (${label}): ${t.priority}  p_genuine ${t.p_genuine}  category ${t.category}  [${t.source}]`);
        console.log(`  action: ${t.action}`);
        for (const r of t.reasons) console.log(`  ${r.effect === 'supports' ? '+' : '-'} ${r.label}`);
    }

    if (keep) console.log(`\nKept scratch database "${SCRATCH_DB}".`);
    else { await mongoose.connection.dropDatabase(); console.log(`\nDropped scratch database "${SCRATCH_DB}".`); }
    await mongoose.disconnect();
}

main().catch(async (err) => {
    console.error('Simulation failed:', err);
    try { if (mongoose.connection.db?.databaseName === SCRATCH_DB) await mongoose.connection.dropDatabase(); } catch { /* ignore */ }
    process.exit(1);
});
