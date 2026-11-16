import { Profile, LocationLog, Incident, Zone } from '../models';
import { findZoneForPoint, calculateSpeed, distanceInMeters } from './geofence';
import { AlertSeverity, AlertSource } from '../types';
import {
    AnomalyFeatureMetrics,
    combineRuleAndModelScore,
    scoreAnomalyRisk,
} from './anomalyModel';
import type { Emitter } from './realtime';
import { assessAnomalyWithGemini } from './geminiAnomalySummary';
import { evaluateTourists, UserMl } from '../ml/runtime';
import type { BehaviourResult } from '../ml/behaviour';

const GEMINI_WEIGHT = parseClampedNumber(process.env.ANOMALY_GEMINI_WEIGHT, 0.3, 0, 1);
// How much the personalised behaviour model shifts a rule-triggered alert (trained model only).
const ML_BEHAVIOUR_WEIGHT = parseClampedNumber(process.env.ANOMALY_ML_WEIGHT, 0.25, 0, 1);

const ANOMALY_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MODEL_WEIGHT = parseClampedNumber(process.env.ANOMALY_MODEL_WEIGHT, 0.35, 0, 1);
const GLOBAL_MIN_SCORE = parseClampedNumber(process.env.ANOMALY_MIN_SCORE, 0.6, 0, 1);

const RULE_SCORES: Record<string, number> = {
    inactivity: 0.9,
    unusual_speed: 0.78,
    zone_breach: 0.88,
    incident_cluster: 0.9,
};

const TYPE_MIN_SCORES: Record<string, number> = {
    inactivity: 0.62,
    unusual_speed: 0.58,
    zone_breach: 0.6,
    incident_cluster: 0.68,
};

type ManagedAnomalyType = 'inactivity' | 'unusual_speed' | 'zone_breach' | 'incident_cluster' | 'behaviour_anomaly';

interface IncidentPoint {
    latitude?: number;
    longitude?: number;
    severity?: string;
    created_at: Date;
}

interface AnomalyCandidate {
    reporter?: string;
    incidentType: ManagedAnomalyType;
    title: string;
    description: string;
    latitude?: number;
    longitude?: number;
    severity: AlertSeverity;
    ruleScore: number;
    minScore: number;
    metrics: AnomalyFeatureMetrics;
    dedupeQuery: Record<string, any>;
    metadata?: Record<string, any>;
    /** Personalised read of this person's movement (Isolation Forest), when available. */
    ml?: BehaviourResult;
    /** Use this as the local score instead of rule + logistic (behaviour-model-detected alerts). */
    overrideLocalScore?: number;
}

/**
 * Starts the anomaly detection engine as a recurring setInterval.
 */
let activeEmitter: Emitter | undefined;

export function startAnomalyDetection(io?: Emitter): void {
    activeEmitter = io;
    console.log('🤖 Anomaly detection engine started (interval: 5 min)');
    setInterval(() => {
        void runAnomalyChecks(io);
    }, ANOMALY_INTERVAL_MS);
}

/**
 * Runs the anomaly checks and stores incidents when hybrid score thresholds pass.
 */
