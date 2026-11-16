import { clamp, round } from './math';

/**
 * Zone risk forecast: expected incidents per zone per hour for the next day.
 *
 * A Gamma-Poisson model with weekly seasonality:
 *   rate(zone, daytype, hour) = daily_rate(zone, daytype) × hour_share(zone, daytype, hour)
 * Sparse zones borrow strength from the platform-wide pattern (empirical-Bayes shrinkage), recent
 * weeks are weighted higher, and expected load (tourists in the zone) damps or boosts the rate.
 * Pure functions: the DB layer feeds data in.
 */

export interface ForecastIncident { t: number; zoneId: string }
export interface ExposureRow { zoneId: string; hourBucket: number; users: number } // hourBucket = floor(ms / 3.6e6)
export interface ForecastZone { id: string; name: string; riskLevel: string }

interface ZoneFit {
    id: string;
    name: string;
    riskLevel: string;
    incidents: number;
    daily_rate: number;
    recent_ratio: number; // last 7 days vs window average
    rate_by_daytype: [number, number]; // [weekday, weekend] incidents/day
    share: [number[], number[]]; // hour-of-day shares, each sums to 1
    exposure: { mean: number; byBucket: Array<number | null>[]; observed: number } | null;
}

export interface ForecastFit {
    fitted_at: number;
    window_days: number;
    total_incidents: number;
    zones: ZoneFit[];
}

export interface HourForecast {
    hour_start: string;
    expected: number;
    probability: number;
    score: number; // 0..100
    band: 'low' | 'elevated' | 'high' | 'severe';
}

export interface ZoneForecast {
    zone_id: string;
    zone_name: string;
    risk_level: string;
    history_incidents: number;
    trend: 'rising' | 'stable' | 'falling';
    expected_next_24h: number;
    peak: { hour_start: string; probability: number; band: HourForecast['band'] } | null;
    hours: HourForecast[];
}

// Used only when the platform has no incident history at all.
const PRIOR_DAILY: Record<string, number> = { restricted: 0.6, high: 0.35, moderate: 0.15, safe: 0.05 };
// Once there is history, a zone's prior is the platform's average zone rate scaled by its risk level, so the
// prior always lives on the same scale as the real data.
const RISK_MULT: Record<string, number> = { restricted: 2.2, high: 1.5, moderate: 0.9, safe: 0.45 };
const PRIOR_DAYS = 7;
// Shrinkage strengths. Backtests showed per-zone, per-weekday hour shapes overfit badly on realistic volumes,
// so the hour-of-day and weekday patterns are learned platform-wide and a zone only departs from them
// when it has a lot of its own history.
const ZONE_SHAPE_K = 60; // pseudo-incidents pulling a zone's hour shape toward the platform shape
const DAYTYPE_SHAPE_K = 50; // pulling the weekend shape toward the all-days shape
const DAYTYPE_RATE_DAYS = 5; // pseudo-days pulling the weekend/weekday rate ratio toward 1

function priorDaily(level: string, platformMean: number): number {
    return platformMean > 0 ? platformMean * (RISK_MULT[level] ?? 1) : (PRIOR_DAILY[level] ?? 0.15);
}
const TZ_OFFSET_MIN = Number.isFinite(Number(process.env.ML_TZ_OFFSET_MIN)) ? Number(process.env.ML_TZ_OFFSET_MIN) : 330;

const MS_H = 3600_000;
const MS_D = 24 * MS_H;
const local = (ms: number) => new Date(ms + TZ_OFFSET_MIN * 60_000);
const dayType = (ms: number): 0 | 1 => { const d = local(ms).getUTCDay(); return d === 0 || d === 6 ? 1 : 0; };
const hourOf = (ms: number): number => local(ms).getUTCHours();

function countDayTypes(endMs: number, days: number): [number, number] {
    const out: [number, number] = [0, 0];
    for (let i = 0; i < days; i++) out[dayType(endMs - (i + 0.5) * MS_D)]++;
    return out;
}

