import { randomBytes, randomInt } from 'node:crypto';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import cors from 'cors';
import express from 'express';
import multer from 'multer';

import { DUMMY_HASH, hashPassword, hashToken, newToken, verifyPassword } from './security.js';
import * as check from './validate.js';

const { HttpError } = check;

const DAY_MS = 24 * 60 * 60 * 1000;
const REMEMBER_DAYS = 30;
const SHORT_SESSION_DAYS = 1;
const MAX_FAILED_SIGN_INS = 10;
const SIGN_IN_WINDOW_MS = 15 * 60 * 1000;
const MAX_TRAVELLERS = 12;
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const STATUSES = ['new', 'confirmed', 'cancelled'];
const MAX_CHAT_MESSAGE = 1000;
const CHAT_HISTORY_LIMIT = 200;
const CHAT_NAME = 'Welcome to Travel';
const RESET_CODE_MINUTES = 15;
const RESET_RESEND_MS = 60 * 1000;
const MAX_RESET_ATTEMPTS = 5;
const MAX_REVIEW_LENGTH = 1000;
const MAX_NOTIFICATIONS_DELETED = 100;
const REVIEWS_PER_PAGE = 50;
const WEEK_REMINDER_DAYS = 7;
const TOUR_WITH_RATING = `
  SELECT tours.*,
    (SELECT ROUND(AVG(rating), 1) FROM reviews WHERE reviews.tour_id = tours.id) AS rating,
    (SELECT COUNT(*) FROM reviews WHERE reviews.tour_id = tours.id) AS review_count
  FROM tours`;
const REVIEW_WITH_AUTHOR = `
  SELECT reviews.*, users.name AS user_name, users.photo AS user_photo, tours.title AS tour_title
  FROM reviews
  JOIN users ON users.id = reviews.user_id
  JOIN tours ON tours.id = reviews.tour_id`;

function imageExtension(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buffer.length >= 12 && buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

function publicUser(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    city: row.city,
    state: row.state,
    country: row.country,
    photo: row.photo,
    role: row.role,
  };
}

function location(body) {
  return {
    city: check.text(body?.city, 'City', { max: 100, required: true }),
    state: check.text(body?.state, 'State', { max: 100, required: true }),
    country: check.text(body?.country, 'Country', { max: 100, required: true }),
  };
}

function publicTour(row) {
  return {
    id: row.id,
    collection: row.collection,
    title: row.title,
    badge: row.badge,
    subtitle: row.subtitle,
    duration: row.duration,
    style: row.style,
    travel: row.travel,
    price: row.price,
    summary: row.summary,
    description: row.description,
    highlights: JSON.parse(row.highlights),
    inclusions: check.storedInclusions(row.inclusions),
    route: JSON.parse(row.route),
    photo: row.photo,
    gallery: JSON.parse(row.gallery),
    meetingPoint: row.meeting_point,
    pickupPoints: JSON.parse(row.pickup_points ?? '[]'),
    transport: row.transport,
    groupSize: row.group_size,
    ageRange: row.age_range,
    rating: row.rating ?? null,
    reviewCount: row.review_count ?? 0,
    published: row.published === 1,
  };
}

// Only the first name and an initial are shown, so a review doesn't publish someone's full name.
function publicReview(row) {
  const [first = '', ...rest] = (row.user_name ?? '').trim().split(/\s+/);
  const initial = rest.at(-1)?.charAt(0).toUpperCase();
  return {
    id: row.id,
    tourId: row.tour_id,
    tourTitle: row.tour_title,
    rating: row.rating,
    body: row.body,
    name: initial ? `${first} ${initial}.` : first,
    photo: row.user_photo ?? null,
    createdAt: row.created_at,
  };
}

function localDate(now) {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

function daysUntil(date, now) {
  const [year, month, day] = date.split('-').map(Number);
  const start = new Date(year, month - 1, day);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((start - today) / DAY_MS);
}

function reminderMessage(row, days) {
  const title = days === 0 ? 'Your trip starts today' : days === 1 ? 'Your trip is tomorrow' : `Your trip is in ${days} days`;
  const status = paymentStatus(row);
  const payment =
    status === 'pending'
      ? ' Your payment is still pending.'
      : status === 'deposit'
        ? ` Your balance of ${(dueNowCents(row) / 100).toFixed(2)} is still due.`
        : '';
  return { title, body: `${row.tour_title} starts on ${row.start_date}. Open My Trip to get ready.${payment}` };
}

// Money is kept in cents, because a card fee makes totals like 3037.24.
function grandTotalCents(row) {
  return row.total > 0 ? Math.round(row.total * 100) + (row.fee_cents ?? 0) : 0;
}

// Bookings paid before deposits existed only have a payment ID, and were always paid in full.
function paidCents(row) {
  if (row.paid_cents > 0) return row.paid_cents;
  return row.payment_id ? grandTotalCents(row) : 0;
}

function paymentStatus(row) {
  if (!(row.total > 0)) return 'none';
  const paid = paidCents(row);
  if (paid >= grandTotalCents(row)) return 'paid';
  return paid > 0 ? 'deposit' : 'pending';
}

// The first payment is the deposit when one was chosen. After that, whatever is left.
function dueNowCents(row) {
  const paid = paidCents(row);
  if (paid === 0 && row.payment_plan === 'deposit' && row.deposit_cents > 0) {
    return Math.min(row.deposit_cents, grandTotalCents(row));
  }
  return Math.max(grandTotalCents(row) - paid, 0);
}

function publicBooking(row) {
  const status = paymentStatus(row);
  return {
    id: row.id,
    tourId: row.tour_id,
    tourTitle: row.tour_title,
    date: row.start_date,
    travellers: row.travellers,
    unitPrice: row.unit_price,
    total: row.total,
    status: row.status,
    paymentStatus: status,
    paymentPlan: row.payment_plan ?? 'full',
    pickupPoint: row.pickup_point ?? '',
    feeCents: row.fee_cents ?? 0,
    totalCents: grandTotalCents(row),
    paidCents: paidCents(row),
    dueNowCents: status === 'paid' || status === 'none' ? 0 : dueNowCents(row),
    createdAt: row.created_at,
  };
}

function publicNotification(row) {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    read: row.read === 1,
    link: row.link ?? null,
    createdAt: row.created_at,
  };
}

function publicChatMessage(row) {
  return {
    id: row.id,
    sender: row.sender,
    body: row.body,
    read: row.read === 1,
    createdAt: row.created_at,
  };
}