export async function runAnomalyChecks(io?: Emitter): Promise<{ detected: number; incidents: string[] }> {
    if (io) activeEmitter = io;
    console.log('🔍 Running anomaly detection...');
    const created: string[] = [];

    try {
        const now = Date.now();
        const activeCutoff = new Date(now - 60 * 60 * 1000);
        const last15min = new Date(now - 15 * 60 * 1000);

        const [zones, recentLogs, recentIncidentsRaw, anomalyCountRows] = await Promise.all([
            Zone.find({ is_active: true }).lean(),
            LocationLog.find({ recorded_at: { $gte: activeCutoff } })
                .populate('user', 'role')
                .sort({ user: 1, recorded_at: -1 })
                .lean(),
            Incident.find({
                created_at: { $gte: last15min },
                latitude: { $exists: true },
                longitude: { $exists: true },
            })
                .select('latitude longitude severity created_at')
                .lean(),
            Incident.aggregate([
                {
                    $match: {
                        source: AlertSource.AI_ANOMALY,
                        status: 'active',
                        reporter: { $exists: true, $ne: null },
                        created_at: { $gte: new Date(now - 24 * 60 * 60 * 1000) },
                    },
                },
                { $group: { _id: '$reporter', count: { $sum: 1 } } },
            ]),
        ]);

        // Personalised behaviour + safety read-out for every active tourist (empty if the models can't run).
        const mlByUser: Map<string, UserMl> = await evaluateTourists({ now }).catch((err) => {
            console.error('ML evaluation failed:', err);
            return new Map<string, UserMl>();
        });
        const flaggedThisRun = new Set<string>();

        const recentIncidents: IncidentPoint[] = recentIncidentsRaw.map((incident: any) => ({
            latitude: toFiniteOrUndefined(incident.latitude),
            longitude: toFiniteOrUndefined(incident.longitude),
            severity: incident.severity ? String(incident.severity) : undefined,
            created_at: new Date(incident.created_at),
        }));

        const userAnomalyCounts = new Map<string, number>();
        for (const row of anomalyCountRows) {
            userAnomalyCounts.set(String(row._id), Number(row.count));
        }

        const byUser = new Map<string, typeof recentLogs>();
        for (const log of recentLogs) {
            const uid = String((log as any).user?._id || log.user);
            if (!byUser.has(uid)) byUser.set(uid, []);
            byUser.get(uid)!.push(log);
        }

        for (const [userId, logs] of byUser.entries()) {
            if (logs.length === 0) continue;

            const latest = logs[0];
            const previous = logs[1];
            const userRole = (latest as any).user?.role || 'tourist';

            const latestLat = Number(latest.latitude);
            const latestLng = Number(latest.longitude);
            const gapMinutes = Math.max(0, (now - new Date(latest.recorded_at).getTime()) / 60000);

            let speedKmh = 0;
            if (previous) {
                speedKmh = calculateSpeed(
                    latestLat,
                    latestLng,
                    new Date(latest.recorded_at),
                    Number(previous.latitude),
                    Number(previous.longitude),
                    new Date(previous.recorded_at)
                );
            }

            const zone = findZoneForPoint(latestLat, latestLng, zones as any);
            const nearbyStats = countNearbyStats(latestLat, latestLng, recentIncidents);
            const userAnomalies24h = userAnomalyCounts.get(userId) ?? 0;

            if (userRole === 'tourist' && gapMinutes > 30) {
                const inactivityCandidate: AnomalyCandidate = {
                    reporter: userId,
                    incidentType: 'inactivity',
                    title: 'Tourist Prolonged Inactivity',
                    description: `Tourist has not updated their location in ${Math.round(gapMinutes)} minutes. Last known: (${latestLat.toFixed(4)}, ${latestLng.toFixed(4)})`,
                    latitude: latestLat,
                    longitude: latestLng,
                    severity: AlertSeverity.HIGH,
                    ml: mlByUser.get(userId)?.behaviour,
                    ruleScore: RULE_SCORES.inactivity,
                    minScore: TYPE_MIN_SCORES.inactivity,
                    metrics: {
                        inactivityMinutes: gapMinutes,
                        speedKmh,
                        isOutsideZone: !zone,
                        nearbyIncidents15m: nearbyStats.total,
                        nearbyCriticalIncidents15m: nearbyStats.critical,
                        userAnomalies24h,
                    },
                    dedupeQuery: {
                        reporter: userId,
                        incident_type: 'inactivity',
                        status: 'active',
                    },
                    metadata: {
                        gap_minutes: Math.round(gapMinutes),
                        last_known_lat: latestLat,
                        last_known_lng: latestLng,
                    },
                };

                const incident = await createScoredAnomalyIncident(inactivityCandidate);
                if (incident) {
                    flaggedThisRun.add(userId);
                    created.push(String(incident._id));
                    userAnomalyCounts.set(userId, userAnomalies24h + 1);
                }
            }

            if (logs.length >= 2 && speedKmh > 130) {
                const speedCandidate: AnomalyCandidate = {
                    reporter: userId,
                    incidentType: 'unusual_speed',
                    title: 'Unusual Movement Speed Detected',
                    description: `User appears to be moving at ${Math.round(speedKmh)} km/h — possible vehicle accident or device error.`,
                    latitude: latestLat,
                    longitude: latestLng,
                    severity: AlertSeverity.HIGH,
                    ml: mlByUser.get(userId)?.behaviour,
                    ruleScore: RULE_SCORES.unusual_speed,
                    minScore: TYPE_MIN_SCORES.unusual_speed,
                    metrics: {
                        inactivityMinutes: gapMinutes,
                        speedKmh,
                        isOutsideZone: !zone,
                        nearbyIncidents15m: nearbyStats.total,
                        nearbyCriticalIncidents15m: nearbyStats.critical,
                        userAnomalies24h,
                    },
                    dedupeQuery: {
                        reporter: userId,
                        incident_type: 'unusual_speed',
                        status: 'active',
                    },
                    metadata: {
                        speed_kmh: Math.round(speedKmh),
                    },
                };

                const incident = await createScoredAnomalyIncident(speedCandidate);
                if (incident) {
                    flaggedThisRun.add(userId);
                    created.push(String(incident._id));
                    userAnomalyCounts.set(userId, (userAnomalyCounts.get(userId) ?? 0) + 1);
                }
            }

            if (!zone) {
                const breachCandidate: AnomalyCandidate = {
                    reporter: userId,
                    incidentType: 'zone_breach',
                    title: 'User Outside All Monitored Zones',
                    description: `User at (${latestLat.toFixed(4)}, ${latestLng.toFixed(4)}) is outside all active safety zones.`,
                    latitude: latestLat,
                    longitude: latestLng,
                    severity: AlertSeverity.MEDIUM,
                    ml: mlByUser.get(userId)?.behaviour,
                    ruleScore: RULE_SCORES.zone_breach,
                    minScore: TYPE_MIN_SCORES.zone_breach,
                    metrics: {
                        inactivityMinutes: gapMinutes,
                        speedKmh,
                        isOutsideZone: true,
                        nearbyIncidents15m: nearbyStats.total,
                        nearbyCriticalIncidents15m: nearbyStats.critical,
                        userAnomalies24h,
                    },
                    dedupeQuery: {
                        reporter: userId,
                        incident_type: 'zone_breach',
                        status: 'active',
                        created_at: { $gte: new Date(now - 30 * 60 * 1000) },
                    },
                };

                const incident = await createScoredAnomalyIncident(breachCandidate);
                if (incident) {
                    flaggedThisRun.add(userId);
                    created.push(String(incident._id));
                    userAnomalyCounts.set(userId, (userAnomalyCounts.get(userId) ?? 0) + 1);
                }
            }
        }

        // Movement the trained model finds out of character for that person, with no rule alert already raised.
        // Only the trained model raises these on its own; the untrained prior just explains rule alerts.
        // Require two consecutive anomalous reads (previous run within 20 min) so one-off GPS blips never page anyone.
        const previousReads = new Map<string, { anomalous?: boolean; at?: string } | undefined>();
        if (mlByUser.size) {
            const rows = await Profile.find({ _id: { $in: [...mlByUser.keys()] } }).select('ml_risk').lean();
            for (const row of rows as any[]) previousReads.set(String(row._id), row.ml_risk?.behaviour);
        }
        for (const [userId, ml] of mlByUser.entries()) {
            if (flaggedThisRun.has(userId) || !ml.behaviour.anomalous || ml.behaviour.source !== 'trained') continue;
            const prev = previousReads.get(userId);
            if (!prev?.anomalous || !prev.at || now - Date.parse(prev.at) > 20 * 60_000) continue;
            const b = ml.behaviour;
            const reasons = b.reasons.length ? b.reasons.join('; ') : 'movement pattern differs from this person\'s norm';
            const candidate: AnomalyCandidate = {
                reporter: userId,
                incidentType: 'behaviour_anomaly',
                title: 'Unusual Behaviour Detected',
                description: `This tourist's movement is out of character: ${reasons}.`,
                latitude: ml.latest.lat,
                longitude: ml.latest.lng,
                severity: b.score >= 0.75 ? AlertSeverity.HIGH : AlertSeverity.MEDIUM,
                ruleScore: 0.6,
                minScore: b.threshold,
                overrideLocalScore: b.score,
                ml: b,
                metrics: {
                    inactivityMinutes: b.raw.silence_min,
                    speedKmh: b.raw.speed_kmh,
                    isOutsideZone: b.raw.zone_risk >= 0.55,
                    nearbyIncidents15m: 0,
                    nearbyCriticalIncidents15m: 0,
                    userAnomalies24h: userAnomalyCounts.get(userId) ?? 0,
                },
                dedupeQuery: {
                    reporter: userId,
                    incident_type: 'behaviour_anomaly',
                    status: 'active',
                    created_at: { $gte: new Date(now - 60 * 60 * 1000) },
                },
            };
            const incident = await createScoredAnomalyIncident(candidate);
            if (incident) created.push(String(incident._id));
        }

        const grid = new Map<string, { count: number; critical: number; latSum: number; lngSum: number }>();
        for (const incident of recentIncidents) {
            if (!Number.isFinite(incident.latitude) || !Number.isFinite(incident.longitude)) continue;
            const lat = Number(incident.latitude);
            const lng = Number(incident.longitude);
            const key = `${Math.round(lat * 200)}_${Math.round(lng * 200)}`;

            if (!grid.has(key)) {
                grid.set(key, { count: 0, critical: 0, latSum: 0, lngSum: 0 });
            }
            const cell = grid.get(key)!;
            cell.count += 1;
            cell.latSum += lat;
            cell.lngSum += lng;
            if (incident.severity === 'critical' || incident.severity === 'high') {
                cell.critical += 1;
            }
        }

        for (const [, cell] of grid.entries()) {
            if (cell.count < 3) continue;

            const clusterLat = cell.latSum / cell.count;
            const clusterLng = cell.lngSum / cell.count;
            const clusterCandidate: AnomalyCandidate = {
                incidentType: 'incident_cluster',
                title: 'Incident Cluster Detected',
                description: `${cell.count} incidents reported in a nearby area within 15 minutes — possible developing situation.`,
                latitude: clusterLat,
                longitude: clusterLng,
                severity: AlertSeverity.CRITICAL,
                ruleScore: RULE_SCORES.incident_cluster,
                minScore: TYPE_MIN_SCORES.incident_cluster,
                metrics: {
                    inactivityMinutes: 0,
                    speedKmh: 0,
                    isOutsideZone: false,
                    nearbyIncidents15m: cell.count,
                    nearbyCriticalIncidents15m: cell.critical,
                    userAnomalies24h: 0,
                },
                dedupeQuery: {
                    incident_type: 'incident_cluster',
                    status: 'active',
                    created_at: { $gte: last15min },
                },
                metadata: {
                    cluster_count: cell.count,
                    cluster_critical_count: cell.critical,
                },
            };

            const incident = await createScoredAnomalyIncident(clusterCandidate);
            if (incident) created.push(String(incident._id));
            break;
        }

        const [tourists, activeCounts] = await Promise.all([
            Profile.find({ role: 'tourist', is_active: true }).lean(),
            Incident.aggregate([
                {
                    $match: {
                        source: AlertSource.AI_ANOMALY,
                        status: 'active',
                        reporter: { $exists: true, $ne: null },
                    },
                },
                { $group: { _id: '$reporter', count: { $sum: 1 } } },
            ]),
        ]);

        const activeCountMap = new Map<string, number>();
        for (const row of activeCounts) {
            activeCountMap.set(String(row._id), Number(row.count));
        }

        for (const tourist of tourists) {
            const id = String(tourist._id);
            const ml = mlByUser.get(id);

            if (ml) {
                // Model-driven: move halfway toward the score implied by the predicted 3-hour risk
                // (smoothed so one noisy reading can't swing it).
                const target = ml.assessment.score;
                const newScore = clampScore(tourist.safety_score * 0.5 + target * 0.5);
                const risk = {
                    p_incident_3h: ml.assessment.p_incident_3h,
                    factors: ml.assessment.factors,
                    model_version: ml.assessment.version,
                    source: ml.assessment.source,
                    updated_at: new Date().toISOString(),
                    behaviour: { score: ml.behaviour.score, anomalous: ml.behaviour.anomalous, at: new Date().toISOString() },
                };
                await Profile.findByIdAndUpdate(tourist._id, { $set: { safety_score: newScore, ml_risk: risk } });
                if (newScore !== tourist.safety_score) {
                    const top = ml.assessment.factors[0];
                    activeEmitter?.to(`user_${id}`).emit('safety_score', {
                        score: newScore,
                        reason: top && top.effect === 'raises' ? top.label : 'Safety score recalculated',
                        risk_3h: risk.p_incident_3h,
                        factors: risk.factors,
                    });
                }
                continue;
            }

            // No recent movement data: fall back to the alert-based adjustment.
            const activeAnomalies = activeCountMap.get(id) ?? 0;
            const decrease = Math.min(activeAnomalies * 10, 50);
            const boost = activeAnomalies === 0 ? 2 : 0;
            const newScore = clampScore(tourist.safety_score - decrease + boost);

            if (newScore !== tourist.safety_score) {
                await Profile.findByIdAndUpdate(tourist._id, { $set: { safety_score: newScore } });
                activeEmitter?.to(`user_${id}`).emit('safety_score', { score: newScore, reason: 'Safety score recalculated' });
            }
        }

        console.log(`✅ Anomaly detection complete. Created ${created.length} new incidents.`);
        return { detected: created.length, incidents: created };
    } catch (err) {
        console.error('❌ Anomaly detection error:', err);
        return { detected: 0, incidents: [] };
    }
}

