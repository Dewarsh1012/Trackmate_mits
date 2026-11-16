import mongoose, { Schema } from 'mongoose';

// Event log backing the serverless realtime transport (clients poll it).
// Rows expire after a few minutes; clients only need the recent tail.
const realtimeEventSchema = new Schema(
    {
        rooms: { type: [String], index: true },
        event: { type: String, required: true },
        payload: { type: Schema.Types.Mixed },
        created_at: { type: Date, default: Date.now, expires: 600 },
    },
    { versionKey: false }
);

export const RealtimeEvent = mongoose.models.RealtimeEvent
    || mongoose.model('RealtimeEvent', realtimeEventSchema);

// Per-user presence: previous zone + last persisted location (replaces in-memory
// maps, which don't survive between serverless invocations).
const presenceSchema = new Schema(
    {
        user: { type: String, required: true, unique: true },
        zone: { type: String, default: null },
        proximity_zone: { type: String, default: null },
        last_seen: { type: Date, default: Date.now },
        last_saved: { type: Date },
        offline_notified: { type: Boolean, default: false },
    },
    { versionKey: false }
);

export const Presence = mongoose.models.Presence || mongoose.model('Presence', presenceSchema);
