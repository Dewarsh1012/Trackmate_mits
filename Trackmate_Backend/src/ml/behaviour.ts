import { clamp, haversineMeters, median, mad, mulberry32, round, sigmoid, auc } from './math';
import { IsolationForestModel, explainDeviation, scoreIsolationForest, trainIsolationForest } from './isolationForest';
import { loadActiveModel, ModelName } from './modelStore';

/**
 * Behavioural anomaly model. Looks at a person's movement the way a patrol officer would
 * ("that is not how this person normally behaves") instead of using fixed thresholds.
 * Unsupervised Isolation Forest, so it works without labelled incidents.
 */

export const BEHAVIOUR_MODEL: ModelName = 'behaviour_anomaly';

export const BEHAVIOUR_FEATURES = [
    'silence_min', 'speed_kmh', 'accel_kmh', 'moved_30m_m', 'hour_sin', 'hour_cos',
    'zone_risk', 'battery', 'dist_from_usual_km', 'stationary_min', 'speed_dev', 'hr_dev',
    // Silence counted only when people are normally active (silence overnight is expected, at noon it is not).
    'active_silence_min',
] as const;

/** Features that are log-scaled before modelling (heavy-tailed quantities). */
const LOG_FEATURES = new Set([0, 1, 2, 3, 8, 9, 12]);

export interface PingRow {
    t: number; // ms epoch
    lat: number;
    lng: number;
    battery?: number; // 0..100
    zoneRisk: number; // 0 safe .. 1 restricted; OUTSIDE_ZONE_RISK when in no zone
    zoneId?: string | null;
}

export const ZONE_RISK_NUM: Record<string, number> = { safe: 0, moderate: 0.35, high: 0.7, restricted: 1 };
export const OUTSIDE_ZONE_RISK = 0.55;

const TZ_OFFSET_MIN = Number.isFinite(Number(process.env.ML_TZ_OFFSET_MIN)) ? Number(process.env.ML_TZ_OFFSET_MIN) : 330;
export const localHour = (ms: number): number => new Date(ms + TZ_OFFSET_MIN * 60_000).getUTCHours() + new Date(ms + TZ_OFFSET_MIN * 60_000).getUTCMinutes() / 60;

export interface BehaviourContext {
    /** Z-score of the latest heart-rate reading against the person's own baseline (0 when unknown). */
    hrZ?: number;
    /** Share of the day's peak activity at each local hour, 0..1 (flat 1 when unknown). */
    activityByHour?: number[];
}

/** An isolation forest plus the hour-of-day activity profile it was trained with. */
export type BehaviourModel = IsolationForestModel & { activity_by_hour: number[] };

export interface BehaviourSnapshot {
    vector: number[];
    raw: Record<(typeof BEHAVIOUR_FEATURES)[number], number>;
}

const WINDOW_48H = 48 * 3600_000;
const MAX_BASELINE = 120;

/**
 * Builds the feature vector as of `tick`. `logs` must be sorted newest first and contain only pings <= tick.
 * Training and serving both call this, so the model sees the same definition in both places.
 */
