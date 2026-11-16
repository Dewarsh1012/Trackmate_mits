import express, { Router, Response } from 'express';
import { z } from 'zod';
import { authenticate, requireRole } from '../middleware/auth';
import { Profile, WalletAttestation } from '../models';
import { AuthRequest, UserRole } from '../types';
import { attestMessage, freshIssuedAt, getAddress, linkMessage, recoverSigner } from '../lib/walletAuth';

const router: Router = express.Router();
const staff = [authenticate, requireRole(UserRole.AUTHORITY, UserRole.ADMIN)];

const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid wallet address');
const signatureSchema = z.string().regex(/^0x[a-fA-F0-9]{130}$/, 'Invalid signature');

// ─── Link a MetaMask wallet to the signed-in officer (proof of ownership) ──

router.get('/link-message', ...staff, (req: AuthRequest, res: Response, next) => {
    try {
        const address = getAddress(addressSchema.parse(req.query.address));
        res.json({ success: true, data: { message: linkMessage(req.user!.userId, address, new Date().toISOString()) } });
    } catch (err) {
        next(err);
    }
});

router.post('/link', ...staff, async (req: AuthRequest, res: Response, next) => {
    try {
        const body = z.object({ address: addressSchema, message: z.string().max(600), signature: signatureSchema }).parse(req.body);
        const address = getAddress(body.address);
        const issued = freshIssuedAt(body.message);
        if (!issued || body.message !== linkMessage(req.user!.userId, address, issued)) {
            res.status(400).json({ success: false, message: 'This signing request has expired or does not match. Try again.' });
            return;
        }
        if (recoverSigner(body.message, body.signature) !== address) {
            res.status(401).json({ success: false, message: 'The signature does not match that wallet.' });
            return;
        }
        const taken = await Profile.findOne({ wallet_address: address.toLowerCase(), _id: { $ne: req.user!.userId } }).select('_id').lean();
        if (taken) {
            res.status(409).json({ success: false, message: 'That wallet is already linked to another account.' });
            return;
        }
        await Profile.findByIdAndUpdate(req.user!.userId, { $set: { wallet_address: address.toLowerCase() } });
        res.json({ success: true, data: { address } });
    } catch (err) {
        next(err);
    }
});

router.get('/me', ...staff, async (req: AuthRequest, res: Response, next) => {
    try {
        const me = await Profile.findById(req.user!.userId).select('wallet_address').lean();
        const addr = (me as any)?.wallet_address;
        res.json({ success: true, data: { address: addr ? getAddress(addr) : null } });
    } catch (err) {
        next(err);
    }
});

router.delete('/link', ...staff, async (req: AuthRequest, res: Response, next) => {
    try {
        await Profile.findByIdAndUpdate(req.user!.userId, { $unset: { wallet_address: 1 } });
        res.json({ success: true });
    } catch (err) {
        next(err);
    }
});

// ─── Verify a blockchain ID by signing it with the linked wallet ─────

type SubjectResult = { error: string; status: number } | { subject: any };

async function loadSubject(blockchainId: string): Promise<SubjectResult> {
    const subject = await Profile.findOne({ blockchain_id: blockchainId }).select('full_name role blockchain_id is_verified').lean();
    if (!subject) return { error: 'No account has that blockchain ID.', status: 404 };
    if ((subject as any).role === UserRole.AUTHORITY || (subject as any).role === UserRole.ADMIN) {
        return { error: 'Only tourist, resident and business IDs are verified this way.', status: 400 };
    }
    return { subject: subject as any };
}

router.get('/attest-message', ...staff, async (req: AuthRequest, res: Response, next) => {
    try {
        const blockchainId = z.string().min(6).max(80).parse(req.query.blockchain_id);
        const me = await Profile.findById(req.user!.userId).select('wallet_address').lean();
        const wallet = (me as any)?.wallet_address;
        if (!wallet) {
            res.status(409).json({ success: false, message: 'Link your MetaMask wallet first.' });
            return;
        }
        const found = await loadSubject(blockchainId);
        if ('error' in found) {
            res.status(found.status).json({ success: false, message: found.error });
            return;
        }
        const s = found.subject;
        const message = attestMessage({ blockchainId: s.blockchain_id, holderName: s.full_name, holderRole: s.role }, req.user!.userId, getAddress(wallet), new Date().toISOString());
        res.json({ success: true, data: { message, subject: { name: s.full_name, role: s.role, blockchain_id: s.blockchain_id, is_verified: s.is_verified } } });
    } catch (err) {
        next(err);
    }
});

router.post('/attest', ...staff, async (req: AuthRequest, res: Response, next) => {
    try {
        const body = z.object({
            blockchain_id: z.string().min(6).max(80),
            message: z.string().max(800),
            signature: signatureSchema,
            chain_id: z.string().max(20).optional(),
        }).parse(req.body);

        const me = await Profile.findById(req.user!.userId).select('wallet_address full_name').lean();
        const wallet = (me as any)?.wallet_address;
        if (!wallet) {
            res.status(409).json({ success: false, message: 'Link your MetaMask wallet first.' });
            return;
        }
        const found = await loadSubject(body.blockchain_id);
        if ('error' in found) {
            res.status(found.status).json({ success: false, message: found.error });
            return;
        }
        const s = found.subject;
        const issued = freshIssuedAt(body.message);
        const expected = issued
            ? attestMessage({ blockchainId: s.blockchain_id, holderName: s.full_name, holderRole: s.role }, req.user!.userId, getAddress(wallet), issued)
            : null;
        if (!issued || body.message !== expected) {
            res.status(400).json({ success: false, message: 'This signing request has expired or does not match the ID. Try again.' });
            return;
        }
        const signer = recoverSigner(body.message, body.signature);
        if (!signer || signer.toLowerCase() !== String(wallet).toLowerCase()) {
            res.status(401).json({ success: false, message: 'The signature was not made by your linked wallet.' });
            return;
        }

        await WalletAttestation.findOneAndUpdate(
            { blockchain_id: s.blockchain_id, verifier_wallet: signer.toLowerCase() },
            { $set: { subject: s._id, verifier: req.user!.userId, message: body.message, signature: body.signature, chain_id: body.chain_id, issued_at: new Date(issued) } },
            { upsert: true }
        );
        await Profile.findByIdAndUpdate(s._id, { $set: { is_verified: true } });
        (req as any).app.get('io')?.to(`user_${String(s._id)}`).emit('profile:verified', { is_verified: true });

        res.status(201).json({ success: true, data: { blockchain_id: s.blockchain_id, verifier_wallet: signer, issued_at: issued } });
    } catch (err) {
        next(err);
    }
});

export default router;
