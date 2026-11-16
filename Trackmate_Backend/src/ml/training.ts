import { HealthSample, Incident, LocationLog, Profile, Zone } from '../models';
import { haversineMeters, mulberry32, round } from './math';
import {
    BehaviourModel, OUTSIDE_ZONE_RISK, PingRow, ZONE_RISK_NUM, buildBehaviourSnapshot, localHour, scoreBehaviour,
    thinNewestFirst, trainBehaviourModel,
} from './behaviour';
import { evaluate, trainLogistic } from './logistic';
import { SAFETY_FEATURES, SAFETY_PRIOR, SAFETY_SIGNS, SafetyInputs, buildSafetyVector } from './safety';
import { TRIAGE_CATEGORIES, TRIAGE_FEATURES, TRIAGE_SIGNS, TextModel, TriageCategory, buildTriageVector, classifyText, seedTextModel, trainTextModel, TriageInputs } from './sosTriage';
import { ForecastFit, backtestForecast, fitZoneForecast, hourlyRate } from './zoneForecast';
import { ModelName, loadActiveModel, saveModel } from './modelStore';
import { assignIncidentsToZones, invalidateForecastCache, loadForecastData } from './runtime';
import { MlModel } from '../models/MlModel';

const MS_H = 3600_000;
const MS_D = 24 * MS_H;
const TRAIN_WINDOW_DAYS = 45;

export interface TrainReport {
    name: string;
    status: 'trained' | 'skipped' | 'rejected';
    reason?: string;
    version?: string;
    samples?: number;
    metrics?: Record<string, any>;
}

/** Quality gates: a retrained model only replaces the current one if it clears these. */
export const GATES = {
    behaviourInjectedAuc: 0.8,
    behaviourFalseAlertRate: 0.05,
    safetyHoldoutAuc: 0.62,
    sosHoldoutAuc: 0.6,
    textAccuracyLift: 0.05,
};

const SERIOUS_TYPES = new Set(['medical_emergency', 'accident', 'crime', 'missing_person', 'natural_disaster', 'fire', 'crowd_emergency', 'sos_emergency']);
const CATEGORY_BY_TYPE: Record<string, (typeof TRIAGE_CATEGORIES)[number]> = {
    medical_emergency: 'medical', crime: 'crime', accident: 'accident', missing_person: 'lost',
    fire: 'disaster', natural_disaster: 'disaster', infrastructure_hazard: 'disaster', suspicious_activity: 'harassment',
};

