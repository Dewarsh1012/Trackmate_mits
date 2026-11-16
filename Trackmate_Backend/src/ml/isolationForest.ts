import { mulberry32, quantile } from './math';

/**
 * Isolation Forest (Liu et al. 2008), unsupervised anomaly detection.
 * It needs no labels: points that are easy to isolate with random splits are anomalous.
 * Trees are plain JSON so a trained forest can be stored in MongoDB and loaded on any serverless instance.
 */

type Leaf = { n: number };
type Split = { f: number; v: number; l: TreeNode; r: TreeNode };
type TreeNode = Leaf | Split;

export interface IsolationForestModel {
    trees: TreeNode[];
    sample_size: number;
    feature_count: number;
    /** Score at the 98.5th percentile of the training data: the default alert threshold. */
    threshold: number;
    /** Median / MAD per feature of the training data, used to explain which feature drove a score. */
    feature_median: number[];
    feature_mad: number[];
}

export interface ForestOptions {
    trees?: number;
    sampleSize?: number;
    seed?: number;
    thresholdQuantile?: number;
}

const EULER = 0.5772156649;

/** Average path length of an unsuccessful BST search: the normaliser c(n) from the paper. */
function c(n: number): number {
    if (n <= 1) return 0;
    if (n === 2) return 1;
    return 2 * (Math.log(n - 1) + EULER) - (2 * (n - 1)) / n;
}

function isSplit(node: TreeNode): node is Split {
    return (node as Split).f !== undefined;
}

function buildTree(rows: number[][], depth: number, maxDepth: number, rand: () => number, featureCount: number): TreeNode {
    if (depth >= maxDepth || rows.length <= 1) return { n: rows.length };

    // Pick a feature that actually varies; give up after a few tries (all rows identical).
    for (let attempt = 0; attempt < featureCount * 2; attempt++) {
        const f = Math.floor(rand() * featureCount);
        let lo = Infinity;
        let hi = -Infinity;
        for (const row of rows) {
            if (row[f] < lo) lo = row[f];
            if (row[f] > hi) hi = row[f];
        }
        if (!(hi > lo)) continue;

        const v = lo + rand() * (hi - lo);
        const left: number[][] = [];
        const right: number[][] = [];
        for (const row of rows) (row[f] < v ? left : right).push(row);
        if (!left.length || !right.length) continue;
        return {
            f,
            v,
            l: buildTree(left, depth + 1, maxDepth, rand, featureCount),
            r: buildTree(right, depth + 1, maxDepth, rand, featureCount),
        };
    }
    return { n: rows.length };
}

function pathLength(node: TreeNode, x: number[], depth: number): number {
    if (!isSplit(node)) return depth + c(node.n);
    return pathLength(x[node.f] < node.v ? node.l : node.r, x, depth + 1);
}

function rawScore(trees: TreeNode[], sampleSize: number, x: number[]): number {
    let total = 0;
    for (const tree of trees) total += pathLength(tree, x, 0);
    const expected = total / trees.length;
    return 2 ** (-expected / c(sampleSize));
}

export function trainIsolationForest(data: number[][], options: ForestOptions = {}): IsolationForestModel {
    if (data.length < 8) throw new Error('Isolation forest needs at least 8 rows.');
    const featureCount = data[0].length;
    const treeCount = options.trees ?? 80;
    const sampleSize = Math.min(options.sampleSize ?? 256, data.length);
    const maxDepth = Math.ceil(Math.log2(sampleSize));
    const rand = mulberry32(options.seed ?? 1337);

    const trees: TreeNode[] = [];
    for (let t = 0; t < treeCount; t++) {
        // Sample without replacement (partial Fisher-Yates on an index array).
        const idx = Array.from({ length: data.length }, (_, i) => i);
        for (let i = 0; i < sampleSize; i++) {
            const j = i + Math.floor(rand() * (idx.length - i));
            [idx[i], idx[j]] = [idx[j], idx[i]];
        }
        trees.push(buildTree(idx.slice(0, sampleSize).map((i) => data[i]), 0, maxDepth, rand, featureCount));
    }

    // Score a bounded subset of the training data to set the alert threshold and feature scales.
    const probe = data.length > 2000 ? data.filter((_, i) => i % Math.ceil(data.length / 2000) === 0) : data;
    const trainScores = probe.map((row) => rawScore(trees, sampleSize, row));
    const columns = Array.from({ length: featureCount }, (_, f) => data.map((row) => row[f]));
    const featureMedian = columns.map((col) => quantile(col, 0.5));
    const featureMad = columns.map((col, f) => quantile(col.map((v) => Math.abs(v - featureMedian[f])), 0.5));

    return {
        trees,
        sample_size: sampleSize,
        feature_count: featureCount,
        threshold: quantile(trainScores, options.thresholdQuantile ?? 0.985),
        feature_median: featureMedian,
        feature_mad: featureMad,
    };
}

/** Anomaly score in (0,1): ~0.5 is typical, above ~0.6 is unusual, near 1 is very unusual. */
export function scoreIsolationForest(model: IsolationForestModel, x: number[]): number {
    return rawScore(model.trees, model.sample_size, x);
}

/** Features ranked by how far they sit from the training median, in robust standard deviations. */
export function explainDeviation(model: IsolationForestModel, x: number[]): Array<{ feature: number; z: number }> {
    return x
        .map((value, feature) => {
            const spread = Math.max(model.feature_mad[feature] * 1.4826, 1e-6);
            return { feature, z: (value - model.feature_median[feature]) / spread };
        })
        .sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
}
