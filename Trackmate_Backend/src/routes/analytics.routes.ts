import express, { Router, Response } from 'express';
import { authenticate, requireRole } from '../middleware/auth';
import { Incident, Profile, LocationLog, Zone } from '../models';
import { AuthRequest, UserRole } from '../types';
import {
    combineRuleAndModelScore,
    getAnomalyModelStatus,
    scoreAnomalyRisk,
    trainAndPersistAnomalyModel,
} from '../lib/anomalyModel';
import { buildRiskPulseSnapshot } from '../lib/riskPulse';
import { computeAreaSafety } from '../lib/areaSafety';
import { findZoneForPoint } from '../lib/geofence';

const router: Router = express.Router();

// ─── Incident trend (last 30 days, by type) ───────────────────────────

router.get(
    '/incidents',
    authenticate,
    requireRole(UserRole.AUTHORITY, UserRole.ADMIN),
    async (req: AuthRequest, res: Response, next) => {
        try {
            const { from, to, zone, ward } = req.query;
            const start = from ? new Date(String(from)) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
            const end = to ? new Date(String(to)) : new Date();

            const match: Record<string, any> = { created_at: { $gte: start, $lte: end } };
            if (zone) match.zone = zone;
            if (ward) match.ward = ward;

            const [byDay, byType, byZone, bySeverity, lifecycle] = await Promise.all([
                Incident.aggregate([
                    { $match: match },
                    {
                        $group: {
                            _id: {
                                date: { $dateToString: { format: '%Y-%m-%d', date: '$created_at' } },
                                type: '$incident_type',
                            },
                            count: { $sum: 1 },
                        },
                    },
                    { $sort: { '_id.date': 1 } },
                ]),
                Incident.aggregate([
                    { $match: match },
                    { $group: { _id: '$incident_type', count: { $sum: 1 } } },
                    { $sort: { count: -1 } },
                ]),
                Incident.aggregate([
                    { $match: match },
                    { $group: { _id: '$zone', count: { $sum: 1 } } },
                    { $lookup: { from: 'zones', localField: '_id', foreignField: '_id', as: 'zone' } },
                    { $unwind: { path: '$zone', preserveNullAndEmptyArrays: true } },
                    { $project: { name: { $ifNull: ['$zone.name', 'Unzoned'] }, count: 1 } },
                ]),
                Incident.aggregate([
                    { $match: match },
                    { $group: { _id: '$severity', count: { $sum: 1 } } },
                ]),
                Incident.aggregate([
                    { $match: match },
                    { $group: { _id: '$status', count: { $sum: 1 } } },
                ]),
            ]);

            res.json({
                success: true,
                data: { byDay, byType, byZone, bySeverity, lifecycle },
            });
        } catch (err) {
            next(err);
        }
    }
);

// ─── Tourist activity (daily active count last 30 days) ───────────────

router.get(
    '/tourists',
    authenticate,
    requireRole(UserRole.AUTHORITY, UserRole.ADMIN),
    async (_req: AuthRequest, res: Response, next) => {
        try {
            const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
            const daily = await LocationLog.aggregate([
                { $match: { recorded_at: { $gte: cutoff } } },
                {
                    $lookup: {
                        from: 'profiles',
                        localField: 'user',
                        foreignField: '_id',
                        as: 'profile',
                    },
                },
                { $unwind: '$profile' },
                { $match: { 'profile.role': 'tourist' } },
                {
                    $group: {
                        _id: { $dateToString: { format: '%Y-%m-%d', date: '$recorded_at' } },
                        count: { $addToSet: '$user' },
                    },
                },
                { $project: { date: '$_id', count: { $size: '$count' }, _id: 0 } },
                { $sort: { date: 1 } },
            ]);

            const totalTourists = await Profile.countDocuments({ role: 'tourist', is_active: true });
            const activeTourists = await LocationLog.distinct('user', {
                recorded_at: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
            });

            res.json({
                success: true,
                data: { daily, totalTourists, activeTodayCount: activeTourists.length },
            });
        } catch (err) {
            next(err);
        }
    }
);

// ─── Zone safety scores over time ────────────────────────────────────

