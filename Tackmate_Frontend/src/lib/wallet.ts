/**
 * Thin wrapper over the browser wallet standard (EIP-1193), which MetaMask implements.
 * No wallet library is needed: signing uses personal_sign, and the server verifies with ethers.
 */

export interface Eip1193Provider {
    isMetaMask?: boolean;
    providers?: Eip1193Provider[];
    request(args: { method: string; params?: unknown[] }): Promise<any>;
    on?(event: string, handler: (...args: any[]) => void): void;
    removeListener?(event: string, handler: (...args: any[]) => void): void;
}

/** MetaMask's provider when several wallet extensions are installed, else whichever wallet is present. */
export function getProvider(): Eip1193Provider | null {
    const eth = (window as unknown as { ethereum?: Eip1193Provider }).ethereum;
    if (!eth) return null;
    if (Array.isArray(eth.providers)) return eth.providers.find((p) => p.isMetaMask) ?? eth.providers[0] ?? eth;
    return eth;
}

export const hasWallet = () => getProvider() !== null;

const CHAINS: Record<string, string> = {
    '0x1': 'Ethereum Mainnet', '0xaa36a7': 'Sepolia', '0x89': 'Polygon', '0x13882': 'Polygon Amoy',
    '0xa4b1': 'Arbitrum One', '0xa': 'Optimism', '0x2105': 'Base', '0x38': 'BNB Chain', '0x539': 'Local network',
};
export const chainName = (chainId: string | null) => (chainId ? CHAINS[chainId.toLowerCase()] ?? `Chain ${parseInt(chainId, 16)}` : 'Unknown network');
export const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export async function requestAccounts(): Promise<string[]> {
    const provider = getProvider();
    if (!provider) throw new Error('No wallet found. Install the MetaMask extension or app.');
    return provider.request({ method: 'eth_requestAccounts' });
}

export async function currentChainId(): Promise<string | null> {
    const provider = getProvider();
    if (!provider) return null;
    try { return await provider.request({ method: 'eth_chainId' }); } catch { return null; }
}

const toHex = (text: string) => `0x${Array.from(new TextEncoder().encode(text)).map((b) => b.toString(16).padStart(2, '0')).join('')}`;

/** Asks the wallet to sign `message` (shown in its pop-up as readable text). */
export async function signMessage(address: string, message: string): Promise<string> {
    const provider = getProvider();
    if (!provider) throw new Error('No wallet found.');
    try {
        return await provider.request({ method: 'personal_sign', params: [toHex(message), address] });
    } catch (err: any) {
        if (err?.code === 4001) throw new Error('You rejected the signature request in your wallet.');
        throw new Error(err?.message || 'The wallet could not sign the message.');
    }
}