export function fitZoneForecast(
    zones: ForecastZone[],
    incidents: ForecastIncident[],
    exposure: ExposureRow[],
    nowMs: number,
    windowDays = 56
): ForecastFit {
    const start = nowMs - windowDays * MS_D;
    const recentStart = nowMs - 7 * MS_D;
    const dayCounts = countDayTypes(nowMs, windowDays);
    const inWindow = incidents.filter((i) => i.t >= start && i.t <= nowMs);

    // Platform-wide hour-of-day shape: pooled over all days, then per daytype shrunk toward the pooled shape.
    const pooledCount = new Array(24).fill(1);
    const dtCount: [number[], number[]] = [new Array(24).fill(0), new Array(24).fill(0)];
    const dtTotal: [number, number] = [0, 0];
    for (const inc of inWindow) {
        const dt = dayType(inc.t);
        const h = hourOf(inc.t);
        pooledCount[h]++;
        dtCount[dt][h]++;
        dtTotal[dt]++;
    }
    const pooledSum = pooledCount.reduce((a, b) => a + b, 0);
    const pooled = pooledCount.map((v) => v / pooledSum);
    const globalShare = [0, 1].map((dt) => dtCount[dt].map((c, h) => (c + DAYTYPE_SHAPE_K * pooled[h]) / (dtTotal[dt] + DAYTYPE_SHAPE_K))) as [number[], number[]];

    // Platform-wide weekday vs weekend multiplier (1 = no difference), shrunk toward 1.
    const overallPerDay = inWindow.length / windowDays;
    const dayFactor = [0, 1].map((dt) => overallPerDay > 0
        ? ((dtTotal[dt] + DAYTYPE_RATE_DAYS * overallPerDay) / (dayCounts[dt] + DAYTYPE_RATE_DAYS)) / overallPerDay
        : 1) as [number, number];

    const byZone = new Map<string, ForecastIncident[]>();
    for (const inc of inWindow) {
        if (!byZone.has(inc.zoneId)) byZone.set(inc.zoneId, []);
        byZone.get(inc.zoneId)!.push(inc);
    }
    const exposureByZone = new Map<string, ExposureRow[]>();
    for (const row of exposure) {
        if (!exposureByZone.has(row.zoneId)) exposureByZone.set(row.zoneId, []);
        exposureByZone.get(row.zoneId)!.push(row);
    }

    const platformMean = zones.length ? inWindow.filter((i) => zones.some((z) => z.id === i.zoneId)).length / zones.length / windowDays : 0;
    const fits: ZoneFit[] = zones.map((zone) => {
        const rows = byZone.get(zone.id) ?? [];
        const prior = priorDaily(zone.riskLevel, platformMean);
        const daily = (rows.length + prior * PRIOR_DAYS) / (windowDays + PRIOR_DAYS);

        const recentCount = rows.filter((r) => r.t >= recentStart).length;
        const recentRate = (recentCount + daily * 3) / (7 + 3);
        const ratio = clamp(recentRate / Math.max(daily, 1e-6), 0.4, 2.5);

        const perType: [number, number] = [daily * dayFactor[0], daily * dayFactor[1]];
        const zoneHour = new Array(24).fill(0);
        for (const r of rows) zoneHour[hourOf(r.t)]++;
        const share = [0, 1].map((dt) =>
            zoneHour.map((c, h) => (c + ZONE_SHAPE_K * globalShare[dt][h]) / (rows.length + ZONE_SHAPE_K))
        ) as [number[], number[]];

        // Typical number of tourists present per (daytype, hour); used to scale the rate with expected load.
        let exposureFit: ZoneFit['exposure'] = null;
        const exp = exposureByZone.get(zone.id) ?? [];
        if (exp.length >= 24) {
            const grid: Array<number[]>[] = [0, 1].map(() => Array.from({ length: 24 }, () => [] as number[]));
            for (const row of exp) {
                const ms = row.hourBucket * MS_H;
                grid[dayType(ms)][hourOf(ms)].push(row.users);
            }
            const means = grid.map((dtRow) => dtRow.map((vals) => (vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null)));
            const flat = means.flat().filter((v): v is number => v != null);
            exposureFit = { mean: flat.reduce((a, b) => a + b, 0) / flat.length, byBucket: means as any, observed: exp.length };
        }

        return {
            id: zone.id, name: zone.name, riskLevel: zone.riskLevel, incidents: rows.length,
            daily_rate: daily, recent_ratio: ratio, rate_by_daytype: perType, share, exposure: exposureFit,
        };
    });

    return { fitted_at: nowMs, window_days: windowDays, total_incidents: inWindow.length, zones: fits };
}

/** Expected incidents in the hour starting at `hourStartMs`. `currentUsers` optionally reflects live load. */
export function hourlyRate(fit: ZoneFit, hourStartMs: number, currentUsers?: number, hoursAhead = 0): number {
    const dt = dayType(hourStartMs);
    const h = hourOf(hourStartMs);
    let lambda = fit.rate_by_daytype[dt] * fit.share[dt][h];
    // Blend recency in gradually: strongest near-term, fading toward the weekly average.
    const recencyWeight = Math.exp(-hoursAhead / 24);
    lambda *= 1 + (fit.recent_ratio - 1) * recencyWeight;

    // Live crowding: if more tourists are in the zone right now than usual for this hour, the next few
    // hours are riskier (damped: double the crowd raises the rate ~41%). The typical hourly pattern is
    // already part of the hour shape, so it is not applied again.
    if (fit.exposure && currentUsers != null && hoursAhead < 3) {
        const typical = fit.exposure.byBucket[dt][h] ?? fit.exposure.mean;
        lambda *= clamp((currentUsers + 0.5) / (typical + 0.5), 0.5, 3) ** 0.5;
    }
    return lambda;
}

export function bandFor(p: number): HourForecast['band'] {
    return p < 0.03 ? 'low' : p < 0.1 ? 'elevated' : p < 0.25 ? 'high' : 'severe';
}

