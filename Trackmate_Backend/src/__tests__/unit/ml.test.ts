import { auc, mulberry32, haversineMeters } from '../../ml/math';
import { trainIsolationForest, scoreIsolationForest } from '../../ml/isolationForest';
import { evaluate, predict, trainLogistic } from '../../ml/logistic';
import { backtestForecast, fitZoneForecast, forecastZones } from '../../ml/zoneForecast';
import { BEHAVIOUR_FEATURES, buildBehaviourSnapshot, PingRow, scoreBehaviour, trainBehaviourModel } from '../../ml/behaviour';
import { assessWithModel, SAFETY_PRIOR, safetyScoreFromRisk } from '../../ml/safety';
import { classifyText, seedTextModel, trainTextModel, triageSos, TRIAGE_PRIOR, TriageInputs } from '../../ml/sosTriage';

const gauss = (rand: () => number) => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());

describe('isolation forest', () => {
    it('ranks planted outliers above normal points and is reproducible', () => {
        const rand = mulberry32(1);
        const normal = Array.from({ length: 600 }, () => [gauss(rand), gauss(rand), gauss(rand)]);
        const outliers = Array.from({ length: 30 }, () => [6 + gauss(rand), -6 + gauss(rand), 5 + gauss(rand)]);
        const model = trainIsolationForest(normal, { seed: 3 });
        const again = trainIsolationForest(normal, { seed: 3 });

        const scores = [...normal.slice(0, 200), ...outliers].map((p) => scoreIsolationForest(model, p));
        const labels = [...new Array(200).fill(0), ...new Array(30).fill(1)] as Array<0 | 1>;
        expect(auc(scores, labels)).toBeGreaterThan(0.95);
        expect(scoreIsolationForest(again, outliers[0])).toBeCloseTo(scoreIsolationForest(model, outliers[0]), 10);
        expect(scoreIsolationForest(model, outliers[0])).toBeGreaterThan(model.threshold);
    });
});

describe('logistic regression', () => {
    it('recovers a planted signal and stays calibrated under class imbalance', () => {
        const rand = mulberry32(5);
        const X: number[][] = [];
        const y: Array<0 | 1> = [];
        for (let i = 0; i < 4000; i++) {
            const x = [rand(), rand(), rand()];
            const logit = -4 + 5 * x[0] + 3 * x[1]; // third feature is noise
            X.push(x);
            y.push(rand() < 1 / (1 + Math.exp(-logit)) ? 1 : 0);
        }
        const split = 3000;
        const model = trainLogistic(X.slice(0, split), y.slice(0, split), ['a', 'b', 'noise']);
        const ev = evaluate(model, X.slice(split), y.slice(split));
        expect(ev.auc).toBeGreaterThan(0.8);
        const meanPred = X.slice(split).reduce((s, x) => s + predict(model, x), 0) / (X.length - split);
        expect(meanPred / ev.base_rate).toBeGreaterThan(0.75);
        expect(meanPred / ev.base_rate).toBeLessThan(1.3);
        expect(Math.abs(model.weights[2])).toBeLessThan(Math.abs(model.weights[0]) / 2);
    });
});

describe('sign constraints', () => {
    it('never lets noisy data flip a risk factor into a safety factor', () => {
        const rand = mulberry32(8);
        const X: number[][] = [];
        const y: Array<0 | 1> = [];
        for (let i = 0; i < 1500; i++) {
            const x = [rand(), rand()];
            // Planted spurious relation: feature 0 *lowers* the outcome in this sample.
            X.push(x);
            y.push(rand() < 1 / (1 + Math.exp(-(-1 - 2 * x[0] + 3 * x[1]))) ? 1 : 0);
        }
        const free = trainLogistic(X, y, ['silence', 'zone']);
        const constrained = trainLogistic(X, y, ['silence', 'zone'], { signs: [1, 1] });
        expect(free.weights[0]).toBeLessThan(0);
        expect(constrained.weights[0]).toBeGreaterThanOrEqual(0);
        expect(constrained.weights[1]).toBeGreaterThan(0);
    });
});

