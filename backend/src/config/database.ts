import { Pool } from 'pg';
import { logger } from '../utils/logger';

// Database connection configuration
const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'ai_news_db',
  user: process.env.DB_USER || 'ai_news_user',
  password: process.env.DB_PASSWORD || 'secure_password_123',
  max: 20, // Maximum number of clients in the pool
  idleTimeoutMillis: 30000, // How long a client is allowed to remain idle
  connectionTimeoutMillis: 2000, // How long to wait when connecting
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
};

// Create connection pool
export const pool = new Pool(dbConfig);

// Test database connection
pool.on('connect', (client) => {
  logger.info('Database client connected', { 
    host: dbConfig.host, 
    database: dbConfig.database 
  });
});

pool.on('error', (err) => {
  logger.error('Database connection error:', err);
  process.exit(-1);
});

// Helper function to execute queries with error handling
export const query = async (text: string, params?: any[]) => {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    logger.debug('Executed query', { text, duration, rows: result.rowCount });
    return result;
  } catch (error) {
    const duration = Date.now() - start;
    logger.error('Query error', { text, duration, error: error.message });
    throw error;
  }
};

// Helper function for transactions
export const withTransaction = async <T>(
  callback: (client: any) => Promise<T>
): Promise<T> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

// Test connection on startup
export const testConnection = async (): Promise<boolean> => {
  try {
    const result = await query('SELECT NOW() as current_time, version() as version');
    logger.info('Database connection successful', {
      time: result.rows[0].current_time,
      version: result.rows[0].version.split(' ')[0]
    });
    return true;
  } catch (error) {
    logger.error('Database connection failed:', error);
    return false;
  }
};