export function buildBehaviourSnapshot(logs: PingRow[], tick: number, ctx: BehaviourContext = {}): BehaviourSnapshot | null {
    const latest = logs[0];
    if (!latest) return null;

    const silenceMin = Math.max(0, (tick - latest.t) / 60_000);

    // Speed over the last segment and the one before it.
    const segSpeed = (a: PingRow, b: PingRow): number => {
        const dtH = (a.t - b.t) / 3600_000;
        if (dtH <= 0 || dtH > 0.5) return 0; // too far apart to infer a speed
        return haversineMeters(a.lat, a.lng, b.lat, b.lng) / 1000 / dtH;
    };
    const speed = logs[1] ? segSpeed(latest, logs[1]) : 0;
    const prevSpeed = logs[2] ? segSpeed(logs[1], logs[2]) : 0;
    const accel = logs[2] ? Math.abs(speed - prevSpeed) : 0;

    // Displacement over ~30 minutes.
    let ref = logs[logs.length - 1];
    for (const p of logs) {
        if (latest.t - p.t >= 30 * 60_000) { ref = p; break; }
    }
    const moved30 = haversineMeters(latest.lat, latest.lng, ref.lat, ref.lng);

    // How long the person has stayed within 50 m of where they are now.
    let stationaryMin = 0;
    for (const p of logs) {
        if (haversineMeters(latest.lat, latest.lng, p.lat, p.lng) > 50) break;
        stationaryMin = (tick - p.t) / 60_000;
    }

    // Personal baseline from up to ~48 h of history, thinned to a bounded sample.
    const inWindow = logs.filter((p) => tick - p.t <= WINDOW_48H);
    const stride = Math.max(1, Math.ceil(inWindow.length / MAX_BASELINE));
    const base = inWindow.filter((_, i) => i % stride === 0);
    const usualLat = median(base.map((p) => p.lat));
    const usualLng = median(base.map((p) => p.lng));
    const distUsualKm = haversineMeters(latest.lat, latest.lng, usualLat, usualLng) / 1000;

    const baseSpeeds: number[] = [];
    for (let i = 0; i + 1 < base.length; i++) baseSpeeds.push(segSpeed(base[i], base[i + 1]));
    const speedMed = median(baseSpeeds);
    const speedDev = baseSpeeds.length >= 5 ? clamp(Math.abs(speed - speedMed) / (mad(baseSpeeds, speedMed) * 1.4826 + 3), 0, 25) : 0;

    const hour = localHour(tick);
    const raw = {
        silence_min: silenceMin,
        speed_kmh: speed,
        accel_kmh: accel,
        moved_30m_m: moved30,
        hour_sin: Math.sin((hour / 24) * 2 * Math.PI),
        hour_cos: Math.cos((hour / 24) * 2 * Math.PI),
        zone_risk: latest.zoneRisk,
        battery: latest.battery != null ? clamp(latest.battery / 100, 0, 1) : 0.6,
        dist_from_usual_km: distUsualKm,
        stationary_min: Math.min(stationaryMin, 600),
        speed_dev: speedDev,
        hr_dev: clamp(Math.abs(ctx.hrZ ?? 0), 0, 8),
        active_silence_min: silenceMin * (ctx.activityByHour ? (ctx.activityByHour[Math.floor(hour) % 24] ?? 1) : 1),
    };
    const vector = BEHAVIOUR_FEATURES.map((name, i) => (LOG_FEATURES.has(i) ? Math.log1p(raw[name]) : raw[name]));
    return { vector, raw };
}

/** Mirrors how training slices history: the newest 30 pings untouched, the rest thinned to a bounded sample. */
export function thinNewestFirst(logs: PingRow[], max = 240): PingRow[] {
    if (logs.length <= max) return logs;
    const stride = Math.max(1, Math.floor(logs.length / max));
    const out: PingRow[] = [];
    for (let i = 0; i < logs.length && out.length < max; i += i < 30 ? 1 : stride) out.push(logs[i]);
    return out;
}

export const MIN_BEHAVIOUR_ROWS = 1500;
export const MIN_BEHAVIOUR_USERS = 5;

// ── Training ──────────────────────────────────────────────────────────────

export interface BehaviourTrainResult {
    model: BehaviourModel;
    metrics: Record<string, number>;
    sampleCount: number;
}

/**
 * `logsByUser` rows must be sorted oldest to newest per user. Samples "ticks" along each person's
 * history exactly the way the live check does (every few minutes) and learns what normal looks like.
 */
