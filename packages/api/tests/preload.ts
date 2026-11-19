process.env.REDIS_URL = 'memory:';
process.env.TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgresql://veqsio:veqsio@localhost:5460/veqsio_test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.STORAGE_TYPE = 'mock';
process.env.RATE_LIMIT_USER_MAX = process.env.RATE_LIMIT_USER_MAX || '100000';
