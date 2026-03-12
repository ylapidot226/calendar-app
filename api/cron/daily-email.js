import nodemailer from 'nodemailer';
import { HDate } from '@hebcal/core';
import sql from '../../lib/db.js';

export default async function handler(req, res) {
  // Verify Vercel Cron secret
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const today = new Date();
  const dateKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  try {
    const rows = await sql`
      SELECT u.to_email, u.username, e.text
      FROM users u
      JOIN entries e ON e.user_id = u.id
      WHERE e.date_key = ${dateKey} AND u.to_email IS NOT NULL
    `;

    if (rows.length === 0) return res.json({ sent: 0 });

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_PORT === '465',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });

    const hd = new HDate(today);
    const hebrewDate = hd.renderGematriya(true);
    let sent = 0;

    for (const row of rows) {
      try {
        await transporter.sendMail({
          from: process.env.SMTP_USER,
          to: row.to_email,
          subject: `לוח שנה - ${dateKey} | ${hebrewDate}`,
          html: `<div dir="rtl" style="font-family:Arial,sans-serif;font-size:16px;">
            <h2>מה יש לך היום</h2>
            <p><strong>${dateKey}</strong> | <strong>${hebrewDate}</strong></p>
            <pre style="font-size:16px;white-space:pre-wrap;">${row.text}</pre>
          </div>`,
        });
        sent++;
      } catch (err) {
        console.error(`Failed email for ${row.username}:`, err.message);
      }
    }

    res.json({ sent });
  } catch (e) {
    console.error('Cron error:', e);
    res.status(500).json({ error: 'cron failed' });
  }
}
