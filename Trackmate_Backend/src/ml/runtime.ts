import mongoose from 'mongoose';
import { HealthSample, Incident, LocationLog, Presence, Profile, Zone } from '../models';
import { findZoneForPoint } from '../lib/geofence';
import { haversineMeters, median, round } from './math';
import {
    BehaviourModel, BehaviourResult, BehaviourSnapshot, OUTSIDE_ZONE_RISK, PingRow, ZONE_RISK_NUM,
    buildBehaviourSnapshot, loadBehaviourModel, localHour, scoreBehaviour, thinNewestFirst,
} from './behaviour';
import { SafetyAssessment, SafetyInputs, assessWithModel, loadSafetyModel } from './safety';
import {
    BacktestResult, ExposureRow, ForecastFit, ForecastIncident, ForecastZone, HourForecast, ZoneForecast,
    backtestForecast, fitZoneForecast, forecastZones, hourlyRate,
} from './zoneForecast';
import { TRIAGE_PRIOR, TriageInputs, TriageResult, classifyText, seedTextModel, triageSos, TextModel } from './sosTriage';
import { loadActiveModel } from './modelStore';
import { LogisticModel } from './logistic';

const MS_H = 3600_000;
const MS_D = 24 * MS_H;
export const FORECAST_WINDOW_DAYS = 56;
const NON_INCIDENT_TYPES = ['checkin', 'safe_house_request'];

// ── Zone forecast ──────────────────────────────────────────────────────────

interface ForecastCache {
    at: number;
    fit: ForecastFit;
    zones: ForecastZone[];
    backtest: BacktestResult;
    currentLoad: Record<string, number>;
}
let forecastCache: ForecastCache | null = null;
const FORECAST_CACHE_MS = 5 * 60_000;

/** Incidents → zone ids. Uses the stored zone, else the zone that contains the incident's coordinates. */
export function assignIncidentsToZones(rows: any[], zonesRaw: any[]): ForecastIncident[] {
    const out: ForecastIncident[] = [];
    for (const row of rows) {
        let zoneId = row.zone ? String(row.zone) : null;
        if (!zoneId && Number.isFinite(row.latitude) && Number.isFinite(row.longitude)) {
            const zone = findZoneForPoint(Number(row.latitude), Number(row.longitude), zonesRaw as any);
            if (zone) zoneId = String((zone as any)._id);
        }
        if (zoneId) out.push({ t: new Date(row.created_at).getTime(), zoneId });
    }
    return out;
}

export async function loadForecastData(now = Date.now()) {
    const since = new Date(now - FORECAST_WINDOW_DAYS * MS_D);
    const exposureSince = new Date(now - 28 * MS_D);
    const [zonesRaw, incRaw, exposureRaw, presence, firstInc, firstLog] = await Promise.all([
        Zone.find({ is_active: true }).lean(),
        Incident.find({
            created_at: { $gte: since },
            incident_type: { $nin: NON_INCIDENT_TYPES },
            status: { $ne: 'false_alarm' },
        }).select('zone latitude longitude created_at').lean(),
        LocationLog.aggregate([
            { $match: { recorded_at: { $gte: exposureSince }, current_zone: { $exists: true, $ne: null } } },
            { $group: { _id: { z: '$current_zone', hb: { $floor: { $divide: [{ $toLong: '$recorded_at' }, MS_H] } } }, users: { $addToSet: '$user' } } },
            { $project: { _id: 0, z: '$_id.z', hb: '$_id.hb', users: { $size: '$users' } } },
        ]).allowDiskUse(true),
        Presence.find({ last_seen: { $gte: new Date(now - 10 * 60_000) }, zone: { $ne: null } }).select('zone').lean(),
        Incident.findOne({ created_at: { $gte: since } }).sort({ created_at: 1 }).select('created_at').lean(),
        LocationLog.findOne({ recorded_at: { $gte: since } }).sort({ recorded_at: 1 }).select('recorded_at').lean(),
    ]);

    // A young platform doesn't have 56 days of history; dividing counts by 56 would understate every rate.
    // Movement data marks when the platform was really in use; back-dated reports alone would stretch the window.
    const starts = [(firstLog as any)?.recorded_at ?? (firstInc as any)?.created_at].filter(Boolean).map((d) => new Date(d).getTime());
    const observedDays = starts.length ? Math.min(FORECAST_WINDOW_DAYS, Math.max(7, Math.ceil((now - Math.min(...starts)) / MS_D))) : 7;

    const zones: ForecastZone[] = (zonesRaw as any[]).map((z) => ({ id: String(z._id), name: z.name, riskLevel: z.risk_level }));
    const incidents = assignIncidentsToZones(incRaw as any[], zonesRaw as any[]);
    const exposure: ExposureRow[] = (exposureRaw as any[]).map((r) => ({ zoneId: String(r.z), hourBucket: Number(r.hb), users: Number(r.users) }));
    const currentLoad: Record<string, number> = {};
    for (const p of presence as any[]) currentLoad[String(p.zone)] = (currentLoad[String(p.zone)] ?? 0) + 1;
    return { zones, incidents, exposure, currentLoad, zonesRaw: zonesRaw as any[], observedDays };
}

