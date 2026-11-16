import mongoose from 'mongoose';
import express, { Router, Response } from 'express';
import { z } from 'zod';
import { authenticate, requireRole } from '../middleware/auth';
import { Alert, Incident, LocationLog, Profile, UserAlert, Zone } from '../models';
import {
    AlertPriority,
    AlertSeverity,
    AlertSource,
    AlertStatus,
    AlertTargetGroup,
    AuthRequest,
    UserRole,
} from '../types';
import { uploadEvidence, toPublicUploadPath } from '../middleware/upload';
import { calculateSpeed, distanceInMeters, findZoneForPoint } from '../lib/geofence';
import { combineRuleAndModelScore, scoreAnomalyRisk } from '../lib/anomalyModel';
import { runAfterResponse } from '../lib/realtime';
import { geminiJson } from '../lib/gemini';
import { sendSosSmsNotifications } from '../lib/sosSmsNotifier';
import { buildSosTriage } from '../ml/runtime';

const router: Router = express.Router();

const createIncidentSchema = z.object({
    incident_type: z.string().min(1),
    title: z.string().min(2).max(200),
    description: z.string().optional(),
    latitude: z.number().optional(),
    longitude: z.number().optional(),
    zone: z.string().optional(),
    ward: z.string().optional(),
    severity: z.nativeEnum(AlertSeverity),
    source: z.nativeEnum(AlertSource).optional(),
    is_public: z.boolean().optional(),
    metadata: z.record(z.string(), z.any()).optional(),
});

const updateIncidentSchema = z.object({
    status: z.nativeEnum(AlertStatus).optional(),
    assigned_to: z.string().optional(),
    severity: z.nativeEnum(AlertSeverity).optional(),
    is_public: z.boolean().optional(),
    description: z.string().optional(),
    metadata: z.record(z.string(), z.any()).optional(),
}).strict();

const timelineWriteSchema = z.object({
    type: z.string().min(2).max(64),
    label: z.string().min(2).max(180),
    details: z.record(z.string(), z.any()).optional(),
});

const SOS_RULE_SCORE = parseClampedNumber(process.env.SOS_RULE_SCORE, 0.96, 0, 1);
const SOS_MODEL_WEIGHT = parseClampedNumber(
    process.env.SOS_MODEL_WEIGHT || process.env.ANOMALY_MODEL_WEIGHT,
    0.35,
    0,
    1
);
const SOS_GUARDIAN_RADIUS_METERS = parsePositiveInt(process.env.SOS_GUARDIAN_RADIUS_METERS, 1600);
const SOS_GUARDIAN_MAX_RECIPIENTS = parsePositiveInt(process.env.SOS_GUARDIAN_MAX_RECIPIENTS, 8);
const SOS_RESPONDER_MAX = parsePositiveInt(process.env.SOS_RESPONDER_MAX, 3);
const SOS_RESPONDER_RADIUS_METERS = parsePositiveInt(process.env.SOS_RESPONDER_RADIUS_METERS, 7000);
const SOS_MISUSE_THRESHOLD = parseClampedNumber(process.env.SOS_MISUSE_THRESHOLD, 0.72, 0, 1);
const LOCATION_FRESHNESS_MINUTES = parsePositiveInt(process.env.LOCATION_FRESHNESS_MINUTES, 35);

interface CrisisTimelineEvent {
    event_id: string;
    type: string;
    label: string;
    timestamp: string;
    actor_role: string;
    actor_id?: string;
    details?: Record<string, any>;
}

interface ResponderCandidate {
    user_id: string;
    full_name: string;
    role: string;
    designation?: string;
    ward_id?: string;
    distance_meters: number;
    score: number;
    last_seen_at: string;
}

interface MisuseShieldMetadata {
    sos_misuse_risk_score: number;
    sos_misuse_risk_band: 'low' | 'medium' | 'high';
    sos_misuse_flagged: boolean;
    sos_misuse_signals: {
        sos_last_24h: number;
        sos_last_7d: number;
        false_alarms_7d: number;
        false_alarm_rate_7d: number;
        minutes_since_last_sos: number;
        is_night_window: boolean;
    };
}

// ─── GET incidents ────────────────────────────────────────────────────

router.get('/', authenticate, async (req: AuthRequest, res: Response, next) => {
    try {
        const {
            status, severity, source, zone, ward, is_public,
            incident_type, page = '1', limit = '20', reporter, sos,
        } = req.query;

        const filter: Record<string, any> = {};

        if (status) filter.status = status;
        if (severity) filter.severity = severity;
        if (source) filter.source = source;
        if (zone) filter.zone = zone;
        if (ward) filter.ward = ward;
        if (is_public !== undefined) filter.is_public = is_public === 'true';
        if (incident_type) filter.incident_type = incident_type;
        if (reporter) filter.reporter = reporter;
        // sos=true: every SOS, however it was raised (one request instead of two overlapping ones).
        if (sos === 'true') filter.$or = [{ incident_type: 'sos_emergency' }, { source: 'sos_panic' }];

        // Role restrictions are applied last so query parameters can't widen them.
        const role = req.user!.role;
        if (role === UserRole.TOURIST) {
            filter.reporter = req.user!.userId;
        } else if (role !== UserRole.AUTHORITY && role !== UserRole.ADMIN) {
            filter.$and = [{ $or: [{ is_public: true }, { reporter: req.user!.userId }] }];
        }

        const pageNum = Math.max(1, parseInt(String(page), 10) || 1);
        const limitNum = Math.min(200, Math.max(1, parseInt(String(limit), 10) || 20));
        const skip = (pageNum - 1) * limitNum;

        const [data, total] = await Promise.all([
            Incident.find(filter)
                .populate('reporter', 'full_name role blockchain_id')
                .populate('zone', 'name risk_level')
                .populate('ward', 'name district')
                .populate('assigned_to', 'full_name designation role')
                .sort({ created_at: -1, severity: -1 })
                .skip(skip)
                .limit(limitNum)
                .lean(),
            Incident.countDocuments(filter),
        ]);

        res.json({
            success: true,
            data,
            meta: {
                total,
                page: pageNum,
                limit: limitNum,
            },
        });
    } catch (err) {
        next(err);
    }
});