export async function trainAll(only?: string[]): Promise<TrainReport[]> {
    const wants = (name: string) => !only || only.includes(name);
    const reports: TrainReport[] = [];

    const since = new Date(Date.now() - TRAIN_WINDOW_DAYS * MS_D);
    const [zonesRaw, touristRows, logRows] = await Promise.all([
        Zone.find({ is_active: true }).lean(),
        Profile.find({ role: 'tourist' }).select('_id').lean(),
        LocationLog.find({ recorded_at: { $gte: since } })
            .select('user latitude longitude battery_level recorded_at current_zone')
            .sort({ recorded_at: -1 }) // uses the recorded_at index; newest 250k pings across everyone
            .limit(250_000)
            .lean(),
    ]);
    const zoneById = new Map((zonesRaw as any[]).map((z) => [String(z._id), z]));
    const tourists = new Set((touristRows as any[]).map((t) => String(t._id)));

    const logsByUser = new Map<string, PingRow[]>();
    for (const l of (logRows as any[]).reverse()) { // oldest first
        const uid = String(l.user);
        if (!logsByUser.has(uid)) logsByUser.set(uid, []);
        const zone = l.current_zone ? zoneById.get(String(l.current_zone)) : null;
        logsByUser.get(uid)!.push({
            t: new Date(l.recorded_at).getTime(),
            lat: Number(l.latitude),
            lng: Number(l.longitude),
            battery: l.battery_level != null ? Number(l.battery_level) : undefined,
            zoneId: l.current_zone ? String(l.current_zone) : null,
            zoneRisk: zone ? (ZONE_RISK_NUM[zone.risk_level] ?? OUTSIDE_ZONE_RISK) : OUTSIDE_ZONE_RISK,
        });
    }

    // 1. Behaviour anomaly model (unsupervised).
    let behaviourModel: BehaviourModel | null = null;
    if (wants('behaviour_anomaly') || wants('safety_risk')) {
        const result = trainBehaviourModel(logsByUser);
        if (!result) {
            reports.push({ name: 'behaviour_anomaly', status: 'skipped', reason: `Needs at least 1,500 in-session movement samples from 5+ people; found ${[...logsByUser.values()].reduce((s, l) => s + l.length, 0)} pings in ${logsByUser.size} users.` });
        } else if (result.metrics.injected_anomaly_auc < GATES.behaviourInjectedAuc || result.metrics.false_alert_rate > GATES.behaviourFalseAlertRate) {
            reports.push({ name: 'behaviour_anomaly', status: 'rejected', reason: 'Did not clear the quality gate; keeping the current model.', samples: result.sampleCount, metrics: result.metrics });
        } else {
            behaviourModel = result.model;
            if (wants('behaviour_anomaly')) {
                const version = await saveModel('behaviour_anomaly', result.model, result.metrics, result.sampleCount);
                reports.push({ name: 'behaviour_anomaly', status: 'trained', version, samples: result.sampleCount, metrics: result.metrics });
            }
        }
    }
    if (!behaviourModel) {
        const current = await loadActiveModel<BehaviourModel>('behaviour_anomaly');
        behaviourModel = current?.payload ?? null;
    }

    // 2. Safety risk (supervised, labelled by confirmed incidents).
    if (wants('safety_risk')) reports.push(await trainSafety(logsByUser, tourists, zonesRaw as any[], behaviourModel));

    // 3. SOS triage.
    if (wants('sos_genuine')) reports.push(await trainSosGenuine());
    if (wants('sos_text')) reports.push(await trainSosText());

    // 4. Zone forecast has no stored weights (it is refit from history on demand); record its backtest.
    if (wants('zone_forecast_backtest')) {
        const data = await loadForecastData();
        const back = backtestForecast(data.zones, data.incidents, data.exposure, Date.now(), data.observedDays);
        if (back.insufficient_data) {
            reports.push({ name: 'zone_forecast', status: 'skipped', reason: `Needs at least 10 earlier and 5 recent incidents to measure accuracy; has ${data.incidents.length} in the last ${data.observedDays} days of history. Forecasts still work from each zone's risk level.`, metrics: back as any });
        } else {
            const version = await saveModel('zone_forecast_backtest', {}, back as any, data.incidents.length);
            reports.push({ name: 'zone_forecast', status: 'trained', version, samples: data.incidents.length, metrics: back as any });
        }
        invalidateForecastCache();
    }
    return reports;
}

// ── Safety risk ────────────────────────────────────────────────────────────

