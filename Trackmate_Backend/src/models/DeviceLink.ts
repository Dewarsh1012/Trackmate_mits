import mongoose, { Schema } from 'mongoose';

/** Remembers which person a Bluetooth device (band, tracker, phone) belongs to, by its advertised name. */
const deviceLinkSchema = new Schema(
    {
        user: { type: Schema.Types.ObjectId, ref: 'Profile', required: true },
        device_name: { type: String, required: true, trim: true, maxlength: 80 },
        name_key: { type: String, required: true, index: true }, // lower-cased name used for lookups
        linked_by: { type: String, enum: ['self', 'authority'], default: 'self' },
        last_used: { type: Date, default: Date.now },
    },
    { versionKey: false }
);
deviceLinkSchema.index({ user: 1, name_key: 1 }, { unique: true });

export const DeviceLink = mongoose.models.DeviceLink || mongoose.model('DeviceLink', deviceLinkSchema);