// ─── GET single incident ──────────────────────────────────────────────

router.get('/:id', authenticate, async (req: AuthRequest, res: Response, next) => {
    try {
        const incident = await Incident.findById(req.params.id)
            .populate('reporter', 'full_name role blockchain_id')
            .populate('zone', 'name risk_level')
            .populate('ward', 'name district')
            .populate('assigned_to', 'full_name designation role')
            .lean();
        if (!incident) {
            res.status(404).json({ success: false, message: 'Incident not found' });
            return;
        }
        if (!canViewIncident(req.user!, incident)) {
            res.status(403).json({ success: false, message: 'Forbidden' });
            return;
        }
        res.json({ success: true, data: incident });
    } catch (err) {
        next(err);
    }
});

// ─── GET timeline for incident ───────────────────────────────────────

router.get('/:id/timeline', authenticate, async (req: AuthRequest, res: Response, next) => {
    try {
        const incident = await Incident.findById(req.params.id)
            .select('reporter metadata')
            .lean();

        if (!incident) {
            res.status(404).json({ success: false, message: 'Incident not found' });
            return;
        }

        const reporterId = incident.reporter ? String(incident.reporter) : null;
        const isAuthority = req.user!.role === UserRole.AUTHORITY || req.user!.role === UserRole.ADMIN;
        const isReporter = reporterId === req.user!.userId;

        if (!isAuthority && !isReporter) {
            res.status(403).json({ success: false, message: 'Forbidden' });
            return;
        }

        const timeline = normalizeTimeline((incident as any).metadata?.crisis_timeline);
        res.json({ success: true, data: timeline });
    } catch (err) {
        next(err);
    }
});

// ─── POST append timeline event (authority/admin) ───────────────────

router.post(
    '/:id/timeline',
    authenticate,
    requireRole(UserRole.AUTHORITY, UserRole.ADMIN),
    async (req: AuthRequest, res: Response, next) => {
        try {
            const body = timelineWriteSchema.parse(req.body);
            const timelineEvent = createTimelineEvent({
                type: body.type,
                label: body.label,
                actorRole: req.user!.role,
                actorId: req.user!.userId,
                details: body.details,
            });

            const incident = await Incident.findByIdAndUpdate(
                req.params.id,
                { $push: { 'metadata.crisis_timeline': timelineEvent } },
                { new: true }
            )
                .populate('reporter', 'full_name role blockchain_id')
                .populate('assigned_to', 'full_name designation role');

            if (!incident) {
                res.status(404).json({ success: false, message: 'Incident not found' });
                return;
            }

            const io = (req as any).app.get('io');
            if (io) {
                const payload = {
                    incident_id: String(incident._id),
                    events: [timelineEvent],
                    latest: timelineEvent,
                };
                io.to('authority_room').to(`incident_${String(incident._id)}`).emit('crisis:timeline', payload);
                const reporterId = getUserId(incident.reporter);
                if (reporterId) io.to(`user_${reporterId}`).emit('crisis:timeline', payload);
            }

            res.json({ success: true, data: timelineEvent });
        } catch (err) {
            next(err);
        }
    }
);

// ─── POST create incident ─────────────────────────────────────────────