function bookingStatusMessage(row, status) {
  const trip = `${row.tour_title} starting ${row.start_date}`;
  if (status === 'confirmed') {
    return { title: 'Booking confirmed', body: `Your booking for ${trip} is confirmed.` };
  }
  const refund = row.payment_id ? ' Our team will contact you about your refund.' : '';
  return { title: 'Booking cancelled', body: `Your booking for ${trip} has been cancelled.${refund}` };
}

function itineraryStatusMessage(row, status) {
  const trip = `Your trip request starting ${row.start_date}`;
  return status === 'confirmed'
    ? { title: 'Trip request confirmed', body: `${trip} is confirmed.` }
    : { title: 'Trip request cancelled', body: `${trip} has been cancelled.` };
}

function paymentResultPage(heading, text) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${heading}</title>
<style>
  body { font-family: system-ui, sans-serif; text-align: center; padding: 64px 24px; color: #101a33; }
  h1 { font-size: 24px; margin: 0 0 12px; }
  p { font-size: 16px; line-height: 24px; color: #5b6478; margin: 0; }
</style>
</head>
<body><h1>${heading}</h1><p>${text}</p></body>
</html>`;
}

function publicItinerary(row) {
  return {
    id: row.id,
    date: row.start_date,
    stay: row.stay,
    transport: row.transport,
    activities: JSON.parse(row.activities),
    startingPoint: row.starting_point,
    status: row.status,
    createdAt: row.created_at,
  };
}

function slugify(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'trip';
}

export function createApp({
  db,
  uploadDir,
  mailer = null,
  razorpay = null,
  push = null,
  publicUrl,
  bookingTerms = { depositPerTraveller: 0, cardFeePercent: 0 },
}) {
  mkdirSync(uploadDir, { recursive: true });

  const app = express();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_PHOTO_BYTES, files: 1 },
  });
  const failedSignIns = new Map();
  const bookingsStartingPayment = new Set();

  // Hosts put the server behind their own HTTPS proxy, so links it builds need the visitor's real address.
  app.set('trust proxy', true);
  app.use(cors());
  app.use(express.json({ limit: '200kb' }));
  app.use('/uploads', express.static(uploadDir, { maxAge: '7d', index: false }));

  function createSession(userId, remember) {
    const token = newToken();
    const days = remember ? REMEMBER_DAYS : SHORT_SESSION_DAYS;
    const expiresAt = new Date(Date.now() + days * DAY_MS).toISOString();
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(
      hashToken(token),
      userId,
      expiresAt,
    );
    return token;
  }

  function currentUser(req) {
    const header = req.get('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return null;
    return (
      db
        .prepare(
          `SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id
           WHERE sessions.token_hash = ? AND sessions.expires_at > ?`,
        )
        .get(hashToken(token), new Date().toISOString()) ?? null
    );
  }

  function requireUser(req, res, next) {
    req.user = currentUser(req);
    if (!req.user) throw new HttpError(401, 'Please sign in.');
    next();
  }

  function requireAdmin(req, res, next) {
    req.user = currentUser(req);
    if (!req.user) throw new HttpError(401, 'Please sign in.');
    if (req.user.role !== 'admin') throw new HttpError(403, 'Admin access only.');
    next();
  }

  function removeUnusedPhoto(photo) {
    if (!photo) return;
    const inUse =
      db.prepare('SELECT 1 FROM tours WHERE photo = ? LIMIT 1').get(photo) ??
      db.prepare('SELECT 1 FROM tours WHERE gallery LIKE ? LIMIT 1').get(`%"${photo}"%`) ??
      db.prepare('SELECT 1 FROM users WHERE photo = ? LIMIT 1').get(photo);
    if (inUse) return;
    const file = join(uploadDir, photo.replace('/uploads/', ''));
    if (existsSync(file)) unlinkSync(file);
  }

  // The file type is checked from its contents, and the name is generated here.
  function saveUploadedPhoto(req) {
    if (!req.file) throw new HttpError(400, 'Choose a photo to upload.');
    const extension = imageExtension(req.file.buffer);
    if (!extension) throw new HttpError(400, 'Photo must be a JPG, PNG or WebP image.');
    const name = `${randomBytes(16).toString('hex')}.${extension}`;
    writeFileSync(join(uploadDir, name), req.file.buffer);
    return `/uploads/${name}`;
  }

  // A failed push is only logged: the message is already saved for when the app is next opened.
  function pushToCustomer(userId, message) {
    if (!push) return;
    const tokens = db.prepare('SELECT token FROM push_tokens WHERE user_id = ?').all(userId).map((row) => row.token);
    if (tokens.length === 0) return;
    push
      .send(tokens, message)
      .then((expired) => {
        for (const token of expired) db.prepare('DELETE FROM push_tokens WHERE token = ?').run(token);
      })
      .catch((error) => console.error('Could not send push notification', error));
  }

  // A failed email is only logged: the status change and in-app message have already been saved.
  function notifyCustomer(userId, { title, body, link = null }) {
    const user = userId === null ? undefined : db.prepare('SELECT name, email FROM users WHERE id = ?').get(userId);
    if (!user) return;
    db.prepare('INSERT INTO notifications (user_id, title, body, link) VALUES (?, ?, ?, ?)').run(userId, title, body, link);
    mailer
      ?.send({ to: user.email, subject: title, text: `Hi ${user.name},\n\n${body}\n\nWelcome to Travel` })
      .catch((error) => console.error('Could not send status email', error));
    pushToCustomer(userId, { title, body, data: { url: link ?? '/notifications' } });
  }

  // Safe to run as often as you like: each booking gets each reminder once. A booking confirmed
  // late only gets the reminder that's still relevant.
  function sendDueReminders(now = new Date()) {
    const bookings = db
      .prepare(
        `SELECT * FROM bookings
         WHERE status = 'confirmed' AND user_id IS NOT NULL AND start_date >= ?`,
      )
      .all(localDate(now));
    for (const booking of bookings) {
      const days = daysUntil(booking.start_date, now);
      const kind = days <= 1 ? 'day' : days <= WEEK_REMINDER_DAYS ? 'week' : null;
      if (!kind) continue;
      const { changes } = db
        .prepare('INSERT OR IGNORE INTO reminders_sent (booking_id, kind) VALUES (?, ?)')
        .run(booking.id, kind);
      if (changes === 0) continue;
      notifyCustomer(booking.user_id, { ...reminderMessage(booking, days), link: `/my-trip/${booking.id}` });
    }
  }
  app.locals.sendDueReminders = sendDueReminders;

  // Only someone whose confirmed trip has started can review it, so every review is from a real traveller.
  function canReview(userId, tourId) {
    return Boolean(
      db
        .prepare(
          `SELECT 1 FROM bookings
           WHERE user_id = ? AND tour_id = ? AND status = 'confirmed' AND start_date <= ? LIMIT 1`,
        )
        .get(userId, tourId, localDate(new Date())),
    );
  }

  function resetCodeHash(userId, code) {
    return hashToken(`${userId}:${code}`);
  }

  // Each customer has one conversation with the admins, kept under their account.
  function chatHistory(userId) {
    return db
      .prepare('SELECT * FROM chat_messages WHERE user_id = ? ORDER BY id DESC LIMIT ?')
      .all(userId, CHAT_HISTORY_LIMIT)
      .reverse()
      .map(publicChatMessage);
  }

  function addChatMessage(req, userId, sender) {
    const body = check.text(req.body?.message, 'Message', { max: MAX_CHAT_MESSAGE, required: true });
    const { lastInsertRowid } = db
      .prepare('INSERT INTO chat_messages (user_id, sender, body) VALUES (?, ?, ?)')
      .run(userId, sender, body);
    return publicChatMessage(db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(lastInsertRowid));
  }

  function chatCustomer(req) {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.userId));
    if (!user) throw new HttpError(404, 'Customer not found.');
    return user;
  }

  // Razorpay is asked directly, so a payment only counts once Razorpay reports it as paid.
  // A paid link is then cleared, so a balance gets its own new link. The update only applies while
  // the link is still attached, so two checks at once can't count the same payment twice.
  async function syncPayment(row) {
    if (paymentStatus(row) === 'paid' || !row.payment_link_id || !razorpay) return { row, link: null };
    const link = await razorpay.fetchLink(row.payment_link_id);
    if (link.status !== 'paid') return { row, link };
    const payment = link.payments?.[0];
    const amount = link.amount_paid ?? link.amount ?? dueNowCents(row);
    const alreadyPaid = paidCents(row);
    db.prepare(
      `UPDATE bookings SET payment_id = ?, paid_at = datetime('now'), payment_method = ?, paid_cents = ?,
         payment_amount = ?, payment_currency = ?, payment_link_id = NULL, payment_link_url = NULL
       WHERE id = ? AND payment_link_id = ?`,
    ).run(
      payment?.payment_id ?? link.id,
      payment?.method ?? null,
      alreadyPaid + amount,
      (alreadyPaid + amount) / 100,
      link.currency ?? razorpay.currency ?? null,
      row.id,
      row.payment_link_id,
    );
    return { row: db.prepare('SELECT * FROM bookings WHERE id = ?').get(row.id), link };
  }

  function ownBooking(req) {
    const row = db
      .prepare('SELECT * FROM bookings WHERE id = ? AND user_id = ?')
      .get(Number(req.params.id), req.user.id);
    if (!row) throw new HttpError(404, 'Booking not found.');
    return row;
  }

  app.get('/api/health', (req, res) => res.json({ ok: true }));

  // Accounts

  app.post('/api/auth/signup', async (req, res) => {
    const name = check.text(req.body?.name, 'Name', { max: 100, required: true });
    const email = check.email(req.body?.email);
    const phone = check.phone(req.body?.phone);
    const { city, state, country } = location(req.body);
    const password = check.newPassword(req.body?.password);

    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
      throw new HttpError(409, 'An account with this email already exists. Please sign in.');
    }
    const passwordHash = await hashPassword(password);
    const { lastInsertRowid } = db
      .prepare('INSERT INTO users (name, email, phone, city, state, country, password_hash) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(name, email, phone, city, state, country, passwordHash);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(lastInsertRowid);
    res.status(201).json({ token: createSession(user.id, req.body?.remember !== false), user: publicUser(user) });
  });

  app.post('/api/auth/signin', async (req, res) => {
    const email = check.email(req.body?.email);
    const password = typeof req.body?.password === 'string' ? req.body.password : '';

    const key = `${req.ip}|${email}`;
    const attempts = failedSignIns.get(key);
    if (attempts && Date.now() - attempts.since < SIGN_IN_WINDOW_MS && attempts.count >= MAX_FAILED_SIGN_INS) {
      throw new HttpError(429, 'Too many attempts. Please try again in 15 minutes.');
    }

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    const valid = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !valid) {
      const expired = !attempts || Date.now() - attempts.since >= SIGN_IN_WINDOW_MS;
      failedSignIns.set(key, expired ? { count: 1, since: Date.now() } : { ...attempts, count: attempts.count + 1 });
      throw new HttpError(401, 'Incorrect email or password.');
    }

    failedSignIns.delete(key);
    res.json({ token: createSession(user.id, req.body?.remember !== false), user: publicUser(user) });
  });

  // The reply is the same for every email, so this can't be used to find out who has an account.
  app.post('/api/auth/forgot-password', (req, res) => {
    const email = check.email(req.body?.email);
    if (!mailer) throw new HttpError(503, 'Password reset isn’t available yet. Please contact us for help.');

    const user = db.prepare('SELECT id, name, email FROM users WHERE email = ?').get(email);
    const previous = user && db.prepare('SELECT created_at FROM password_resets WHERE user_id = ?').get(user.id);
    const tooSoon = previous && Date.now() - new Date(previous.created_at).getTime() < RESET_RESEND_MS;
    if (user && !tooSoon) {
      const code = String(randomInt(100000, 1000000));
      const now = Date.now();
      db.prepare(
        `INSERT OR REPLACE INTO password_resets (user_id, code_hash, expires_at, attempts, created_at)
         VALUES (?, ?, ?, 0, ?)`,
      ).run(
        user.id,
        resetCodeHash(user.id, code),
        new Date(now + RESET_CODE_MINUTES * 60 * 1000).toISOString(),
        new Date(now).toISOString(),
      );
      mailer
        .send({
          to: user.email,
          subject: 'Your password reset code',
          text: `Hi ${user.name},\n\nYour code is ${code}. It expires in ${RESET_CODE_MINUTES} minutes.\n\nIf you didn’t ask for this, you can ignore this email.\n\nWelcome to Travel`,
        })
        .catch((error) => console.error('Could not send password reset email', error));
    }
    res.json({ ok: true });
  });

  // Signs out every device, because someone else may have been using the old password.
  app.post('/api/auth/reset-password', async (req, res) => {
    const email = check.email(req.body?.email);
    const code = check.text(req.body?.code, 'Code', { max: 10, required: true });
    const password = check.newPassword(req.body?.newPassword);
    const invalid = new HttpError(400, 'That code is wrong or has expired. Please request a new one.');

    const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    const reset = user && db.prepare('SELECT * FROM password_resets WHERE user_id = ?').get(user.id);
    if (!reset) throw invalid;
    if (reset.expires_at <= new Date().toISOString() || reset.attempts >= MAX_RESET_ATTEMPTS) {
      db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(user.id);
      throw invalid;
    }
    if (reset.code_hash !== resetCodeHash(user.id, code)) {
      db.prepare('UPDATE password_resets SET attempts = attempts + 1 WHERE user_id = ?').run(user.id);
      throw invalid;
    }

    const passwordHash = await hashPassword(password);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, user.id);
    db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    db.prepare('DELETE FROM push_tokens WHERE user_id = ?').run(user.id);
    res.status(204).end();
  });

  app.post('/api/auth/signout', requireUser, (req, res) => {
    const token = req.get('authorization').slice(7);
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
    res.status(204).end();
  });

  app.get('/api/me', requireUser, (req, res) => res.json({ user: publicUser(req.user) }));

  // Open records follow the new details, so the team always sees how to reach the customer.
  app.put('/api/me', requireUser, (req, res) => {
    const name = check.text(req.body?.name, 'Name', { max: 100, required: true });
    const phone = check.phone(req.body?.phone);
    const { city, state, country } = location(req.body);
    db.prepare('UPDATE users SET name = ?, phone = ?, city = ?, state = ?, country = ? WHERE id = ?').run(
      name,
      phone,
      city,
      state,
      country,
      req.user.id,
    );
    db.prepare('UPDATE bookings SET customer_name = ?, customer_phone = ? WHERE user_id = ?').run(name, phone, req.user.id);
    db.prepare('UPDATE itineraries SET customer_name = ?, customer_phone = ? WHERE user_id = ?').run(name, phone, req.user.id);
    res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
  });

  app.post('/api/me/photo', requireUser, upload.single('photo'), (req, res) => {
    const photo = saveUploadedPhoto(req);
    db.prepare('UPDATE users SET photo = ? WHERE id = ?').run(photo, req.user.id);
    removeUnusedPhoto(req.user.photo);
    res.status(201).json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
  });

  app.delete('/api/me/photo', requireUser, (req, res) => {
    db.prepare('UPDATE users SET photo = NULL WHERE id = ?').run(req.user.id);
    removeUnusedPhoto(req.user.photo);
    res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
  });

  // A device belongs to whoever signed in on it last.
  app.post('/api/me/push-token', requireUser, (req, res) => {
    const token = check.text(req.body?.token, 'Push token', { max: 200, required: true });
    if (!/^Expo(nent)?PushToken\[.+\]$/.test(token)) throw new HttpError(400, 'Invalid push token.');
    db.prepare('INSERT OR REPLACE INTO push_tokens (token, user_id) VALUES (?, ?)').run(token, req.user.id);
    res.status(204).end();
  });

  app.delete('/api/me/push-token', requireUser, (req, res) => {
    const token = check.text(req.body?.token, 'Push token', { max: 200, required: true });
    db.prepare('DELETE FROM push_tokens WHERE token = ? AND user_id = ?').run(token, req.user.id);
    res.status(204).end();
  });

  async function requireCurrentPassword(req) {
    const password = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : '';
    if (!(await verifyPassword(password, req.user.password_hash))) {
      throw new HttpError(401, 'Current password is incorrect.');
    }
  }

  app.put('/api/me/email', requireUser, async (req, res) => {
    const email = check.email(req.body?.email);
    await requireCurrentPassword(req);
    const taken = db.prepare('SELECT 1 FROM users WHERE email = ? AND id != ?').get(email, req.user.id);
    if (taken) throw new HttpError(409, 'An account with this email already exists.');
    db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email, req.user.id);
    res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
  });

  // Signs out every other device, in case the password was changed because of a leak.
  app.put('/api/me/password', requireUser, async (req, res) => {
    const password = check.newPassword(req.body?.newPassword);
    await requireCurrentPassword(req);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(password), req.user.id);
    const currentToken = hashToken(req.get('authorization').slice(7));
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(req.user.id, currentToken);
    res.status(204).end();
  });

  // Keeps booking records for the business but removes the person's details from them.
  app.delete('/api/me', requireUser, async (req, res) => {
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!(await verifyPassword(password, req.user.password_hash))) {
      throw new HttpError(401, 'Incorrect password.');
    }
    if (req.user.role === 'admin') {
      const admins = db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'").get().count;
      if (admins <= 1) throw new HttpError(400, 'The last admin account cannot be deleted.');
    }
    db.exec('BEGIN');
    try {
      const id = req.user.id;
      db.prepare(
        `UPDATE bookings SET customer_name = 'Deleted user', customer_email = '', customer_phone = '',
           lead_traveller = '{}', billing = '{}'
         WHERE user_id = ?`,
      ).run(id);
      db.prepare("UPDATE itineraries SET customer_name = 'Deleted user', customer_email = '', customer_phone = '' WHERE user_id = ?").run(id);
      db.prepare('DELETE FROM messages WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM users WHERE id = ?').run(id);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    removeUnusedPhoto(req.user.photo);
    res.status(204).end();
  });

  // Public trips

  app.get('/api/tours', (req, res) => {
    const rows = db.prepare(`${TOUR_WITH_RATING} WHERE published = 1 ORDER BY sort_order, created_at`).all();
    res.json({ tours: rows.map(publicTour) });
  });

  // Reviews

  app.get('/api/reviews/latest', (req, res) => {
    const summary = db
      .prepare(
        `SELECT COUNT(*) AS count, ROUND(AVG(rating), 1) AS average FROM reviews
         JOIN tours ON tours.id = reviews.tour_id WHERE tours.published = 1`,
      )
      .get();
    const rows = db
      .prepare(`${REVIEW_WITH_AUTHOR} WHERE tours.published = 1 AND reviews.body != '' ORDER BY reviews.id DESC LIMIT 5`)
      .all();
    res.json({ count: summary.count, average: summary.average, reviews: rows.map(publicReview) });
  });

  app.get('/api/tours/:id/reviews', (req, res) => {
    const tour = db.prepare('SELECT id FROM tours WHERE id = ? AND published = 1').get(req.params.id);
    if (!tour) throw new HttpError(404, 'Trip not found.');
    const rows = db
      .prepare(`${REVIEW_WITH_AUTHOR} WHERE reviews.tour_id = ? ORDER BY reviews.id DESC LIMIT ?`)
      .all(tour.id, REVIEWS_PER_PAGE);
    const user = currentUser(req);
    const mine = user && db.prepare(`${REVIEW_WITH_AUTHOR} WHERE reviews.tour_id = ? AND reviews.user_id = ?`).get(tour.id, user.id);
    const summary = db
      .prepare('SELECT COUNT(*) AS count, ROUND(AVG(rating), 1) AS average FROM reviews WHERE tour_id = ?')
      .get(tour.id);
    res.json({
      count: summary.count,
      average: summary.average,
      reviews: rows.map(publicReview),
      mine: mine ? publicReview(mine) : null,
      canReview: user ? canReview(user.id, tour.id) : false,
    });
  });

  app.put('/api/tours/:id/reviews/mine', requireUser, (req, res) => {
    const rating = check.rating(req.body?.rating);
    const body = check.text(req.body?.body, 'Review', { max: MAX_REVIEW_LENGTH });
    const tour = db.prepare('SELECT id FROM tours WHERE id = ? AND published = 1').get(req.params.id);
    if (!tour) throw new HttpError(404, 'Trip not found.');
    if (!canReview(req.user.id, tour.id)) {
      throw new HttpError(403, 'You can review this trip once your confirmed trip has started.');
    }
    db.prepare(
      `INSERT INTO reviews (tour_id, user_id, rating, body) VALUES (?, ?, ?, ?)
       ON CONFLICT (tour_id, user_id) DO UPDATE SET rating = excluded.rating, body = excluded.body`,
    ).run(tour.id, req.user.id, rating, body);
    const row = db.prepare(`${REVIEW_WITH_AUTHOR} WHERE reviews.tour_id = ? AND reviews.user_id = ?`).get(tour.id, req.user.id);
    res.json({ review: publicReview(row) });
  });

  app.delete('/api/tours/:id/reviews/mine', requireUser, (req, res) => {
    db.prepare('DELETE FROM reviews WHERE tour_id = ? AND user_id = ?').run(req.params.id, req.user.id);
    res.status(204).end();
  });

  // Customer data

  app.get('/api/me/saved', requireUser, (req, res) => {
    const rows = db.prepare('SELECT tour_id FROM saved_tours WHERE user_id = ?').all(req.user.id);
    res.json({ tourIds: rows.map((row) => row.tour_id) });
  });

  app.put('/api/me/saved/:tourId', requireUser, (req, res) => {
    if (!db.prepare('SELECT 1 FROM tours WHERE id = ?').get(req.params.tourId)) {
      throw new HttpError(404, 'Trip not found.');
    }
    db.prepare('INSERT OR IGNORE INTO saved_tours (user_id, tour_id) VALUES (?, ?)').run(req.user.id, req.params.tourId);
    res.status(204).end();
  });

  app.delete('/api/me/saved/:tourId', requireUser, (req, res) => {
    db.prepare('DELETE FROM saved_tours WHERE user_id = ? AND tour_id = ?').run(req.user.id, req.params.tourId);
    res.status(204).end();
  });

  app.get('/api/me/bookings', requireUser, (req, res) => {
    const rows = db.prepare('SELECT * FROM bookings WHERE user_id = ? ORDER BY id DESC').all(req.user.id);
    res.json({ bookings: rows.map(publicBooking) });
  });

  // The price always comes from the database, never from what the app sends.
  app.post('/api/bookings', requireUser, (req, res) => {
    const tour = db
      .prepare('SELECT * FROM tours WHERE id = ? AND published = 1')
      .get(check.text(req.body?.tourId, 'Trip', { required: true }));
    if (!tour) throw new HttpError(404, 'Trip not found.');

    const date = check.futureDate(req.body?.date);
    const travellers = req.body?.travellers;
    if (!Number.isInteger(travellers) || travellers < 1 || travellers > MAX_TRAVELLERS) {
      throw new HttpError(400, `Travellers must be between 1 and ${MAX_TRAVELLERS}.`);
    }

    const pickupPoints = JSON.parse(tour.pickup_points ?? '[]');
    const pickupPoint = check.text(req.body?.pickupPoint, 'Pick-up point', { max: 200 });
    if (pickupPoints.length > 0 && !pickupPoints.includes(pickupPoint)) {
      throw new HttpError(400, 'Choose one of this trip’s pick-up points.');
    }

    // The checkout form sends these. Older app versions don't, so they stay optional here.
    const traveller = req.body?.traveller === undefined ? null : check.travellerDetails(req.body.traveller, 'Traveller');
    const billing = req.body?.billing === undefined ? null : check.billingDetails(req.body.billing);
    if (traveller && req.body?.agreedToTerms !== true) {
      throw new HttpError(400, 'Please agree to the Terms & Conditions to book.');
    }

    const total = tour.price === null ? null : tour.price * travellers;
    const feeCents = total > 0 ? Math.round(total * 100 * (bookingTerms.cardFeePercent / 100)) : 0;
    const depositCents = bookingTerms.depositPerTraveller * travellers * 100;
    const grandCents = total > 0 ? total * 100 + feeCents : 0;
    const plan = req.body?.plan === 'deposit' && depositCents > 0 && depositCents < grandCents ? 'deposit' : 'full';
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO bookings (user_id, tour_id, tour_title, customer_name, customer_email, customer_phone,
           start_date, travellers, unit_price, total, payment_plan, fee_cents, deposit_cents, lead_traveller, billing,
           pickup_point)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        req.user.id, tour.id, tour.title, req.user.name, req.user.email, req.user.phone, date, travellers,
        tour.price, total, plan, feeCents, plan === 'deposit' ? depositCents : null,
        JSON.stringify(traveller ?? {}), JSON.stringify(billing ?? {}), pickupPoints.length > 0 ? pickupPoint : '',
      );
    const row = db.prepare('SELECT * FROM bookings WHERE id = ?').get(lastInsertRowid);
    res.status(201).json({ booking: publicBooking(row) });
  });

  // What the checkout shows before booking. The server still works out the real amounts itself.
  app.get('/api/booking-terms', (req, res) => {
    res.json({
      currency: razorpay?.currency ?? 'AUD',
      depositPerTraveller: bookingTerms.depositPerTraveller,
      cardFeePercent: bookingTerms.cardFeePercent,
      onlinePaymentOn: Boolean(razorpay),
    });
  });

  app.post('/api/bookings/:id/cancel', requireUser, (req, res) => {
    const result = db
      .prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ? AND user_id = ?")
      .run(Number(req.params.id), req.user.id);
    if (result.changes === 0) throw new HttpError(404, 'Booking not found.');
    res.json({ booking: publicBooking(db.prepare('SELECT * FROM bookings WHERE id = ?').get(Number(req.params.id))) });
  });

  // Paying doesn't change the booking status: it stays a request until an admin decides.
  app.post('/api/bookings/:id/pay', requireUser, async (req, res) => {
    const booking = ownBooking(req);
    if (booking.status === 'cancelled') throw new HttpError(400, 'This booking has been cancelled.');
    if (!(booking.total > 0)) throw new HttpError(400, 'This trip can’t be paid for online.');
    if (paymentStatus(booking) === 'paid') return res.json({ booking: publicBooking(booking), url: null });
    if (!razorpay) throw new HttpError(503, 'Online payment isn’t available yet. Please try again later.');

    // Two links for one booking could both be paid, so only one may be created at a time.
    if (bookingsStartingPayment.has(booking.id)) throw new HttpError(409, 'Payment is already starting.');
    bookingsStartingPayment.add(booking.id);
    try {
      const { row, link } = await syncPayment(booking);
      if (paymentStatus(row) === 'paid') return res.json({ booking: publicBooking(row), url: null });
      if (link?.status === 'created') return res.json({ booking: publicBooking(row), url: row.payment_link_url });

      const stage = paymentStatus(row) === 'deposit' ? ' (balance)' : row.payment_plan === 'deposit' ? ' (deposit)' : '';
      const created = await razorpay.createLink({
        amountCents: dueNowCents(row),
        description: `${row.tour_title} starting ${row.start_date}${stage}`.slice(0, 2048),
        customer: {
          name: row.customer_name,
          email: row.customer_email,
          ...(check.isPhone(row.customer_phone) ? { contact: row.customer_phone } : {}),
        },
        callbackUrl: `${publicUrl ?? `${req.protocol}://${req.get('host')}`}/payments/razorpay/return`,
        bookingId: row.id,
      });
      db.prepare('UPDATE bookings SET payment_link_id = ?, payment_link_url = ? WHERE id = ?').run(
        created.id,
        created.short_url,
        row.id,
      );
      res.json({ booking: publicBooking(row), url: created.short_url });
    } finally {
      bookingsStartingPayment.delete(booking.id);
    }
  });

  app.post('/api/bookings/:id/payment/check', requireUser, async (req, res) => {
    const { row } = await syncPayment(ownBooking(req));
    res.json({ booking: publicBooking(row) });
  });

  // Razorpay sends the customer's browser here after paying. Nothing in the address is trusted.
  app.get('/payments/razorpay/return', async (req, res) => {
    const linkId = typeof req.query.razorpay_payment_link_id === 'string' ? req.query.razorpay_payment_link_id : '';
    const booking = db.prepare('SELECT * FROM bookings WHERE payment_link_id = ?').get(linkId);
    const row = booking ? (await syncPayment(booking).catch(() => ({ row: booking }))).row : null;
    res
      .type('html')
      .send(
        row?.payment_id
          ? paymentResultPage('Payment received', 'Thank you. Please return to the app. Our team will review your booking and confirm it with you.')
          : paymentResultPage('Payment not confirmed yet', 'Please return to the app to check your booking.'),
      );
  });

  app.get('/api/me/notifications', requireUser, (req, res) => {
    const rows = db
      .prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50')
      .all(req.user.id);
    res.json({ notifications: rows.map(publicNotification) });
  });

  app.post('/api/me/notifications/:id/read', requireUser, (req, res) => {
    const result = db
      .prepare('UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?')
      .run(Number(req.params.id), req.user.id);
    if (result.changes === 0) throw new HttpError(404, 'Notification not found.');
    res.status(204).end();
  });

  // Deletes several at once. Only the person's own notifications are touched, whatever IDs are sent.
  app.delete('/api/me/notifications', requireUser, (req, res) => {
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_NOTIFICATIONS_DELETED) {
      throw new HttpError(400, `Choose between 1 and ${MAX_NOTIFICATIONS_DELETED} notifications to delete.`);
    }
    if (!ids.every((id) => Number.isInteger(id) && id > 0)) throw new HttpError(400, 'Invalid notification.');
    const remove = db.prepare('DELETE FROM notifications WHERE id = ? AND user_id = ?');
    let deleted = 0;
    for (const id of new Set(ids)) deleted += remove.run(id, req.user.id).changes;
    res.json({ deleted });
  });

  app.get('/api/me/chat', requireUser, (req, res) => {
    res.json({ messages: chatHistory(req.user.id) });
  });

  app.post('/api/me/chat', requireUser, (req, res) => {
    res.status(201).json({ message: addChatMessage(req, req.user.id, 'customer') });
  });

  app.post('/api/me/chat/read', requireUser, (req, res) => {
    db.prepare("UPDATE chat_messages SET read = 1 WHERE user_id = ? AND sender = 'admin'").run(req.user.id);
    res.status(204).end();
  });

  app.get('/api/me/itineraries', requireUser, (req, res) => {
    const rows = db.prepare('SELECT * FROM itineraries WHERE user_id = ? ORDER BY id DESC').all(req.user.id);
    res.json({ itineraries: rows.map(publicItinerary) });
  });

  app.post('/api/itineraries', requireUser, (req, res) => {
    const date = check.futureDate(req.body?.date);
    const stay = check.text(req.body?.stay, 'Stay', { max: 50, required: true });
    const transport = check.text(req.body?.transport, 'Transport', { max: 50, required: true });
    const activities = check.stringList(req.body?.activities, 'Activities');
    const startingPoint = check.text(req.body?.startingPoint, 'Starting point') || null;
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO itineraries (user_id, customer_name, customer_email, customer_phone, start_date, stay,
           transport, activities, starting_point)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(req.user.id, req.user.name, req.user.email, req.user.phone, date, stay, transport, JSON.stringify(activities), startingPoint);
    const row = db.prepare('SELECT * FROM itineraries WHERE id = ?').get(lastInsertRowid);
    res.status(201).json({ itinerary: publicItinerary(row) });
  });

  app.post('/api/itineraries/:id/cancel', requireUser, (req, res) => {
    const result = db
      .prepare("UPDATE itineraries SET status = 'cancelled' WHERE id = ? AND user_id = ?")
      .run(Number(req.params.id), req.user.id);
    if (result.changes === 0) throw new HttpError(404, 'Request not found.');
    res.json({ itinerary: publicItinerary(db.prepare('SELECT * FROM itineraries WHERE id = ?').get(Number(req.params.id))) });
  });

  // Help form: signing in isn't needed to ask a question.
  app.post('/api/messages', (req, res) => {
    const name = check.text(req.body?.name, 'Name', { max: 100, required: true });
    const email = check.email(req.body?.email);
    const question = check.text(req.body?.question, 'Question', { max: 5000, required: true });
    const user = currentUser(req);
    db.prepare('INSERT INTO messages (user_id, name, email, question) VALUES (?, ?, ?, ?)').run(user?.id ?? null, name, email, question);
    res.status(201).json({ ok: true });
  });

  // Admin

  app.get('/api/admin/tours', requireAdmin, (req, res) => {
    const rows = db.prepare(`${TOUR_WITH_RATING} ORDER BY sort_order, created_at`).all();
    res.json({ tours: rows.map(publicTour) });
  });

  app.get('/api/admin/reviews', requireAdmin, (req, res) => {
    const rows = db.prepare(`${REVIEW_WITH_AUTHOR} ORDER BY reviews.id DESC`).all();
    res.json({ reviews: rows.map((row) => ({ ...publicReview(row), name: row.user_name })) });
  });

  app.delete('/api/admin/reviews/:id', requireAdmin, (req, res) => {
    const result = db.prepare('DELETE FROM reviews WHERE id = ?').run(Number(req.params.id));
    if (result.changes === 0) throw new HttpError(404, 'Review not found.');
    res.status(204).end();
  });

  app.post('/api/admin/tours', requireAdmin, (req, res) => {
    const tour = check.tourInput(req.body);
    const base = slugify(tour.title);
    const id = db.prepare('SELECT 1 FROM tours WHERE id = ?').get(base)
      ? `${base}-${randomBytes(3).toString('hex')}`
      : base;
    const sortOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM tours').get().next;
    db.prepare(
      `INSERT INTO tours (id, collection, title, badge, subtitle, duration, style, travel, price, summary,
         description, highlights, route, photo, gallery, meeting_point, transport, group_size, age_range,
         inclusions, pickup_points, published, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, tour.collection, tour.title, tour.badge, tour.subtitle, tour.duration, tour.style, tour.travel,
      tour.price, tour.summary, tour.description, JSON.stringify(tour.highlights), JSON.stringify(tour.route),
      tour.photo, JSON.stringify(tour.gallery), tour.meetingPoint, tour.transport, tour.groupSize, tour.ageRange,
      JSON.stringify(tour.inclusions), JSON.stringify(tour.pickupPoints), tour.published, sortOrder,
    );
    res.status(201).json({ tour: publicTour(db.prepare('SELECT * FROM tours WHERE id = ?').get(id)) });
  });

  app.put('/api/admin/tours/:id', requireAdmin, (req, res) => {
    const existing = db.prepare('SELECT * FROM tours WHERE id = ?').get(req.params.id);
    if (!existing) throw new HttpError(404, 'Trip not found.');
    const tour = check.tourInput(req.body);
    db.prepare(
      `UPDATE tours SET collection = ?, title = ?, badge = ?, subtitle = ?, duration = ?, style = ?, travel = ?,
         price = ?, summary = ?, description = ?, highlights = ?, route = ?, photo = ?, gallery = ?,
         meeting_point = ?, transport = ?, group_size = ?, age_range = ?, inclusions = ?, pickup_points = ?, published = ?,
         updated_at = datetime('now')
       WHERE id = ?`,
    ).run(
      tour.collection, tour.title, tour.badge, tour.subtitle, tour.duration, tour.style, tour.travel, tour.price,
      tour.summary, tour.description, JSON.stringify(tour.highlights), JSON.stringify(tour.route), tour.photo,
      JSON.stringify(tour.gallery), tour.meetingPoint, tour.transport, tour.groupSize, tour.ageRange,
      JSON.stringify(tour.inclusions), JSON.stringify(tour.pickupPoints), tour.published, req.params.id,
    );
    if (existing.photo !== tour.photo) removeUnusedPhoto(existing.photo);
    for (const photo of JSON.parse(existing.gallery)) {
      if (!tour.gallery.includes(photo)) removeUnusedPhoto(photo);
    }
    res.json({ tour: publicTour(db.prepare('SELECT * FROM tours WHERE id = ?').get(req.params.id)) });
  });

  // Existing bookings keep the price they were made at.
  app.patch('/api/admin/tours/:id/price', requireAdmin, (req, res) => {
    if (req.body?.price === undefined || req.body.price === null) throw new HttpError(400, 'Enter a price.');
    const price = check.tourPrice(req.body.price);
    const result = db
      .prepare("UPDATE tours SET price = ?, updated_at = datetime('now') WHERE id = ?")
      .run(price, req.params.id);
    if (result.changes === 0) throw new HttpError(404, 'Trip not found.');
    res.json({ tour: publicTour(db.prepare('SELECT * FROM tours WHERE id = ?').get(req.params.id)) });
  });

  // Past bookings keep their saved trip title after the trip is deleted.
  app.delete('/api/admin/tours/:id', requireAdmin, (req, res) => {
    const existing = db.prepare('SELECT * FROM tours WHERE id = ?').get(req.params.id);
    if (!existing) throw new HttpError(404, 'Trip not found.');
    db.prepare('DELETE FROM tours WHERE id = ?').run(req.params.id);
    removeUnusedPhoto(existing.photo);
    for (const photo of JSON.parse(existing.gallery)) removeUnusedPhoto(photo);
    res.status(204).end();
  });

  app.post('/api/admin/uploads', requireAdmin, upload.single('photo'), (req, res) => {
    res.status(201).json({ photo: saveUploadedPhoto(req) });
  });

  app.get('/api/admin/bookings', requireAdmin, (req, res) => {
    const rows = db.prepare('SELECT * FROM bookings ORDER BY id DESC').all();
    res.json({
      bookings: rows.map((row) => ({
        ...publicBooking(row),
        userId: row.user_id,
        customerName: row.customer_name,
        customerEmail: row.customer_email,
        customerPhone: row.customer_phone,
        paymentId: row.payment_id,
        traveller: JSON.parse(row.lead_traveller ?? '{}'),
        billing: JSON.parse(row.billing ?? '{}'),
      })),
    });
  });

  function adminPayment(row) {
    return {
      bookingId: row.id,
      tourTitle: row.tour_title,
      customerName: row.customer_name,
      customerEmail: row.customer_email,
      date: row.start_date,
      travellers: row.travellers,
      total: grandTotalCents(row) / 100,
      bookingStatus: row.status,
      paymentStatus: paymentStatus(row),
      paymentPlan: row.payment_plan ?? 'full',
      amountPaid: paidCents(row) > 0 ? paidCents(row) / 100 : null,
      balance: (grandTotalCents(row) - paidCents(row)) / 100,
      currency: row.payment_currency,
      method: row.payment_method,
      paymentId: row.payment_id,
      paymentLinkId: row.payment_link_id,
      paidAt: row.paid_at,
    };
  }

  app.get('/api/admin/payments', requireAdmin, (req, res) => {
    const payments = db
      .prepare('SELECT * FROM bookings WHERE total > 0 ORDER BY id DESC')
      .all()
      .map(adminPayment);
    const sum = (items, pick) => items.reduce((total, item) => total + pick(item), 0);
    const paid = payments.filter((item) => item.amountPaid !== null);
    const round = (value) => Math.round(value * 100) / 100;
    res.json({
      currency: razorpay?.currency ?? null,
      onlinePaymentOn: Boolean(razorpay),
      summary: {
        collected: round(sum(paid.filter((item) => item.bookingStatus !== 'cancelled'), (item) => item.amountPaid)),
        awaiting: round(
          sum(
            payments.filter((item) => item.paymentStatus !== 'paid' && item.bookingStatus !== 'cancelled'),
            (item) => item.balance,
          ),
        ),
        paidThenCancelled: round(
          sum(paid.filter((item) => item.bookingStatus === 'cancelled'), (item) => item.amountPaid),
        ),
      },
      payments,
    });
  });

  // For a customer who paid but closed their browser before coming back.
  app.post('/api/admin/bookings/:id/payment/check', requireAdmin, async (req, res) => {
    const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(Number(req.params.id));
    if (!booking) throw new HttpError(404, 'Booking not found.');
    const { row } = await syncPayment(booking);
    res.json({ payment: adminPayment(row) });
  });

  app.patch('/api/admin/bookings/:id', requireAdmin, (req, res) => {
    if (!STATUSES.includes(req.body?.status)) throw new HttpError(400, 'Invalid status.');
    const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(Number(req.params.id));
    if (!booking) throw new HttpError(404, 'Booking not found.');
    db.prepare('UPDATE bookings SET status = ? WHERE id = ?').run(req.body.status, booking.id);
    if (req.body.status !== 'new' && req.body.status !== booking.status) {
      notifyCustomer(booking.user_id, bookingStatusMessage(booking, req.body.status));
    }
    res.status(204).end();
  });

  app.get('/api/admin/users', requireAdmin, (req, res) => {
    const rows = db
      .prepare(
        `SELECT users.id, users.name, users.email, users.phone, users.city, users.state, users.country,
           users.role, users.created_at,
           (SELECT COUNT(*) FROM bookings WHERE bookings.user_id = users.id) AS booking_count
         FROM users ORDER BY users.id DESC`,
      )
      .all();
    res.json({
      users: rows.map((row) => ({
        id: row.id,
        name: row.name,
        email: row.email,
        phone: row.phone,
        city: row.city,
        state: row.state,
        country: row.country,
        role: row.role,
        createdAt: row.created_at,
        bookingCount: row.booking_count,
      })),
    });
  });

  app.get('/api/admin/itineraries', requireAdmin, (req, res) => {
    const rows = db.prepare('SELECT * FROM itineraries ORDER BY id DESC').all();
    res.json({
      itineraries: rows.map((row) => ({
        ...publicItinerary(row),
        userId: row.user_id,
        customerName: row.customer_name,
        customerEmail: row.customer_email,
        customerPhone: row.customer_phone,
      })),
    });
  });

  app.patch('/api/admin/itineraries/:id', requireAdmin, (req, res) => {
    if (!STATUSES.includes(req.body?.status)) throw new HttpError(400, 'Invalid status.');
    const itinerary = db.prepare('SELECT * FROM itineraries WHERE id = ?').get(Number(req.params.id));
    if (!itinerary) throw new HttpError(404, 'Request not found.');
    db.prepare('UPDATE itineraries SET status = ? WHERE id = ?').run(req.body.status, itinerary.id);
    if (req.body.status !== 'new' && req.body.status !== itinerary.status) {
      notifyCustomer(itinerary.user_id, itineraryStatusMessage(itinerary, req.body.status));
    }
    res.status(204).end();
  });

  app.get('/api/admin/chats', requireAdmin, (req, res) => {
    const rows = db
      .prepare(
        `SELECT users.id, users.name, users.email, last.body AS last_body, last.sender AS last_sender,
           last.created_at AS last_at,
           (SELECT COUNT(*) FROM chat_messages AS unread
            WHERE unread.user_id = users.id AND unread.sender = 'customer' AND unread.read = 0) AS unread
         FROM users
         JOIN chat_messages AS last
           ON last.id = (SELECT MAX(id) FROM chat_messages WHERE user_id = users.id)
         ORDER BY last.id DESC`,
      )
      .all();
    res.json({
      chats: rows.map((row) => ({
        userId: row.id,
        name: row.name,
        email: row.email,
        lastMessage: row.last_body,
        lastSender: row.last_sender,
        lastAt: row.last_at,
        unread: row.unread,
      })),
    });
  });

  app.get('/api/admin/chats/:userId', requireAdmin, (req, res) => {
    const user = chatCustomer(req);
    res.json({
      customer: { id: user.id, name: user.name, email: user.email, phone: user.phone },
      messages: chatHistory(user.id),
    });
  });

  app.post('/api/admin/chats/:userId', requireAdmin, (req, res) => {
    const user = chatCustomer(req);
    const message = addChatMessage(req, user.id, 'admin');
    pushToCustomer(user.id, { title: CHAT_NAME, body: message.body, data: { url: '/chat' } });
    res.status(201).json({ message });
  });

  app.post('/api/admin/chats/:userId/read', requireAdmin, (req, res) => {
    const user = chatCustomer(req);
    db.prepare("UPDATE chat_messages SET read = 1 WHERE user_id = ? AND sender = 'customer'").run(user.id);
    res.status(204).end();
  });

  app.get('/api/admin/messages', requireAdmin, (req, res) => {
    const rows = db.prepare('SELECT * FROM messages ORDER BY id DESC').all();
    res.json({
      messages: rows.map((row) => ({
        id: row.id,
        name: row.name,
        email: row.email,
        question: row.question,
        createdAt: row.created_at,
      })),
    });
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof HttpError) return res.status(error.status).json({ error: error.message });
    if (error instanceof multer.MulterError) {
      const message = error.code === 'LIMIT_FILE_SIZE' ? 'Photo must be 5 MB or smaller.' : 'Could not read the upload.';
      return res.status(400).json({ error: message });
    }
    if (error.type === 'entity.parse.failed' || error.type === 'entity.too.large') {
      return res.status(400).json({ error: 'Invalid request.' });
    }
    console.error(error);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });

  return app;
}
