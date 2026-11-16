import express, { Router, Response, Request } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { authenticate } from '../middleware/auth';
import { HealthSample, Profile } from '../models';
import { AuthRequest } from '../types';

const router: Router = express.Router();

// ─── Parsing ─────────────────────────────────────────────────────────

interface Vitals { steps?: number; heart_rate?: number; spo2?: number; recorded_at?: Date }

const num = (v: unknown): number | undefined => {
    const n = typeof v === 'string' ? parseFloat(v) : (v as number);
    return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};

/** SpO2 may arrive as a fraction (0.97, Apple Health) or a percentage (97). */
function normaliseSpo2(v: number | undefined): number | undefined {
    if (v === undefined) return undefined;
    const pct = v <= 1 ? v * 100 : v;
    return pct >= 50 && pct <= 100 ? Math.round(pct * 10) / 10 : undefined;
}

function clean(v: Vitals): Vitals | null {
    const out: Vitals = {};
    if (v.steps !== undefined && v.steps >= 0 && v.steps <= 200000) out.steps = Math.round(v.steps);
    if (v.heart_rate !== undefined && v.heart_rate >= 20 && v.heart_rate <= 250) out.heart_rate = Math.round(v.heart_rate);
    const spo2 = normaliseSpo2(v.spo2);
    if (spo2 !== undefined) out.spo2 = spo2;
    if (v.recorded_at && !Number.isNaN(v.recorded_at.getTime()) && v.recorded_at.getTime() <= Date.now() + 5 * 60_000) out.recorded_at = v.recorded_at;
    return out.steps === undefined && out.heart_rate === undefined && out.spo2 === undefined ? null : out;
}

/**
 * Accepts a simple body ({ steps, heart_rate, spo2 }) or the "Health Auto Export" app's JSON
 * ({ data: { metrics: [{ name: 'step_count' | 'heart_rate' | 'blood_oxygen_saturation', data: [...] }] } }),
 * which is what iPhone Shortcuts / Health Auto Export and similar Android bridges send.
 */
export function extractVitals(body: any): Vitals[] {
    const metrics = body?.data?.metrics ?? body?.metrics;
    if (Array.isArray(metrics)) {
        const byTime = new Map<string, Vitals>();
        for (const m of metrics) {
            const name = String(m?.name || '').toLowerCase();
            const points: any[] = Array.isArray(m?.data) ? m.data : [];
            if (name === 'step_count') {
                const total = points.reduce((sum, p) => sum + (num(p?.qty) ?? 0), 0);
                const key = 'steps';
                byTime.set(key, { ...(byTime.get(key) ?? {}), steps: total });
                continue;
            }
            const latest = points[points.length - 1];
            if (!latest) continue;
            const at = latest.date ? new Date(latest.date) : undefined;
            const key = at ? at.toISOString() : 'latest';
            const entry = { ...(byTime.get(key) ?? {}), ...(at ? { recorded_at: at } : {}) } as Vitals;
            if (name === 'heart_rate') entry.heart_rate = num(latest.Avg) ?? num(latest.qty) ?? num(latest.avg);
            if (name === 'blood_oxygen_saturation' || name === 'oxygen_saturation') entry.spo2 = num(latest.qty) ?? num(latest.Avg);
            byTime.set(key, entry);
        }
        return [...byTime.values()].map(clean).filter((v): v is Vitals => v !== null);
    }

    const single = clean({
        steps: num(body?.steps ?? body?.step_count ?? body?.stepCount),
        heart_rate: num(body?.heart_rate ?? body?.heartRate ?? body?.hr ?? body?.bpm),
        spo2: num(body?.spo2 ?? body?.SpO2 ?? body?.oxygen ?? body?.blood_oxygen),
        recorded_at: body?.recorded_at || body?.date ? new Date(body.recorded_at ?? body.date) : undefined,
    });
    return single ? [single] : [];
}

async function store(userId: string, samples: Vitals[], source: 'bluetooth' | 'health_app' | 'manual', deviceName?: string) {
    if (samples.length === 0) return [];
    return HealthSample.insertMany(samples.map((s) => ({ user: userId, ...s, source, device_name: deviceName, recorded_at: s.recorded_at ?? new Date() })));
}

function announce(req: Request, userId: string, latest: Vitals) {
    const io = (req as any).app.get('io');
    io?.to(`user_${userId}`).emit('health:update', { ...latest, at: new Date().toISOString() });
}

// ─── Read: today's vitals + recent series ────────────────────────────