router.post('/', authenticate, async (req: AuthRequest, res: Response, next) => {
    const t0 = Date.now();
    const marks: string[] = [];
    const mark = (name: string) => marks.push(`${name};dur=${Date.now() - t0}`);
    try {
        const body = createIncidentSchema.parse(req.body);
        const rawLocation = (req.body as Record<string, any>)?.location;
        const geoLongitude = Array.isArray(rawLocation?.coordinates)
            ? toFiniteOrUndefined(rawLocation.coordinates[0])
            : undefined;
        const geoLatitude = Array.isArray(rawLocation?.coordinates)
            ? toFiniteOrUndefined(rawLocation.coordinates[1])
            : undefined;

        const incidentType = String(body.incident_type || '').toLowerCase() === 'sos_panic'
            ? 'sos_emergency'
            : body.incident_type;
        const isSosIncident = body.source === AlertSource.SOS_PANIC || incidentType === 'sos_emergency';
        const incidentSource = body.source || (isSosIncident ? AlertSource.SOS_PANIC : AlertSource.USER_REPORT);

        const reporterId = isSosIncident || req.user!.role !== UserRole.AUTHORITY
            ? req.user!.userId
            : undefined;

        const incidentLatitude = toFiniteOrUndefined(body.latitude) ?? geoLatitude;
        const incidentLongitude = toFiniteOrUndefined(body.longitude) ?? geoLongitude;
        let resolvedIncidentLatitude = incidentLatitude;
        let resolvedIncidentLongitude = incidentLongitude;

        // Offline retries carry an idempotency key: a repeat of an already-stored SOS returns the original.
        const clientRequestId = typeof body.metadata?.client_request_id === 'string' ? body.metadata.client_request_id.slice(0, 80) : null;
        if (isSosIncident && reporterId && clientRequestId) {
            const existing = await Incident.findOne({ reporter: reporterId, 'metadata.client_request_id': clientRequestId })
                .populate('reporter', 'full_name role blockchain_id phone')
                .lean();
            if (existing) {
                res.status(200).json({ success: true, data: existing, duplicate: true });
                return;
            }
        }

        const timelineEvents: CrisisTimelineEvent[] = [
            createTimelineEvent({
                type: isSosIncident ? 'sos_received' : 'incident_created',
                label: isSosIncident ? 'Emergency SOS received' : 'Incident created',
                actorRole: req.user!.role,
                actorId: req.user!.userId,
                details: {
                    incident_type: incidentType,
                    severity: body.severity,
                    source: incidentSource,
                },
            }),
        ];

        let metadata: Record<string, any> = body.metadata ? { ...body.metadata } : {};
        // Fetched in parallel with the insert so the alert can carry the reporter's name without waiting on populate().
        const reporterPromise = reporterId
            ? Profile.findById(reporterId).select('full_name role blockchain_id phone').lean()
            : Promise.resolve(null);

        const incident = await Incident.create({
            ...body,
            incident_type: incidentType,
            source: incidentSource,
            latitude: resolvedIncidentLatitude,
            longitude: resolvedIncidentLongitude,
            metadata: {
                ...metadata,
                crisis_timeline: timelineEvents,
            },
            reporter: reporterId,
        });

        mark('create');
        const io = (req as any).app.get('io');

        // Used for the realtime alerts: ready the instant the insert returns.
        const reporterDoc = await reporterPromise;
        const finalIncident: any = { ...incident.toObject(), reporter: reporterDoc ?? incident.toObject().reporter };

        // Alert authorities first: nothing slower than the DB write sits between an SOS and the command centre.
        if (io) {
            io.to('authority_room').emit('incident:new', finalIncident);
            io.to('authority_room').emit('new-incident', finalIncident);
            // Private incidents (e.g. SOS) go to authorities only; the public feed gets public ones.
            if ((finalIncident as any)?.is_public) {
                io.to('role_tourist').to('role_resident').to('role_business').emit('new-incident', finalIncident);
            }

            if (isSosIncident) {
                const incidentId = String(finalIncident._id);
                io.to('authority_room').to(`incident_${incidentId}`).emit('sos:triggered', finalIncident);

                const timelinePayload = {
                    incident_id: incidentId,
                    events: [...timelineEvents],
                    latest: timelineEvents[timelineEvents.length - 1],
                };
                io.to('authority_room').to(`incident_${incidentId}`).emit('crisis:timeline', timelinePayload);
                if (reporterId) io.to(`user_${reporterId}`).emit('crisis:timeline', timelinePayload);
            }
        }

        // The HTTP response also carries zone/ward/assignee details (the alerts above already went out).
        await incident.populate([
            { path: 'zone', select: 'name risk_level' },
            { path: 'ward', select: 'name district' },
            { path: 'assigned_to', select: 'full_name designation role' },
        ]);
        const responseIncident = { ...incident.toObject(), reporter: reporterDoc ?? incident.toObject().reporter };

        mark('fetch');
        res.setHeader('Server-Timing', marks.join(', '));
        res.status(201).json({ success: true, data: responseIncident });

        // Guardian-network dispatch and SMS are slow (extra queries, third-party calls), so they run
        // in parallel after the response. runAfterResponse keeps a serverless function alive for them.
        if (isSosIncident && reporterId) {
            const incidentId = String(finalIncident._id);

            // Risk scoring, misuse shield and responder assignment: valuable, but not worth delaying the alert.
            const enrichTask = (async () => {
                const [sosRiskMetadata, misuseMetadata] = await Promise.all([
                    buildSosRiskMetadata({ reporterId, latitude: incidentLatitude, longitude: incidentLongitude }),
                    buildMisuseShieldMetadata({ reporterId, excludeId: String(incident._id) }),
                ]);

                const fallbackLatitude = toFiniteOrUndefined(sosRiskMetadata.sos_risk_metrics?.latitude);
                const fallbackLongitude = toFiniteOrUndefined(sosRiskMetadata.sos_risk_metrics?.longitude);
                if (resolvedIncidentLatitude == null && fallbackLatitude != null) resolvedIncidentLatitude = fallbackLatitude;
                if (resolvedIncidentLongitude == null && fallbackLongitude != null) resolvedIncidentLongitude = fallbackLongitude;

                // Responder search and the ML triage are independent: run them together.
                const [responderPlan, triage] = await Promise.all([
                    selectAutoResponders({
                        latitude: resolvedIncidentLatitude,
                        longitude: resolvedIncidentLongitude,
                        wardId: body.ward,
                        excludeUserId: reporterId,
                    }),
                    buildSosTriage({
                        reporterId,
                        text: body.description || '', // the title is boilerplate ("Emergency SOS"), so only the person's own words count
                        latitude: resolvedIncidentLatitude,
                        longitude: resolvedIncidentLongitude,
                        metrics: sosRiskMetadata.sos_risk_metrics,
                        misuse: misuseMetadata.sos_misuse_signals,
                        geminiScore: sosRiskMetadata.sos_risk_gemini_score,
                    }).catch((err) => { console.error('SOS triage failed:', err); return null; }),
                ]);

                const extraEvents: CrisisTimelineEvent[] = [
                    createTimelineEvent({
                        type: 'sos_risk_scored',
                        label: 'SOS risk scored',
                        actorRole: 'model',
                        details: {
                            real_danger_probability: sosRiskMetadata.sos_risk_real_danger_probability,
                            false_alarm_probability: sosRiskMetadata.sos_risk_false_alarm_probability,
                            confidence_band: sosRiskMetadata.sos_risk_confidence_band,
                        },
                    }),
                ];
                if (triage) {
                    extraEvents.push(createTimelineEvent({
                        type: 'sos_triaged',
                        label: `SOS triaged ${triage.priority}${triage.category !== 'unspecified' ? ` (${triage.category})` : ''}`,
                        actorRole: 'model',
                        details: { priority: triage.priority, p_genuine: triage.p_genuine, category: triage.category, action: triage.action },
                    }));
                }
                if (misuseMetadata.sos_misuse_flagged) {
                    extraEvents.push(createTimelineEvent({
                        type: 'misuse_shield_flagged',
                        label: 'Incident flagged by misuse shield',
                        actorRole: 'misuse-shield',
                        details: {
                            misuse_risk_score: misuseMetadata.sos_misuse_risk_score,
                            misuse_risk_band: misuseMetadata.sos_misuse_risk_band,
                        },
                    }));
                }
                if (responderPlan.primary) {
                    extraEvents.push(createTimelineEvent({
                        type: 'responder_auto_assigned',
                        label: 'Responder auto-assigned',
                        actorRole: 'dispatcher',
                        details: {
                            primary_responder: responderPlan.primary,
                            backup_responders: responderPlan.responders.slice(1),
                        },
                    }));
                }

                const $set: Record<string, any> = {
                    'metadata.triggered_by_role': req.user!.role,
                    'metadata.sos_auto_assignment': {
                        generated_at: new Date().toISOString(),
                        primary_responder: responderPlan.primary || null,
                        responders: responderPlan.responders,
                    },
                };
                for (const [key, value] of Object.entries({ ...sosRiskMetadata, ...misuseMetadata })) {
                    $set[`metadata.${key}`] = value;
                }
                if (triage) $set['metadata.sos_triage'] = { ...triage, generated_at: new Date().toISOString() };
                if (responderPlan.primary) $set.assigned_to = responderPlan.primary.user_id;
                if (resolvedIncidentLatitude != null) $set.latitude = resolvedIncidentLatitude;
                if (resolvedIncidentLongitude != null) $set.longitude = resolvedIncidentLongitude;

                const updated = await Incident.findByIdAndUpdate(
                    incident._id,
                    { $set, $push: { 'metadata.crisis_timeline': { $each: extraEvents } } },
                    { new: true }
                )
                    .populate('reporter', 'full_name role blockchain_id phone')
                    .populate('zone', 'name risk_level')
                    .populate('ward', 'name district')
                    .populate('assigned_to', 'full_name designation role')
                    .lean();

                if (!io) return;
                if (updated) {
                    io.to('authority_room').emit('incident:updated', updated);
                    io.to('authority_room').emit('incident-updated', updated);
                    io.to(`incident_${incidentId}`).emit('incident-updated', updated);
                }
                const timelinePayload = { incident_id: incidentId, events: extraEvents, latest: extraEvents[extraEvents.length - 1] };
                io.to('authority_room').to(`incident_${incidentId}`).emit('crisis:timeline', timelinePayload);
                io.to(`user_${reporterId}`).emit('crisis:timeline', timelinePayload);

                if (responderPlan.responders.length > 0) {
                    const assignmentPayload = {
                        incident_id: incidentId,
                        responders: responderPlan.responders,
                        primary_responder: responderPlan.responders[0],
                    };
                    io.to('authority_room').emit('responder:auto-assigned', assignmentPayload);
                    io.to(`user_${reporterId}`).emit('sos:assignment', assignmentPayload);
                    for (const responder of responderPlan.responders) {
                        io.to(`user_${responder.user_id}`).emit('responder:auto-assigned', assignmentPayload);
                    }
                }
                if (misuseMetadata.sos_misuse_flagged) {
                    io.to('authority_room').emit('sos:misuse-flagged', {
                        incident_id: incidentId,
                        reporter_id: reporterId,
                        misuse_risk_score: misuseMetadata.sos_misuse_risk_score,
                        misuse_risk_band: misuseMetadata.sos_misuse_risk_band,
                    });
                }
            })();

            const guardianTask = (async () => {
                if (!io) return;
                await enrichTask.catch(() => undefined); // guardian dispatch wants the resolved location
                const dispatch = await dispatchGuardianNetwork({
                    io,
                    incidentId,
                    incidentTitle: body.title,
                    reporterId,
                    latitude: resolvedIncidentLatitude,
                    longitude: resolvedIncidentLongitude,
                });
                if (!dispatch) return;
                await Incident.findByIdAndUpdate(incident._id, {
                    $set: { 'metadata.sos_guardian_dispatch': dispatch.summary },
                    $push: { 'metadata.crisis_timeline': dispatch.timelineEvent },
                });
                const payload = { incident_id: incidentId, events: [dispatch.timelineEvent], latest: dispatch.timelineEvent };
                io.to('authority_room').to(`incident_${incidentId}`).emit('crisis:timeline', payload);
                io.to(`user_${reporterId}`).emit('crisis:timeline', payload);
                io.to('authority_room').emit('guardian:dispatch-summary', { incident_id: incidentId, ...dispatch.summary });
            })();

            const smsTask = (async () => {
                const reporter = (finalIncident as any).reporter;
                const authorityRecipients = await Profile.find({
                    role: { $in: [UserRole.AUTHORITY, UserRole.ADMIN] },
                    is_active: true,
                    phone: { $exists: true, $ne: '' },
                }).select('_id full_name phone').lean();

                const fallbackLatitude = toFiniteOrUndefined((finalIncident as any).metadata?.sos_risk_metrics?.latitude);
                const fallbackLongitude = toFiniteOrUndefined((finalIncident as any).metadata?.sos_risk_metrics?.longitude);
                const smsRecipients = process.env.SOS_SMS_TRIAL_ONLY_VERIFIED === 'true'
                    ? []
                    : authorityRecipients.map((authority: any) => ({
                        user_id: String(authority._id),
                        full_name: String(authority.full_name || 'Authority Officer'),
                        phone: String(authority.phone || ''),
                    }));

                const smsSummary = await sendSosSmsNotifications(
                    {
                        incidentId,
                        reporterName: String(reporter?.full_name || (finalIncident as any).metadata?.triggered_by_name || 'Unknown User'),
                        reporterRole: String(reporter?.role || req.user!.role || 'user'),
                        reporterPhone: reporter?.phone ? String(reporter.phone) : undefined,
                        latitude: toFiniteOrUndefined((finalIncident as any).latitude) ?? fallbackLatitude,
                        longitude: toFiniteOrUndefined((finalIncident as any).longitude) ?? fallbackLongitude,
                        triggeredAt: new Date((finalIncident as any).created_at || Date.now()),
                    },
                    smsRecipients
                );
                await Incident.findByIdAndUpdate(incident._id, { $set: { 'metadata.sos_sms_dispatch': smsSummary } });
                io?.to('authority_room').emit('sos:sms-dispatch', { incident_id: incidentId, dispatch: smsSummary });
            })();

            runAfterResponse(Promise.allSettled([enrichTask, guardianTask, smsTask]));
        }
    } catch (err) {
        next(err);
    }
});