describe('zone forecast', () => {
    const HOUR = 3600_000;
    const now = Date.UTC(2026, 10, 16, 12, 0, 0);
    const zones = [
        { id: 'a', name: 'Night market', riskLevel: 'high' },
        { id: 'b', name: 'Old fort', riskLevel: 'moderate' },
        { id: 'c', name: 'Lake', riskLevel: 'safe' },
    ];
    // Planted truth: zone a peaks 20:00-23:00 local (IST) every day; b is quiet; c almost never.
    const simulate = (seed: number) => {
        const rand = mulberry32(seed);
        const out: Array<{ t: number; zoneId: string }> = [];
        for (let h = 0; h < 56 * 24; h++) {
            const t = now - h * HOUR;
            const localHour = new Date(t + 330 * 60_000).getUTCHours();
            const rate = { a: localHour >= 20 && localHour <= 23 ? 0.5 : 0.03, b: 0.03, c: 0.004 };
            for (const z of zones) {
                const lambda = (rate as any)[z.id];
                let n = 0;
                for (let k = 0, p = Math.exp(-lambda), cum = p, u = rand(); u > cum && k < 6; k++) { n++; p *= lambda / (k + 1); cum += p; }
                for (let k = 0; k < n; k++) out.push({ t: t - rand() * HOUR, zoneId: z.id });
            }
        }
        return out;
    };

    it('finds the planted evening peak and beats a flat-rate baseline', () => {
        const incidents = simulate(11);
        const fit = fitZoneForecast(zones, incidents, [], now);
        const forecast = forecastZones(fit, now, 24);
        expect(forecast[0].zone_id).toBe('a');
        const peakLocalHour = new Date(new Date(forecast[0].peak!.hour_start).getTime() + 330 * 60_000).getUTCHours();
        expect(peakLocalHour).toBeGreaterThanOrEqual(20);
        expect(peakLocalHour).toBeLessThanOrEqual(23);

        const back = backtestForecast(zones, incidents, [], now);
        expect(back.insufficient_data).toBe(false);
        expect(back.skill_vs_flat!).toBeGreaterThan(0.1);
        expect(back.capture_top10!).toBeGreaterThan(0.3);
    });

    it('falls back to risk-level priors for a zone with no history', () => {
        const fit = fitZoneForecast(zones, [], [], now);
        const forecast = forecastZones(fit, now, 24);
        expect(forecast[0].zone_id).toBe('a'); // "high" ranks above "moderate" and "safe"
        expect(forecast[2].zone_id).toBe('c');
        expect(backtestForecast(zones, [], [], now).insufficient_data).toBe(true);
    });
});

describe('behaviour anomaly model', () => {
    // A tourist who walks around a base at ~3-5 km/h and pings every ~30 s for several days.
    const makeUser = (seed: number, baseLat: number, baseLng: number): PingRow[] => {
        const rand = mulberry32(seed);
        const rows: PingRow[] = [];
        let lat = baseLat;
        let lng = baseLng;
        const start = Date.UTC(2026, 10, 1);
        for (let day = 0; day < 8; day++) {
            for (let s = 0; s < 1680; s++) { // active 08:00-22:00, offline overnight
                const t = start + day * 86400_000 + 8 * 3600_000 + s * 30_000;
                lat += (rand() - 0.5) * 0.00018 + (baseLat - lat) * 0.01;
                lng += (rand() - 0.5) * 0.00018 + (baseLng - lng) * 0.01;
                rows.push({ t, lat, lng, battery: 80 - day * 2, zoneRisk: 0 });
            }
        }
        return rows;
    };

    it('learns normal movement, then flags long silence, a far jump and a speed spike', async () => {
        const users = new Map<string, PingRow[]>();
        for (let u = 0; u < 5; u++) users.set(`u${u}`, makeUser(20 + u, 27.1 + u * 0.01, 91.8));
        // Too few people: no model, rather than one fit to a handful of devices.
        expect(trainBehaviourModel(new Map([...users].slice(0, 3)), { ticksPerUser: 200 })).toBeNull();
        const trained = trainBehaviourModel(users, { ticksPerUser: 400 });
        expect(trained).not.toBeNull();
        expect(trained!.metrics.injected_anomaly_auc).toBeGreaterThan(0.85);

        const logs = users.get('u0')!;
        const idx = 1680 * 4 + 400; // mid-morning, in the middle of an active session
        const newestFirst = logs.slice(Math.max(0, idx - 240), idx + 1).reverse();
        const tick = newestFirst[0].t + 30_000;

        const ctx = { activityByHour: trained!.model.activity_by_hour };
        const normal = await scoreBehaviour(buildBehaviourSnapshot(newestFirst, tick, ctx)!, trained!.model);
        expect(normal.anomalous).toBe(false);

        const silent = await scoreBehaviour(buildBehaviourSnapshot(newestFirst, newestFirst[0].t + 150 * 60_000, ctx)!, trained!.model);
        expect(silent.score).toBeGreaterThan(normal.score + 0.08);
        expect(silent.reasons.join(' ')).toMatch(/no location update|stationary/);

        // Teleport 40 km away and move fast in the last segment.
        const jumped: PingRow[] = [{ ...newestFirst[0], t: tick, lat: newestFirst[0].lat + 0.36, lng: newestFirst[0].lng }, ...newestFirst];
        const far = await scoreBehaviour(buildBehaviourSnapshot(jumped, tick + 1000, ctx)!, trained!.model);
        expect(far.anomalous).toBe(true);
        expect(far.reasons.length).toBeGreaterThan(0);
        expect(haversineMeters(newestFirst[0].lat, newestFirst[0].lng, jumped[0].lat, jumped[0].lng)).toBeGreaterThan(30_000);
        expect(BEHAVIOUR_FEATURES.length).toBe(trained!.model.feature_count);
    });

    it('uses a conservative prior when no model has been trained yet', async () => {
        const logs = makeUser(99, 27.1, 91.8).slice(0, 400).reverse();
        const calm = await scoreBehaviour(buildBehaviourSnapshot(logs, logs[0].t + 30_000)!, null);
        expect(calm.source).toBe('prior');
        expect(calm.anomalous).toBe(false);
        const gone = await scoreBehaviour(buildBehaviourSnapshot(logs, logs[0].t + 6 * 3600_000)!, null);
        expect(gone.anomalous).toBe(true);
    });
});