export function trainBehaviourModel(
    logsByUser: Map<string, PingRow[]>,
    options: { ticksPerUser?: number; maxRows?: number; seed?: number } = {}
): BehaviourTrainResult | null {
    const rand = mulberry32(options.seed ?? 7);
    const ticksPerUser = options.ticksPerUser ?? 300;
    const maxRows = options.maxRows ?? 20_000;
    const rows: number[][] = [];

    // When are people normally sending pings? Smoothed so a quiet hour is never exactly zero.
    const hourly = new Array(24).fill(0);
    for (const logs of logsByUser.values()) for (const p of logs) hourly[Math.floor(localHour(p.t)) % 24]++;
    const peak = Math.max(...hourly, 1);
    const activityByHour = hourly.map((c) => round(Math.max(0.02, c / peak), 4));

    for (const logs of logsByUser.values()) {
        if (logs.length < 12) continue;
        const first = logs[0].t + 10 * 60_000;
        const last = logs[logs.length - 1].t + 10 * 60_000; // a tick shortly after the last ping is a real case too
        if (last <= first) continue;
        for (let k = 0; k < ticksPerUser && rows.length < maxRows; k++) {
            const tick = first + rand() * (last - first);
            // Newest-first slice of pings at or before the tick (binary search on the ascending array).
            let lo = 0;
            let hi = logs.length - 1;
            let idx = -1;
            while (lo <= hi) {
                const mid = (lo + hi) >> 1;
                if (logs[mid].t <= tick) { idx = mid; lo = mid + 1; } else hi = mid - 1;
            }
            if (idx < 0) continue;
            const slice: PingRow[] = thinNewestFirst(logs.slice(Math.max(0, idx - 1500), idx + 1).reverse());
            const silence = (tick - slice[0].t) / 60_000;
            if (silence > 360) continue; // person was simply not using the app
            const snap = buildBehaviourSnapshot(slice, tick, { activityByHour });
            if (snap) rows.push(snap.vector);
        }
    }
    // A model that can raise alerts on its own needs a real population behind it, not a handful of demo users.
    const users = [...logsByUser.values()].filter((l) => l.length >= 12).length;
    if (rows.length < MIN_BEHAVIOUR_ROWS || users < MIN_BEHAVIOUR_USERS) return null;

    // Hold out 20% for a sanity check, train on the rest.
    const shuffled = rows.map((r) => ({ r, k: rand() })).sort((a, b) => a.k - b.k).map((x) => x.r);
    const cut = Math.floor(shuffled.length * 0.8);
    const trainRows = shuffled.slice(0, cut);
    const testRows = shuffled.slice(cut);
    const model: BehaviourModel = { ...trainIsolationForest(trainRows, { trees: 80, sampleSize: 256, seed: options.seed ?? 7, thresholdQuantile: 0.99 }), activity_by_hour: activityByHour };

    // Without labels we validate by injecting realistic anomalies into held-out rows and checking they rank higher.
    const injected = testRows.map((row) => injectAnomaly(row, rand));
    const normalScores = testRows.map((r) => scoreIsolationForest(model, r));
    const injectedScores = injected.map((r) => scoreIsolationForest(model, r));
    const detection = auc([...normalScores, ...injectedScores], [...normalScores.map(() => 0 as const), ...injectedScores.map(() => 1 as const)]);
    const falseAlertRate = normalScores.filter((s) => s >= model.threshold).length / normalScores.length;
    const recall = injectedScores.filter((s) => s >= model.threshold).length / injectedScores.length;

    return {
        model,
        sampleCount: rows.length,
        metrics: {
            injected_anomaly_auc: round(detection, 4),
            injected_recall_at_threshold: round(recall, 4),
            false_alert_rate: round(falseAlertRate, 4),
            threshold: round(model.threshold, 4),
        },
    };
}

/** A believable "something went wrong" perturbation: long silence, a speed spike, or being far from the usual area. */
export function injectAnomaly(row: number[], rand: () => number): number[] {
    const out = [...row];
    const kind = Math.floor(rand() * 3);
    if (kind === 0) { const m = 90 + rand() * 240; out[0] = Math.log1p(m); out[9] = Math.log1p(90 + rand() * 300); out[12] = Math.log1p(m * 0.9); }
    else if (kind === 1) { out[1] = Math.log1p(80 + rand() * 120); out[2] = Math.log1p(40 + rand() * 80); out[10] = 8 + rand() * 12; }
    else { out[8] = Math.log1p(15 + rand() * 80); out[3] = Math.log1p(2000 + rand() * 8000); out[6] = Math.max(out[6], 0.7); }
    return out;
}

// ── Serving ───────────────────────────────────────────────────────────────