// ─── PATCH update incident (authority/admin) ─────────────────────────

router.patch(
    '/:id',
    authenticate,
    requireRole(UserRole.AUTHORITY, UserRole.ADMIN),
    async (req: AuthRequest, res: Response, next) => {
        try {
            const updates = updateIncidentSchema.parse(req.body);
            const current = await Incident.findById(req.params.id).lean();

            if (!current) {
                res.status(404).json({ success: false, message: 'Incident not found' });
                return;
            }

            const extra: Record<string, any> = {};
            const timelineEvents: CrisisTimelineEvent[] = [];

            if (updates.status && updates.status !== current.status) {
                timelineEvents.push(
                    createTimelineEvent({
                        type: 'status_updated',
                        label: `Status changed from ${current.status} to ${updates.status}`,
                        actorRole: req.user!.role,
                        actorId: req.user!.userId,
                        details: { from: current.status, to: updates.status },
                    })
                );
            }

            if (updates.assigned_to && String(updates.assigned_to) !== String(current.assigned_to || '')) {
                timelineEvents.push(
                    createTimelineEvent({
                        type: 'responder_assigned',
                        label: 'Responder manually assigned',
                        actorRole: req.user!.role,
                        actorId: req.user!.userId,
                        details: { assigned_to: updates.assigned_to },
                    })
                );
            }

            if (updates.severity && updates.severity !== current.severity) {
                timelineEvents.push(
                    createTimelineEvent({
                        type: 'severity_updated',
                        label: `Severity changed from ${current.severity} to ${updates.severity}`,
                        actorRole: req.user!.role,
                        actorId: req.user!.userId,
                        details: { from: current.severity, to: updates.severity },
                    })
                );
            }

            if (updates.status === AlertStatus.RESOLVED) {
                extra.resolved_by = req.user!.userId;
                extra.resolved_at = new Date();
            }

            const updateQuery: Record<string, any> = { $set: { ...updates, ...extra } };
            if (timelineEvents.length > 0) {
                updateQuery.$push = { 'metadata.crisis_timeline': { $each: timelineEvents } };
            }

            const incident = await Incident.findByIdAndUpdate(
                req.params.id,
                updateQuery,
                { new: true, runValidators: true }
            )
                .populate('reporter', 'full_name role blockchain_id')
                .populate('assigned_to', 'full_name designation role');

            if (!incident) {
                res.status(404).json({ success: false, message: 'Incident not found' });
                return;
            }

            const io = (req as any).app.get('io');
            if (io) {
                const incidentObj = incident.toObject();
                const incidentId = String(incident._id);
                io.to('authority_room').emit('incident:updated', incidentObj);
                io.to('authority_room').emit('incident-updated', incidentObj);
                io.to(`incident_${incidentId}`).emit('incident-updated', incidentObj);
                if (incidentObj.is_public) {
                    io.to('role_tourist').to('role_resident').to('role_business').emit('incident-updated', incidentObj);
                } else if (incidentObj.reporter) {
                    io.to(`user_${String((incidentObj.reporter as any)._id ?? incidentObj.reporter)}`).emit('incident-updated', incidentObj);
                }

                if (timelineEvents.length > 0) {
                    const timelinePayload = {
                        incident_id: incidentId,
                        events: timelineEvents,
                        latest: timelineEvents[timelineEvents.length - 1],
                    };
                    io.to('authority_room').to(`incident_${incidentId}`).emit('crisis:timeline', timelinePayload);
                    const reporterId = getUserId((incident as any).reporter);
                    if (reporterId) io.to(`user_${reporterId}`).emit('crisis:timeline', timelinePayload);
                }
            }

            res.json({ success: true, data: incident });
        } catch (err) {
            next(err);
        }
    }
);