router.get(
    '/zones',
    authenticate,
    requireRole(UserRole.AUTHORITY, UserRole.ADMIN),
    async (_req: AuthRequest, res: Response, next) => {
        try {
            // Two grouped queries for every zone (this used to be two queries per zone: ~100 round trips).
            const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
            const [zones, activeCounts, resolvedCounts] = await Promise.all([
                Zone.find({ is_active: true }).select('name risk_level').lean(),
                Incident.aggregate([
                    { $match: { zone: { $ne: null }, status: { $in: ['active', 'acknowledged', 'assigned', 'escalated'] } } },
                    { $group: { _id: '$zone', count: { $sum: 1 } } },
                ]),
                Incident.aggregate([
                    { $match: { zone: { $ne: null }, status: 'resolved', resolved_at: { $gte: sevenDaysAgo } } },
                    { $group: { _id: '$zone', count: { $sum: 1 } } },
                ]),
            ]);
            const active = new Map<string, number>(activeCounts.map((r: any) => [String(r._id), Number(r.count)]));
            const resolved = new Map<string, number>(resolvedCounts.map((r: any) => [String(r._id), Number(r.count)]));
            const zoneStats = zones.map((z: any) => ({
                id: z._id,
                name: z.name,
                risk_level: z.risk_level,
                active_incidents: active.get(String(z._id)) ?? 0,
                resolved_last_7d: resolved.get(String(z._id)) ?? 0,
            }));

            res.json({ success: true, data: zoneStats });
        } catch (err) {
            next(err);
        }
    }
);

// ─── Platform stats summary ───────────────────────────────────────────

router.get(
    '/summary',
    authenticate,
    requireRole(UserRole.AUTHORITY, UserRole.ADMIN),
    async (_req: AuthRequest, res: Response, next) => {
        try {
            const now = new Date();
            const todayStart = new Date(now.setHours(0, 0, 0, 0));
            const hourAgo = new Date(Date.now() - 60 * 60 * 1000);

            const [totalUsers, openIncidents, sosLastHour, activeTodayUsers, roleCounts] = await Promise.all([
                Profile.countDocuments({ is_active: true }),
                Incident.countDocuments({ status: { $in: ['active', 'acknowledged', 'assigned', 'escalated'] } }),
                Incident.countDocuments({ $or: [{ source: 'sos_panic' }, { incident_type: 'sos_emergency' }], created_at: { $gte: hourAgo } }),
                LocationLog.distinct('user', { recorded_at: { $gte: todayStart } }),
                Profile.aggregate([{ $match: { is_active: true } }, { $group: { _id: '$role', count: { $sum: 1 } } }]),
            ]);
            const byRole = new Map<string, number>(roleCounts.map((r: any) => [String(r._id), Number(r.count)]));

            res.json({
                success: true,
                data: {
                    totalUsers,
                    totalTourists: byRole.get('tourist') ?? 0,
                    totalResidents: byRole.get('resident') ?? 0,
                    totalBusinesses: byRole.get('business') ?? 0,
                    openIncidents,
                    sosLastHour,
                    activeUsersToday: activeTodayUsers.length,
                },
            });
        } catch (err) {
            next(err);
        }
    }
);

// ─── Anomaly model status (authority/admin) ─────────────────────────

router.get(
    '/anomaly-model',
    authenticate,
    requireRole(UserRole.AUTHORITY, UserRole.ADMIN),
    async (_req: AuthRequest, res: Response, next) => {
        try {
            const status = await getAnomalyModelStatus();
            res.json({ success: true, data: status });
        } catch (err) {
            next(err);
        }
    }
);

// ─── Trigger anomaly model training (authority/admin) ───────────────

router.post(
    '/anomaly-model/train',
    authenticate,
    requireRole(UserRole.AUTHORITY, UserRole.ADMIN),
    async (req: AuthRequest, res: Response, next) => {
        try {
            const maxSamplesInput = Number((req.body as Record<string, unknown>)?.maxSamples);
            const iterationsInput = Number((req.body as Record<string, unknown>)?.iterations);
            const learningRateInput = Number((req.body as Record<string, unknown>)?.learningRate);

            const result = await trainAndPersistAnomalyModel({
                maxSamples: Number.isFinite(maxSamplesInput) ? maxSamplesInput : undefined,
                iterations: Number.isFinite(iterationsInput) ? iterationsInput : undefined,
                learningRate: Number.isFinite(learningRateInput) ? learningRateInput : undefined,
            });

            res.json({ success: true, data: result });
        } catch (err) {
            next(err);
        }
    }
);

