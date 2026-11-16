import { MlModel } from '../models/MlModel';

export type ModelName = 'behaviour_anomaly' | 'safety_risk' | 'sos_genuine' | 'sos_text' | 'zone_forecast_backtest';

export interface StoredModel<T = any> {
    name: ModelName;
    version: string;
    payload: T;
    metrics: Record<string, any>;
    sample_count: number;
    trained_at: string;
}

const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; value: StoredModel | null }>();

/** Latest active trained model, or null when only the built-in prior exists. Cached briefly per instance. */
export async function loadActiveModel<T = any>(name: ModelName): Promise<StoredModel<T> | null> {
    const hit = cache.get(name);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as StoredModel<T> | null;

    let value: StoredModel<T> | null = null;
    try {
        const row: any = await MlModel.findOne({ name, is_active: true }).sort({ trained_at: -1 }).lean();
        if (row) {
            value = {
                name,
                version: row.version,
                payload: row.payload as T,
                metrics: row.metrics || {},
                sample_count: row.sample_count || 0,
                trained_at: new Date(row.trained_at).toISOString(),
            };
        }
    } catch {
        // A DB hiccup must never break scoring: fall back to the prior.
    }
    cache.set(name, { at: Date.now(), value });
    return value;
}

export async function saveModel(name: ModelName, payload: unknown, metrics: Record<string, any>, sampleCount: number): Promise<string> {
    const version = `${name}-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}`;
    await MlModel.updateMany({ name, is_active: true }, { $set: { is_active: false } });
    await MlModel.create({ name, version, payload, metrics, sample_count: sampleCount, is_active: true, trained_at: new Date() });

    // Keep the last five versions for rollback; drop the rest.
    const old: any[] = await MlModel.find({ name }).sort({ trained_at: -1 }).skip(5).select('_id').lean();
    if (old.length) await MlModel.deleteMany({ _id: { $in: old.map((r) => r._id) } });

    cache.delete(name);
    return version;
}

export function invalidateModelCache(name?: ModelName): void {
    if (name) cache.delete(name);
    else cache.clear();
}