// ─── POST add evidence URLs ──────────────────────────────────────────

router.post('/:id/evidence', authenticate, async (req: AuthRequest, res: Response, next) => {
    try {
        const bodyUrls = req.body?.urls;
        const urls = (Array.isArray(bodyUrls) ? bodyUrls : [])
            .filter((u: unknown): u is string => typeof u === 'string' && u.length > 0 && u.length <= 2048)
            .slice(0, 20);

        if (urls.length === 0) {
            res.status(400).json({ success: false, message: 'urls must be a non-empty array of strings' });
            return;
        }

        const existing = await Incident.findById(req.params.id).select('reporter assigned_to').lean();
        if (!existing) {
            res.status(404).json({ success: false, message: 'Incident not found' });
            return;
        }
        if (!canModifyEvidence(req.user!, existing)) {
            res.status(403).json({ success: false, message: 'Forbidden' });
            return;
        }

        const incident = await Incident.findByIdAndUpdate(
            req.params.id,
            { $push: { evidence_urls: { $each: urls } } },
            { new: true }
        );

        res.json({ success: true, data: incident });
    } catch (err) {
        next(err);
    }
});

// ─── POST upload evidence files ──────────────────────────────────────

router.post('/:id/evidence/upload', authenticate, async (req: AuthRequest, res: Response, next) => {
    uploadEvidence(req as any, res as any, async (uploadErr: any) => {
        if (uploadErr) {
            res.status(400).json({ success: false, message: uploadErr.message || 'Upload failed' });
            return;
        }

        try {
            const files = ((req as any).files || []) as Express.Multer.File[];
            if (!files.length) {
                res.status(400).json({ success: false, message: 'No evidence files uploaded' });
                return;
            }

            const urls = files.map((file) => toPublicUploadPath(file.path));
            const existing = await Incident.findById(req.params.id).select('reporter assigned_to').lean();
            if (!existing) {
                res.status(404).json({ success: false, message: 'Incident not found' });
                return;
            }
            if (!canModifyEvidence(req.user!, existing)) {
                res.status(403).json({ success: false, message: 'Forbidden' });
                return;
            }
            const incident = await Incident.findByIdAndUpdate(
                req.params.id,
                { $push: { evidence_urls: { $each: urls } } },
                { new: true }
            );

            if (!incident) {
                res.status(404).json({ success: false, message: 'Incident not found' });
                return;
            }

            res.status(201).json({ success: true, data: incident, uploaded: urls });
        } catch (err) {
            next(err);
        }
    });
});

export default router;

const idOf = (v: any): string | null => (v ? String(v._id ?? v) : null);

function isStaff(user: { role: string }): boolean {
    return user.role === UserRole.AUTHORITY || user.role === UserRole.ADMIN;
}

/** Staff see everything; others see public incidents and their own. */
function canViewIncident(user: { userId: string; role: string }, incident: any): boolean {
    return isStaff(user) || incident.is_public === true || idOf(incident.reporter) === user.userId;
}

function canModifyEvidence(user: { userId: string; role: string }, incident: any): boolean {
    return isStaff(user) || idOf(incident.reporter) === user.userId || idOf(incident.assigned_to) === user.userId;
}