export interface BehaviourResult {
    score: number; // 0..1, ~0.5 typical
    threshold: number;
    anomalous: boolean;
    source: 'prior' | 'trained';
    version: string;
    reasons: string[];
    raw: BehaviourSnapshot['raw'];
}

/** Scales used before a model has been trained: a point must be several "typical spreads" out to count. */
const PRIOR_SCALE: Record<string, [number, number]> = {
    active_silence_min: [4, 12], speed_kmh: [5, 20], accel_kmh: [3, 15], moved_30m_m: [250, 900],
    dist_from_usual_km: [1.5, 6], stationary_min: [20, 60], speed_dev: [1, 3], hr_dev: [0.5, 2],
};

function priorScore(raw: BehaviourSnapshot['raw']): number {
    let worst = 0;
    for (const [name, [typical, spread]] of Object.entries(PRIOR_SCALE)) {
        worst = Math.max(worst, ((raw as any)[name] - typical) / spread);
    }
    return sigmoid((worst - 3.5) * 1.1);
}

const describe: Record<string, (raw: BehaviourSnapshot['raw']) => string> = {
    active_silence_min: (r) => `no location update for ${Math.round(r.silence_min)} min`,
    speed_kmh: (r) => `moving at ${Math.round(r.speed_kmh)} km/h`,
    accel_kmh: (r) => `sudden speed change of ${Math.round(r.accel_kmh)} km/h`,
    moved_30m_m: (r) => `moved ${r.moved_30m_m >= 1000 ? (r.moved_30m_m / 1000).toFixed(1) + ' km' : Math.round(r.moved_30m_m) + ' m'} in 30 min`,
    dist_from_usual_km: (r) => `${r.dist_from_usual_km.toFixed(1)} km from their usual area`,
    stationary_min: (r) => `stationary for ${Math.round(r.stationary_min)} min`,
    speed_dev: (r) => `speed ${r.speed_dev.toFixed(1)}× their normal variation`,
    hr_dev: (r) => `heart rate ${r.hr_dev.toFixed(1)} SD from their baseline`,
};

export async function loadBehaviourModel(): Promise<{ model: BehaviourModel | null; version: string }> {
    const stored = await loadActiveModel<BehaviourModel>(BEHAVIOUR_MODEL);
    const ok = stored && Array.isArray(stored.payload?.trees) && stored.payload.feature_count === BEHAVIOUR_FEATURES.length;
    return ok ? { model: stored!.payload, version: stored!.version } : { model: null, version: 'prior-v1' };
}

export async function scoreBehaviour(snapshot: BehaviourSnapshot, preloaded?: BehaviourModel | null): Promise<BehaviourResult> {
    let model: BehaviourModel | null = preloaded ?? null;
    let version = 'prior-v1';
    if (preloaded === undefined) {
        const loaded = await loadBehaviourModel();
        model = loaded.model;
        version = loaded.version;
    }

    const reasons: string[] = [];
    let score: number;
    let threshold: number;
    let source: 'prior' | 'trained';
    if (model) {
        score = scoreIsolationForest(model, snapshot.vector);
        threshold = Math.max(model.threshold, 0.58);
        source = 'trained';
        for (const { feature, z } of explainDeviation(model, snapshot.vector)) {
            const name = BEHAVIOUR_FEATURES[feature];
            if (Math.abs(z) < 2.5 || !describe[name]) continue;
            if (z < 0) continue; // only "too much of" something is noteworthy
            reasons.push(describe[name](snapshot.raw));
            if (reasons.length >= 3) break;
        }
    } else {
        score = priorScore(snapshot.raw);
        threshold = 0.7;
        source = 'prior';
        for (const [name, [typical, spread]] of Object.entries(PRIOR_SCALE)) {
            if (((snapshot.raw as any)[name] - typical) / spread >= 3 && describe[name]) reasons.push(describe[name](snapshot.raw));
            if (reasons.length >= 3) break;
        }
    }
    return { score: round(score, 4), threshold: round(threshold, 4), anomalous: score >= threshold, source, version, reasons, raw: snapshot.raw };
}
