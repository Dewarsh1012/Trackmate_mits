/** Small numeric helpers shared by the ML modules. Pure functions only. */

export const clamp = (v: number, min: number, max: number): number => Math.max(min, Math.min(max, v));

export function sigmoid(x: number): number {
    if (x >= 0) return 1 / (1 + Math.exp(-x));
    const z = Math.exp(x);
    return z / (1 + z);
}

export const round = (v: number, digits = 4): number => {
    const p = 10 ** digits;
    return Math.round(v * p) / p;
};

/** Deterministic PRNG so training runs are reproducible (and testable). */
export function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function mean(xs: number[]): number {
    if (!xs.length) return 0;
    let s = 0;
    for (const x of xs) s += x;
    return s / xs.length;
}

export function std(xs: number[]): number {
    if (xs.length < 2) return 0;
    const m = mean(xs);
    let s = 0;
    for (const x of xs) s += (x - m) ** 2;
    return Math.sqrt(s / (xs.length - 1));
}

export function quantile(xs: number[], q: number): number {
    if (!xs.length) return 0;
    const sorted = [...xs].sort((a, b) => a - b);
    const pos = clamp(q, 0, 1) * (sorted.length - 1);
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export const median = (xs: number[]): number => quantile(xs, 0.5);

/** Median absolute deviation (robust spread). */
export function mad(xs: number[], center = median(xs)): number {
    if (!xs.length) return 0;
    return median(xs.map((x) => Math.abs(x - center)));
}

/** Area under the ROC curve (rank statistic). Returns 0.5 when only one class is present. */
export function auc(scores: number[], labels: Array<0 | 1>): number {
    const pairs = scores.map((s, i) => ({ s, y: labels[i] })).sort((a, b) => a.s - b.s);
    let pos = 0;
    let neg = 0;
    for (const p of pairs) (p.y === 1 ? pos++ : neg++);
    if (pos === 0 || neg === 0) return 0.5;

    // Average ranks across ties.
    let rankSumPos = 0;
    let i = 0;
    while (i < pairs.length) {
        let j = i;
        while (j + 1 < pairs.length && pairs[j + 1].s === pairs[i].s) j++;
        const avgRank = (i + j) / 2 + 1;
        for (let k = i; k <= j; k++) if (pairs[k].y === 1) rankSumPos += avgRank;
        i = j + 1;
    }
    return (rankSumPos - (pos * (pos + 1)) / 2) / (pos * neg);
}

/** Great-circle distance in metres. */
export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371000;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
