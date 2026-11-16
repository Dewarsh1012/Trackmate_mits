import express, { Router, Response } from 'express';
import { Profile, Trip, WalletAttestation } from '../models';
import { getAddress, recoverSigner } from '../lib/walletAuth';

const router: Router = express.Router();

// Public: verify a blockchain ID without authentication
router.get('/:blockchainId', async (req, res: Response, next) => {
    try {
        const profile = await Profile.findOne({ blockchain_id: req.params.blockchainId })
            .select('full_name role blockchain_id id_type id_last_four is_verified created_at')
            .lean();

        if (!profile) {
            res.json({ success: true, data: { valid: false, message: 'Blockchain ID not found' } });
            return;
        }

        let tripInfo = null;
        if (profile.role === 'tourist') {
            const now = new Date();
            const trip = await Trip.findOne({
                tourist: profile._id,
                is_active: true,
                start_date: { $lte: now },
                end_date: { $gte: now },
            })
                .select('destination_region start_date end_date')
                .lean();

            if (trip) {
                tripInfo = {
                    destination_region: trip.destination_region,
                    valid_from: trip.start_date,
                    valid_to: trip.end_date,
                    is_currently_valid: true,
                };
            }
        }

        // Wallet attestations are re-verified on every read: the signature is checked, never just trusted from the DB.
        const rows = await WalletAttestation.find({ blockchain_id: profile.blockchain_id }).sort({ issued_at: -1 }).limit(10).populate('verifier', 'full_name designation').lean();
        const wallet_attestations = (rows as any[]).map((a) => ({
            verifier_name: a.verifier?.full_name ?? 'Officer',
            verifier_designation: a.verifier?.designation ?? null,
            verifier_wallet: getAddress(a.verifier_wallet),
            issued_at: a.issued_at,
            chain_id: a.chain_id ?? null,
            message: a.message,
            signature: a.signature,
            signature_valid: recoverSigner(a.message, a.signature)?.toLowerCase() === String(a.verifier_wallet).toLowerCase(),
        }));

        res.json({
            success: true,
            data: {
                wallet_attestations,
                valid: profile.role !== 'tourist' || !!tripInfo,
                name: profile.full_name,
                role: profile.role,
                blockchain_id: profile.blockchain_id,
                is_verified: profile.is_verified,
                issued_at: profile.created_at,
                trip: tripInfo,
            },
        });
    } catch (err) {
        next(err);
    }
});

export default router;