describe('safety risk', () => {
    const safe = { zoneRisk: 0, hour: 14, silenceMin: 1, speedKmh: 4, behaviourScore: 0.45, battery: 80, nearbyIncidents6h: 0, anomalies24h: 0, areaForecastP3h: 0.01, healthFlag: false };

    it('scores a calm tourist near 100 and a stacked-risk situation much lower, with reasons', () => {
        const calm = assessWithModel(SAFETY_PRIOR, 'prior', 'prior-v1', safe);
        expect(calm.score).toBeGreaterThanOrEqual(95);
        expect(calm.factors[0].effect).toBe('lowers');

        const risky = assessWithModel(SAFETY_PRIOR, 'prior', 'prior-v1', {
            ...safe, zoneRisk: 1, hour: 23, silenceMin: 50, behaviourScore: 0.8, battery: 10, nearbyIncidents6h: 3, anomalies24h: 1, areaForecastP3h: 0.3,
        });
        expect(risky.p_incident_3h).toBeGreaterThan(calm.p_incident_3h * 20);
        expect(risky.score).toBeLessThan(50);
        expect(risky.factors.length).toBeGreaterThan(0);
        expect(risky.factors.every((f) => f.effect === 'raises')).toBe(true);
    });

    it('maps risk to score monotonically', () => {
        const scores = [0, 0.004, 0.02, 0.1, 0.3, 0.7, 1].map(safetyScoreFromRisk);
        for (let i = 1; i < scores.length; i++) expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]);
        expect(scores[0]).toBe(100);
        expect(scores[scores.length - 1]).toBe(0);
    });
});

describe('SOS triage', () => {
    const base: TriageInputs = {
        text: '', zoneRisk: 0, outsideZone: false, hour: 14, healthFlag: false, battery: 80, behaviourScore: 0.45,
        nearbyIncidents15m: 0, anomalies24h: 0, sosLast24h: 1, falseAlarmRate7d: 0, minutesSinceLastSos: 9999, silenceMin: 2,
    };
    const models = { genuine: TRIAGE_PRIOR, genuineSource: 'prior' as const, genuineVersion: 'prior-v1', text: seedTextModel(), textVersion: 'seed-v1' };

    it('classifies emergency type from text, including Hinglish', () => {
        const m = seedTextModel();
        expect(classifyText(m, 'severe chest pain and cannot breathe, please help').category).toBe('medical');
        expect(classifyText(m, 'two men robbed me and one has a knife').category).toBe('crime');
        expect(classifyText(m, 'gaadi ka accident ho gaya, bike crashed').category).toBe('accident');
        expect(classifyText(m, 'we are lost and stranded, cannot find the trail').category).toBe('lost');
        expect(classifyText(m, 'asdf qwerty').category).toBe('unspecified');
        // Stemming: "following"/"threatening" match the lexicon's "followed"/"threatened".
        expect(classifyText(m, 'two men are following me and threatening').category).toBe('crime');
    });

    it('learns vocabulary from labelled incidents', () => {
        const before = classifyText(seedTextModel(), 'my companion has altitude sickness and mountain sickness').category;
        const learned = trainTextModel(Array.from({ length: 12 }, () => ({ text: 'mountain sickness headache companion', category: 'medical' as const })));
        const after = classifyText(learned, 'companion has mountain sickness');
        expect(after.category).toBe('medical');
        expect(after.probs.medical).toBeGreaterThanOrEqual(0.5);
        expect(before).toBeDefined();
    });

    it('prioritises a corroborated emergency above a probable accidental press, and explains why', () => {
        const real = triageSos({ ...base, text: 'chest pain, cannot breathe, please help', zoneRisk: 1, hour: 23, healthFlag: true, behaviourScore: 0.8, nearbyIncidents15m: 2 }, models);
        expect(real.priority).toBe('P1');
        expect(real.category).toBe('medical');
        expect(real.reasons.some((r) => r.effect === 'supports')).toBe(true);

        const mistake = triageSos({ ...base, text: 'sorry pressed by mistake, testing', sosLast24h: 4, falseAlarmRate7d: 0.8, minutesSinceLastSos: 5 }, models);
        expect(['P3', 'P4']).toContain(mistake.priority);
        expect(mistake.p_genuine).toBeLessThan(real.p_genuine / 2);
        expect(mistake.reasons.some((r) => r.effect === 'doubts')).toBe(true);
        expect(mistake.action).toMatch(/verify|confirm/i);
    });

    it('blends an external score without letting it override the model entirely', () => {
        const without = triageSos(base, models);
        const withHigh = triageSos(base, models, 1);
        const withLow = triageSos(base, models, 0);
        expect(withHigh.p_genuine).toBeGreaterThan(without.p_genuine);
        expect(withLow.p_genuine).toBeLessThan(without.p_genuine);
        expect(Math.abs(withHigh.p_genuine - withLow.p_genuine)).toBeCloseTo(0.25, 2);
    });
});
