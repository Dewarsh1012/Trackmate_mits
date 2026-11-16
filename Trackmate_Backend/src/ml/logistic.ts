import { auc, clamp, mean, sigmoid, std } from './math';

/**
 * Logistic regression with feature standardisation, L2 regularisation, class weighting and
 * prior correction, trained with Adam. Small, dependency-free, and its coefficients can be read
 * directly to explain a prediction.
 */

export interface LogisticModel {
    feature_names: string[];
    weights: number[]; // on standardised features
    bias: number;
    mean: number[];
    scale: number[];
}

export interface Evaluation {
    n: number;
    positives: number;
    auc: number;
    brier: number;
    log_loss: number;
    /** Precision and recall at the threshold that maximises F1. */
    best_threshold: number;
    precision: number;
    recall: number;
    base_rate: number;
}

export interface TrainOptions {
    epochs?: number;
    learningRate?: number;
    l2?: number;
    /**
     * Allowed sign per feature: +1 = effect may only raise the probability, -1 = may only lower it, 0 = free.
     * Encodes domain knowledge (e.g. more silence can never make a tourist safer) so a small, noisy dataset can't flip it.
     */
    signs?: Array<1 | -1 | 0>;
    /** True base rate of the positive class when the training set over-samples positives. Defaults to the sample rate. */
    baseRate?: number;
}

export function predict(model: LogisticModel, x: number[]): number {
    return sigmoid(linearScore(model, x));
}

export function linearScore(model: LogisticModel, x: number[]): number {
    let z = model.bias;
    for (let i = 0; i < model.weights.length; i++) {
        z += model.weights[i] * ((x[i] - model.mean[i]) / model.scale[i]);
    }
    return z;
}

/** Per-feature contribution to the log-odds, relative to a typical (mean) input. Sorted by size. */
export function contributions(model: LogisticModel, x: number[]): Array<{ feature: string; index: number; value: number; contribution: number }> {
    return model.feature_names
        .map((feature, index) => ({
            feature,
            index,
            value: x[index],
            contribution: model.weights[index] * ((x[index] - model.mean[index]) / model.scale[index]),
        }))
        .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
}

/**
 * Conditions that are actually present (feature above zero), ranked by how much they move the prediction.
 * `sign` is the direction of the learned effect. Used to explain a prediction in plain language.
 */
export function presentFactors(model: LogisticModel, x: number[], minStrength = 0.2): Array<{ index: number; strength: number; sign: 1 | -1 }> {
    return model.feature_names
        .map((_, index) => ({ index, strength: Math.abs(model.weights[index]) * (x[index] / model.scale[index]), sign: (model.weights[index] >= 0 ? 1 : -1) as 1 | -1 }))
        .filter((f) => x[f.index] > 0.15 && f.strength >= minStrength)
        .sort((a, b) => b.strength - a.strength);
}

/** Hand-set prior used before enough real data exists. Coefficients are in raw (unstandardised) feature units. */
export function priorModel(featureNames: string[], rawWeights: number[], rawBias: number): LogisticModel {
    return {
        feature_names: featureNames,
        weights: [...rawWeights],
        bias: rawBias,
        mean: featureNames.map(() => 0),
        scale: featureNames.map(() => 1),
    };
}

export function trainLogistic(
    X: number[][],
    y: Array<0 | 1>,
    featureNames: string[],
    options: TrainOptions = {}
): LogisticModel {
    if (!X.length) throw new Error('No training rows.');
    const d = featureNames.length;
    const n = X.length;
    const epochs = options.epochs ?? 500;
    const lr = options.learningRate ?? 0.08;
    const l2 = options.l2 ?? 0.01;

    const mu = Array.from({ length: d }, (_, j) => mean(X.map((row) => row[j])));
    const sd = Array.from({ length: d }, (_, j) => Math.max(std(X.map((row) => row[j])), 1e-6));
    const Z = X.map((row) => row.map((v, j) => (v - mu[j]) / sd[j]));

    const pos = y.reduce((s: number, v) => s + v, 0);
    const neg = n - pos;
    const wPos = pos > 0 ? n / (2 * pos) : 1;
    const wNeg = neg > 0 ? n / (2 * neg) : 1;

    const w = new Array(d).fill(0);
    let b = 0;
    const m = new Array(d + 1).fill(0);
    const v = new Array(d + 1).fill(0);
    const beta1 = 0.9;
    const beta2 = 0.999;

    for (let epoch = 1; epoch <= epochs; epoch++) {
        const grad = new Array(d + 1).fill(0);
        for (let i = 0; i < n; i++) {
            let z = b;
            for (let j = 0; j < d; j++) z += w[j] * Z[i][j];
            const sw = y[i] === 1 ? wPos : wNeg;
            const err = (sigmoid(z) - y[i]) * sw;
            for (let j = 0; j < d; j++) grad[j] += err * Z[i][j];
            grad[d] += err;
        }
        for (let j = 0; j <= d; j++) {
            const g = grad[j] / n + (j < d ? l2 * w[j] : 0);
            m[j] = beta1 * m[j] + (1 - beta1) * g;
            v[j] = beta2 * v[j] + (1 - beta2) * g * g;
            const step = (lr * (m[j] / (1 - beta1 ** epoch))) / (Math.sqrt(v[j] / (1 - beta2 ** epoch)) + 1e-8);
            if (j < d) {
                w[j] -= step;
                const sign = options.signs?.[j];
                if (sign === 1 && w[j] < 0) w[j] = 0;
                else if (sign === -1 && w[j] > 0) w[j] = 0;
            } else b -= step;
        }
    }

    // Class weighting trains for a 50/50 world; shift the intercept back to the real base rate
    // so predicted probabilities mean what they say.
    const rate = clamp(options.baseRate ?? pos / n, 1e-5, 1 - 1e-5);
    b += Math.log(rate / (1 - rate));

    return { feature_names: featureNames, weights: w, bias: b, mean: mu, scale: sd };
}

export function evaluate(model: LogisticModel, X: number[][], y: Array<0 | 1>): Evaluation {
    const p = X.map((row) => predict(model, row));
    const positives = y.reduce((s: number, v) => s + v, 0);
    const n = y.length;
    let brier = 0;
    let logLoss = 0;
    for (let i = 0; i < n; i++) {
        brier += (p[i] - y[i]) ** 2;
        const q = clamp(p[i], 1e-6, 1 - 1e-6);
        logLoss += -(y[i] * Math.log(q) + (1 - y[i]) * Math.log(1 - q));
    }

    // Best-F1 operating point over the observed scores.
    let best = { t: 0.5, f1: -1, precision: 0, recall: 0 };
    const candidates = [...new Set(p)].sort((a, b) => a - b);
    const step = Math.max(1, Math.floor(candidates.length / 200));
    for (let k = 0; k < candidates.length; k += step) {
        const t = candidates[k];
        let tp = 0;
        let fp = 0;
        let fn = 0;
        for (let i = 0; i < n; i++) {
            const pred = p[i] >= t;
            if (pred && y[i] === 1) tp++;
            else if (pred) fp++;
            else if (y[i] === 1) fn++;
        }
        const precision = tp + fp ? tp / (tp + fp) : 0;
        const recall = tp + fn ? tp / (tp + fn) : 0;
        const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
        if (f1 > best.f1) best = { t, f1, precision, recall };
    }

    return {
        n,
        positives,
        auc: auc(p, y),
        brier: brier / n,
        log_loss: logLoss / n,
        best_threshold: best.t,
        precision: best.precision,
        recall: best.recall,
        base_rate: positives / n,
    };
}