async function getForecastCache(): Promise<ForecastCache> {
    if (forecastCache && Date.now() - forecastCache.at < FORECAST_CACHE_MS) return forecastCache;
    const now = Date.now();
    const data = await loadForecastData(now);
    forecastCache = {
        at: now,
        zones: data.zones,
        fit: fitZoneForecast(data.zones, data.incidents, data.exposure, now, data.observedDays),
        backtest: backtestForecast(data.zones, data.incidents, data.exposure, now, data.observedDays),
        currentLoad: data.currentLoad,
    };
    return forecastCache;
}

export function invalidateForecastCache(): void { forecastCache = null; }

export interface ForecastResponse {
    generated_at: string;
    horizon_hours: number;
    model: {
        kind: string;
        window_days: number;
        incidents_in_window: number;
        backtest: BacktestResult;
        note: string;
    };
    zones: ZoneForecast[];
    top_windows: Array<{ zone_id: string; zone_name: string; hour_start: string; probability: number; band: HourForecast['band'] }>;
}

export async function getZoneForecast(hours = 24): Promise<ForecastResponse> {
    const cache = await getForecastCache();
    const now = Date.now();
    const zones = forecastZones(cache.fit, now, hours, cache.currentLoad);
    const top = zones
        .flatMap((z) => z.hours.map((h) => ({ zone_id: z.zone_id, zone_name: z.zone_name, hour_start: h.hour_start, probability: h.probability, band: h.band })))
        .sort((a, b) => b.probability - a.probability)
        .slice(0, 8);
    const sparse = cache.fit.total_incidents < 30;
    return {
        generated_at: new Date(now).toISOString(),
        horizon_hours: hours,
        model: {
            kind: 'seasonal Gamma-Poisson',
            window_days: cache.fit.window_days,
            incidents_in_window: cache.fit.total_incidents,
            backtest: cache.backtest,
            note: sparse
                ? 'Little incident history so far: forecasts lean on each zone\'s risk level and sharpen as real incidents accumulate.'
                : 'Learned from incident history by zone, hour of day and weekday, adjusted for recent trend and tourist load.',
        },
        zones,
        top_windows: top,
    };
}

/** Probability of at least one incident in the zone during the next 3 hours (0 when outside all zones). */
export async function areaForecastP3h(zoneId: string | null): Promise<number> {
    if (!zoneId) return 0;
    try {
        const cache = await getForecastCache();
        const zone = cache.fit.zones.find((z) => z.id === zoneId);
        if (!zone) return 0;
        const first = Math.floor(Date.now() / MS_H) * MS_H;
        let lambda = 0;
        for (let k = 0; k < 3; k++) lambda += hourlyRate(zone, first + k * MS_H, cache.currentLoad[zoneId], k);
        return 1 - Math.exp(-lambda);
    } catch {
        return 0;
    }
}

// ── Live tourist evaluation (behaviour anomaly + safety risk) ─────────────────

export interface UserMl {
    userId: string;
    behaviour: BehaviourResult;
    assessment: SafetyAssessment;
    snapshot: BehaviourSnapshot;
    latest: { lat: number; lng: number; at: number; zoneId: string | null };
}

const HEALTH_FLAG = (hr?: number, spo2?: number) => (hr != null && (hr > 160 || hr < 40)) || (spo2 != null && spo2 < 92);
const STALE_AFTER_MIN = 360;

const PINGS_PER_USER = 1500;

/** Newest pings per person (bounded per user, so one busy device can't crowd out everyone else). */
async function fetchRecentPings(ids: string[], now: number): Promise<Map<string, any[]>> {
    const since = new Date(now - 48 * MS_H);
    const out = new Map<string, any[]>();
    for (let i = 0; i < ids.length; i += 8) {
        await Promise.all(ids.slice(i, i + 8).map(async (uid) => {
            const rows = await LocationLog.find({ user: uid, recorded_at: { $gte: since } })
                .select('user latitude longitude battery_level recorded_at current_zone')
                .sort({ recorded_at: -1 })
                .limit(PINGS_PER_USER)
                .lean();
            if (rows.length) out.set(uid, rows as any[]);
        }));
    }
    return out;
}

