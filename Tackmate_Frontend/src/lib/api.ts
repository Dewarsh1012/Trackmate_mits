import axios from 'axios';

const rawApiUrl = import.meta.env.VITE_API_URL || '';
const API_URL = rawApiUrl.includes(':5001')
    ? rawApiUrl.replace(':5001', ':5010')
    : (rawApiUrl || 'http://localhost:5010');

const api = axios.create({
    baseURL: `${API_URL}/api/v1`,
    headers: { 'Content-Type': 'application/json' },
});

// Reference data that every page asks for (zones, wards) is cached briefly and shared between
// concurrent callers, so switching sections doesn't re-download it each time.
const CACHEABLE = /^\/(zones|wards)(\?.*)?$/;
const CACHE_TTL_MS = 20_000;
const responseCache = new Map<string, { at: number; response: any }>();
const inflight = new Map<string, Promise<any>>();
const baseAdapter = axios.getAdapter(api.defaults.adapter);

api.defaults.adapter = async (config) => {
    const url = String(config.url || '');
    const isCacheable = (config.method || 'get').toLowerCase() === 'get' && CACHEABLE.test(url);
    if (!isCacheable) {
        // Any write to zones/wards makes the cached copies stale.
        if ((config.method || 'get').toLowerCase() !== 'get' && /^\/(zones|wards)/.test(url)) {
            return baseAdapter(config).finally(() => responseCache.clear());
        }
        return baseAdapter(config);
    }

    const key = `${localStorage.getItem('token') || ''}|${url}`;
    const hit = responseCache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { ...hit.response, config };

    let pending = inflight.get(key);
    if (!pending) {
        pending = baseAdapter(config)
            .then((response) => { responseCache.set(key, { at: Date.now(), response }); return response; })
            .finally(() => inflight.delete(key));
        inflight.set(key, pending);
    }
    return { ...(await pending), config };
};

/** Drops cached reference data (call after a zone is created, edited or deleted). */
export function invalidateApiCache(): void {
    responseCache.clear();
}

api.interceptors.request.use((config) => {
    const token = localStorage.getItem('token');
    if (token) {
        config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
});

api.interceptors.response.use(
    (res) => res,
    (err) => {
        if (err.response?.status === 401) {
            localStorage.removeItem('token');
            localStorage.removeItem('user');
            if (window.location.pathname !== '/auth') {
                window.location.href = '/auth';
            }
        }
        return Promise.reject(err);
    }
);

export default api;
