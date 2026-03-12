import express from 'express';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import { HDate } from '@hebcal/core';
import sql, { initDB } from '../lib/db.js';
import { signToken, setTokenCookie, clearTokenCookie, requireAuth } from '../lib/auth.js';

const app = express();
app.use(express.json());
app.use(cookieParser());

// Initialize DB tables on first cold start
let dbReady = false;
app.use(async (req, res, next) => {
  if (!dbReady) {
    try { await initDB(); dbReady = true; } catch (e) { console.error('DB init error:', e); }
  }
  next();
});

// --- Auth ---
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'missing fields' });
  try {
    const existing = await sql`SELECT id FROM users WHERE username = ${username}`;
    if (existing.length > 0) return res.status(400).json({ error: 'user exists' });

    const password_hash = bcrypt.hashSync(password, 10);
    const rows = await sql`
      INSERT INTO users (username, password_hash)
      VALUES (${username}, ${password_hash})
      RETURNING id, primary_calendar, location_name, latitude, longitude, timezone, candle_lighting_mins
    `;
    const user = rows[0];
    const token = await signToken({ id: user.id, username });
    setTokenCookie(res, token);
    res.json({
      ok: true, user: username,
      settings: {
        primaryCalendar: user.primary_calendar,
        locationName: user.location_name,
        latitude: user.latitude,
        longitude: user.longitude,
        timezone: user.timezone,
        candleLightingMins: user.candle_lighting_mins,
      }
    });
  } catch (e) {
    console.error('Register error:', e);
    res.status(500).json({ error: 'server error' });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const rows = await sql`SELECT * FROM users WHERE username = ${username}`;
    if (rows.length === 0 || !bcrypt.compareSync(password, rows[0].password_hash)) {
      return res.status(401).json({ error: 'invalid credentials' });
    }
    const user = rows[0];
    const token = await signToken({ id: user.id, username });
    setTokenCookie(res, token);
    res.json({
      ok: true, user: username,
      settings: {
        primaryCalendar: user.primary_calendar,
        locationName: user.location_name,
        latitude: user.latitude,
        longitude: user.longitude,
        timezone: user.timezone,
        candleLightingMins: user.candle_lighting_mins,
      }
    });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ error: 'server error' });
  }
});

app.post('/api/logout', (req, res) => {
  clearTokenCookie(res);
  res.json({ ok: true });
});

app.get('/api/me', async (req, res) => {
  const token = req.cookies?.token;
  if (!token) return res.json({ user: null });
  try {
    const { verifyToken } = await import('../lib/auth.js');
    const payload = await verifyToken(token);
    const rows = await sql`SELECT * FROM users WHERE id = ${payload.id}`;
    if (rows.length === 0) return res.json({ user: null });
    const user = rows[0];
    res.json({
      user: user.username,
      settings: {
        primaryCalendar: user.primary_calendar,
        locationName: user.location_name,
        latitude: user.latitude,
        longitude: user.longitude,
        timezone: user.timezone,
        candleLightingMins: user.candle_lighting_mins,
      }
    });
  } catch {
    res.json({ user: null });
  }
});

// --- Settings ---
app.post('/api/settings', requireAuth, async (req, res) => {
  try {
    const { primaryCalendar, locationName, latitude, longitude, timezone, candleLightingMins } = req.body;
    const rows = await sql`
      UPDATE users SET
        primary_calendar = COALESCE(${primaryCalendar ?? null}, primary_calendar),
        location_name = COALESCE(${locationName ?? null}, location_name),
        latitude = COALESCE(${latitude ?? null}, latitude),
        longitude = COALESCE(${longitude ?? null}, longitude),
        timezone = COALESCE(${timezone ?? null}, timezone),
        candle_lighting_mins = COALESCE(${candleLightingMins ?? null}, candle_lighting_mins)
      WHERE id = ${req.user.id}
      RETURNING primary_calendar, location_name, latitude, longitude, timezone, candle_lighting_mins
    `;
    const u = rows[0];
    res.json({
      ok: true,
      settings: {
        primaryCalendar: u.primary_calendar,
        locationName: u.location_name,
        latitude: u.latitude,
        longitude: u.longitude,
        timezone: u.timezone,
        candleLightingMins: u.candle_lighting_mins,
      }
    });
  } catch (e) {
    console.error('Settings error:', e);
    res.status(500).json({ error: 'server error' });
  }
});

