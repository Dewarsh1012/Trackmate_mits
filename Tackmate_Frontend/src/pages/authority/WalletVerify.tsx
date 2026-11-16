import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { BadgeCheck, Link2, Loader2, Search, Wallet } from 'lucide-react';
import api from '../../lib/api';
import AuthoritySidebar from '../../components/layout/AuthoritySidebar';
import IdDossier from '../../components/authority/IdDossier';
import { useWallet } from '../../hooks/useWallet';
import { shortAddress, signMessage } from '../../lib/wallet';
import { CLAY_COLORS as C, CLAY_CARD_STYLE as clayCard } from '../../theme/clayTheme';

interface Person { _id: string; full_name: string; role: string; blockchain_id?: string; is_verified?: boolean; email?: string }
interface Subject { name: string; role: string; blockchain_id: string; is_verified: boolean }

const ID_PATTERN = /^[A-Z]{2}[0-9A-F]{16}$/;
const btn = (kind: 'primary' | 'ghost' | 'danger' = 'primary'): React.CSSProperties => ({
    background: kind === 'primary' ? '#F6851B' : kind === 'danger' ? '#B42318' : C.surfaceAlt,
    color: kind === 'ghost' ? C.text : '#fff', border: kind === 'ghost' ? `1px solid ${C.border}` : 'none',
    borderRadius: 12, padding: '10px 16px', fontFamily: 'inherit', fontWeight: 800, fontSize: '0.82rem', cursor: 'pointer',
    display: 'inline-flex', alignItems: 'center', gap: 8,
});

