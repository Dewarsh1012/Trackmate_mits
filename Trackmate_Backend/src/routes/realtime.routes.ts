import { Router, Response } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { authenticate } from '../middleware/auth';
import { AuthRequest } from '../types';
import { RealtimeEvent, PlatformConfig, Presence } from '../models';
import { roomsForUser, runAfterResponse, Emitter } from '../lib/realtime';
import { processLocationUpdate } from '../lib/locationProcessor';
import { buildRiskPulseSnapshot } from '../lib/riskPulse';
import { runAnomalyChecks } from '../lib/anomalyDetection';
import { trainAll } from '../ml/training';
import { invalidateModelCache } from '../ml/modelStore';

const router = Router();

const RISK_PULSE_EVERY_MS = 90_000;
const ANOMALY_EVERY_MS = 5 * 60_000;
const PRESENCE_LOOKBACK_MS = 6_000;
const LONG_POLL_INTERVAL_MS = 120;
const OFFLINE_AFTER_MS = 2 * 60_000;
const OFFLINE_CHECK_EVERY_MS = 60_000;
const ML_TRAIN_EVERY_MS = 24 * 60 * 60_000;

// Mirror of the Socket.IO server's offline detection, driven by Presence rows.
async function emitOfflineUsers(bus: Emitter): Promise<void> {
    const cutoff = new Date(Date.now() - OFFLINE_AFTER_MS);
    const stale = await Presence.find({ last_seen: { $lt: cutoff }, offline_notified: { $ne: true } }).lean();
    for (const row of stale as any[]) {
        bus.to('authority_room').emit('user_offline', { userId: row.user, lastSeen: new Date(row.last_seen).toISOString() });
    }
    if (stale.length) await Presence.updateMany({ _id: { $in: stale.map((r: any) => r._id) } }, { $set: { offline_notified: true } });
}

/**
 * Cross-invocation "cron": the first authority poll after the interval elapses wins
 * the claim and runs the job. Replaces setInterval, which can't live in serverless.
 */
async function claimTick(key: string, intervalMs: number): Promise<boolean> {
    const now = Date.now();
    try {
        const claimed = await PlatformConfig.findOneAndUpdate(
            { key, value: { $lt: String(now - intervalMs) } },
            { $set: { value: String(now) } }
        );
        if (claimed) return true;
        await PlatformConfig.create({ key, value: String(now) });
        return true;
    } catch {
        return false;
    }
}

function cursorFromNow(): string {
    const seconds = Math.floor((Date.now() - PRESENCE_LOOKBACK_MS) / 1000).toString(16).padStart(8, '0');
    return new mongoose.Types.ObjectId(`${seconds}0000000000000000`).toHexString();
}

router.get('/poll', authenticate, async (req: AuthRequest, res: Response, next) => {
    try {
        const user = req.user!;
        const extra = typeof req.query.rooms === 'string' ? req.query.rooms.split(',') : [];
        const rooms = roomsForUser(user, extra);

        const raw = typeof req.query.cursor === 'string' ? req.query.cursor : '';
        const cursor = mongoose.Types.ObjectId.isValid(raw) && raw.length === 24 ? raw : cursorFromNow();

        const fetchRows = () => RealtimeEvent.find({ _id: { $gt: cursor }, rooms: { $in: rooms } })
            .sort({ _id: 1 })
            .limit(200)
            .lean();

        // Long-poll: hold the request open (up to `wait` seconds) until something arrives, so an SOS
        // reaches the command centre within a few hundred ms instead of waiting for the next poll.
        const waitMs = Math.min(20, Math.max(0, Number(req.query.wait) || 0)) * 1000;
        const deadline = Date.now() + waitMs;
        let clientGone = false;
        req.on('close', () => { clientGone = true; });

        let rows = await fetchRows();
        while (rows.length === 0 && waitMs > 0 && Date.now() < deadline && !clientGone) {
            await new Promise((resolve) => setTimeout(resolve, LONG_POLL_INTERVAL_MS));
            rows = await fetchRows();
        }

        const nextCursor = rows.length ? String(rows[rows.length - 1]._id) : cursor;

        if (user.role === 'authority' || user.role === 'admin') {
            const bus = req.app.get('io') as Emitter;
            if (await claimTick('tick_risk_pulse', RISK_PULSE_EVERY_MS)) {
                runAfterResponse(buildRiskPulseSnapshot().then((snap) => bus.to('authority_room').emit('risk:pulse', snap)));
            }
            if (await claimTick('tick_offline', OFFLINE_CHECK_EVERY_MS)) {
                runAfterResponse(emitOfflineUsers(bus));
            }
            if (await claimTick('tick_anomaly', ANOMALY_EVERY_MS)) {
                runAfterResponse(runAnomalyChecks(bus));
            }
            // Daily retraining. Each model is gated, so a bad run never replaces a working model.
            if (await claimTick('tick_ml_train', ML_TRAIN_EVERY_MS)) {
                runAfterResponse(trainAll().then(() => invalidateModelCache()).catch((err) => console.error('ML retraining failed:', err)));
            }
        }

        res.json({
            success: true,
            cursor: nextCursor,
            events: rows.map((r: any) => ({ event: r.event, payload: r.payload })),
        });
    } catch (err) {
        next(err);
    }
});

const locationSchema = z.object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    accuracy: z.number().optional(),
    speed: z.number().optional(),
    battery: z.number().optional(),
    name: z.string().max(120).optional(),
});

// HTTP equivalent of the `location_update` socket event.
router.post('/location', authenticate, async (req: AuthRequest, res: Response, next) => {
    try {
        const body = locationSchema.parse(req.body);
        const user = req.user!;
        await processLocationUpdate(req.app.get('io') as Emitter, {
            ...body,
            userId: user.userId,
            role: user.role,
        });
        res.json({ success: true });
    } catch (err) {
        next(err);
    }
});

export default router;