export function forecastZones(fit: ForecastFit, nowMs: number, hours = 24, currentLoad: Record<string, number> = {}): ZoneForecast[] {
    // Hours start on local clock hours (IST is UTC+5:30, so UTC hour boundaries would read as :30).
    const offset = TZ_OFFSET_MIN * 60_000;
    const first = Math.floor((nowMs + offset) / MS_H) * MS_H - offset;
    return fit.zones.map((zone) => {
        const hoursOut: HourForecast[] = [];
        let total = 0;
        for (let k = 0; k < hours; k++) {
            const start = first + k * MS_H;
            const lambda = hourlyRate(zone, start, currentLoad[zone.id], k);
            const p = 1 - Math.exp(-lambda);
            total += lambda;
            hoursOut.push({
                hour_start: new Date(start).toISOString(),
                expected: round(lambda, 4),
                probability: round(p, 4),
                score: Math.round(100 * Math.min(1, p / 0.3) ** 0.6),
                band: bandFor(p),
            });
        }
        const peak = hoursOut.reduce((best, h) => (h.probability > best.probability ? h : best), hoursOut[0]);
        const trend: ZoneForecast['trend'] = zone.recent_ratio > 1.25 ? 'rising' : zone.recent_ratio < 0.8 ? 'falling' : 'stable';
        return {
            zone_id: zone.id, zone_name: zone.name, risk_level: zone.riskLevel,
            history_incidents: zone.incidents, trend, expected_next_24h: round(total, 3),
            peak: peak ? { hour_start: peak.hour_start, probability: peak.probability, band: peak.band } : null,
            hours: hoursOut,
        };
    }).sort((a, b) => b.expected_next_24h - a.expected_next_24h);
}

// ── Backtest: how much better than naive guessing? ───────────────────────────

export interface BacktestResult {
    insufficient_data: boolean;
    test_days: number;
    test_incidents: number;
    zone_hours: number;
    /** 1 = perfect, 0 = no better than a flat rate, negative = worse. */
    skill_vs_flat: number | null;
    skill_vs_risk_prior: number | null;
    /** Share of test incidents that fell in the 10% of zone-hours the model ranked riskiest. */
    capture_top10: number | null;
}

function poissonDeviance(observed: number[], predicted: number[]): number {
    let dev = 0;
    for (let i = 0; i < observed.length; i++) {
        const mu = Math.max(predicted[i], 1e-9);
        const y = observed[i];
        dev += 2 * ((y > 0 ? y * Math.log(y / mu) : 0) - (y - mu));
    }
    return dev;
}

export function backtestForecast(
    zones: ForecastZone[],
    incidents: ForecastIncident[],
    exposure: ExposureRow[],
    nowMs: number,
    windowDays = 56,
    testDays = 7
): BacktestResult {
    const cutoff = nowMs - testDays * MS_D;
    const trainIncidents = incidents.filter((i) => i.t < cutoff);
    const testIncidents = incidents.filter((i) => i.t >= cutoff && i.t <= nowMs);
    const base: BacktestResult = { insufficient_data: true, test_days: testDays, test_incidents: testIncidents.length, zone_hours: 0, skill_vs_flat: null, skill_vs_risk_prior: null, capture_top10: null };
    if (windowDays - testDays < 7 || testIncidents.length < 5 || trainIncidents.length < 10) return base;

    const fit = fitZoneForecast(zones, trainIncidents, exposure.filter((e) => e.hourBucket * MS_H < cutoff), cutoff, windowDays - testDays);
    const flatRate = trainIncidents.length / Math.max(1, zones.length) / ((windowDays - testDays) * 24);

    const observed: number[] = [];
    const modelPred: number[] = [];
    const flatPred: number[] = [];
    const priorPred: number[] = [];
    const observedCount = new Map<string, number>();
    for (const inc of testIncidents) {
        const key = `${inc.zoneId}:${Math.floor(inc.t / MS_H)}`;
        observedCount.set(key, (observedCount.get(key) ?? 0) + 1);
    }
    for (const zone of fit.zones) {
        for (let k = 0; k < testDays * 24; k++) {
            const hourStart = Math.floor(cutoff / MS_H) * MS_H + (k + 1) * MS_H;
            observed.push(observedCount.get(`${zone.id}:${hourStart / MS_H}`) ?? 0);
            modelPred.push(hourlyRate(zone, hourStart, undefined, k));
            flatPred.push(flatRate);
            priorPred.push(priorDaily(zone.riskLevel, trainIncidents.length / Math.max(1, zones.length) / (windowDays - testDays)) / 24);
        }
    }
    const devModel = poissonDeviance(observed, modelPred);
    const devFlat = poissonDeviance(observed, flatPred);
    const devPrior = poissonDeviance(observed, priorPred);

    const order = modelPred.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v).slice(0, Math.max(1, Math.floor(observed.length * 0.1)));
    const captured = order.reduce((s, o) => s + observed[o.i], 0);
    const total = observed.reduce((s, v) => s + v, 0);

    return {
        insufficient_data: false,
        test_days: testDays,
        test_incidents: total,
        zone_hours: observed.length,
        skill_vs_flat: devFlat > 0 ? round(1 - devModel / devFlat, 4) : null,
        skill_vs_risk_prior: devPrior > 0 ? round(1 - devModel / devPrior, 4) : null,
        capture_top10: total > 0 ? round(captured / total, 4) : null,
    };
}