export default function WalletVerify() {
    const wallet = useWallet();
    const [linked, setLinked] = useState<string | null | undefined>(undefined);
    const [busy, setBusy] = useState('');
    const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

    // Finding a person
    const [query, setQuery] = useState('');
    const [results, setResults] = useState<Person[]>([]);
    const [searching, setSearching] = useState(false);
    const [subject, setSubject] = useState<Subject | null>(null);
    const [reload, setReload] = useState(0);
    const [params] = useSearchParams();
    const [pending, setPending] = useState<{ message: string } | null>(null);

    const say = (ok: boolean, text: string) => setNotice({ ok, text });

    useEffect(() => {
        api.get('/wallet/me').then((r) => setLinked(r.data.data.address)).catch(() => setLinked(null));
    }, []);

    const sameAccount = Boolean(wallet.account && linked && wallet.account.toLowerCase() === linked.toLowerCase());

    const linkWallet = async () => {
        if (!wallet.account) return;
        setBusy('link'); setNotice(null);
        try {
            const { data } = await api.get('/wallet/link-message', { params: { address: wallet.account } });
            const message: string = data.data.message;
            const signature = await signMessage(wallet.account, message);
            const res = await api.post('/wallet/link', { address: wallet.account, message, signature });
            setLinked(res.data.data.address);
            say(true, 'Wallet linked to your officer account.');
        } catch (err: any) {
            say(false, err.response?.data?.message || err.message || 'Could not link the wallet.');
        } finally { setBusy(''); }
    };

    const unlink = async () => {
        setBusy('unlink');
        try { await api.delete('/wallet/link'); setLinked(null); say(true, 'Wallet unlinked.'); } catch { say(false, 'Could not unlink.'); } finally { setBusy(''); }
    };

    // Search by name, email or by pasting the blockchain ID itself.
    useEffect(() => {
        const q = query.trim();
        if (q.length < 2) { setResults([]); return; }
        let cancelled = false;
        setSearching(true);
        const timer = setTimeout(async () => {
            const lists = await Promise.all(['tourist', 'resident', 'business'].map((role) => api.get('/profiles', { params: { role, search: q, limit: 8 } }).catch(() => null)));
            if (!cancelled) {
                setResults(lists.flatMap((r) => (r?.data?.data as Person[]) || []).filter((p) => p.blockchain_id).slice(0, 12));
                setSearching(false);
            }
        }, 300);
        return () => { cancelled = true; clearTimeout(timer); };
    }, [query]);

    const openSubject = useCallback(async (blockchainId: string) => {
        setPending(null); setNotice(null);
        try {
            const res = await api.get(`/verify/${blockchainId}`);
            const d = res.data.data;
            if (!d?.name) { setSubject(null); say(false, 'No account has that blockchain ID.'); return; }
            setSubject({ name: d.name, role: d.role, blockchain_id: d.blockchain_id, is_verified: Boolean(d.is_verified) });
        } catch { say(false, 'Could not load that ID.'); }
    }, []);

    const startVerify = async () => {
        if (!subject) return;
        setBusy('prepare'); setNotice(null);
        try {
            const { data } = await api.get('/wallet/attest-message', { params: { blockchain_id: subject.blockchain_id } });
            setPending({ message: data.data.message });
        } catch (err: any) {
            say(false, err.response?.data?.message || 'Could not prepare the verification.');
        } finally { setBusy(''); }
    };

    const signAndSubmit = async () => {
        if (!pending || !wallet.account || !subject) return;
        setBusy('sign'); setNotice(null);
        try {
            const signature = await signMessage(wallet.account, pending.message);
            await api.post('/wallet/attest', { blockchain_id: subject.blockchain_id, message: pending.message, signature, chain_id: wallet.chainId ?? undefined });
            setPending(null);
            await openSubject(subject.blockchain_id);
            setReload((n) => n + 1);
            say(true, `${subject.name}'s blockchain ID is now verified with your wallet.`);
        } catch (err: any) {
            say(false, err.response?.data?.message || err.message || 'Verification failed.');
        } finally { setBusy(''); }
    };

    useEffect(() => {
        const id = params.get('id');
        if (id) void openSubject(id.toUpperCase());
    }, [params, openSubject]);

    const pastedId = ID_PATTERN.test(query.trim().toUpperCase()) ? query.trim().toUpperCase() : null;

    return (
        <div style={{ display: 'flex', minHeight: '100vh', background: C.bg, fontFamily: "'Inter', sans-serif" }}>
            <AuthoritySidebar />
            <main className="page-with-sidebar" style={{ flex: 1, padding: 'clamp(14px, 3vw, 28px)', color: C.text }}>
                <div style={{ marginBottom: 20 }}>
                    <h1 style={{ margin: 0, fontSize: '1.5rem', fontWeight: 800 }}>Wallet verification</h1>
                    <p style={{ margin: '4px 0 0', fontSize: '0.78rem', color: C.textMuted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Verify blockchain IDs with MetaMask</p>
                </div>

                {notice && (
                    <div role="status" style={{ marginBottom: 16, padding: '10px 14px', borderRadius: 12, fontWeight: 700, fontSize: '0.84rem', background: notice.ok ? 'rgba(18,179,166,0.12)' : 'rgba(239,68,68,0.1)', color: notice.ok ? '#0F766E' : '#B42318', border: `1px solid ${notice.ok ? 'rgba(18,179,166,0.4)' : 'rgba(239,68,68,0.4)'}` }}>
                        {notice.text}
                    </div>
                )}

                <div className="responsive-grid" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.4fr)', gap: 20, alignItems: 'start' }}>
                    {/* ── Wallet ── */}
                    <div style={{ ...clayCard, padding: 20 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                            <Wallet size={20} color="#F6851B" />
                            <h2 style={{ margin: 0, fontSize: '1rem', fontWeight: 800 }}>Your wallet</h2>
                        </div>

                        {!wallet.available ? (
                            <>
                                <p style={{ margin: '0 0 12px', fontSize: '0.84rem', lineHeight: 1.5 }}>MetaMask was not detected in this browser. Install the extension (desktop) or open this page in the MetaMask app’s browser (phone).</p>
                                <a href="https://metamask.io/download/" target="_blank" rel="noreferrer" style={{ ...btn(), textDecoration: 'none' }}>Get MetaMask</a>
                            </>
                        ) : !wallet.account ? (
                            <>
                                <p style={{ margin: '0 0 12px', fontSize: '0.84rem', lineHeight: 1.5 }}>Connect MetaMask to sign verifications. Connecting only shares your public address; nothing is sent or paid.</p>
                                <button type="button" onClick={() => void wallet.connect()} disabled={wallet.connecting} style={btn()}>
                                    {wallet.connecting ? <Loader2 size={16} style={{ animation: 'spin-slow 1s linear infinite' }} /> : <Wallet size={16} />} Connect MetaMask
                                </button>
                                {wallet.error && <p role="alert" style={{ margin: '10px 0 0', color: '#B42318', fontWeight: 700, fontSize: '0.8rem' }}>{wallet.error}</p>}
                            </>
                        ) : (
                            <div style={{ display: 'grid', gap: 10 }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <span style={{ width: 9, height: 9, borderRadius: '50%', background: C.safe }} />
                                    <code title={wallet.account} style={{ fontWeight: 800 }}>{shortAddress(wallet.account)}</code>
                                    <span style={{ marginLeft: 'auto', fontSize: '0.7rem', fontWeight: 800, color: C.textMuted }}>{wallet.network}</span>
                                </div>
                                {linked === undefined ? (
                                    <span style={{ fontSize: '0.8rem', color: C.textMuted }}>Checking link…</span>
                                ) : sameAccount ? (
                                    <div style={{ fontSize: '0.82rem', fontWeight: 700, color: '#0F766E', display: 'flex', alignItems: 'center', gap: 6 }}><BadgeCheck size={16} /> Linked to your officer account</div>
                                ) : (
                                    <>
                                        <p style={{ margin: 0, fontSize: '0.8rem', lineHeight: 1.5 }}>
                                            {linked ? <>Your account is linked to <code>{shortAddress(linked)}</code>, not this wallet. Switch accounts in MetaMask, or link this one.</> : 'Link this wallet to your officer account. You sign a short message to prove you own it. This is free.'}
                                        </p>
                                        <button type="button" onClick={() => void linkWallet()} disabled={busy === 'link'} style={btn()}>
                                            {busy === 'link' ? <Loader2 size={16} style={{ animation: 'spin-slow 1s linear infinite' }} /> : <Link2 size={16} />} {linked ? 'Link this wallet instead' : 'Link wallet'}
                                        </button>
                                    </>
                                )}
                                {linked && <button type="button" onClick={() => void unlink()} disabled={busy === 'unlink'} style={{ ...btn('ghost'), justifySelf: 'start' }}>Unlink wallet</button>}
                                {wallet.error && <p role="alert" style={{ margin: 0, color: '#B42318', fontWeight: 700, fontSize: '0.8rem' }}>{wallet.error}</p>}
                            </div>
                        )}
                    </div>

                    {/* ── Verify an ID ── */}
                    <div style={{ ...clayCard, padding: 20 }}>
                        <h2 style={{ margin: '0 0 12px', fontSize: '1rem', fontWeight: 800 }}>Verify a blockchain ID</h2>
                        <div style={{ position: 'relative' }}>
                            <Search size={15} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: C.textMuted }} />
                            <input aria-label="Search by name, email or blockchain ID" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Name, email or blockchain ID (e.g. BCA857F9938ADA8332)"
                                style={{ width: '100%', boxSizing: 'border-box', padding: '11px 12px 11px 36px', borderRadius: 12, border: `1px solid ${C.border}`, background: C.surfaceAlt, fontFamily: 'inherit', fontSize: '0.88rem' }} />
                        </div>

                        {pastedId && <button type="button" onClick={() => void openSubject(pastedId)} style={{ ...btn('ghost'), marginTop: 8 }}>Open ID {pastedId}</button>}
                        {searching && <p style={{ margin: '8px 0 0', fontSize: '0.78rem', color: C.textMuted }}>Searching…</p>}
                        {results.length > 0 && (
                            <div style={{ display: 'grid', gap: 6, marginTop: 8, maxHeight: 220, overflowY: 'auto' }}>
                                {results.map((p) => (
                                    <button key={p._id} type="button" onClick={() => { setQuery(''); setResults([]); void openSubject(p.blockchain_id!); }}
                                        style={{ ...btn('ghost'), justifyContent: 'space-between', width: '100%', textAlign: 'left' }}>
                                        <span style={{ minWidth: 0 }}>
                                            <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.full_name}</span>
                                            <code style={{ fontSize: '0.68rem', color: C.textMuted }}>{p.blockchain_id}</code>
                                        </span>
                                        <span style={{ fontSize: '0.68rem', color: C.textMuted, textTransform: 'capitalize' }}>{p.role}</span>
                                    </button>
                                ))}
                            </div>
                        )}

                        {subject && (
                            <div style={{ marginTop: 16, borderTop: `1px solid ${C.border}`, paddingTop: 16 }}>
                                <IdDossier key={`${subject.blockchain_id}-${reload}`} blockchainId={subject.blockchain_id} />

                                {!pending ? (
                                    <div style={{ marginTop: 14 }}>
                                        <button type="button" onClick={() => void startVerify()} disabled={busy === 'prepare' || !sameAccount} style={{ ...btn(), opacity: sameAccount ? 1 : 0.5 }}>
                                            {busy === 'prepare' ? <Loader2 size={16} style={{ animation: 'spin-slow 1s linear infinite' }} /> : <BadgeCheck size={16} />} Verify with MetaMask
                                        </button>
                                        {!sameAccount && <p style={{ margin: '8px 0 0', fontSize: '0.74rem', color: C.textMuted }}>Connect and link your wallet first (left).</p>}
                                    </div>
                                ) : (
                                    <div style={{ marginTop: 14, border: `1px solid ${C.border}`, borderRadius: 12, padding: 12, background: C.surfaceAlt }}>
                                        <div style={{ fontSize: '0.74rem', fontWeight: 800, marginBottom: 6 }}>MetaMask will ask you to sign exactly this text:</div>
                                        <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '0.74rem', background: C.surface, borderRadius: 8, padding: 10, border: `1px solid ${C.border}` }}>{pending.message}</pre>
                                        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                                            <button type="button" onClick={() => void signAndSubmit()} disabled={busy === 'sign'} style={btn()}>
                                                {busy === 'sign' ? <Loader2 size={16} style={{ animation: 'spin-slow 1s linear infinite' }} /> : <Wallet size={16} />} Sign in MetaMask
                                            </button>
                                            <button type="button" onClick={() => setPending(null)} style={btn('ghost')}>Cancel</button>
                                        </div>
                                        <p style={{ margin: '8px 0 0', fontSize: '0.7rem', color: C.textMuted }}>Signing is free and sends no transaction. The request expires in 10 minutes.</p>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            </main>
        </div>
    );
}
