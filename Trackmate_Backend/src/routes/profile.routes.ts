import express, { Router, Response } from 'express';
import { z } from 'zod';
import { authenticate, requireRole } from '../middleware/auth';
import {
    Profile, Business, Trip, Itinerary, ItineraryStop, EmergencyContact, LocationLog, Incident, EFIR,
    WalletAttestation, DeviceLink, Presence,
} from '../models';
import { getAddress, recoverSigner } from '../lib/walletAuth';
import { AuthRequest, UserRole } from '../types';

const router: Router = express.Router();

// ─── Get my profile ───────────────────────────────────────────────────

router.get('/me', authenticate, async (req: AuthRequest, res: Response, next) => {
    try {
        const profile = await Profile.findById(req.user!.userId)
            .populate('ward', 'name district state center_lat center_lng')
            .lean();
        if (!profile) {
            res.status(404).json({ success: false, message: 'Profile not found' });
            return;
        }
        res.json({ success: true, data: profile });
    } catch (err) {
        next(err);
    }
});

// ─── Update my profile ────────────────────────────────────────────────

const updateProfileSchema = z.object({
    full_name: z.string().min(2).max(100).optional(),
    phone: z.string().optional(),
    preferred_language: z.string().optional(),
    avatar_url: z.string().url().optional(),
}).strict();

router.patch('/me', authenticate, async (req: AuthRequest, res: Response, next) => {
    try {
        const updates = updateProfileSchema.parse(req.body);
        const profile = await Profile.findByIdAndUpdate(
            req.user!.userId,
            { $set: updates },
            { new: true, runValidators: true }
        ).populate('ward', 'name district state');

        res.json({ success: true, data: profile });
    } catch (err) {
        next(err);
    }
});

// ─── Authority: everything on file for a blockchain ID ───────────────

router.get(
    '/lookup/:blockchainId',
    authenticate,
    requireRole(UserRole.AUTHORITY, UserRole.ADMIN),
    async (req: AuthRequest, res: Response, next) => {
        try {
            const blockchainId = String(req.params.blockchainId || '').trim().toUpperCase();
            const profile = await Profile.findOne({ blockchain_id: blockchainId })
                .populate('ward', 'name district state')
                .lean();
            if (!profile) {
                res.status(404).json({ success: false, message: 'No account has that blockchain ID.' });
                return;
            }
            const id = (profile as any)._id;
            const now = new Date();

            const [trips, contacts, lastLog, presence, incidents, efirs, attestations, devices, business] = await Promise.all([
                Trip.find({ tourist: id }).sort({ start_date: -1 }).limit(10).lean(),
                EmergencyContact.find({ user: id }).sort({ is_primary: -1, created_at: 1 }).lean(),
                LocationLog.findOne({ user: id }).sort({ recorded_at: -1 }).populate('current_zone', 'name risk_level').lean(),
                Presence.findOne({ user: String(id) }).select('last_seen').lean(),
                Incident.find({ reporter: id }).sort({ created_at: -1 }).limit(15)
                    .select('title incident_type severity status source latitude longitude created_at').lean(),
                EFIR.find({ user: id }).sort({ created_at: -1 }).limit(10).select('title status incident_type incident_location blockchain_hash ledger_anchor_status created_at').lean(),
                WalletAttestation.find({ blockchain_id: blockchainId }).sort({ issued_at: -1 }).limit(10).populate('verifier', 'full_name designation').lean(),
                DeviceLink.find({ user: id }).sort({ last_used: -1 }).limit(10).select('device_name linked_by last_used').lean(),
                Business.find({ owner: id }).select('business_name category address phone is_verified is_active').lean(),
            ]);

            // The itinerary of the trip that is on now, else the most recent one.
            const current = (trips as any[]).find((t) => new Date(t.start_date) <= now && new Date(t.end_date) >= now && t.is_active)
                ?? (trips as any[])[0] ?? null;
            const itinerary = current ? await Itinerary.findOne({ trip: current._id }).lean() : null;
            const stops = itinerary ? await ItineraryStop.find({ itinerary: (itinerary as any)._id }).sort({ sort_order: 1 }).lean() : [];

            const p: any = profile;
            res.json({
                success: true,
                data: {
                    profile: {
                        id: String(p._id), full_name: p.full_name, role: p.role, email: p.email, phone: p.phone ?? null,
                        blockchain_id: p.blockchain_id, id_type: p.id_type ?? null, id_last_four: p.id_last_four ?? null,
                        safety_score: p.safety_score, is_verified: p.is_verified, is_active: p.is_active,
                        preferred_language: p.preferred_language, created_at: p.created_at, ward: p.ward ?? null,
                        wallet_address: p.wallet_address ? getAddress(p.wallet_address) : null,
                        designation: p.designation ?? null, department: p.department ?? null,
                    },
                    current_trip: current ? { ...current, is_current: new Date(current.start_date) <= now && new Date(current.end_date) >= now && current.is_active } : null,
                    trips,
                    itinerary: itinerary ? { title: (itinerary as any).title, stops } : null,
                    emergency_contacts: contacts,
                    last_location: lastLog ? {
                        latitude: (lastLog as any).latitude, longitude: (lastLog as any).longitude, recorded_at: (lastLog as any).recorded_at,
                        battery_level: (lastLog as any).battery_level ?? null, source: (lastLog as any).source, zone: (lastLog as any).current_zone ?? null,
                    } : null,
                    last_seen: (presence as any)?.last_seen ?? (lastLog as any)?.recorded_at ?? null,
                    incidents,
                    efirs,
                    business: business.length ? business : null,
                    devices,
                    wallet_attestations: (attestations as any[]).map((a) => ({
                        verifier_name: a.verifier?.full_name ?? 'Officer', verifier_designation: a.verifier?.designation ?? null,
                        verifier_wallet: getAddress(a.verifier_wallet), issued_at: a.issued_at, chain_id: a.chain_id ?? null,
                        message: a.message, signature: a.signature,
                        signature_valid: recoverSigner(a.message, a.signature)?.toLowerCase() === String(a.verifier_wallet).toLowerCase(),
                    })),
                },
            });
        } catch (err) {
            next(err);
        }
    }
);