async function createScoredAnomalyIncident(candidate: AnomalyCandidate): Promise<any | null> {
    const exists = await Incident.findOne(candidate.dedupeQuery);
    if (exists) return null;

    const model = await scoreAnomalyRisk(candidate.metrics);
    let localScore = candidate.overrideLocalScore ?? combineRuleAndModelScore(candidate.ruleScore, model.modelScore, MODEL_WEIGHT);

    // Personalise rule alerts: the same silence or speed is routine for one person and alarming for another.
    // Only a trained model shifts the score; the untrained prior just supplies reasons.
    let mlStrength: number | null = null;
    if (candidate.ml) {
        mlStrength = Math.min(1, Math.max(0, (candidate.ml.score - 0.45) / 0.35));
        if (candidate.ml.source === 'trained' && candidate.overrideLocalScore === undefined) {
            localScore = (1 - ML_BEHAVIOUR_WEIGHT) * localScore + ML_BEHAVIOUR_WEIGHT * mlStrength;
        }
    }

    // Gemini reviews candidates the local scorers are at least borderline on, and
    // its verdict is blended into the final score (falls back to local if unavailable).
    const minRequired = Math.max(GLOBAL_MIN_SCORE, candidate.minScore);
    let hybridScore = localScore;
    let summary: string | null = null;
    let geminiScore: number | null = null;
    if (process.env.GEMINI_API_KEY && localScore >= minRequired - 0.15) {
        const assessment = await assessAnomalyWithGemini({
            incidentType: candidate.incidentType,
            severity: candidate.severity,
            title: candidate.title,
            description: candidate.description,
            ruleScore: candidate.ruleScore,
            modelScore: model.modelScore,
            hybridScore: localScore,
            metrics: candidate.metrics,
        });
        summary = assessment.summary;
        geminiScore = assessment.score;
        if (geminiScore !== null) {
            hybridScore = (1 - GEMINI_WEIGHT) * localScore + GEMINI_WEIGHT * geminiScore;
        }
    }
    if (hybridScore < minRequired) {
        return null;
    }

    const behaviourNote = candidate.ml && candidate.ml.reasons.length && candidate.incidentType !== 'behaviour_anomaly'
        ? `\n\nBehaviour model: ${candidate.ml.reasons.join('; ')}.`
        : '';
    const descriptionWithSummary = (summary
        ? `${candidate.description}${behaviourNote}\n\nAI Triage: ${summary}`
        : `${candidate.description}${behaviourNote}`);

    const incident = await Incident.create({
        reporter: candidate.reporter,
        incident_type: candidate.incidentType,
        title: candidate.title,
        description: descriptionWithSummary,
        latitude: candidate.latitude,
        longitude: candidate.longitude,
        severity: candidate.severity,
        source: AlertSource.AI_ANOMALY,
        metadata: {
            ...(candidate.metadata || {}),
            anomaly_type: candidate.incidentType,
            rule_score: roundTo(candidate.ruleScore, 4),
            model_score: roundTo(model.modelScore, 4),
            local_score: roundTo(localScore, 4),
            gemini_score: geminiScore === null ? null : roundTo(geminiScore, 4),
            hybrid_score: roundTo(hybridScore, 4),
            min_required_score: roundTo(minRequired, 4),
            model_version: model.modelVersion,
            normalized_features: model.normalizedFeatures.map((v) => roundTo(v, 4)),
            ml_anomaly: candidate.ml
                ? { score: candidate.ml.score, strength: mlStrength === null ? null : roundTo(mlStrength, 4), threshold: candidate.ml.threshold, source: candidate.ml.source, version: candidate.ml.version, reasons: candidate.ml.reasons }
                : null,
            summary_provider: summary ? 'gemini' : 'none',
            triage_summary: summary,
            detected_at: new Date().toISOString(),
        },
    });

    if (activeEmitter) {
        const payload = incident.toObject ? incident.toObject() : incident;
        activeEmitter.to('authority_room').emit('incident:new', payload);
        activeEmitter.to('authority_room').emit('new-incident', payload);
    }

    return incident;
}

function countNearbyStats(lat: number, lng: number, incidents: IncidentPoint[]): { total: number; critical: number } {
    let total = 0;
    let critical = 0;

    for (const incident of incidents) {
        if (!Number.isFinite(incident.latitude) || !Number.isFinite(incident.longitude)) continue;
        const dist = distanceInMeters(lat, lng, Number(incident.latitude), Number(incident.longitude));
        if (dist > 600) continue;
        total += 1;
        if (incident.severity === 'critical' || incident.severity === 'high') {
            critical += 1;
        }
    }

    return { total, critical };
}

function clampScore(value: number): number {
    return Math.max(0, Math.min(100, Math.round(value)));
}

function parseClampedNumber(raw: string | undefined, fallback: number, min: number, max: number): number {
    const value = Number(raw);
    if (!Number.isFinite(value)) return fallback;
    return Math.max(min, Math.min(max, value));
}

function toFiniteOrUndefined(value: unknown): number | undefined {
    const num = Number(value);
    return Number.isFinite(num) ? num : undefined;
}

function roundTo(value: number, digits: number): number {
    const p = 10 ** digits;
    return Math.round(value * p) / p;
}
