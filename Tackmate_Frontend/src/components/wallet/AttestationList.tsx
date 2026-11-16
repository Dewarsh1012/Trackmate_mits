import { useState } from 'react';
import { BadgeCheck, ShieldX, Copy, Check } from 'lucide-react';
import { shortAddress } from '../../lib/wallet';

export interface Attestation {
    verifier_name: string;
    verifier_designation: string | null;
    verifier_wallet: string;
    issued_at: string;
    chain_id: string | null;
    message: string;
    signature: string;
    signature_valid: boolean;
}

/** Wallet verifications of an ID. Validity is re-computed by the server on every read. */
export default function AttestationList({ items, compact = false }: { items: Attestation[]; compact?: boolean }) {
    const [copied, setCopied] = useState<string | null>(null);
    const copy = async (key: string, text: string) => {
        try { await navigator.clipboard.writeText(text); setCopied(key); setTimeout(() => setCopied(null), 1600); } catch { /* blocked */ }
    };
    if (items.length === 0) return <p style={{ margin: 0, fontSize: '0.78rem', opacity: 0.7 }}>No wallet verification yet.</p>;

    return (
        <div style={{ display: 'grid', gap: 8 }}>
            {items.map((a) => (
                <div key={a.verifier_wallet + a.issued_at} style={{ border: `1px solid ${a.signature_valid ? 'rgba(18,179,166,0.5)' : 'rgba(239,68,68,0.5)'}`, borderRadius: 12, padding: '10px 12px', background: a.signature_valid ? 'rgba(18,179,166,0.07)' : 'rgba(239,68,68,0.07)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 800, fontSize: '0.84rem' }}>
                        {a.signature_valid ? <BadgeCheck size={16} color="#0F766E" /> : <ShieldX size={16} color="#B42318" />}
                        {a.signature_valid ? 'Signature valid' : 'Signature does NOT match'}
                    </div>
                    <div style={{ fontSize: '0.74rem', marginTop: 4, lineHeight: 1.5 }}>
                        Signed by <b>{a.verifier_name}</b>{a.verifier_designation ? `, ${a.verifier_designation}` : ''} with wallet <code title={a.verifier_wallet}>{shortAddress(a.verifier_wallet)}</code>
                        <br />{new Date(a.issued_at).toLocaleString()}
                    </div>
                    {!compact && (
                        <details style={{ marginTop: 6, fontSize: '0.72rem' }}>
                            <summary style={{ cursor: 'pointer', fontWeight: 700 }}>Check it yourself</summary>
                            <p style={{ margin: '6px 0', lineHeight: 1.5 }}>Paste the message and signature into any Ethereum “verify signature” tool (for example Etherscan). It must report the wallet above.</p>
                            <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all', background: 'rgba(0,0,0,0.05)', borderRadius: 8, padding: 8 }}>{a.message}</pre>
                            <code style={{ display: 'block', wordBreak: 'break-all', marginTop: 6 }}>{a.signature}</code>
                            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                                <button type="button" onClick={() => void copy('m' + a.signature, a.message)} style={{ fontSize: '0.7rem', fontWeight: 700, cursor: 'pointer' }}>{copied === 'm' + a.signature ? <><Check size={11} /> Copied</> : <><Copy size={11} /> Message</>}</button>
                                <button type="button" onClick={() => void copy('s' + a.signature, a.signature)} style={{ fontSize: '0.7rem', fontWeight: 700, cursor: 'pointer' }}>{copied === 's' + a.signature ? <><Check size={11} /> Copied</> : <><Copy size={11} /> Signature</>}</button>
                            </div>
                        </details>
                    )}
                </div>
            ))}
        </div>
    );
}
