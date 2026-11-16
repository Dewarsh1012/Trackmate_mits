import dotenv from 'dotenv';

// Load test environment variables
dotenv.config({ path: '.env.test' });

// Set test environment
process.env.NODE_ENV = 'test';
// Never run tests against the real database from .env: opt in explicitly with TEST_MONGODB_URI.
process.env.MONGODB_URI = process.env.TEST_MONGODB_URI || 'mongodb://localhost:27017/trackmate-test';

// Global test timeout
jest.setTimeout(30000);

// Suppress console logs in tests
global.console = {
    ...console,
    error: jest.fn(),
    debug: jest.fn(),
    log: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
};
