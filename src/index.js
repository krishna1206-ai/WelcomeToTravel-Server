import { join } from 'node:path';

import { createApp } from './app.js';
import { openDatabase } from './db.js';
import { createMailer } from './email.js';
import { createPushSender } from './push.js';
import { createRazorpay } from './razorpay.js';
import { seedTours } from './seed.js';

const dataDir = process.env.DATA_DIR ?? join(import.meta.dirname, '..', 'data');
const uploadDir = join(dataDir, 'uploads');
const port = Number(process.env.PORT ?? 4100);

const db = openDatabase(join(dataDir, 'app.db'));
const seeded = seedTours(db, uploadDir);
if (seeded) console.log(`Added ${seeded} starter trips.`);

const mailer = createMailer();
const razorpay = createRazorpay();
if (!mailer) console.warn('SMTP_HOST is not set: status emails will not be sent.');
if (!razorpay) console.warn('RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are not set: online payment is off.');

// Matches the website's checkout: a fixed deposit per traveller, and a card fee on the full price.
const bookingTerms = {
  depositPerTraveller: Number(process.env.DEPOSIT_PER_TRAVELLER ?? 200),
  cardFeePercent: Number(process.env.CARD_FEE_PERCENT ?? 1.75),
};

const app = createApp({
  db,
  uploadDir,
  mailer,
  razorpay,
  push: createPushSender(),
  publicUrl: process.env.PUBLIC_URL,
  bookingTerms,
});

const REMINDER_CHECK_MS = 60 * 60 * 1000;

function sendReminders() {
  try {
    app.locals.sendDueReminders();
  } catch (error) {
    console.error('Could not send trip reminders', error);
  }
}

app.listen(port, '0.0.0.0', () => {
  console.log(`Welcome to Travel server running on http://localhost:${port}`);
  sendReminders();
  setInterval(sendReminders, REMINDER_CHECK_MS);
});
