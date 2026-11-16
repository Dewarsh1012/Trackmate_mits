import { clamp, round } from './math';
import { LogisticModel, predict, presentFactors, priorModel } from './logistic';
import { loadActiveModel, ModelName } from './modelStore';

/**
 * Safety-risk model: the probability that a tourist has a confirmed incident (SOS, reported
 * emergency, or an anomaly an officer confirmed) within the next 3 hours.
 * Supervised logistic regression. Until enough confirmed incidents exist it uses a hand-set prior,
 * which the training job replaces automatically.
 */

export const SAFETY_MODEL: ModelName = 'safety_risk';
export const SAFETY_HORIZON_HOURS = 3;
/** Every safety feature can only raise risk. */
export const SAFETY_SIGNS: Array<1 | -1 | 0> = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1];

export const SAFETY_FEATURES = [
    'zone_risk', 'night', 'silence', 'speed', 'behaviour', 'low_battery',
    'nearby_incidents', 'earlier_alerts', 'area_forecast', 'health_flag',
] as const;

export interface SafetyInputs {
    zoneRisk: number; // 0..1
    hour: number; // local hour 0..24
    silenceMin: number;
    speedKmh: number;
    behaviourScore: number; // isolation-forest score, ~0.5 typical
    battery?: number; // 0..100
    nearbyIncidents6h: number;
    anomalies24h: number;
    areaForecastP3h: number; // probability of an incident in this zone in the next 3 h
    healthFlag: boolean;
}

export function buildSafetyVector(i: SafetyInputs): number[] {
    const night = i.hour >= 22 || i.hour < 5 ? 1 : 0;
    const battery = i.battery == null ? 0 : i.battery < 20 ? 1 : i.battery < 40 ? 0.5 : 0;
    return [
        clamp(i.zoneRisk, 0, 1),
        night,
        clamp(i.silenceMin / 60, 0, 1),
        clamp(i.speedKmh / 140, 0, 1),
        clamp((i.behaviourScore - 0.55) / 0.35, 0, 1),
        battery,
        clamp(i.nearbyIncidents6h / 5, 0, 1),
        clamp(i.anomalies24h / 3, 0, 1),
        clamp(i.areaForecastP3h / 0.5, 0, 1),
        i.healthFlag ? 1 : 0,
    ];
}

/** Prior coefficients: a defensible starting point, replaced as soon as real outcomes are available. */
export const SAFETY_PRIOR: LogisticModel = priorModel(
    [...SAFETY_FEATURES],
    [1.6, 0.5, 1.4, 0.6, 1.6, 0.5, 1.0, 1.2, 1.0, 1.6],
    -5.5
);

const FACTOR_LABELS: Record<(typeof SAFETY_FEATURES)[number], string> = {
    zone_risk: 'Current area is risky',
    night: 'Night-time',
    silence: 'Location updates have gone quiet',
    speed: 'Unusually fast movement',
    behaviour: 'Movement is out of character',
    low_battery: 'Phone battery is low',
    nearby_incidents: 'Recent incidents nearby',
    earlier_alerts: 'Earlier alerts for this person',
    area_forecast: 'This area is forecast to be riskier now',
    health_flag: 'Vital signs outside the normal range',
};

export interface SafetyAssessment {
    p_incident_3h: number;
    score: number; // 0..100, 100 = safest
    factors: Array<{ label: string; effect: 'raises' | 'lowers'; weight: number }>;
    source: 'prior' | 'trained';
    version: string;
}

/** Risk probability to the 0..100 safety score shown to people: monotonic, 100 when risk is negligible. */
export function safetyScoreFromRisk(p: number): number {
    const floor = 0.004;
    const adjusted = clamp((p - floor) / (1 - floor), 0, 1);
    return clamp(Math.round(100 - 100 * Math.sqrt(adjusted)), 0, 100);
}

export async function loadSafetyModel(): Promise<{ model: LogisticModel; source: 'prior' | 'trained'; version: string }> {
    const stored = await loadActiveModel<LogisticModel>(SAFETY_MODEL);
    if (stored && Array.isArray(stored.payload?.weights) && stored.payload.weights.length === SAFETY_FEATURES.length) {
        return { model: stored.payload, source: 'trained', version: stored.version };
    }
    return { model: SAFETY_PRIOR, source: 'prior', version: 'prior-v1' };
}

export function assessWithModel(model: LogisticModel, source: 'prior' | 'trained', version: string, inputs: SafetyInputs): SafetyAssessment {
    const x = buildSafetyVector(inputs);
    const p = predict(model, x);
    const raising = presentFactors(model, x)
        .filter((f) => f.sign === 1)
        .slice(0, 3)
        .map((f) => ({ label: FACTOR_LABELS[SAFETY_FEATURES[f.index]], effect: 'raises' as const, weight: round(f.strength, 2) }));
    const factors = raising.length
        ? raising
        : [{ label: 'No risk signals right now', effect: 'lowers' as const, weight: 0 }];
    return { p_incident_3h: round(p, 4), score: safetyScoreFromRisk(p), factors, source, version };
}

export async function assessSafety(inputs: SafetyInputs): Promise<SafetyAssessment> {
    const { model, source, version } = await loadSafetyModel();
    return assessWithModel(model, source, version, inputs);
}