async function buildSosRiskMetadata(params: {
    reporterId: string;
    latitude?: number;
    longitude?: number;
}): Promise<Record<string, any>> {
    const { reporterId } = params;
    const now = Date.now();

    const [latestLogs, zones, recentIncidents, recentUserAnomalies] = await Promise.all([
        LocationLog.find({ user: reporterId })
            .sort({ recorded_at: -1 })
            .limit(2)
            .lean(),
        Zone.find({ is_active: true }).lean(),
        Incident.find({
            created_at: { $gte: new Date(now - 15 * 60 * 1000) },
            latitude: { $exists: true },
            longitude: { $exists: true },
        })
            .select('latitude longitude severity created_at')
            .lean(),
        Incident.countDocuments({
            reporter: reporterId,
            source: AlertSource.AI_ANOMALY,
            created_at: { $gte: new Date(now - 24 * 60 * 60 * 1000) },
            status: { $in: ['active', 'acknowledged', 'assigned', 'escalated'] },
        }),
    ]);

    const latest = latestLogs[0];
    const previous = latestLogs[1];

    const latitude = toFiniteOrUndefined(params.latitude) ?? toFiniteOrUndefined(latest?.latitude);
    const longitude = toFiniteOrUndefined(params.longitude) ?? toFiniteOrUndefined(latest?.longitude);

    const inactivityMinutes = latest
        ? Math.max(0, (now - new Date(latest.recorded_at).getTime()) / 60000)
        : 60;

    let speedKmh = 0;
    if (latest && previous) {
        speedKmh = calculateSpeed(
            Number(latest.latitude),
            Number(latest.longitude),
            new Date(latest.recorded_at),
            Number(previous.latitude),
            Number(previous.longitude),
            new Date(previous.recorded_at)
        );
    }

    let isOutsideZone = false;
    let nearbyIncidents15m = 0;
    let nearbyCriticalIncidents15m = 0;

    if (latitude != null && longitude != null) {
        isOutsideZone = !findZoneForPoint(latitude, longitude, zones as any);
        const nearbyCounts = countNearbyIncidentStats(latitude, longitude, recentIncidents as any[]);
        nearbyIncidents15m = nearbyCounts.total;
        nearbyCriticalIncidents15m = nearbyCounts.critical;
    }

    const metrics = {
        inactivityMinutes,
        speedKmh,
        isOutsideZone,
        nearbyIncidents15m,
        nearbyCriticalIncidents15m,
        userAnomalies24h: recentUserAnomalies,
    };

    const model = await scoreAnomalyRisk(metrics);
    const localScore = combineRuleAndModelScore(SOS_RULE_SCORE, model.modelScore, SOS_MODEL_WEIGHT);

    // Gemini gives its own read of how likely this SOS is a genuine emergency; blend it with the local score.
    const gemini = await geminiJson<{ real_danger_probability?: number; reasoning?: string }>([
        'You assess SOS panic-button events for a tourist-safety command centre.',
        'Estimate the probability (0-1) that this SOS is a genuine emergency rather than a false alarm or accidental press.',
        'Reply with JSON only: {"real_danger_probability": number, "reasoning": string under 30 words}.',
        '',
        JSON.stringify({ local_score: roundTo(localScore, 3), metrics, hour_utc: new Date().getUTCHours() }),
    ].join('\n'), 5000);
    const geminiScore = Number(gemini?.real_danger_probability);
    const hasGemini = Number.isFinite(geminiScore);
    const hybridScore = hasGemini
        ? Math.min(1, Math.max(0, 0.65 * localScore + 0.35 * geminiScore))
        : localScore;
    const falseAlarmProbability = 1 - hybridScore;

    return {
        sos_risk_local_score: roundTo(localScore, 4),
        sos_risk_gemini_score: hasGemini ? roundTo(geminiScore, 4) : null,
        sos_risk_gemini_reasoning: gemini?.reasoning ? String(gemini.reasoning).slice(0, 240) : null,
        sos_risk_provider: hasGemini ? 'gemini+model' : 'model',
        sos_risk_rule_score: roundTo(SOS_RULE_SCORE, 4),
        sos_risk_model_score: roundTo(model.modelScore, 4),
        sos_risk_hybrid_score: roundTo(hybridScore, 4),
        sos_risk_real_danger_probability: roundTo(hybridScore, 4),
        sos_risk_false_alarm_probability: roundTo(falseAlarmProbability, 4),
        sos_risk_confidence_band: getRiskBand(hybridScore),
        sos_risk_model_version: model.modelVersion,
        sos_risk_normalized_features: model.normalizedFeatures.map((value) => roundTo(value, 4)),
        sos_risk_metrics: {
            latitude,
            longitude,
            inactivityMinutes: roundTo(inactivityMinutes, 2),
            speedKmh: roundTo(speedKmh, 2),
            isOutsideZone,
            nearbyIncidents15m,
            nearbyCriticalIncidents15m,
            userAnomalies24h: recentUserAnomalies,
        },
    };
}