router.get('/today', authenticate, async (req: AuthRequest, res: Response, next) => {
    try {
        const userId = req.user!.userId;
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);
        const since = new Date(Date.now() - 24 * 3600 * 1000);

        const [recent, stepRows] = await Promise.all([
            HealthSample.find({ user: userId, recorded_at: { $gte: since } }).sort({ recorded_at: -1 }).limit(400).lean(),
            HealthSample.find({ user: userId, steps: { $exists: true }, recorded_at: { $gte: startOfDay } }).sort({ steps: -1 }).limit(1).lean(),
        ]);

        const latestOf = (field: 'heart_rate' | 'spo2') => {
            const row: any = (recent as any[]).find((r) => typeof r[field] === 'number');
            return row ? { value: row[field] as number, at: row.recorded_at, source: row.source, device: row.device_name ?? null } : null;
        };
        const stepsRow: any = stepRows[0];

        res.json({
            success: true,
            data: {
                steps: stepsRow ? { value: stepsRow.steps as number, at: stepsRow.recorded_at, source: stepsRow.source, device: stepsRow.device_name ?? null } : null,
                heart_rate: latestOf('heart_rate'),
                spo2: latestOf('spo2'),
                series: (recent as any[])
                    .filter((r) => typeof r.heart_rate === 'number' || typeof r.spo2 === 'number')
                    .slice(0, 120)
                    .reverse()
                    .map((r) => ({ at: r.recorded_at, heart_rate: r.heart_rate ?? null, spo2: r.spo2 ?? null })),
            },
        });
    } catch (err) {
        next(err);
    }
});

// ─── Write: signed-in app (Bluetooth device or manual entry) ─────────

const manualSchema = z.object({
    steps: z.number().min(0).max(200000).optional(),
    heart_rate: z.number().min(20).max(250).optional(),
    spo2: z.number().min(50).max(100).optional(),
    source: z.enum(['bluetooth', 'manual']).default('manual'),
    device_name: z.string().max(80).optional(),
}).refine((v) => v.steps !== undefined || v.heart_rate !== undefined || v.spo2 !== undefined, { message: 'Send at least one of steps, heart_rate, spo2' });

router.post('/', authenticate, async (req: AuthRequest, res: Response, next) => {
    try {
        const body = manualSchema.parse(req.body);
        const samples = extractVitals(body);
        if (samples.length === 0) {
            res.status(400).json({ success: false, message: 'No valid readings in the request' });
            return;
        }
        await store(req.user!.userId, samples, body.source, body.device_name);
        announce(req, req.user!.userId, samples[samples.length - 1]);
        res.status(201).json({ success: true, data: samples[samples.length - 1] });
    } catch (err) {
        next(err);
    }
});

// ─── Health-app bridge: a personal key lets Shortcuts / Health Auto Export / Tasker push data ──

const hashKey = (key: string) => crypto.createHash('sha256').update(key).digest('hex');

router.post('/key', authenticate, async (req: AuthRequest, res: Response, next) => {
    try {
        const key = `hk_${crypto.randomBytes(24).toString('hex')}`;
        await Profile.findByIdAndUpdate(req.user!.userId, { $set: { health_key_hash: hashKey(key) } });
        // The key is shown once; only its hash is stored.
        res.status(201).json({ success: true, data: { key } });
    } catch (err) {
        next(err);
    }
});

router.delete('/key', authenticate, async (req: AuthRequest, res: Response, next) => {
    try {
        await Profile.findByIdAndUpdate(req.user!.userId, { $unset: { health_key_hash: 1 } });
        res.json({ success: true });
    } catch (err) {
        next(err);
    }
});

router.get('/key', authenticate, async (req: AuthRequest, res: Response, next) => {
    try {
        const p = await Profile.findById(req.user!.userId).select('+health_key_hash').lean();
        res.json({ success: true, data: { has_key: Boolean((p as any)?.health_key_hash) } });
    } catch (err) {
        next(err);
    }
});

/** Public endpoint: authenticated by the personal key, so a phone automation needs no login. */
router.post('/ingest', async (req: Request, res: Response, next) => {
    try {
        const header = String(req.headers['x-health-key'] || req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
        if (!/^hk_[a-f0-9]{48}$/.test(header)) {
            res.status(401).json({ success: false, message: 'Missing or invalid health key' });
            return;
        }
        const profile = await Profile.findOne({ health_key_hash: hashKey(header) }).select('_id is_active').lean();
        if (!profile || (profile as any).is_active === false) {
            res.status(401).json({ success: false, message: 'Missing or invalid health key' });
            return;
        }
        const samples = extractVitals(req.body);
        if (samples.length === 0) {
            res.status(400).json({ success: false, message: 'No valid steps, heart_rate or spo2 values found' });
            return;
        }
        const userId = String((profile as any)._id);
        await store(userId, samples, 'health_app');
        announce(req, userId, samples[samples.length - 1]);
        res.status(201).json({ success: true, accepted: samples.length });
    } catch (err) {
        next(err);
    }
});

export default router;