/**
 * Scores tourists from their last 48 h of pings. People who have not pinged for six hours are skipped
 * (they are simply offline; the inactivity rules handle them).
 */
export async function evaluateTourists(opts: { userIds?: string[]; now?: number } = {}): Promise<Map<string, UserMl>> {
    const now = opts.now ?? Date.now();
    const out = new Map<string, UserMl>();

    let ids = opts.userIds;
    if (!ids) {
        const tourists = await Profile.find({ role: 'tourist', is_active: true }).select('_id').lean();
        ids = tourists.map((t: any) => String(t._id));
    }
    if (!ids.length) return out;

    const [zonesRaw, logsRaw, incidents6h, anomalyRows, healthRows, behaviourLoaded, safetyLoaded] = await Promise.all([
        Zone.find({ is_active: true }).lean(),
        fetchRecentPings(ids, now),
        Incident.find({ created_at: { $gte: new Date(now - 6 * MS_H) }, latitude: { $exists: true }, longitude: { $exists: true }, incident_type: { $nin: NON_INCIDENT_TYPES } })
            .select('latitude longitude')
            .lean(),
        Incident.aggregate([
            { $match: { reporter: { $in: ids.filter((id) => mongoose.Types.ObjectId.isValid(id)).map((id) => new mongoose.Types.ObjectId(id)) }, source: 'ai_anomaly', status: { $nin: ['false_alarm', 'resolved'] }, created_at: { $gte: new Date(now - 24 * MS_H) } } },
            { $group: { _id: '$reporter', n: { $sum: 1 } } },
        ]),
        HealthSample.find({ user: { $in: ids }, recorded_at: { $gte: new Date(now - 7 * MS_D) } })
            .select('user heart_rate spo2 recorded_at').sort({ recorded_at: -1 }).limit(20_000).lean(),
        loadBehaviourModel(),
        loadSafetyModel(),
    ]);

    const zoneById = new Map((zonesRaw as any[]).map((z) => [String(z._id), z]));
    const anomalies = new Map((anomalyRows as any[]).map((r) => [String(r._id), Number(r.n)]));
    const byUser = logsRaw;
    const healthByUser = new Map<string, any[]>();
    for (const row of healthRows as any[]) {
        const key = String(row.user);
        if (!healthByUser.has(key)) healthByUser.set(key, []);
        healthByUser.get(key)!.push(row);
    }
    const activity = behaviourLoaded.model?.activity_by_hour;

    for (const userId of ids) {
        const logs = byUser.get(userId);
        if (!logs?.length) continue;
        const latestRow = logs[0];
        if ((now - new Date(latestRow.recorded_at).getTime()) / 60_000 > STALE_AFTER_MIN) continue;

        // Each ping already stores the zone it was in, so no geometry work per ping.
        const pings: PingRow[] = logs.map((l: any) => ({
            t: new Date(l.recorded_at).getTime(),
            lat: Number(l.latitude),
            lng: Number(l.longitude),
            battery: l.battery_level != null ? Number(l.battery_level) : undefined,
            zoneId: l.current_zone ? String(l.current_zone) : null,
            zoneRisk: l.current_zone && zoneById.get(String(l.current_zone))
                ? (ZONE_RISK_NUM[zoneById.get(String(l.current_zone)).risk_level] ?? OUTSIDE_ZONE_RISK)
                : OUTSIDE_ZONE_RISK,
        }));
        const health = healthByUser.get(userId) ?? [];
        const hrValues = health.map((h) => Number(h.heart_rate)).filter((v) => Number.isFinite(v));
        const latestHealth = health.find((h) => now - new Date(h.recorded_at).getTime() <= 30 * 60_000);
        const hrMedian = hrValues.length >= 10 ? median(hrValues) : null;
        const hrSd = hrValues.length >= 10 ? Math.max(8, Math.sqrt(hrValues.reduce((s, v) => s + (v - hrMedian!) ** 2, 0) / hrValues.length)) : 10;
        const hrZ = latestHealth && hrMedian != null && Number.isFinite(Number(latestHealth.heart_rate)) ? (Number(latestHealth.heart_rate) - hrMedian) / hrSd : 0;

        const snapshot = buildBehaviourSnapshot(thinNewestFirst(pings), now, { hrZ, activityByHour: activity });
        if (!snapshot) continue;
        const behaviour = await scoreBehaviour(snapshot, behaviourLoaded.model);

        const latest = pings[0];
        const zone = findZoneForPoint(latest.lat, latest.lng, zonesRaw as any) as any;
        const zoneId = zone ? String(zone._id) : null;
        const nearby = (incidents6h as any[]).filter((i) => haversineMeters(latest.lat, latest.lng, Number(i.latitude), Number(i.longitude)) <= 1000).length;
        const inputs: SafetyInputs = {
            zoneRisk: zone ? (ZONE_RISK_NUM[zone.risk_level] ?? OUTSIDE_ZONE_RISK) : OUTSIDE_ZONE_RISK,
            hour: localHour(now),
            silenceMin: snapshot.raw.silence_min,
            speedKmh: snapshot.raw.speed_kmh,
            behaviourScore: behaviour.score,
            battery: latest.battery,
            nearbyIncidents6h: nearby,
            anomalies24h: anomalies.get(userId) ?? 0,
            areaForecastP3h: await areaForecastP3h(zoneId),
            healthFlag: HEALTH_FLAG(latestHealth?.heart_rate, latestHealth?.spo2),
        };
        const assessment = assessWithModel(safetyLoaded.model, safetyLoaded.source, safetyLoaded.version, inputs);
        out.set(userId, { userId, behaviour, assessment, snapshot, latest: { lat: latest.lat, lng: latest.lng, at: latest.t, zoneId } });
    }
    return out;
}

