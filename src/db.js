import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    phone TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('customer', 'admin')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tours (
    id TEXT PRIMARY KEY,
    collection TEXT NOT NULL CHECK (collection IN ('city', 'east')),
    title TEXT NOT NULL,
    badge TEXT NOT NULL DEFAULT '',
    subtitle TEXT NOT NULL DEFAULT '',
    duration TEXT NOT NULL DEFAULT '',
    style TEXT NOT NULL DEFAULT '',
    travel TEXT NOT NULL DEFAULT '',
    price INTEGER,
    summary TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    highlights TEXT NOT NULL DEFAULT '[]',
    route TEXT NOT NULL DEFAULT '[]',
    photo TEXT,
    published INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS saved_tours (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tour_id TEXT NOT NULL REFERENCES tours(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, tour_id)
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    tour_id TEXT REFERENCES tours(id) ON DELETE SET NULL,
    tour_title TEXT NOT NULL,
    customer_name TEXT NOT NULL,
    customer_email TEXT NOT NULL,
    customer_phone TEXT NOT NULL DEFAULT '',
    start_date TEXT NOT NULL,
    travellers INTEGER NOT NULL,
    unit_price INTEGER,
    total INTEGER,
    status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'confirmed', 'cancelled')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS itineraries (
    id INTEGER PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    customer_name TEXT NOT NULL,
    customer_email TEXT NOT NULL,
    customer_phone TEXT NOT NULL DEFAULT '',
    start_date TEXT NOT NULL,
    stay TEXT NOT NULL,
    transport TEXT NOT NULL,
    activities TEXT NOT NULL DEFAULT '[]',
    starting_point TEXT,
    status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'confirmed', 'cancelled')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    question TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    read INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sender TEXT NOT NULL CHECK (sender IN ('customer', 'admin')),
    body TEXT NOT NULL,
    read INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS push_tokens (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY,
    tour_id TEXT NOT NULL REFERENCES tours(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    body TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (tour_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS reminders_sent (
    booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    PRIMARY KEY (booking_id, kind)
  );

  CREATE TABLE IF NOT EXISTS password_resets (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
`;

const USER_LOCATION_COLUMNS = ['city', 'state', 'country'];
const TOUR_DETAIL_COLUMNS = ['transport', 'group_size', 'age_range'];

const BOOKING_PAYMENT_COLUMNS = [
  'payment_link_id',
  'payment_link_url',
  'payment_id',
  'paid_at',
  'payment_method',
  'payment_currency',
];

export function openDatabase(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);

  // Databases made before online payment don't have these columns yet.
  const existing = db.prepare('PRAGMA table_info(bookings)').all().map((column) => column.name);
  for (const column of BOOKING_PAYMENT_COLUMNS) {
    if (!existing.includes(column)) db.exec(`ALTER TABLE bookings ADD COLUMN ${column} TEXT`);
  }

  if (!existing.includes('payment_amount')) db.exec('ALTER TABLE bookings ADD COLUMN payment_amount INTEGER');
  const checkoutColumns = {
    payment_plan: "TEXT NOT NULL DEFAULT 'full'",
    fee_cents: 'INTEGER NOT NULL DEFAULT 0',
    deposit_cents: 'INTEGER',
    paid_cents: 'INTEGER NOT NULL DEFAULT 0',
    lead_traveller: "TEXT NOT NULL DEFAULT '{}'",
    billing: "TEXT NOT NULL DEFAULT '{}'",
  };
  for (const [column, type] of Object.entries(checkoutColumns)) {
    if (!existing.includes(column)) db.exec(`ALTER TABLE bookings ADD COLUMN ${column} ${type}`);
  }

  const tourColumns = db.prepare('PRAGMA table_info(tours)').all().map((column) => column.name);
  if (!tourColumns.includes('gallery')) db.exec("ALTER TABLE tours ADD COLUMN gallery TEXT NOT NULL DEFAULT '[]'");
  if (!tourColumns.includes('meeting_point')) db.exec("ALTER TABLE tours ADD COLUMN meeting_point TEXT NOT NULL DEFAULT ''");
  if (!tourColumns.includes('inclusions')) db.exec("ALTER TABLE tours ADD COLUMN inclusions TEXT NOT NULL DEFAULT '[]'");
  for (const column of TOUR_DETAIL_COLUMNS) {
    if (!tourColumns.includes(column)) db.exec(`ALTER TABLE tours ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`);
  }

  const notificationColumns = db.prepare('PRAGMA table_info(notifications)').all().map((column) => column.name);
  if (!notificationColumns.includes('link')) db.exec('ALTER TABLE notifications ADD COLUMN link TEXT');

  const userColumns = db.prepare('PRAGMA table_info(users)').all().map((column) => column.name);
  for (const column of USER_LOCATION_COLUMNS) {
    if (!userColumns.includes(column)) db.exec(`ALTER TABLE users ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`);
  }

  if (!userColumns.includes('photo')) db.exec('ALTER TABLE users ADD COLUMN photo TEXT');

  // Admin messages used to be saved as notifications. They now belong in the customer's chat.
  db.exec(`
    BEGIN;
    INSERT INTO chat_messages (user_id, sender, body, read, created_at)
      SELECT user_id, 'admin', body, read, created_at FROM notifications
      WHERE title LIKE 'Message about %' ORDER BY id;
    DELETE FROM notifications WHERE title LIKE 'Message about %';
    COMMIT;
  `);
  return db;
}
