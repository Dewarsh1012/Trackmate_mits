import { useCallback, useEffect, useState } from 'react';
import { chainName, currentChainId, getProvider, hasWallet, requestAccounts } from '../lib/wallet';

/** Connected MetaMask account + network, kept in sync with the wallet's own events. */
export function useWallet() {
    const [account, setAccount] = useState<string | null>(null);
    const [chainId, setChainId] = useState<string | null>(null);
    const [connecting, setConnecting] = useState(false);
    const [error, setError] = useState('');

    // Pick up an account the site was already allowed to see (no pop-up).
    useEffect(() => {
        const provider = getProvider();
        if (!provider) return;
        provider.request({ method: 'eth_accounts' }).then((a: string[]) => { if (a?.[0]) setAccount(a[0]); }).catch(() => undefined);
        void currentChainId().then(setChainId);

        const onAccounts = (accounts: string[]) => setAccount(accounts?.[0] ?? null);
        const onChain = (id: string) => setChainId(id);
        provider.on?.('accountsChanged', onAccounts);
        provider.on?.('chainChanged', onChain);
        return () => {
            provider.removeListener?.('accountsChanged', onAccounts);
            provider.removeListener?.('chainChanged', onChain);
        };
    }, []);

    const connect = useCallback(async () => {
        setError('');
        setConnecting(true);
        try {
            const accounts = await requestAccounts();
            setAccount(accounts[0] ?? null);
            setChainId(await currentChainId());
        } catch (err: any) {
            setError(err?.code === 4001 ? 'You closed the connection request in your wallet.' : err?.message || 'Could not connect to the wallet.');
        } finally {
            setConnecting(false);
        }
    }, []);

    return { available: hasWallet(), account, chainId, network: chainName(chainId), connecting, error, connect };
}