async function buildMisuseShieldMetadata(params: { reporterId: string; excludeId?: string }): Promise<MisuseShieldMetadata> {
    const now = Date.now();
    const start24h = new Date(now - 24 * 60 * 60 * 1000);
    const start7d = new Date(now - 7 * 24 * 60 * 60 * 1000);

    const [sosLast24h, sosLast7d, falseAlarms7d, lastSos] = await Promise.all([
        Incident.countDocuments({
            reporter: params.reporterId,
            source: AlertSource.SOS_PANIC,
            created_at: { $gte: start24h },
        }),
        Incident.countDocuments({
            reporter: params.reporterId,
            source: AlertSource.SOS_PANIC,
            created_at: { $gte: start7d },
        }),
        Incident.countDocuments({
            reporter: params.reporterId,
            source: AlertSource.SOS_PANIC,
            status: AlertStatus.FALSE_ALARM,
            created_at: { $gte: start7d },
        }),
        // The SOS being scored already exists; "time since the last SOS" must look at the one before it.
        Incident.findOne({
            reporter: params.reporterId,
            source: AlertSource.SOS_PANIC,
            ...(params.excludeId ? { _id: { $ne: params.excludeId } } : {}),
        })
            .sort({ created_at: -1 })
            .select('created_at')
            .lean(),
    ]);

    const falseAlarmRate = sosLast7d > 0 ? falseAlarms7d / sosLast7d : 0;
    const minutesSinceLastSos = lastSos
        ? Math.max(0, (now - new Date(lastSos.created_at).getTime()) / 60000)
        : 9999;

    const hour = new Date().getHours();
    const isNightWindow = hour >= 0 && hour <= 4;

    let misuseScore = 0.08;
    misuseScore += Math.max(0, sosLast24h - 1) * 0.16;
    misuseScore += falseAlarmRate * 0.44;
    if (minutesSinceLastSos < 20) misuseScore += 0.22;
    if (isNightWindow) misuseScore += 0.08;

    misuseScore = clampNumber(misuseScore, 0, 1);

    const misuseBand: 'low' | 'medium' | 'high' = misuseScore >= 0.75
        ? 'high'
        : misuseScore >= 0.45
            ? 'medium'
            : 'low';

    return {
        sos_misuse_risk_score: roundTo(misuseScore, 4),
        sos_misuse_risk_band: misuseBand,
        sos_misuse_flagged: misuseScore >= SOS_MISUSE_THRESHOLD,
        sos_misuse_signals: {
            sos_last_24h: sosLast24h,
            sos_last_7d: sosLast7d,
            false_alarms_7d: falseAlarms7d,
            false_alarm_rate_7d: roundTo(falseAlarmRate, 4),
            minutes_since_last_sos: roundTo(minutesSinceLastSos, 2),
            is_night_window: isNightWindow,
        },
    };
}

async function selectAutoResponders(params: {
    latitude?: number;
    longitude?: number;
    wardId?: string;
    excludeUserId?: string;
}): Promise<{ primary: ResponderCandidate | null; responders: ResponderCandidate[] }> {
    const latitude = toFiniteOrUndefined(params.latitude);
    const longitude = toFiniteOrUndefined(params.longitude);

    if (latitude == null || longitude == null) {
        return { primary: null, responders: [] };
    }

    const cutoff = new Date(Date.now() - LOCATION_FRESHNESS_MINUTES * 60 * 1000);

    // Latest ping per nearby user, joined with the profile server-side. (Loading and populating
    // every recent log was the slowest step of an SOS.)
    const dLat = SOS_RESPONDER_RADIUS_METERS / 111_320;
    const dLng = SOS_RESPONDER_RADIUS_METERS / (111_320 * Math.max(0.2, Math.cos((latitude * Math.PI) / 180)));
    const logs = await LocationLog.aggregate([
        {
            $match: {
                recorded_at: { $gte: cutoff },
                latitude: { $gte: latitude - dLat, $lte: latitude + dLat },
                longitude: { $gte: longitude - dLng, $lte: longitude + dLng },
                ...(params.excludeUserId && mongoose.Types.ObjectId.isValid(params.excludeUserId)
                    ? { user: { $ne: new mongoose.Types.ObjectId(params.excludeUserId) } }
                    : {}),
            },
        },
        { $sort: { recorded_at: -1 } },
        { $group: { _id: '$user', log: { $first: '$$ROOT' } } },
        { $replaceRoot: { newRoot: '$log' } },
        { $lookup: { from: 'profiles', localField: 'user', foreignField: '_id', as: 'user' } },
        { $unwind: '$user' },
        { $project: { latitude: 1, longitude: 1, recorded_at: 1, 'user._id': 1, 'user.full_name': 1, 'user.role': 1, 'user.ward': 1, 'user.designation': 1, 'user.is_active': 1 } },
    ]);

    const candidatesByUser = new Map<string, ResponderCandidate>();

    for (const log of logs as any[]) {
        const profile = log.user;
        if (!profile || !profile._id || profile.is_active === false) continue;

        const role = String(profile.role || '').toLowerCase();
        if (role !== 'authority' && role !== 'resident' && role !== 'business') continue;

        const userId = String(profile._id);
        if (candidatesByUser.has(userId)) continue;

        const lat = toFiniteOrUndefined(log.latitude);
        const lng = toFiniteOrUndefined(log.longitude);
        if (lat == null || lng == null) continue;

        const distanceMeters = distanceInMeters(latitude, longitude, lat, lng);
        if (distanceMeters > SOS_RESPONDER_RADIUS_METERS) continue;

        const staleMinutes = Math.max(0, (Date.now() - new Date(log.recorded_at).getTime()) / 60000);
        const roleBias = role === 'authority' ? 0 : role === 'resident' ? 110 : 145;
        const sameWardBonus = params.wardId && profile.ward && String(profile.ward) === String(params.wardId) ? -45 : 0;
        const score = roleBias + distanceMeters / 60 + staleMinutes * 1.4 + sameWardBonus;

        candidatesByUser.set(userId, {
            user_id: userId,
            full_name: String(profile.full_name || 'Responder'),
            role,
            designation: profile.designation ? String(profile.designation) : undefined,
            ward_id: profile.ward ? String(profile.ward) : undefined,
            distance_meters: Math.round(distanceMeters),
            score: roundTo(score, 3),
            last_seen_at: new Date(log.recorded_at).toISOString(),
        });
    }

    const responders = Array.from(candidatesByUser.values())
        .sort((a, b) => a.score - b.score)
        .slice(0, SOS_RESPONDER_MAX);

    const primary = responders.find((candidate) => candidate.role === 'authority') || responders[0] || null;
    return { primary, responders };
}

