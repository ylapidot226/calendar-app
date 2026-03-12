import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import cron from 'node-cron';
import nodemailer from 'nodemailer';
import session from 'express-session';
import bcrypt from 'bcryptjs';
import { HDate } from '@hebcal/core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 3000;
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: 'calendar-app-secret-key-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }
}));

// --- Helpers ---
function loadUsers() {
  if (fs.existsSync(USERS_FILE)) return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  return {};
}
function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}
function getUserDataFile(username) {
  return path.join(DATA_DIR, `calendar-${username}.json`);
}
function loadUserData(username) {
  const f = getUserDataFile(username);
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  return {};
}
function saveUserData(username, data) {
  fs.writeFileSync(getUserDataFile(username), JSON.stringify(data, null, 2));
}
function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'not authenticated' });
  next();
}

const DEFAULT_SETTINGS = {
  primaryCalendar: 'gregorian',
  locationName: 'ירושלים',
  latitude: 31.7683,
  longitude: 35.2137,
  timezone: 'Asia/Jerusalem',
  candleLightingMins: 40,
};

// --- Auth ---
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'missing fields' });
  const users = loadUsers();
  if (users[username]) return res.status(400).json({ error: 'user exists' });
  users[username] = {
    password: bcrypt.hashSync(password, 10),
    settings: { ...DEFAULT_SETTINGS },
  };
  saveUsers(users);
  req.session.user = username;
  res.json({ ok: true, user: username, settings: users[username].settings });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const users = loadUsers();
  if (!users[username] || !bcrypt.compareSync(password, users[username].password)) {
    return res.status(401).json({ error: 'invalid credentials' });
  }
  req.session.user = username;
  res.json({ ok: true, user: username, settings: users[username].settings });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  if (!req.session.user) return res.json({ user: null });
  const users = loadUsers();
  const u = users[req.session.user];
  res.json({ user: req.session.user, settings: u ? u.settings : {} });
});

// --- Settings ---
app.post('/api/settings', requireAuth, (req, res) => {
  const users = loadUsers();
  users[req.session.user].settings = { ...users[req.session.user].settings, ...req.body };
  saveUsers(users);
  res.json({ ok: true, settings: users[req.session.user].settings });
});

// --- Entries ---
app.get('/api/entries', requireAuth, (req, res) => {
  res.json(loadUserData(req.session.user));
});

app.post('/api/entries', requireAuth, (req, res) => {
  const { date, text } = req.body;
  const data = loadUserData(req.session.user);
  if (!text || text.trim() === '') {
    delete data[date];
  } else {
    data[date] = text;
  }
  saveUserData(req.session.user, data);
  res.json({ ok: true });
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
    res.json({ hebrewYear: y, hebrewMonth: m, monthName: firstHd.getMonthName(), days, daysInMonth, isLeapYear: HDate.isLeapYear(y) });
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

// --- Shabbat times via Hebcal Calendar API (all events for the month) ---
app.get('/api/shabbat-times', requireAuth, async (req, res) => {
  const users = loadUsers();
  const s = users[req.session.user].settings;
  const y = parseInt(req.query.year);
  const m = parseInt(req.query.month);

  try {
    const url = `https://www.hebcal.com/hebcal?v=1&cfg=json&year=${y}&month=${m}&c=on&b=${s.candleLightingMins}&M=on&s=on&geo=pos&latitude=${s.latitude}&longitude=${s.longitude}&tzid=${s.timezone}&lg=h`;
    const response = await fetch(url);
    const data = await response.json();

    // Build a map: date -> { candles, havdalah, parasha }
    const dateMap = {};
    for (const item of (data.items || [])) {
      const dateStr = item.date.slice(0, 10);
      if (!dateMap[dateStr]) dateMap[dateStr] = {};

      if (item.category === 'candles') {
        // Extract time from title like "הַדְלָקַת נֵרוֹת: 17:05"
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
    console.error('Hebcal API error:', e.message);
    res.json({});
  }
});

// --- Email config ---
app.post('/api/email-config', requireAuth, (req, res) => {
  const users = loadUsers();
  users[req.session.user].emailConfig = req.body;
  saveUsers(users);
  res.json({ ok: true });
});

// --- Daily email ---
cron.schedule('0 6 * * *', async () => {
  const users = loadUsers();
  const today = new Date();
  const dateKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  for (const [username, user] of Object.entries(users)) {
    if (!user.emailConfig) continue;
    const data = loadUserData(username);
    const todayText = data[dateKey];
    if (!todayText) continue;

    try {
      const config = user.emailConfig;
      const transporter = nodemailer.createTransport({
        host: config.smtp_host,
        port: config.smtp_port,
        secure: config.smtp_port === 465,
        auth: { user: config.smtp_user, pass: config.smtp_pass },
      });

      const hd = new HDate(today);
      const hebrewDate = hd.renderGematriya(true);

      await transporter.sendMail({
        from: config.smtp_user,
        to: config.to_email,
        subject: `לוח שנה - ${dateKey} | ${hebrewDate}`,
        html: `<div dir="rtl" style="font-family:Arial,sans-serif;font-size:16px;">
          <h2>מה יש לך היום</h2>
          <p><strong>${dateKey}</strong> | <strong>${hebrewDate}</strong></p>
          <pre style="font-size:16px;white-space:pre-wrap;">${todayText}</pre>
        </div>`,
      });
      console.log(`Email sent to ${config.to_email} for ${dateKey}`);
    } catch (err) {
      console.error(`Failed email for ${username}:`, err.message);
    }
  }
});

app.listen(PORT, () => {
  console.log(`Calendar app running at http://localhost:${PORT}`);
});
