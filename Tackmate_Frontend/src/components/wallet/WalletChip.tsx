import { Link } from 'react-router-dom';
import { Wallet } from 'lucide-react';
import { useWallet } from '../../hooks/useWallet';
import { shortAddress } from '../../lib/wallet';

/** Header chip: connect MetaMask, or show the connected account and open the wallet page. */
export default function WalletChip() {
    const w = useWallet();
    const base: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, borderRadius: 12, padding: '8px 14px', fontFamily: 'inherit', fontWeight: 800, fontSize: '0.78rem', cursor: 'pointer', textDecoration: 'none' };

    if (!w.available) {
        return <Link to="/authority/wallet" style={{ ...base, background: 'rgba(246,133,27,0.12)', color: '#B45309', border: '1px solid rgba(246,133,27,0.4)' }}><Wallet size={14} /> MetaMask</Link>;
    }
    if (!w.account) {
        return (
            <button type="button" onClick={() => void w.connect()} disabled={w.connecting} title={w.error || 'Connect your MetaMask wallet'} style={{ ...base, background: '#F6851B', color: '#fff', border: 'none' }}>
                <Wallet size={14} /> {w.connecting ? 'Connecting…' : 'Connect wallet'}
            </button>
        );
    }
    return (
        <Link to="/authority/wallet" title={`${w.account} · ${w.network}`} style={{ ...base, background: 'rgba(18,179,166,0.12)', color: '#0F766E', border: '1px solid rgba(18,179,166,0.4)' }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#12B3A6' }} /> {shortAddress(w.account)}
        </Link>
    );
}
