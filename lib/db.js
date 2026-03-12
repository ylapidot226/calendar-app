import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);

export default sql;

export async function initDB() {
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(100) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      primary_calendar VARCHAR(20) DEFAULT 'gregorian',
      location_name VARCHAR(100) DEFAULT 'ירושלים',
      latitude DOUBLE PRECISION DEFAULT 31.7683,
      longitude DOUBLE PRECISION DEFAULT 35.2137,
      timezone VARCHAR(50) DEFAULT 'Asia/Jerusalem',
      candle_lighting_mins INTEGER DEFAULT 40,
      to_email VARCHAR(255),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS entries (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      date_key VARCHAR(10) NOT NULL,
      text TEXT NOT NULL,
      UNIQUE(user_id, date_key)
    )
  `;
}
