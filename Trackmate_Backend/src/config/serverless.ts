import mongoose from 'mongoose';

// Imported before any model is defined. Indexes already exist in Atlas (created by the first
// run / seed), so skip the per-cold-start index build that slows the first request.
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);
