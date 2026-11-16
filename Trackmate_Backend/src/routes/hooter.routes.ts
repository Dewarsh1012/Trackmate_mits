import express, { Router, Response } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { authenticate, requireRole } from '../middleware/auth';
import { Profile, Presence, DeviceLink } from '../models';
import { AuthRequest, UserRole } from '../types';

const router: Router = express.Router();

const ONLINE_WITHIN_MS = 2 * 60_000;

const startSchema = z.object({
    user_id: z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid user id'),
    message: z.string().trim().max(200).optional(),
});

/**
 * Authority sounds a hooter on a person's phone. The phone (TrackMate open) plays a siren and
 * shows a flashing warning with the way to the nearest safe zone. It runs over the same realtime
 * channel as SOS, so it arrives in well under a second.
 */
router.post('/start', authenticate, requireRole(UserRole.AUTHORITY, UserRole.ADMIN), async (req: AuthRequest, res: Response, next) => {
    try {
        const body = startSchema.parse(req.body);
        const target = await Profile.findById(body.user_id).select('full_name role is_active').lean();
        if (!target || (target as any).is_active === false) {
            res.status(404).json({ success: false, message: 'User not found' });
            return;
        }
        if ((target as any).role === UserRole.AUTHORITY || (target as any).role === UserRole.ADMIN) {
            res.status(400).json({ success: false, message: 'A hooter can only be sounded on a tourist, resident or business account' });
            return;
        }

        const issuer = await Profile.findById(req.user!.userId).select('full_name').lean();
        const hooterId = crypto.randomBytes(8).toString('hex');
        const payload = {
            hooter_id: hooterId,
            message: body.message || null,
            issued_by: (issuer as any)?.full_name || 'Authority',
            at: new Date().toISOString(),
        };
        const io = (req as any).app.get('io');
        io?.to(`user_${body.user_id}`).emit('hooter:start', payload);

        const presence = await Presence.findOne({ user: body.user_id }).select('last_seen').lean();
        const lastSeen = (presence as any)?.last_seen ? new Date((presence as any).last_seen).getTime() : 0;
        res.status(201).json({
            success: true,
            data: { ...payload, user_id: body.user_id, name: (target as any).full_name, online: Date.now() - lastSeen < ONLINE_WITHIN_MS },
        });
    } catch (err) {
        next(err);
    }
});

router.post('/stop', authenticate, requireRole(UserRole.AUTHORITY, UserRole.ADMIN), async (req: AuthRequest, res: Response, next) => {
    try {
        const { user_id } = startSchema.pick({ user_id: true }).parse(req.body);
        (req as any).app.get('io')?.to(`user_${user_id}`).emit('hooter:stop', { at: new Date().toISOString() });
        res.json({ success: true });
    } catch (err) {
        next(err);
    }
});

/** The person confirms they've seen the warning; authorities see it on their screen. */
router.post('/ack', authenticate, async (req: AuthRequest, res: Response, next) => {
    try {
        const hooterId = typeof req.body?.hooter_id === 'string' ? req.body.hooter_id.slice(0, 40) : null;
        const me = await Profile.findById(req.user!.userId).select('full_name').lean();
        (req as any).app.get('io')?.to('authority_room').emit('hooter:ack', {
            hooter_id: hooterId,
            user_id: req.user!.userId,
            name: (me as any)?.full_name || 'User',
            at: new Date().toISOString(),
        });
        res.json({ success: true });
    } catch (err) {
        next(err);
    }
});

// ─── Device ownership: which person does a paired Bluetooth device belong to? ──

const nameKey = (name: string) => name.trim().toLowerCase();
const deviceNameSchema = z.object({ device_name: z.string().trim().min(1).max(80) });

/** A signed-in person registers their own band/tracker (done automatically when they connect it in IoT Sync). */
router.post('/devices', authenticate, async (req: AuthRequest, res: Response, next) => {
    try {
        const { device_name } = deviceNameSchema.parse(req.body);
        await DeviceLink.findOneAndUpdate(
            { user: req.user!.userId, name_key: nameKey(device_name) },
            { $set: { device_name, last_used: new Date() }, $setOnInsert: { linked_by: 'self' } },
            { upsert: true }
        );
        res.status(201).json({ success: true });
    } catch (err) {
        next(err);
    }
});

/** Authority: who owns a device with this name? */
router.get('/devices/owners', authenticate, requireRole(UserRole.AUTHORITY, UserRole.ADMIN), async (req: AuthRequest, res: Response, next) => {
    try {
        const { device_name } = deviceNameSchema.parse({ device_name: req.query.name });
        const links = await DeviceLink.find({ name_key: nameKey(device_name) }).sort({ last_used: -1 }).limit(10).populate('user', 'full_name role is_active').lean();
        res.json({
            success: true,
            data: (links as any[])
                .filter((l) => l.user && l.user.is_active !== false)
                .map((l) => ({ user_id: String(l.user._id), full_name: l.user.full_name, role: l.user.role, linked_by: l.linked_by })),
        });
    } catch (err) {
        next(err);
    }
});

/** Authority: assign a device to a person, so later pairings find the owner automatically. */
router.post('/devices/link', authenticate, requireRole(UserRole.AUTHORITY, UserRole.ADMIN), async (req: AuthRequest, res: Response, next) => {
    try {
        const body = deviceNameSchema.extend({ user_id: z.string().regex(/^[a-f0-9]{24}$/i) }).parse(req.body);
        const target = await Profile.findById(body.user_id).select('full_name role').lean();
        if (!target) {
            res.status(404).json({ success: false, message: 'User not found' });
            return;
        }
        await DeviceLink.findOneAndUpdate(
            { user: body.user_id, name_key: nameKey(body.device_name) },
            { $set: { device_name: body.device_name, linked_by: 'authority', last_used: new Date() } },
            { upsert: true }
        );
        res.status(201).json({ success: true, data: { user_id: body.user_id, full_name: (target as any).full_name, role: (target as any).role } });
    } catch (err) {
        next(err);
    }
});

export default router;