// ── SOS triage ──────────────────────────────────────────────────────────────

export async function loadTriageModels(): Promise<{ genuine: LogisticModel; genuineSource: 'prior' | 'trained'; genuineVersion: string; text: TextModel; textVersion: string }> {
    const [genuine, text] = await Promise.all([loadActiveModel<LogisticModel>('sos_genuine'), loadActiveModel<TextModel>('sos_text')]);
    const genuineOk = genuine && Array.isArray(genuine.payload?.weights) && genuine.payload.weights.length === TRIAGE_PRIOR.weights.length;
    const textOk = text && text.payload?.counts && text.payload?.class_docs;
    return {
        genuine: genuineOk ? genuine!.payload : TRIAGE_PRIOR,
        genuineSource: genuineOk ? 'trained' : 'prior',
        genuineVersion: genuineOk ? genuine!.version : 'prior-v1',
        text: textOk ? text!.payload : seedTextModel(),
        textVersion: textOk ? text!.version : 'seed-v1',
    };
}

export async function buildSosTriage(params: {
    reporterId: string;
    text: string;
    latitude?: number;
    longitude?: number;
    metrics?: { isOutsideZone?: boolean; nearbyIncidents15m?: number; userAnomalies24h?: number; inactivityMinutes?: number };
    misuse?: { sos_last_24h?: number; false_alarm_rate_7d?: number; minutes_since_last_sos?: number };
    geminiScore?: number | null;
}): Promise<TriageResult> {
    const now = Date.now();
    const [models, userMl, zonesRaw, health, lastLog] = await Promise.all([
        loadTriageModels(),
        evaluateTourists({ userIds: [params.reporterId], now }).catch(() => new Map<string, UserMl>()),
        Zone.find({ is_active: true }).lean(),
        HealthSample.findOne({ user: params.reporterId, recorded_at: { $gte: new Date(now - 30 * 60_000) } }).sort({ recorded_at: -1 }).lean(),
        LocationLog.findOne({ user: params.reporterId }).sort({ recorded_at: -1 }).select('battery_level').lean(),
    ]);

    const zone = Number.isFinite(params.latitude) && Number.isFinite(params.longitude)
        ? (findZoneForPoint(Number(params.latitude), Number(params.longitude), zonesRaw as any) as any)
        : null;
    const ml = userMl.get(params.reporterId);
    const h: any = health;
    const inputs: TriageInputs = {
        text: params.text,
        zoneRisk: zone ? (ZONE_RISK_NUM[zone.risk_level] ?? 0) : 0,
        outsideZone: params.metrics?.isOutsideZone ?? !zone,
        hour: localHour(now),
        healthFlag: HEALTH_FLAG(h?.heart_rate, h?.spo2),
        battery: (lastLog as any)?.battery_level != null ? Number((lastLog as any).battery_level) : undefined,
        behaviourScore: ml?.behaviour.score ?? 0.5,
        nearbyIncidents15m: params.metrics?.nearbyIncidents15m ?? 0,
        anomalies24h: params.metrics?.userAnomalies24h ?? 0,
        sosLast24h: params.misuse?.sos_last_24h ?? 1,
        falseAlarmRate7d: params.misuse?.false_alarm_rate_7d ?? 0,
        minutesSinceLastSos: params.misuse?.minutes_since_last_sos ?? 9999,
        silenceMin: Math.min(params.metrics?.inactivityMinutes ?? 0, 360),
    };
    return triageSos(inputs, models, params.geminiScore ?? null);
}

export { classifyText, round };
export type { BehaviourModel };