// ─── Score anomaly features with active model ────────────────────────

router.post(
    '/anomaly-model/score',
    authenticate,
    requireRole(UserRole.AUTHORITY, UserRole.ADMIN),
    async (req: AuthRequest, res: Response, next) => {
        try {
            const body = (req.body || {}) as Record<string, unknown>;
            const metrics = {
                inactivityMinutes: Number(body.inactivityMinutes),
                speedKmh: Number(body.speedKmh),
                isOutsideZone: Boolean(body.isOutsideZone),
                nearbyIncidents15m: Number(body.nearbyIncidents15m),
                nearbyCriticalIncidents15m: Number(body.nearbyCriticalIncidents15m),
                userAnomalies24h: Number(body.userAnomalies24h),
            };

            if (
                !Number.isFinite(metrics.inactivityMinutes) ||
                !Number.isFinite(metrics.speedKmh) ||
                !Number.isFinite(metrics.nearbyIncidents15m) ||
                !Number.isFinite(metrics.nearbyCriticalIncidents15m) ||
                !Number.isFinite(metrics.userAnomalies24h)
            ) {
                res.status(400).json({
                    success: false,
                    message: 'Invalid input. Provide numeric feature values and isOutsideZone boolean.',
                });
                return;
            }

            const ruleScoreInput = Number(body.ruleScore);
            const ruleScore = Number.isFinite(ruleScoreInput) ? ruleScoreInput : 0.8;

            const scored = await scoreAnomalyRisk(metrics);
            const hybridScore = combineRuleAndModelScore(ruleScore, scored.modelScore);

            res.json({
                success: true,
                data: {
                    modelVersion: scored.modelVersion,
                    modelScore: scored.modelScore,
                    hybridScore,
                    normalizedFeatures: scored.normalizedFeatures,
                },
            });
        } catch (err) {
            next(err);
        }
    }
);

// ─── Predictive risk pulse snapshot ─────────────────────────────────

router.get(
    '/risk-pulse',
    authenticate,
    requireRole(UserRole.AUTHORITY, UserRole.ADMIN),
    async (req: AuthRequest, res: Response, next) => {
        try {
            const wardId = typeof req.query.ward === 'string' ? req.query.ward : undefined;
            const snapshot = await buildRiskPulseSnapshot(wardId);
            res.json({ success: true, data: snapshot });
        } catch (err) {
            next(err);
        }
    }
);

// ─── Heatmap: incident distribution + tourist load ───────────────────

const SEVERITY_WEIGHT: Record<string, number> = { critical: 1, high: 0.75, medium: 0.45, low: 0.2 };

