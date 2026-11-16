import mongoose, { Schema } from 'mongoose';

/** A trained model, stored as JSON so every serverless instance can load the same version. */
const mlModelSchema = new Schema(
    {
        name: { type: String, required: true, index: true },
        version: { type: String, required: true },
        payload: { type: Schema.Types.Mixed, required: true },
        metrics: { type: Schema.Types.Mixed, default: {} },
        sample_count: { type: Number, default: 0 },
        is_active: { type: Boolean, default: true },
        trained_at: { type: Date, default: Date.now },
    },
    { versionKey: false }
);

mlModelSchema.index({ name: 1, trained_at: -1 });

export const MlModel = mongoose.models.MlModel || mongoose.model('MlModel', mlModelSchema);
