import express, { Router, Response } from 'express';
import mongoose from 'mongoose';
import { authenticate, requireRole } from '../middleware/auth';
import { Incident } from '../models';
import { AuthRequest, UserRole } from '../types';
import { buildSosTriage, evaluateTourists, getZoneForecast } from '../ml/runtime';
import { getMlStatus, trainAll } from '../ml/training';
import { invalidateModelCache } from '../ml/modelStore';

const router: Router = express.Router();
const staff = requireRole(UserRole.AUTHORITY, UserRole.ADMIN);

// Which models are live, whether each is a trained model or the built-in prior, and how accurate it is.
router.get('/status', authenticate, staff, async (_req: AuthRequest, res: Response, next) => {
    try {
        res.json({ success: true, data: await getMlStatus() });
    } catch (err) { next(err); }
});

// Retrain from the database. Each model only replaces the current one if it clears its quality gate.
router.post('/train', authenticate, staff, async (req: AuthRequest, res: Response, next) => {
    try {
        const only = Array.isArray(req.body?.only) ? (req.body.only as unknown[]).map(String) : undefined;
        const reports = await trainAll(only);
        invalidateModelCache();
        res.json({ success: true, data: { trained_at: new Date().toISOString(), reports } });
    } catch (err) { next(err); }
});

// Zone risk forecast for the next N hours (1..72).
router.get('/forecast', authenticate, staff, async (req: AuthRequest, res: Response, next) => {
    try {
        const hours = Math.min(72, Math.max(1, Number(req.query.hours) || 24));
        res.json({ success: true, data: await getZoneForecast(hours) });
    } catch (err) { next(err); }
});

// A tourist's current risk read-out with reasons, for officers.
router.get('/tourists/:id/risk', authenticate, staff, async (req: AuthRequest, res: Response, next) => {
    try {
        const id = String(req.params.id);
        if (!mongoose.Types.ObjectId.isValid(id)) { res.status(400).json({ success: false, message: 'Invalid id' }); return; }
        const result = (await evaluateTourists({ userIds: [id] })).get(id);
        if (!result) { res.json({ success: true, data: null, message: 'No recent location data for this person.' }); return; }
        res.json({
            success: true,
            data: {
                ...result.assessment,
                behaviour: { score: result.behaviour.score, threshold: result.behaviour.threshold, anomalous: result.behaviour.anomalous, source: result.behaviour.source, reasons: result.behaviour.reasons },
            },
        });
    } catch (err) { next(err); }
});

// A person's own risk read-out. Reasons only; internal scores stay server-side.
router.get('/me/risk', authenticate, async (req: AuthRequest, res: Response, next) => {
    try {
        const id = req.user!.userId;
        const result = (await evaluateTourists({ userIds: [id] })).get(id);
        res.json({ success: true, data: result ? { p_incident_3h: result.assessment.p_incident_3h, score: result.assessment.score, factors: result.assessment.factors } : null });
    } catch (err) { next(err); }
});

// Compute (or recompute) triage for one SOS and store it on the incident.
router.post('/triage/:incidentId', authenticate, staff, async (req: AuthRequest, res: Response, next) => {
    try {
        const id = String(req.params.incidentId);
        if (!mongoose.Types.ObjectId.isValid(id)) { res.status(400).json({ success: false, message: 'Invalid id' }); return; }
        const incident: any = await Incident.findById(id).lean();
        if (!incident) { res.status(404).json({ success: false, message: 'Incident not found' }); return; }
        if (!incident.reporter) { res.status(400).json({ success: false, message: 'Incident has no reporter to triage' }); return; }

        const meta = incident.metadata || {};
        const triage = await buildSosTriage({
            reporterId: String(incident.reporter),
            text: incident.description || '',
            latitude: incident.latitude,
            longitude: incident.longitude,
            metrics: meta.sos_risk_metrics,
            misuse: meta.sos_misuse_signals,
            geminiScore: meta.sos_risk_gemini_score ?? null,
        });
        const updated = await Incident.findByIdAndUpdate(id, { $set: { 'metadata.sos_triage': { ...triage, generated_at: new Date().toISOString() } } }, { new: true })
            .populate('reporter', 'full_name role blockchain_id phone').lean();
        const io = req.app.get('io');
        if (io && updated) {
            io.to('authority_room').emit('incident:updated', updated);
            io.to('authority_room').emit('incident-updated', updated);
        }
        res.json({ success: true, data: triage });
    } catch (err) { next(err); }
});

export default router;
