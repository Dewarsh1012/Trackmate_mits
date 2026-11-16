import crypto from 'crypto';
import { getAddress, verifyMessage } from 'ethers';

const MAX_AGE_MS = 10 * 60 * 1000;

function secret(): string {
    const s = process.env.JWT_SECRET;
    if (!s) throw new Error('JWT_SECRET is not configured');
    return s;
}

/** Stateless one-time-ish nonce: HMAC of the officer and issue time, so nothing needs storing. */
function nonceFor(userId: string, issuedIso: string): string {
    return crypto.createHmac('sha256', secret()).update(`wallet-link|${userId}|${issuedIso}`).digest('hex').slice(0, 32);
}

export function linkMessage(userId: string, address: string, issuedIso: string): string {
    return [
        'TrackMate: link wallet to officer account',
        `Officer ID: ${userId}`,
        `Wallet: ${address}`,
        `Nonce: ${nonceFor(userId, issuedIso)}`,
        `Issued: ${issuedIso}`,
    ].join('\n');
}

export interface AttestSubject { blockchainId: string; holderName: string; holderRole: string }

export function attestMessage(subject: AttestSubject, verifierUserId: string, verifierWallet: string, issuedIso: string): string {
    return [
        'TrackMate: verify blockchain ID',
        `Blockchain ID: ${subject.blockchainId}`,
        `Holder: ${subject.holderName} (${subject.holderRole})`,
        `Verifier officer: ${verifierUserId}`,
        `Verifier wallet: ${verifierWallet}`,
        `Issued: ${issuedIso}`,
    ].join('\n');
}

/** Pulls the "Issued:" timestamp out of a signed message and checks it is recent. */
export function freshIssuedAt(message: string): string | null {
    const match = message.match(/\nIssued: (\d{4}-\d{2}-\d{2}T[\d:.]+Z)$/);
    if (!match) return null;
    const t = new Date(match[1]).getTime();
    if (!Number.isFinite(t) || Date.now() - t > MAX_AGE_MS || t - Date.now() > 60_000) return null;
    return match[1];
}

/** Returns the checksummed address that signed `message`, or null when the signature is invalid. */
export function recoverSigner(message: string, signature: string): string | null {
    try {
        return getAddress(verifyMessage(message, signature));
    } catch {
        return null;
    }
}

export { getAddress };
