import mongoose, { Schema } from 'mongoose';

/** One health reading for a user. Any subset of the vitals may be present. */
const healthSampleSchema = new Schema(
    {
        user: { type: Schema.Types.ObjectId, ref: 'Profile', required: true },
        steps: { type: Number, min: 0, max: 200000 }, // running total for the day the sample was taken
        heart_rate: { type: Number, min: 20, max: 250 }, // beats per minute
        spo2: { type: Number, min: 50, max: 100 }, // blood oxygen, percent
        source: { type: String, enum: ['bluetooth', 'health_app', 'manual'], default: 'manual' },
        device_name: { type: String },
        recorded_at: { type: Date, default: Date.now },
    },
    { versionKey: false }
);

healthSampleSchema.index({ user: 1, recorded_at: -1 });
// Keep a rolling 30 days.
healthSampleSchema.index({ recorded_at: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });

export const HealthSample = mongoose.models.HealthSample || mongoose.model('HealthSample', healthSampleSchema);
