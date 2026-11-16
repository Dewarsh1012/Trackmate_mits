import mongoose, { Schema } from 'mongoose';

/**
 * A verifier's MetaMask signature over a person's blockchain ID. Anyone can re-check it with
 * `verifyMessage(message, signature)`: the recovered address must equal `verifier_wallet`.
 */
const walletAttestationSchema = new Schema(
    {
        blockchain_id: { type: String, required: true, index: true },
        subject: { type: Schema.Types.ObjectId, ref: 'Profile', required: true },
        verifier: { type: Schema.Types.ObjectId, ref: 'Profile', required: true },
        verifier_wallet: { type: String, required: true, lowercase: true },
        message: { type: String, required: true },
        signature: { type: String, required: true },
        chain_id: { type: String },
        issued_at: { type: Date, required: true },
    },
    { versionKey: false, timestamps: { createdAt: 'created_at', updatedAt: false } }
);
// One current attestation per verifier wallet and person: re-signing replaces it.
walletAttestationSchema.index({ blockchain_id: 1, verifier_wallet: 1 }, { unique: true });

export const WalletAttestation = mongoose.models.WalletAttestation || mongoose.model('WalletAttestation', walletAttestationSchema);