async function trainSafety(
    logsByUser: Map<string, PingRow[]>,
    tourists: Set<string>,
    zonesRaw: any[],
    behaviour: BehaviourModel | null
): Promise<TrainReport> {
    const name = 'safety_risk';
    const since = new Date(Date.now() - TRAIN_WINDOW_DAYS * MS_D);
    const incidents: any[] = await Incident.find({ created_at: { $gte: since }, incident_type: { $nin: ['checkin', 'safe_house_request'] } })
        .select('reporter source status incident_type latitude longitude zone created_at').lean();

    // Confirmed = a human or the victim says it was real. Rule-generated geofence events are excluded to avoid circular labels.
    const confirmed = new Map<string, number[]>();
    const aiAlerts = new Map<string, number[]>();
    for (const inc of incidents) {
        if (!inc.reporter) continue;
        const uid = String(inc.reporter);
        const t = new Date(inc.created_at).getTime();
        if (inc.source === 'ai_anomaly' && inc.status !== 'false_alarm') {
            if (!aiAlerts.has(uid)) aiAlerts.set(uid, []);
            aiAlerts.get(uid)!.push(t);
        }
        const real = inc.status !== 'false_alarm' && (
            inc.source === 'sos_panic' ||
            ((inc.source === 'user_report' || inc.source === 'resident_report') && SERIOUS_TYPES.has(inc.incident_type)) ||
            (inc.source === 'ai_anomaly' && ['resolved', 'assigned', 'acknowledged', 'escalated'].includes(inc.status))
        );
        if (real) {
            if (!confirmed.has(uid)) confirmed.set(uid, []);
            confirmed.get(uid)!.push(t);
        }
    }
    const totalConfirmed = [...confirmed.values()].reduce((s, a) => s + a.length, 0);

    const withCoords = incidents.filter((i) => Number.isFinite(i.latitude) && Number.isFinite(i.longitude))
        .map((i) => ({ t: new Date(i.created_at).getTime(), lat: Number(i.latitude), lng: Number(i.longitude) }));

    const health: any[] = await HealthSample.find({ recorded_at: { $gte: since } }).select('user heart_rate spo2 recorded_at').lean();
    const healthByUser = new Map<string, Array<{ t: number; flag: boolean }>>();
    for (const h of health) {
        const uid = String(h.user);
        if (!healthByUser.has(uid)) healthByUser.set(uid, []);
        healthByUser.get(uid)!.push({ t: new Date(h.recorded_at).getTime(), flag: (h.heart_rate > 160 || h.heart_rate < 40) || (h.spo2 != null && h.spo2 < 92) });
    }

    // Sample moments (ticks): random ones for the base rate, plus a few just before each confirmed incident.
    const rand = mulberry32(99);
    interface Tick { uid: string; t: number; random: boolean }
    const ticks: Tick[] = [];
    for (const [uid, logs] of logsByUser) {
        if (!tourists.has(uid) || logs.length < 12) continue;
        const first = logs[0].t + 10 * 60_000;
        const last = logs[logs.length - 1].t + 10 * 60_000;
        for (let k = 0; k < 250 && last > first; k++) ticks.push({ uid, t: first + rand() * (last - first), random: true });
        for (const t of confirmed.get(uid) ?? []) {
            for (let k = 0; k < 2; k++) ticks.push({ uid, t: t - (10 + rand() * 160) * 60_000, random: false });
        }
    }
    if (totalConfirmed < 8 || !ticks.length) {
        return { name, status: 'skipped', reason: `Needs confirmed incidents (SOS, reported emergencies, officer-confirmed alerts) to learn from; found ${totalConfirmed} in ${TRAIN_WINDOW_DAYS} days. Using the built-in prior meanwhile.` };
    }
    ticks.sort((a, b) => a.t - b.t);
    const splitT = ticks[Math.floor(ticks.length * 0.75)].t;

    // The area forecast feature is fit only on incidents before the split so the hold-out is honest.
    const forecastData = await loadForecastData();
    const earlier = assignIncidentsToZones(incidents.filter((i) => new Date(i.created_at).getTime() < splitT), zonesRaw);
    const fit: ForecastFit = fitZoneForecast(forecastData.zones, earlier, [], splitT, forecastData.observedDays);
    const fitZone = new Map(fit.zones.map((z) => [z.id, z]));

    const X: number[][] = [];
    const y: Array<0 | 1> = [];
    const times: number[] = [];
    const isRandom: boolean[] = [];
    for (const tick of ticks) {
        const logs = logsByUser.get(tick.uid)!;
        let lo = 0; let hi = logs.length - 1; let idx = -1;
        while (lo <= hi) { const mid = (lo + hi) >> 1; if (logs[mid].t <= tick.t) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
        if (idx < 0) continue;
        const slice = thinNewestFirst(logs.slice(Math.max(0, idx - 1500), idx + 1).reverse());
        const snap = buildBehaviourSnapshot(slice, tick.t, { activityByHour: behaviour?.activity_by_hour });
        if (!snap || snap.raw.silence_min > 360) continue;
        const beh = await scoreBehaviour(snap, behaviour);

        const latest = slice[0];
        const zone = latest.zoneId ? fitZone.get(latest.zoneId) : undefined;
        let lambda = 0;
        if (zone) for (let k = 0; k < 3; k++) lambda += hourlyRate(zone, Math.floor(tick.t / MS_H) * MS_H + k * MS_H, undefined, k);
        const nearby = withCoords.filter((i) => i.t < tick.t && tick.t - i.t <= 6 * MS_H && haversineMeters(latest.lat, latest.lng, i.lat, i.lng) <= 1000).length;
        const anomalies = (aiAlerts.get(tick.uid) ?? []).filter((t) => t < tick.t && tick.t - t <= MS_D).length;
        const userHealth = (healthByUser.get(tick.uid) ?? []).filter((h) => h.t <= tick.t && tick.t - h.t <= 30 * 60_000);
        const inputs: SafetyInputs = {
            zoneRisk: latest.zoneRisk, hour: localHour(tick.t), silenceMin: snap.raw.silence_min, speedKmh: snap.raw.speed_kmh,
            behaviourScore: beh.score, battery: latest.battery, nearbyIncidents6h: nearby, anomalies24h: anomalies,
            areaForecastP3h: 1 - Math.exp(-lambda), healthFlag: userHealth.some((h) => h.flag),
        };
        X.push(buildSafetyVector(inputs));
        y.push((confirmed.get(tick.uid) ?? []).some((t) => t > tick.t && t <= tick.t + 3 * MS_H) ? 1 : 0);
        times.push(tick.t);
        isRandom.push(tick.random);
    }

    const cut = times.findIndex((t) => t >= splitT);
    const split = cut < 0 ? Math.floor(X.length * 0.75) : cut;
    const trainPos = y.slice(0, split).reduce((s: number, v) => s + v, 0);
    const testPos = y.slice(split).reduce((s: number, v) => s + v, 0);
    if (trainPos < 12 || testPos < 4) {
        return { name, status: 'skipped', reason: `Needs at least 12 positive training moments and 4 in the hold-out; found ${trainPos} and ${testPos}. Using the built-in prior meanwhile.`, samples: X.length };
    }

    // Positives were deliberately over-sampled (moments just before real incidents), so calibrate the
    // intercept to the true base rate measured on the randomly sampled moments only.
    const rateOf = (from: number, to: number) => {
        let n = 0; let pos = 0;
        for (let i = from; i < to; i++) if (isRandom[i]) { n++; pos += y[i]; }
        return n ? Math.max(pos / n, 1e-4) : undefined;
    };
    const candidate = trainLogistic(X.slice(0, split), y.slice(0, split), [...SAFETY_FEATURES], { baseRate: rateOf(0, split), signs: SAFETY_SIGNS });
    const holdout = evaluate(candidate, X.slice(split), y.slice(split));
    const prior = evaluate(SAFETY_PRIOR, X.slice(split), y.slice(split));
    const randomIdx = Array.from({ length: X.length - split }, (_, i) => i + split).filter((i) => isRandom[i]);
    const holdoutRandom = randomIdx.length ? evaluate(candidate, randomIdx.map((i) => X[i]), randomIdx.map((i) => y[i])) : null;
    const metrics = {
        holdout_auc: round(holdout.auc, 4), prior_auc: round(prior.auc, 4),
        calibrated_brier: holdoutRandom ? round(holdoutRandom.brier, 5) : null,
        true_base_rate: holdoutRandom ? round(holdoutRandom.base_rate, 5) : null,
        holdout_n: holdout.n, holdout_positives: holdout.positives,
    };
    if (holdout.auc < GATES.safetyHoldoutAuc || holdout.auc < prior.auc - 0.02) {
        return { name, status: 'rejected', reason: `Hold-out AUC ${metrics.holdout_auc} did not beat the quality gate (≥ ${GATES.safetyHoldoutAuc}) and the prior (${metrics.prior_auc}); keeping the prior.`, samples: X.length, metrics };
    }
    const finalModel = trainLogistic(X, y, [...SAFETY_FEATURES], { baseRate: rateOf(0, X.length), signs: SAFETY_SIGNS });
    const version = await saveModel('safety_risk', finalModel, metrics, X.length);
    return { name, status: 'trained', version, samples: X.length, metrics };
}

// ── SOS triage ──────────────────────────────────────────────────────────────

async function trainSosGenuine(): Promise<TrainReport> {
    const name = 'sos_genuine';
    const rows: any[] = await Incident.find({ source: 'sos_panic', status: { $in: ['false_alarm', 'resolved', 'assigned', 'escalated'] } })
        .select('title description status created_at metadata').sort({ created_at: 1 }).limit(5000).lean();

    const X: number[][] = [];
    const y: Array<0 | 1> = [];
    const text = seedTextModel();
    for (const r of rows) {
        const meta = r.metadata || {};
        const saved: number[] | undefined = meta.sos_triage?.vector;
        let vector: number[];
        if (Array.isArray(saved) && saved.length === TRIAGE_FEATURES.length) {
            vector = saved;
        } else {
            const m = meta.sos_risk_metrics || {};
            const s = meta.sos_misuse_signals || {};
            const inputs: TriageInputs = {
                text: r.description || '', zoneRisk: 0, outsideZone: !!m.isOutsideZone, hour: localHour(new Date(r.created_at).getTime()),
                healthFlag: false, behaviourScore: 0.5, nearbyIncidents15m: Number(m.nearbyIncidents15m) || 0, anomalies24h: Number(m.userAnomalies24h) || 0,
                sosLast24h: Number(s.sos_last_24h) || 1, falseAlarmRate7d: Number(s.false_alarm_rate_7d) || 0,
                // Older records measured the gap to the SOS itself (~0 min); treat those as unknown.
                minutesSinceLastSos: Number(s.minutes_since_last_sos) >= 0.5 ? Number(s.minutes_since_last_sos) : 9999,
                silenceMin: Math.min(Number(m.inactivityMinutes) || 0, 360),
            };
            vector = buildTriageVector(inputs, classifyText(text, inputs.text));
        }
        X.push(vector);
        y.push(r.status === 'false_alarm' ? 0 : 1);
    }
    const pos = y.reduce((s: number, v) => s + v, 0);
    const neg = y.length - pos;
    if (y.length < 40 || pos < 10 || neg < 10) {
        return { name, status: 'skipped', reason: `Needs at least 40 SOS outcomes with 10+ genuine and 10+ false alarms (officers mark false alarms); found ${y.length} (${pos} genuine, ${neg} false). Using the built-in prior meanwhile.`, samples: y.length };
    }
    const split = Math.floor(X.length * 0.75);
    const candidate = trainLogistic(X.slice(0, split), y.slice(0, split), [...TRIAGE_FEATURES], { signs: TRIAGE_SIGNS });
    const holdout = evaluate(candidate, X.slice(split), y.slice(split));
    const metrics = { holdout_auc: round(holdout.auc, 4), brier: round(holdout.brier, 4), genuine: pos, false_alarm: neg, holdout_n: holdout.n };
    if (holdout.auc < GATES.sosHoldoutAuc) {
        return { name, status: 'rejected', reason: `Hold-out AUC ${metrics.holdout_auc} is below ${GATES.sosHoldoutAuc}; keeping the prior.`, samples: y.length, metrics };
    }
    const version = await saveModel('sos_genuine', trainLogistic(X, y, [...TRIAGE_FEATURES], { signs: TRIAGE_SIGNS }), metrics, y.length);
    return { name, status: 'trained', version, samples: y.length, metrics };
}

async function trainSosText(): Promise<TrainReport> {
    const name = 'sos_text';
    const rows: any[] = await Incident.find({ incident_type: { $in: Object.keys(CATEGORY_BY_TYPE) }, status: { $ne: 'false_alarm' } })
        .select('title description incident_type').limit(5000).lean();
    const examples = rows
        .map((r) => ({ text: `${r.title || ''}. ${r.description || ''}`, category: CATEGORY_BY_TYPE[r.incident_type] as TriageCategory & (typeof TRIAGE_CATEGORIES)[number] }))
        .filter((e) => e.category && e.text.length > 12);
    if (examples.length < 40) {
        return { name, status: 'skipped', reason: `Needs at least 40 described incidents with a known type; found ${examples.length}. Using the keyword lexicon meanwhile.`, samples: examples.length };
    }
    const split = Math.floor(examples.length * 0.8);
    const accuracy = (model: TextModel, set: typeof examples) => {
        let correct = 0;
        for (const e of set) if (classifyText(model, e.text).category === e.category) correct++;
        return correct / Math.max(1, set.length);
    };
    const holdout = examples.slice(split);
    const lexiconAcc = accuracy(seedTextModel(), holdout);
    const learned = trainTextModel(examples.slice(0, split));
    const learnedAcc = accuracy(learned, holdout);
    const metrics = { holdout_accuracy: round(learnedAcc, 4), lexicon_accuracy: round(lexiconAcc, 4), holdout_n: holdout.length };
    if (learnedAcc < lexiconAcc + GATES.textAccuracyLift) {
        return { name, status: 'rejected', reason: 'Learning from incidents did not beat the keyword lexicon on the hold-out; keeping the lexicon.', samples: examples.length, metrics };
    }
    const version = await saveModel('sos_text', trainTextModel(examples), metrics, examples.length);
    return { name, status: 'trained', version, samples: examples.length, metrics };
}

// ── Status for the dashboard ─────────────────────────────────────────────────

export async function getMlStatus() {
    const names: ModelName[] = ['behaviour_anomaly', 'safety_risk', 'sos_genuine', 'sos_text', 'zone_forecast_backtest'];
    const stored = await Promise.all(names.map((n) => loadActiveModel(n)));
    const since = new Date(Date.now() - TRAIN_WINDOW_DAYS * MS_D);
    const [pings, sosLabelled, confirmed] = await Promise.all([
        LocationLog.countDocuments({ recorded_at: { $gte: since } }),
        Incident.countDocuments({ source: 'sos_panic', status: { $in: ['false_alarm', 'resolved', 'assigned', 'escalated'] } }),
        Incident.countDocuments({ created_at: { $gte: since }, status: { $ne: 'false_alarm' }, source: { $in: ['sos_panic', 'user_report', 'resident_report'] } }),
    ]);
    const total = await MlModel.countDocuments({});
    const info = (label: string, what: string, name: ModelName, needs: string) => {
        const m = stored[names.indexOf(name)];
        return {
            key: name, label, what, source: m ? 'trained' : 'prior',
            version: m?.version ?? null, trained_at: m?.trained_at ?? null, samples: m?.sample_count ?? 0, metrics: m?.metrics ?? null, needs,
        };
    };
    return {
        models: [
            info('Behaviour anomaly', 'Flags movement that is out of character for this person', 'behaviour_anomaly', '1,500+ in-session movement samples from 5+ people'),
            info('Safety risk', 'Probability of an incident in the next 3 hours (drives the safety score)', 'safety_risk', '8+ confirmed incidents, 12+ positive training moments'),
            info('SOS genuineness', 'How likely an SOS is a real emergency', 'sos_genuine', '40+ SOS outcomes with 10+ genuine and 10+ false alarms'),
            info('SOS category', 'What kind of emergency the message describes', 'sos_text', '40+ described incidents with a known type'),
            info('Zone forecast', 'Expected incidents per zone and hour', 'zone_forecast_backtest', '10+ earlier and 5+ recent incidents to measure accuracy'),
        ],
        data: { pings_45d: pings, sos_outcomes: sosLabelled, reported_or_sos_incidents_45d: confirmed, stored_model_versions: total },
        gates: GATES,
    };
}