// --- Entries ---
app.get('/api/entries', requireAuth, async (req, res) => {
  try {
    const rows = await sql`SELECT date_key, text FROM entries WHERE user_id = ${req.user.id}`;
    const result = {};
    for (const row of rows) result[row.date_key] = row.text;
    res.json(result);
  } catch (e) {
    console.error('Entries error:', e);
    res.status(500).json({ error: 'server error' });
  }
});

app.post('/api/entries', requireAuth, async (req, res) => {
  const { date, text } = req.body;
  try {
    if (!text || text.trim() === '') {
      await sql`DELETE FROM entries WHERE user_id = ${req.user.id} AND date_key = ${date}`;
    } else {
      await sql`
        INSERT INTO entries (user_id, date_key, text)
        VALUES (${req.user.id}, ${date}, ${text})
        ON CONFLICT (user_id, date_key) DO UPDATE SET text = ${text}
      `;
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('Entry save error:', e);
    res.status(500).json({ error: 'server error' });
  }
});

// --- Hebrew calendar ---
app.get('/api/hebrew-month', requireAuth, (req, res) => {
  const y = parseInt(req.query.year);
  const m = parseInt(req.query.month);
  try {
    const daysInMonth = HDate.daysInMonth(m, y);
    const days = [];
    for (let d = 1; d <= daysInMonth; d++) {
      const hd = new HDate(d, m, y);
      const greg = hd.greg();
      const gYear = greg.getFullYear();
      const gMonth = String(greg.getMonth() + 1).padStart(2, '0');
      const gDay = String(greg.getDate()).padStart(2, '0');
      days.push({
        hebrewDay: d,
        hebrewDateStr: hd.renderGematriya(true),
        gregDate: `${gYear}-${gMonth}-${gDay}`,
        gregDay: greg.getDate(),
        gregMonth: greg.getMonth() + 1,
        gregYear: greg.getFullYear(),
        dayOfWeek: greg.getDay(),
      });
    }
    const firstHd = new HDate(1, m, y);
    res.json({
      hebrewYear: y, hebrewMonth: m,
      monthName: firstHd.getMonthName(),
      days, daysInMonth,
      isLeapYear: HDate.isLeapYear(y),
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/greg-to-hebrew', (req, res) => {
  const d = new Date(req.query.date + 'T12:00:00');
  const hd = new HDate(d);
  res.json({
    hebrewDay: hd.getDate(),
    hebrewMonth: hd.getMonth(),
    hebrewYear: hd.getFullYear(),
    hebrewDateStr: hd.renderGematriya(true),
    monthName: hd.getMonthName(),
  });
});

// --- Shabbat times ---
app.get('/api/shabbat-times', requireAuth, async (req, res) => {
  try {
    const rows = await sql`SELECT * FROM users WHERE id = ${req.user.id}`;
    const s = rows[0];
    const y = parseInt(req.query.year);
    const m = parseInt(req.query.month);

    const url = `https://www.hebcal.com/hebcal?v=1&cfg=json&year=${y}&month=${m}&c=on&b=${s.candle_lighting_mins}&M=on&s=on&geo=pos&latitude=${s.latitude}&longitude=${s.longitude}&tzid=${s.timezone}&lg=h`;
    const response = await fetch(url);
    const data = await response.json();

    const dateMap = {};
    for (const item of (data.items || [])) {
      const dateStr = item.date.slice(0, 10);
      if (!dateMap[dateStr]) dateMap[dateStr] = {};
      if (item.category === 'candles') {
        const timeMatch = item.title.match(/(\d{1,2}:\d{2})/);
        dateMap[dateStr].candles = timeMatch ? timeMatch[1] : null;
      } else if (item.category === 'havdalah') {
        const timeMatch = item.title.match(/(\d{1,2}:\d{2})/);
        dateMap[dateStr].havdalah = timeMatch ? timeMatch[1] : null;
      } else if (item.category === 'parashat') {
        dateMap[dateStr].parasha = item.hebrew || item.title;
      }
    }
    res.json(dateMap);
  } catch (e) {
    console.error('Shabbat times error:', e.message);
    res.json({});
  }
});

// --- Email config ---
app.post('/api/email-config', requireAuth, async (req, res) => {
  try {
    await sql`UPDATE users SET to_email = ${req.body.to_email} WHERE id = ${req.user.id}`;
    res.json({ ok: true });
  } catch (e) {
    console.error('Email config error:', e);
    res.status(500).json({ error: 'server error' });
  }
});

export default app;