async function dispatchGuardianNetwork(params: {
    io: any;
    incidentId: string;
    incidentTitle: string;
    reporterId: string;
    latitude?: number;
    longitude?: number;
}): Promise<{ summary: Record<string, any>; timelineEvent: CrisisTimelineEvent } | null> {
    const latitude = toFiniteOrUndefined(params.latitude);
    const longitude = toFiniteOrUndefined(params.longitude);
    if (latitude == null || longitude == null) return null;

    const cutoff = new Date(Date.now() - LOCATION_FRESHNESS_MINUTES * 60 * 1000);
    const logs = await LocationLog.find({
        recorded_at: { $gte: cutoff },
        user: { $ne: params.reporterId },
    })
        .populate('user', 'full_name role is_active')
        .sort({ recorded_at: -1 })
        .limit(2000)
        .lean();

    const recipientMap = new Map<string, { user_id: string; full_name: string; role: string; distance_meters: number }>();

    for (const log of logs as any[]) {
        const profile = log.user;
        if (!profile || !profile._id || profile.is_active === false) continue;

        const role = String(profile.role || '').toLowerCase();
        if (role !== 'resident' && role !== 'business') continue;

        const userId = String(profile._id);
        if (recipientMap.has(userId)) continue;

        const lat = toFiniteOrUndefined(log.latitude);
        const lng = toFiniteOrUndefined(log.longitude);
        if (lat == null || lng == null) continue;

        const distanceMeters = distanceInMeters(latitude, longitude, lat, lng);
        if (distanceMeters > SOS_GUARDIAN_RADIUS_METERS) continue;

        recipientMap.set(userId, {
            user_id: userId,
            full_name: String(profile.full_name || 'Guardian'),
            role,
            distance_meters: Math.round(distanceMeters),
        });
    }

    const recipients = Array.from(recipientMap.values())
        .sort((a, b) => a.distance_meters - b.distance_meters)
        .slice(0, SOS_GUARDIAN_MAX_RECIPIENTS);

    const alertMessage = `Nearby emergency reported. Incident #${params.incidentId.slice(-6)} requires local guardian assistance.`;

    const dispatchSummary = {
        radius_meters: SOS_GUARDIAN_RADIUS_METERS,
        recipient_count: recipients.length,
        recipients,
        dispatched_at: new Date().toISOString(),
    };

    if (recipients.length > 0) {
        const alert = await Alert.create({
            created_by: params.reporterId,
            title: 'Guardian Assist Request',
            message: alertMessage,
            alert_type: 'emergency',
            priority: AlertPriority.CRITICAL,
            target_group: AlertTargetGroup.USER,
            target_user_id: recipients[0].user_id,
            sent_at: new Date(),
        });

        await UserAlert.insertMany(
            recipients.map((recipient) => ({
                alert: alert._id,
                user: recipient.user_id,
                delivered_at: new Date(),
            })),
            { ordered: false }
        ).catch(() => { });

        const alertPayload = {
            _id: String(alert._id),
            title: alert.title,
            message: alert.message,
            alert_type: alert.alert_type,
            priority: alert.priority,
            created_at: alert.created_at,
            metadata: {
                dispatch_type: 'guardian_network',
                incident_id: params.incidentId,
            },
        };

        const dispatchPayload = {
            incident_id: params.incidentId,
            incident_title: params.incidentTitle,
            message: alertMessage,
            latitude,
            longitude,
            ...dispatchSummary,
        };

        for (const recipient of recipients) {
            params.io.to(`user_${recipient.user_id}`).emit('new_alert', alertPayload);
            params.io.to(`user_${recipient.user_id}`).emit('guardian:dispatch', {
                ...dispatchPayload,
                assigned_guardian: recipient,
            });
        }
    }

    const timelineEvent = createTimelineEvent({
        type: 'guardian_network_dispatch',
        label: `Guardian network dispatch ${recipients.length > 0 ? 'sent' : 'attempted'}`,
        actorRole: 'dispatcher',
        details: {
            recipient_count: recipients.length,
            radius_meters: SOS_GUARDIAN_RADIUS_METERS,
        },
    });

    return {
        summary: dispatchSummary,
        timelineEvent,
    };
}

function normalizeTimeline(value: unknown): CrisisTimelineEvent[] {
    if (!Array.isArray(value)) return [];
    return value.filter(Boolean).map((event: any) => ({
        event_id: String(event.event_id || `evt_${Math.random().toString(36).slice(2, 10)}`),
        type: String(event.type || 'event'),
        label: String(event.label || 'Timeline event'),
        timestamp: String(event.timestamp || new Date().toISOString()),
        actor_role: String(event.actor_role || 'system'),
        actor_id: event.actor_id ? String(event.actor_id) : undefined,
        details: event.details && typeof event.details === 'object' ? event.details : undefined,
    }));
}

function createTimelineEvent(params: {
    type: string;
    label: string;
    actorRole: string;
    actorId?: string;
    details?: Record<string, any>;
}): CrisisTimelineEvent {
    return {
        event_id: `${params.type}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        type: params.type,
        label: params.label,
        timestamp: new Date().toISOString(),
        actor_role: params.actorRole,
        actor_id: params.actorId,
        details: params.details,
    };
}

function countNearbyIncidentStats(
    latitude: number,
    longitude: number,
    incidents: Array<{ latitude?: number; longitude?: number; severity?: string }>
): { total: number; critical: number } {
    let total = 0;
    let critical = 0;

    for (const incident of incidents) {
        const lat = toFiniteOrUndefined(incident.latitude);
        const lng = toFiniteOrUndefined(incident.longitude);
        if (lat == null || lng == null) continue;

        const distance = distanceInMeters(latitude, longitude, lat, lng);
        if (distance > 600) continue;

        total += 1;
        if (incident.severity === 'critical' || incident.severity === 'high') {
            critical += 1;
        }
    }

    return { total, critical };
}

function getUserId(value: any): string | null {
    if (!value) return null;
    if (typeof value === 'string') return value;
    if (value._id) return String(value._id);
    return null;
}

function parseClampedNumber(raw: string | undefined, fallback: number, min: number, max: number): number {
    const value = Number(raw);
    if (!Number.isFinite(value)) return fallback;
    return Math.max(min, Math.min(max, value));
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) return fallback;
    return Math.floor(value);
}

function toFiniteOrUndefined(value: unknown): number | undefined {
    const num = Number(value);
    return Number.isFinite(num) ? num : undefined;
}

function roundTo(value: number, digits: number): number {
    const power = 10 ** digits;
    return Math.round(value * power) / power;
}

function clampNumber(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function getRiskBand(score: number): 'critical' | 'high' | 'medium' | 'low' {
    if (score >= 0.85) return 'critical';
    if (score >= 0.7) return 'high';
    if (score >= 0.5) return 'medium';
    return 'low';
}