router.get(
    '/heatmap',
    authenticate,
    requireRole(UserRole.AUTHORITY, UserRole.ADMIN),
    async (req: AuthRequest, res: Response, next) => {
        try {
            const hours = Math.min(24 * 90, Math.max(1, parseInt(String(req.query.hours || '168'), 10) || 168));
            const since = new Date(Date.now() - hours * 3_600_000);
            const liveSince = new Date(Date.now() - 30 * 60_000);

            const [incidents, touristCells, liveTourists, zones] = await Promise.all([
                Incident.find({
                    created_at: { $gte: since },
                    latitude: { $type: 'number' },
                    longitude: { $type: 'number' },
                    incident_type: { $nin: ['checkin', 'safe_house_request'] },
                } as any).select('latitude longitude severity incident_type status created_at').limit(5000).lean(),
                // Where tourists have been: distinct tourists per ~110 m cell over the window.
                LocationLog.aggregate([
                    { $match: { recorded_at: { $gte: since } } },
                    { $lookup: { from: 'profiles', localField: 'user', foreignField: '_id', as: 'p' } },
                    { $match: { 'p.role': 'tourist' } },
                    {
                        $group: {
                            _id: { lat: { $round: ['$latitude', 3] }, lng: { $round: ['$longitude', 3] } },
                            users: { $addToSet: '$user' },
                            pings: { $sum: 1 },
                        },
                    },
                    { $project: { _id: 0, lat: '$_id.lat', lng: '$_id.lng', tourists: { $size: '$users' }, pings: 1 } },
                    { $limit: 5000 },
                ]),
                // Where tourists are right now: latest ping per tourist in the last 30 minutes.
                LocationLog.aggregate([
                    { $match: { recorded_at: { $gte: liveSince } } },
                    { $sort: { recorded_at: -1 } },
                    { $group: { _id: '$user', latitude: { $first: '$latitude' }, longitude: { $first: '$longitude' } } },
                    { $lookup: { from: 'profiles', localField: '_id', foreignField: '_id', as: 'p' } },
                    { $match: { 'p.role': 'tourist' } },
                    { $project: { _id: 0, lat: '$latitude', lng: '$longitude' } },
                ]),
                Zone.find({ is_active: true }).lean(),
            ]);

            // Per-zone load: current tourists inside each zone, and incidents in the window.
            const zoneLoad = (zones as any[]).map((z) => ({
                id: String(z._id),
                name: z.name,
                risk_level: z.risk_level,
                tourists_now: (liveTourists as any[]).filter((t) => findZoneForPoint(t.lat, t.lng, [z]) !== null).length,
                incidents: (incidents as any[]).filter((i) => findZoneForPoint(i.latitude, i.longitude, [z]) !== null).length,
            }));

            res.json({
                success: true,
                data: {
                    hours,
                    generated_at: new Date().toISOString(),
                    incidents: (incidents as any[]).map((i) => ({
                        lat: i.latitude,
                        lng: i.longitude,
                        weight: SEVERITY_WEIGHT[i.severity] ?? 0.3,
                        severity: i.severity,
                        type: i.incident_type,
                    })),
                    tourist_density: (touristCells as any[]).map((c) => ({ lat: c.lat, lng: c.lng, weight: c.tourists, pings: c.pings })),
                    tourists_live: liveTourists,
                    zone_load: zoneLoad,
                },
            });
        } catch (err) {
            next(err);
        }
    }
);

// ─── Safety score for a position ─────────────────────────────────────

router.get('/area-safety', authenticate, async (req: AuthRequest, res: Response, next) => {
    try {
        const lat = Number(req.query.lat);
        const lng = Number(req.query.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
            res.status(400).json({ success: false, message: 'lat and lng are required' });
            return;
        }
        const zones = await Zone.find({ is_active: true }).lean();
        const zone = findZoneForPoint(lat, lng, zones as any);
        res.json({ success: true, data: await computeAreaSafety(lat, lng, zone as any) });
    } catch (err) {
        next(err);
    }
});

// ─── Ward summary analytics ──────────────────────────────────────────

router.get(
    '/ward/:wardId',
    authenticate,
    async (req: AuthRequest, res: Response, next) => {
        try {
            const { wardId } = req.params;
            const todayStart = new Date();
            todayStart.setHours(0, 0, 0, 0);

            const [openIncidents, totalIncidents, touristCount, residentCount, activeUsersToday] = await Promise.all([
                Incident.countDocuments({ ward: wardId, status: { $in: ['active', 'acknowledged', 'assigned', 'escalated'] } }),
                Incident.countDocuments({ ward: wardId }),
                Profile.countDocuments({ ward: wardId, role: 'tourist', is_active: true }),
                Profile.countDocuments({ ward: wardId, role: 'resident', is_active: true }),
                LocationLog.distinct('user', { recorded_at: { $gte: todayStart } }),
            ]);

            const baseScore = 100;
            const penalty = Math.min(openIncidents * 8, 60);
            const safetyScore = Math.max(0, baseScore - penalty);

            res.json({
                success: true,
                data: {
                    wardId,
                    open_incidents: openIncidents,
                    total_incidents: totalIncidents,
                    tourist_count: touristCount,
                    resident_count: residentCount,
                    active_users_today: activeUsersToday.length,
                    safety_score: safetyScore,
                },
            });
        } catch (err) {
            next(err);
        }
    }
);

export default router;