// ─── Authority: Get any profile by ID ────────────────────────────────

router.get(
    '/:id',
    authenticate,
    requireRole(UserRole.AUTHORITY, UserRole.ADMIN),
    async (req: AuthRequest, res: Response, next) => {
        try {
            const profile = await Profile.findById(req.params.id)
                .populate('ward', 'name district state center_lat center_lng')
                .lean();
            if (!profile) {
                res.status(404).json({ success: false, message: 'Profile not found' });
                return;
            }
            res.json({ success: true, data: profile });
        } catch (err) {
            next(err);
        }
    }
);

// ─── Authority: List all profiles by role ────────────────────────────

router.get(
    '/',
    authenticate,
    requireRole(UserRole.AUTHORITY, UserRole.ADMIN),
    async (req: AuthRequest, res: Response, next) => {
        try {
            const { role, ward, is_verified, search, page = '1', limit = '20' } = req.query;
            const filter: Record<string, any> = {};
            if (role) filter.role = role;
            if (ward) filter.ward = ward;
            if (is_verified !== undefined) filter.is_verified = is_verified === 'true';
            if (search) {
                const rx = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
                filter.$or = [{ full_name: rx }, { blockchain_id: rx }, { email: rx }];
            }

            const skip = (parseInt(String(page)) - 1) * parseInt(String(limit));
            const [data, total] = await Promise.all([
                Profile.find(filter)
                    .populate('ward', 'name district')
                    .sort({ created_at: -1 })
                    .skip(skip)
                    .limit(parseInt(String(limit)))
                    .lean(),
                Profile.countDocuments(filter),
            ]);

            res.json({ success: true, data, meta: { total, page: parseInt(String(page)), limit: parseInt(String(limit)) } });
        } catch (err) {
            next(err);
        }
    }
);

// ─── Authority: Verify a user ─────────────────────────────────────────

router.patch(
    '/:id/verify',
    authenticate,
    requireRole(UserRole.AUTHORITY, UserRole.ADMIN),
    async (req: AuthRequest, res: Response, next) => {
        try {
            const profile = await Profile.findByIdAndUpdate(
                req.params.id,
                { $set: { is_verified: true } },
                { new: true }
            );
            if (!profile) {
                res.status(404).json({ success: false, message: 'Profile not found' });
                return;
            }

            // A verified business owner means a verified business listing.
            if (profile.role === UserRole.BUSINESS) {
                await Business.updateMany({ owner: profile._id }, { $set: { is_verified: true } });
            }

            // Let the user's own session show "verified" immediately.
            const io = (req as any).app.get('io');
            io?.to(`user_${String(profile._id)}`).emit('profile:verified', { is_verified: true });

            res.json({ success: true, data: profile });
        } catch (err) {
            next(err);
        }
    }
);

export default router;
