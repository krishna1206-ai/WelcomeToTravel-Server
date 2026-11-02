import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { seedTours } from '../src/seed.js';
import { hashPassword } from '../src/security.js';

let server;
let createdApp;
let base;
let db;
let dir;
let uploadDir;
const sentEmails = [];
const paymentLinks = new Map();
let emailShouldFail = false;

const mailer = {
  async send(email) {
    if (emailShouldFail) throw new Error('mail server down');
    sentEmails.push(email);
  },
};

const razorpay = {
  async createLink(details) {
    const id = `plink_${paymentLinks.size + 1}`;
    const link = { id, short_url: `https://rzp.io/${id}`, status: 'created', amount: details.amountCents, details };
    paymentLinks.set(id, link);
    return link;
  },
  async fetchLink(id) {
    return paymentLinks.get(id);
  },
};

const pushes = [];
const expiredPushTokens = new Set();
const push = {
  async send(tokens, message) {
    pushes.push({ tokens, message });
    return tokens.filter((token) => expiredPushTokens.has(token));
  },
};

const LOCATION = { city: 'Sydney', state: 'NSW', country: 'Australia' };

const JPEG =Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2, 3]);

async function api(path, { method = 'GET', body, token, server = base } = {}) {
  const response = await fetch(server + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null };
}

function uploadPhoto(token, buffer, name = 'photo.jpg') {
  const form = new FormData();
  form.append('photo', new Blob([buffer]), name);
  return fetch(`${base}/api/admin/uploads`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  }).then(async (response) => ({ status: response.status, data: await response.json() }));
}

let counter = 0;
async function signUp(overrides = {}) {
  counter += 1;
  const body = { name: 'Asha', email: `user${counter}@example.com`, phone: '+61400000000', ...LOCATION, password: 'password123', ...overrides };
  return (await api('/api/auth/signup', { method: 'POST', body })).data;
}

async function adminToken() {
  const email = 'admin@example.com';
  if (!db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES ('Admin', ?, ?, 'admin')").run(email, await hashPassword('adminpass123'));
  }
  const { data } = await api('/api/auth/signin', { method: 'POST', body: { email, password: 'adminpass123' } });
  return data.token;
}

const NEW_TOUR = {
  collection: 'east',
  title: 'Test Trip',
  subtitle: 'A → B',
  price: 1000,
  highlights: ['One'],
  route: [{ place: 'A', note: 'Start' }],
};

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wtt-api-'));
  uploadDir = join(dir, 'uploads');
  db = openDatabase(join(dir, 'test.db'));
  seedTours(db, uploadDir);
  await new Promise((resolve) => {
    createdApp = createApp({ db, uploadDir, mailer, razorpay, push });
    server = createdApp.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('starter trips are public and do not come back after being deleted', async () => {
  const { data } = await api('/api/tours');
  assert.equal(data.tours.length, 9);
  assert.equal(data.tours[0].price, 4895);
  assert.equal(seedTours(db, uploadDir), 0);
});

test('sign up stores a hashed password and returns no secrets', async () => {
  const response = await api('/api/auth/signup', {
    method: 'POST',
    body: { name: 'Ravi', email: 'RAVI@Example.com ', password: 'password123', phone: '+61 400 000 123', ...LOCATION },
  });
  assert.equal(response.status, 201);
  assert.equal(response.data.user.email, 'ravi@example.com');
  assert.equal(response.data.user.phone, '+61400000123');
  assert.equal(response.data.user.password_hash, undefined);
  const row = db.prepare('SELECT password_hash FROM users WHERE email = ?').get('ravi@example.com');
  assert.ok(!row.password_hash.includes('password123'));
});

test('sign up rejects bad input and duplicates', async () => {
  const post = (body) => api('/api/auth/signup', { method: 'POST', body: { ...LOCATION, ...body } });
  const phone = '+61400000000';
  assert.equal((await post({ name: '', email: 'a@b.co', phone, password: 'password123' })).status, 400);
  assert.equal((await post({ name: 'A', email: 'nope', phone, password: 'password123' })).status, 400);
  assert.equal((await post({ name: 'A', email: 'short@b.co', phone, password: 'short' })).status, 400);
  await post({ name: 'A', email: 'dup@b.co', phone, password: 'password123' });
  assert.equal((await post({ name: 'B', email: 'DUP@b.co', phone, password: 'password123' })).status, 409);
});

test('sign up requires a valid mobile number', async () => {
  const post = (phone) => api('/api/auth/signup', { method: 'POST', body: { name: 'A', email: 'phone@b.co', phone, ...LOCATION, password: 'password123' } });
  for (const phone of [undefined, '', '   ', '12345', 'not-a-phone', '+1234567890123456']) {
    const response = await post(phone);
    assert.equal(response.status, 400, `accepted ${phone}`);
  }
  assert.equal((await post('(040) 000-0000')).status, 201);
});

test('sign up requires a city, state and country', async () => {
  const post = (overrides) => api('/api/auth/signup', { method: 'POST', body: { name: 'A', email: 'place@b.co', phone: '+61400000000', password: 'password123', ...LOCATION, ...overrides } });
  for (const missing of ['city', 'state', 'country']) {
    assert.equal((await post({ [missing]: '  ' })).status, 400, `accepted a blank ${missing}`);
    assert.equal((await post({ [missing]: undefined })).status, 400, `accepted no ${missing}`);
  }
  const { status, data } = await post({ city: ' Pune ', state: 'Maharashtra', country: 'India' });
  assert.equal(status, 201);
  assert.equal(data.user.city, 'Pune');
  assert.equal(data.user.state, 'Maharashtra');
  assert.equal(data.user.country, 'India');
});

test('customers can edit their details, and open records follow', async () => {
  const admin = await adminToken();
  const { token, user } = await signUp({ name: 'Old Name' });
  const booking = await bookTrip(token);
  const edit = (body, as = token) => api('/api/me', { method: 'PUT', token: as, body });
  const details = { name: 'New Name', phone: '+61 411 111 111', city: 'Perth', state: 'WA', country: 'Australia' };

  assert.equal((await api('/api/me', { method: 'PUT', body: details })).status, 401);
  assert.equal((await edit({ ...details, name: ' ' })).status, 400);
  assert.equal((await edit({ ...details, phone: '12' })).status, 400);
  assert.equal((await edit({ ...details, country: '' })).status, 400);

  const { status, data } = await edit({ ...details, role: 'admin', email: 'stolen@example.com' });
  assert.equal(status, 200);
  assert.equal(data.user.name, 'New Name');
  assert.equal(data.user.phone, '+61411111111');
  assert.equal(data.user.city, 'Perth');
  assert.equal(data.user.role, 'customer');
  assert.equal(data.user.email, user.email);

  const row = (await api('/api/admin/bookings', { token: admin })).data.bookings.find((item) => item.id === booking.id);
  assert.equal(row.customerName, 'New Name');
  assert.equal(row.customerPhone, '+61411111111');
  const person = (await api('/api/admin/users', { token: admin })).data.users.find((item) => item.id === user.id);
  assert.equal(person.city, 'Perth');
  assert.equal(person.country, 'Australia');
});

function latestResetCode() {
  return /code is (\d{6})/.exec(sentEmails.at(-1).text)[1];
}

test('forgot password emails a code that changes the password and signs out everywhere', async () => {
  const { token, user } = await signUp();
  sentEmails.length = 0;
  const forgot = (email) => api('/api/auth/forgot-password', { method: 'POST', body: { email } });
  const reset = (body) => api('/api/auth/reset-password', { method: 'POST', body: { email: user.email, newPassword: 'brand-new-pass', ...body } });

  // Unknown emails get the same answer and no email.
  const unknown = await forgot('nobody@example.com');
  assert.equal(unknown.status, 200);
  assert.equal(sentEmails.length, 0);

  const known = await forgot(user.email);
  assert.deepEqual(known.data, unknown.data);
  assert.equal(sentEmails.length, 1);
  assert.equal(sentEmails[0].to, user.email);
  const code = latestResetCode();

  // A second request straight away doesn't send another or replace the code.
  await forgot(user.email);
  assert.equal(sentEmails.length, 1);

  const stored = db.prepare('SELECT code_hash FROM password_resets WHERE user_id = ?').get(user.id);
  assert.ok(!stored.code_hash.includes(code));

  assert.equal((await reset({ code: '000000' })).status, 400);
  assert.equal((await reset({ code, newPassword: 'short' })).status, 400);
  assert.equal((await reset({ code })).status, 204);

  assert.equal((await api('/api/me', { token })).status, 401);
  const signIn = (password) => api('/api/auth/signin', { method: 'POST', body: { email: user.email, password } });
  assert.equal((await signIn('password123')).status, 401);
  assert.equal((await signIn('brand-new-pass')).status, 200);

  assert.equal((await reset({ code })).status, 400);
});

test('a reset code stops working after too many tries or when it expires', async () => {
  const { user } = await signUp();
  const reset = (code) => api('/api/auth/reset-password', { method: 'POST', body: { email: user.email, code, newPassword: 'brand-new-pass' } });
  const request = async () => {
    db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(user.id);
    await api('/api/auth/forgot-password', { method: 'POST', body: { email: user.email } });
    return latestResetCode();
  };

  let code = await request();
  for (let attempt = 0; attempt < 5; attempt += 1) await reset('000000');
  assert.equal((await reset(code)).status, 400);

  code = await request();
  db.prepare('UPDATE password_resets SET expires_at = ? WHERE user_id = ?').run(new Date(Date.now() - 1000).toISOString(), user.id);
  assert.equal((await reset(code)).status, 400);
});

test('a code for one account does not work on another', async () => {
  const first = await signUp();
  const second = await signUp();
  await api('/api/auth/forgot-password', { method: 'POST', body: { email: first.user.email } });
  const code = latestResetCode();
  await api('/api/auth/forgot-password', { method: 'POST', body: { email: second.user.email } });
  const response = await api('/api/auth/reset-password', { method: 'POST', body: { email: second.user.email, code, newPassword: 'brand-new-pass' } });
  assert.equal(response.status, 400);
});

test('push goes to the customer’s devices for status changes and admin chat messages', async () => {
  const admin = await adminToken();
  const { token, user } = await signUp();
  const other = await signUp();
  const device = 'ExponentPushToken[device-one]';
  const register = (value, as = token) => api('/api/me/push-token', { method: 'POST', token: as, body: { token: value } });

  assert.equal((await api('/api/me/push-token', { method: 'POST', body: { token: device } })).status, 401);
  assert.equal((await register('not-a-token')).status, 400);
  assert.equal((await register(device)).status, 204);
  assert.equal((await register('ExponentPushToken[other]', other.token)).status, 204);
  pushes.length = 0;

  await setBookingStatus(admin, (await bookTrip(token)).id, 'confirmed');
  assert.equal(pushes.length, 1);
  assert.deepEqual(pushes[0].tokens, [device]);
  assert.equal(pushes[0].message.title, 'Booking confirmed');
  assert.deepEqual(pushes[0].message.data, { url: '/notifications' });

  await api(`/api/admin/chats/${user.id}`, { method: 'POST', token: admin, body: { message: 'Hello there' } });
  assert.equal(pushes[1].message.title, 'Welcome to Travel');
  assert.equal(pushes[1].message.body, 'Hello there');
  assert.deepEqual(pushes[1].message.data, { url: '/chat' });

  // The customer's own messages don't push to anyone.
  await api('/api/me/chat', { method: 'POST', token, body: { message: 'Hi' } });
  assert.equal(pushes.length, 2);
});

test('push tokens are removed on sign out, on transfer and when Expo rejects them', async () => {
  const admin = await adminToken();
  const first = await signUp();
  const second = await signUp();
  const tokenFor = (value) => db.prepare('SELECT user_id FROM push_tokens WHERE token = ?').get(value);
  const shared = 'ExponentPushToken[shared]';
  await api('/api/me/push-token', { method: 'POST', token: first.token, body: { token: shared } });
  await api('/api/me/push-token', { method: 'POST', token: second.token, body: { token: shared } });
  assert.equal(tokenFor(shared).user_id, second.user.id);

  // Someone else can't remove it.
  await api('/api/me/push-token', { method: 'DELETE', token: first.token, body: { token: shared } });
  assert.ok(tokenFor(shared));
  await api('/api/me/push-token', { method: 'DELETE', token: second.token, body: { token: shared } });
  assert.equal(tokenFor(shared), undefined);

  const gone = 'ExponentPushToken[gone]';
  await api('/api/me/push-token', { method: 'POST', token: first.token, body: { token: gone } });
  expiredPushTokens.add(gone);
  await api(`/api/admin/chats/${first.user.id}`, { method: 'POST', token: admin, body: { message: 'Hello' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(tokenFor(gone), undefined);
});

test('accounts made before location was added get empty values, once', () => {
  const path = join(dir, 'before-location.db');
  const older = openDatabase(path);
  older.prepare("INSERT INTO users (name, email, password_hash) VALUES ('Old', 'old@example.com', 'x')").run();
  older.close();
  const reopened = openDatabase(path);
  assert.equal(reopened.prepare('SELECT city FROM users').get().city, '');
  reopened.close();
});

test('customers can set, replace and remove their own profile photo', async () => {
  const { token, user } = await signUp();
  const send = (buffer, as = token) => {
    const form = new FormData();
    form.append('photo', new Blob([buffer]), 'me.jpg');
    return fetch(`${base}/api/me/photo`, {
      method: 'POST',
      headers: as ? { Authorization: `Bearer ${as}` } : {},
      body: form,
    }).then(async (response) => ({ status: response.status, data: await response.json() }));
  };
  const fileFor = (photo) => join(uploadDir, photo.replace('/uploads/', ''));

  assert.equal(user.photo, null);
  assert.equal((await send(JPEG, null)).status, 401);
  assert.equal((await send(Buffer.from('<script>not an image</script>'))).status, 400);

  const first = await send(JPEG);
  assert.equal(first.status, 201);
  assert.match(first.data.user.photo, /^\/uploads\/[a-f0-9]+\.jpg$/);
  assert.ok(existsSync(fileFor(first.data.user.photo)));
  assert.equal((await api('/api/me', { token })).data.user.photo, first.data.user.photo);

  const second = await send(JPEG);
  assert.notEqual(second.data.user.photo, first.data.user.photo);
  assert.ok(!existsSync(fileFor(first.data.user.photo)));

  const removed = await api('/api/me/photo', { method: 'DELETE', token });
  assert.equal(removed.data.user.photo, null);
  assert.ok(!existsSync(fileFor(second.data.user.photo)));

  const third = await send(JPEG);
  await api('/api/me', { method: 'DELETE', token, body: { password: 'password123' } });
  assert.ok(!existsSync(fileFor(third.data.user.photo)));
});

test('admin payments show Razorpay details and correct totals', async () => {
  const admin = await adminToken();
  const { token } = await signUp({ name: 'Payment Person' });
  const before = (await api('/api/admin/payments', { token: admin })).data.summary;

  const paid = await bookTrip(token);
  const cancelled = await bookTrip(token);
  const unpaid = await bookTrip(token);
  const markPaid = async (booking, paymentId) => {
    const { data } = await api(`/api/bookings/${booking.id}/pay`, { method: 'POST', token });
    Object.assign(paymentLinks.get(data.url.split('/').pop()), {
      status: 'paid',
      amount_paid: booking.total * 100,
      currency: 'AUD',
      payments: [{ payment_id: paymentId, method: 'upi', status: 'captured' }],
    });
    return data.url.split('/').pop();
  };

  // A customer who never came back: only the admin's check finds the payment.
  const linkId = await markPaid(paid, 'pay_details');
  const notFound = (await api('/api/admin/payments', { token: admin })).data.payments.find((item) => item.bookingId === paid.id);
  assert.equal(notFound.paymentStatus, 'pending');
  assert.equal(notFound.paymentLinkId, linkId);
  const checked = await api(`/api/admin/bookings/${paid.id}/payment/check`, { method: 'POST', token: admin });
  assert.equal(checked.data.payment.paymentStatus, 'paid');

  await markPaid(cancelled, 'pay_cancelled');
  await api(`/api/bookings/${cancelled.id}/payment/check`, { method: 'POST', token });
  await setBookingStatus(admin, cancelled.id, 'cancelled');

  const { data } = await api('/api/admin/payments', { token: admin });
  const row = data.payments.find((item) => item.bookingId === paid.id);
  assert.equal(row.customerName, 'Payment Person');
  assert.equal(row.paymentId, 'pay_details');
  assert.equal(row.method, 'upi');
  assert.equal(row.currency, 'AUD');
  assert.equal(row.amountPaid, paid.total);
  assert.ok(row.paidAt);
  assert.equal(data.payments.find((item) => item.bookingId === unpaid.id).paymentStatus, 'pending');

  assert.equal(data.summary.collected - before.collected, paid.total);
  assert.equal(data.summary.paidThenCancelled - before.paidThenCancelled, cancelled.total);
  assert.equal(data.summary.awaiting - before.awaiting, unpaid.total);

  assert.equal((await api('/api/admin/payments')).status, 401);
  assert.equal((await api('/api/admin/payments', { token })).status, 403);
  assert.equal((await api(`/api/admin/bookings/${paid.id}/payment/check`, { method: 'POST', token })).status, 403);
  assert.equal((await api('/api/admin/bookings/999999/payment/check', { method: 'POST', token: admin })).status, 404);
});

test('an admin can set just a trip’s price, and existing bookings keep theirs', async () => {
  const admin = await adminToken();
  const customer = await signUp();
  const created = await api('/api/admin/tours', { method: 'POST', token: admin, body: { ...NEW_TOUR, title: 'Priced Later', price: 500 } });
  const id = created.data.tour.id;
  const setPrice = (price, token = admin) => api(`/api/admin/tours/${id}/price`, { method: 'PATCH', token, body: { price } });
  const booked = await api('/api/bookings', { method: 'POST', token: customer.token, body: { tourId: id, date: '2099-01-01', travellers: 1 } });

  assert.equal((await setPrice(900, customer.token)).status, 403);
  for (const bad of [null, undefined, -1, 1.5, '900', 10_000_001]) {
    assert.equal((await setPrice(bad)).status, 400, `accepted ${bad}`);
  }
  assert.equal((await api('/api/admin/tours/no-such-trip/price', { method: 'PATCH', token: admin, body: { price: 1 } })).status, 404);

  const { status, data } = await setPrice(900);
  assert.equal(status, 200);
  assert.equal(data.tour.price, 900);
  assert.equal(data.tour.title, 'Priced Later');
  assert.equal(data.tour.subtitle, NEW_TOUR.subtitle);
  assert.deepEqual(data.tour.highlights, NEW_TOUR.highlights);

  assert.equal((await api('/api/tours')).data.tours.find((tour) => tour.id === id).price, 900);
  const mine = (await api('/api/me/bookings', { token: customer.token })).data.bookings.find((item) => item.id === booked.data.booking.id);
  assert.equal(mine.total, 500);
});

function dateFromToday(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

// A trip that has started, which can't be booked through the app.
async function startedTrip(token, tourId = 'east-coast-37', status = 'confirmed') {
  const { data } = await api('/api/bookings', { method: 'POST', token, body: { tourId, date: '2099-01-01', travellers: 1 } });
  db.prepare('UPDATE bookings SET status = ?, start_date = ? WHERE id = ?').run(status, dateFromToday(-1), data.booking.id);
  return data.booking;
}

test('only a traveller whose confirmed trip has started can review it', async () => {
  const guest = await signUp();
  const review = { rating: 5, body: 'Loved it' };
  const put = (token, body = review, tourId = 'welcome-to-sydney') => api(`/api/tours/${tourId}/reviews/mine`, { method: 'PUT', token, body });

  assert.equal((await put(null)).status, 401);
  assert.equal((await put(guest.token)).status, 403);

  // A booking that hasn't started or isn't confirmed doesn't count.
  const { data: upcoming } = await api('/api/bookings', { method: 'POST', token: guest.token, body: { tourId: 'welcome-to-sydney', date: '2099-01-01', travellers: 1 } });
  db.prepare("UPDATE bookings SET status = 'confirmed' WHERE id = ?").run(upcoming.booking.id);
  assert.equal((await put(guest.token)).status, 403);
  const cancelled = await signUp();
  await startedTrip(cancelled.token, 'welcome-to-sydney', 'cancelled');
  assert.equal((await put(cancelled.token)).status, 403);

  const traveller = await signUp({ name: 'Priya Devi Sharma' });
  await startedTrip(traveller.token, 'welcome-to-sydney');
  assert.equal((await put(traveller.token, { rating: 0 })).status, 400);
  assert.equal((await put(traveller.token, { rating: 6 })).status, 400);
  assert.equal((await put(traveller.token, { rating: 4.5 })).status, 400);
  assert.equal((await put(traveller.token, { rating: 5, body: 'x'.repeat(1001) })).status, 400);

  const saved = await put(traveller.token);
  assert.equal(saved.status, 200);
  assert.equal(saved.data.review.name, 'Priya S.');
  assert.ok(!JSON.stringify(saved.data).includes('Sharma'));

  // Reviewing again updates the same review.
  await put(traveller.token, { rating: 3, body: 'Good' });
  let { data } = await api('/api/tours/welcome-to-sydney/reviews', { token: traveller.token });
  assert.equal(data.count, 1);
  assert.equal(data.average, 3);
  assert.equal(data.reviews[0].body, 'Good');
  assert.equal(data.mine.rating, 3);
  assert.equal(data.canReview, true);
  assert.equal((await api('/api/tours/welcome-to-sydney/reviews')).data.canReview, false);

  const tour = (await api('/api/tours')).data.tours.find((item) => item.id === 'welcome-to-sydney');
  assert.equal(tour.rating, 3);
  assert.equal(tour.reviewCount, 1);

  assert.equal((await api('/api/tours/welcome-to-sydney/reviews/mine', { method: 'DELETE', token: traveller.token })).status, 204);
  ({ data } = await api('/api/tours/welcome-to-sydney/reviews'));
  assert.equal(data.count, 0);
  assert.equal(data.average, null);
});

test('admins can see and remove reviews, and the latest list only shows written ones', async () => {
  const admin = await adminToken();
  const { token } = await signUp({ name: 'Solo' });
  await startedTrip(token, 'melbourne-mini-pack');
  await api('/api/tours/melbourne-mini-pack/reviews/mine', { method: 'PUT', token, body: { rating: 4, body: 'Written review' } });
  const second = await signUp({ name: 'Quiet Person' });
  await startedTrip(second.token, 'melbourne-mini-pack');
  await api('/api/tours/melbourne-mini-pack/reviews/mine', { method: 'PUT', token: second.token, body: { rating: 5 } });

  const latest = (await api('/api/reviews/latest')).data;
  assert.ok(latest.count >= 2);
  assert.ok(latest.reviews.some((item) => item.body === 'Written review' && item.name === 'Solo'));
  assert.ok(latest.reviews.every((item) => item.body !== ''));

  assert.equal((await api('/api/admin/reviews', { token })).status, 403);
  const { reviews } = (await api('/api/admin/reviews', { token: admin })).data;
  const found = reviews.find((item) => item.body === 'Written review');
  assert.equal((await api(`/api/admin/reviews/${found.id}`, { method: 'DELETE', token })).status, 403);
  assert.equal((await api(`/api/admin/reviews/${found.id}`, { method: 'DELETE', token: admin })).status, 204);
  assert.equal((await api(`/api/admin/reviews/${found.id}`, { method: 'DELETE', token: admin })).status, 404);

  await api('/api/me', { method: 'DELETE', token: second.token, body: { password: 'password123' } });
  assert.equal((await api('/api/tours/melbourne-mini-pack/reviews')).data.count, 0);
});

test('trip details like transport, group size and age save, update and are public', async () => {
  const admin = await adminToken();
  const details = { transport: ' Coach ', groupSize: '8 - 20 People', ageRange: '18 - 36' };
  const created = await api('/api/admin/tours', { method: 'POST', token: admin, body: { ...NEW_TOUR, title: 'Detailed Trip', ...details } });
  assert.equal(created.status, 201);
  const id = created.data.tour.id;
  assert.equal(created.data.tour.transport, 'Coach');
  assert.equal(created.data.tour.groupSize, '8 - 20 People');
  assert.equal(created.data.tour.ageRange, '18 - 36');

  await api(`/api/admin/tours/${id}`, { method: 'PUT', token: admin, body: { ...NEW_TOUR, title: 'Detailed Trip', ...details, transport: 'Campervan' } });
  const live = (await api('/api/tours')).data.tours.find((tour) => tour.id === id);
  assert.equal(live.transport, 'Campervan');
  assert.equal(live.ageRange, '18 - 36');

  const plain = await api('/api/admin/tours', { method: 'POST', token: admin, body: { ...NEW_TOUR, title: 'Plain Trip' } });
  assert.equal(plain.data.tour.groupSize, '');
  const none = { experiences: [], accommodation: [], included: [], addOns: [], transport: [], meals: [] };
  assert.deepEqual(plain.data.tour.inclusions, none);

  const included = {
    ...NEW_TOUR,
    title: 'Included Trip',
    inclusions: { experiences: [' Reef snorkel ', 'Scenic flight'], transport: ['Coach'], unknownGroup: ['ignored'] },
  };
  const withList = await api('/api/admin/tours', { method: 'POST', token: admin, body: included });
  assert.deepEqual(withList.data.tour.inclusions, { ...none, experiences: ['Reef snorkel', 'Scenic flight'], transport: ['Coach'] });
  await api(`/api/admin/tours/${withList.data.tour.id}`, { method: 'PUT', token: admin, body: { ...included, inclusions: { meals: ['Breakfast'] } } });
  const updated = (await api('/api/tours')).data.tours.find((tour) => tour.id === withList.data.tour.id);
  assert.deepEqual(updated.inclusions, { ...none, meals: ['Breakfast'] });

  const bad = (inclusions) => api('/api/admin/tours', { method: 'POST', token: admin, body: { ...NEW_TOUR, inclusions } });
  assert.equal((await bad('nope')).status, 400);
  assert.equal((await bad(['a flat list'])).status, 400);
  assert.equal((await bad({ meals: [''] })).status, 400);
  assert.equal((await bad({ meals: 'Breakfast' })).status, 400);

  // A trip saved with the earlier single list still loads, as "Included".
  db.prepare('UPDATE tours SET inclusions = ? WHERE id = ?').run(JSON.stringify(['Old item']), withList.data.tour.id);
  const old = (await api('/api/tours')).data.tours.find((tour) => tour.id === withList.data.tour.id);
  assert.deepEqual(old.inclusions, { ...none, included: ['Old item'] });
  assert.equal((await api('/api/admin/tours', { method: 'POST', token: admin, body: { ...NEW_TOUR, transport: 'x'.repeat(51) } })).status, 400);
});

test('trip galleries and meeting points save, and removed photos are deleted', async () => {
  const admin = await adminToken();
  const upload = async () => (await uploadPhoto(admin, JPEG)).data.photo;
  const fileFor = (photo) => join(uploadDir, photo.replace('/uploads/', ''));
  const [one, two, shared] = [await upload(), await upload(), await upload()];
  const body = { ...NEW_TOUR, title: 'Gallery Trip', gallery: [one, two, shared], meetingPoint: ' Central Station, 8am ' };

  const created = await api('/api/admin/tours', { method: 'POST', token: admin, body });
  assert.equal(created.status, 201);
  const id = created.data.tour.id;
  assert.deepEqual(created.data.tour.gallery, [one, two, shared]);
  assert.equal(created.data.tour.meetingPoint, 'Central Station, 8am');

  const bad = (gallery) => api('/api/admin/tours', { method: 'POST', token: admin, body: { ...NEW_TOUR, gallery } });
  assert.equal((await bad(['https://example.com/x.jpg'])).status, 400);
  assert.equal((await bad(['/uploads/../secret'])).status, 400);
  assert.equal((await bad(Array(13).fill(one))).status, 400);
  assert.equal((await bad('nope')).status, 400);

  // A photo also used by another trip must survive being removed from this one.
  await api('/api/admin/tours', { method: 'POST', token: admin, body: { ...NEW_TOUR, title: 'Other Gallery', gallery: [shared] } });
  await api(`/api/admin/tours/${id}`, { method: 'PUT', token: admin, body: { ...body, gallery: [two] } });
  assert.ok(!existsSync(fileFor(one)));
  assert.ok(existsSync(fileFor(two)));
  assert.ok(existsSync(fileFor(shared)));

  await api(`/api/admin/tours/${id}`, { method: 'DELETE', token: admin });
  assert.ok(!existsSync(fileFor(two)));
  assert.ok(existsSync(fileFor(shared)));
});

test('confirmed trips get one reminder a week before and one the day before', async () => {
  const send = (now) => server.listening && createdApp.locals.sendDueReminders(now);
  const { token } = await signUp();
  const admin = await adminToken();
  const booking = await bookTrip(token);
  const titles = async () => (await api('/api/me/notifications', { token })).data.notifications.map((item) => item.title);
  db.prepare('UPDATE bookings SET start_date = ? WHERE id = ?').run('2099-06-20', booking.id);
  sentEmails.length = 0;

  // Still a request: no reminder, even inside the window.
  send(new Date(2099, 5, 15));
  assert.deepEqual(await titles(), []);

  await setBookingStatus(admin, booking.id, 'confirmed');
  const confirmedOnly = (await titles()).length;

  send(new Date(2099, 4, 1));
  assert.equal((await titles()).length, confirmedOnly);

  send(new Date(2099, 5, 13));
  let list = await titles();
  assert.equal(list[0], 'Your trip is in 7 days');
  const notes = (await api('/api/me/notifications', { token })).data.notifications;
  assert.equal(notes[0].link, `/my-trip/${booking.id}`);
  assert.ok(notes[0].body.includes('payment is still pending'));
  assert.ok(sentEmails.some((email) => email.subject === 'Your trip is in 7 days'));

  // Running again the same week sends nothing new.
  const count = list.length;
  send(new Date(2099, 5, 13));
  send(new Date(2099, 5, 16));
  assert.equal((await titles()).length, count);

  send(new Date(2099, 5, 19));
  list = await titles();
  assert.equal(list[0], 'Your trip is tomorrow');
  send(new Date(2099, 5, 20));
  assert.equal((await titles()).length, list.length);

  // After it has started, nothing more is sent.
  send(new Date(2099, 5, 21));
  assert.equal((await titles()).length, list.length);
});

test('a cancelled trip gets no reminders, and a late confirmation only gets the relevant one', async () => {
  const send = (now) => createdApp.locals.sendDueReminders(now);
  const admin = await adminToken();
  const { token } = await signUp();
  const titles = async () => (await api('/api/me/notifications', { token })).data.notifications.map((item) => item.title);

  const cancelled = await bookTrip(token);
  db.prepare('UPDATE bookings SET start_date = ? WHERE id = ?').run('2098-03-10', cancelled.id);
  await setBookingStatus(admin, cancelled.id, 'cancelled');
  send(new Date(2098, 2, 9));
  assert.ok(!(await titles()).some((title) => title.startsWith('Your trip')));

  const late = await bookTrip(token);
  db.prepare('UPDATE bookings SET start_date = ? WHERE id = ?').run('2098-04-10', late.id);
  await setBookingStatus(admin, late.id, 'confirmed');
  send(new Date(2098, 3, 10));
  const list = (await titles()).filter((title) => title.startsWith('Your trip'));
  assert.deepEqual(list, ['Your trip starts today']);
});

// A second server sharing the same database, set up like the real one with a deposit and card fee.
async function withCheckoutServer(run) {
  const checkoutApp = createApp({ db, uploadDir, mailer, razorpay, push, bookingTerms: { depositPerTraveller: 200, cardFeePercent: 1.75 } });
  const checkoutServer = await new Promise((resolve) => {
    const started = checkoutApp.listen(0, '127.0.0.1', () => resolve(started));
  });
  try {
    await run(`http://127.0.0.1:${checkoutServer.address().port}`);
  } finally {
    await new Promise((resolve) => checkoutServer.close(resolve));
  }
}

const TRAVELLER = {
  firstName: 'Asha',
  lastName: 'Rao',
  mobile: '+61400000000',
  email: 'asha@example.com',
  dateOfBirth: '1999-04-12',
  country: 'India',
  gender: 'Woman',
  health: 'N/A',
  dietary: 'Vegetarian',
  previousTour: 'None',
};
const BILLING = { ...TRAVELLER, specialRequirements: '', travellingWith: 'N/A', visa: 'Working holiday' };

function payLink(url) {
  return paymentLinks.get(url.split('/').pop());
}

function markLinkPaid(link, paymentId) {
  Object.assign(link, { status: 'paid', amount_paid: link.amount, payments: [{ payment_id: paymentId, method: 'card' }] });
}

test('checkout takes a deposit first, then the balance, with the card fee on the full price', async () => {
  await withCheckoutServer(async (server) => {
    const { token } = await signUp();
    const terms = await api('/api/booking-terms', { server });
    assert.equal(terms.data.depositPerTraveller, 200);
    assert.equal(terms.data.cardFeePercent, 1.75);

    const created = await api('/api/bookings', {
      method: 'POST',
      token,
      server,
      body: { tourId: 'east-coast-30', date: '2099-01-01', travellers: 1, plan: 'deposit', traveller: TRAVELLER, billing: BILLING, agreedToTerms: true },
    });
    assert.equal(created.status, 201);
    const booking = created.data.booking;
    // 4895 + 1.75% = 4980.66
    assert.equal(booking.feeCents, 8566);
    assert.equal(booking.totalCents, 498066);
    assert.equal(booking.paymentPlan, 'deposit');
    assert.equal(booking.dueNowCents, 20000);

    const pay = () => api(`/api/bookings/${booking.id}/pay`, { method: 'POST', token, server });
    const check = () => api(`/api/bookings/${booking.id}/payment/check`, { method: 'POST', token, server });

    const deposit = payLink((await pay()).data.url);
    assert.equal(deposit.details.amountCents, 20000);
    assert.ok(deposit.details.description.includes('(deposit)'));
    markLinkPaid(deposit, 'pay_deposit');
    let after = (await check()).data.booking;
    assert.equal(after.paymentStatus, 'deposit');
    assert.equal(after.paidCents, 20000);
    assert.equal(after.dueNowCents, 478066);

    // Checking again can't count the same payment twice.
    after = (await check()).data.booking;
    assert.equal(after.paidCents, 20000);

    const balance = payLink((await pay()).data.url);
    assert.notEqual(balance.id, deposit.id);
    assert.equal(balance.details.amountCents, 478066);
    assert.ok(balance.details.description.includes('(balance)'));
    markLinkPaid(balance, 'pay_balance');
    after = (await check()).data.booking;
    assert.equal(after.paymentStatus, 'paid');
    assert.equal(after.paidCents, 498066);
    assert.equal(after.dueNowCents, 0);
    assert.equal((await pay()).data.url, null);

    const admin = await adminToken();
    const row = (await api('/api/admin/payments', { token: admin, server })).data.payments.find((item) => item.bookingId === booking.id);
    assert.equal(row.total, 4980.66);
    assert.equal(row.amountPaid, 4980.66);
    assert.equal(row.balance, 0);
    const adminBooking = (await api('/api/admin/bookings', { token: admin, server })).data.bookings.find((item) => item.id === booking.id);
    assert.equal(adminBooking.traveller.firstName, 'Asha');
    assert.equal(adminBooking.billing.visa, 'Working holiday');
  });
});

test('paying in full charges the whole amount at once, and tiny totals skip the deposit', async () => {
  await withCheckoutServer(async (server) => {
    const { token } = await signUp();
    const book = (tourId, plan, travellers = 2) =>
      api('/api/bookings', { method: 'POST', token, server, body: { tourId, date: '2099-01-01', travellers, plan, traveller: TRAVELLER, billing: BILLING, agreedToTerms: true } });

    const full = (await book('east-coast-30', 'full')).data.booking;
    assert.equal(full.totalCents, 979000 + Math.round(979000 * 0.0175));
    assert.equal(full.dueNowCents, full.totalCents);
    assert.equal(payLink((await api(`/api/bookings/${full.id}/pay`, { method: 'POST', token, server })).data.url).details.amountCents, full.totalCents);

    // The deposit is per traveller.
    assert.equal((await book('east-coast-30', 'deposit')).data.booking.dueNowCents, 40000);

    // A deposit bigger than the trip makes no sense, so it is paid in full.
    const admin = await adminToken();
    const cheap = await api('/api/admin/tours', { method: 'POST', token: admin, body: { ...NEW_TOUR, title: 'Cheap Trip', price: 150 } });
    const small = (await book(cheap.data.tour.id, 'deposit', 1)).data.booking;
    assert.equal(small.paymentPlan, 'full');
    assert.equal(small.dueNowCents, small.totalCents);
  });
});

test('checkout requires the traveller details and agreeing to the terms', async () => {
  await withCheckoutServer(async (server) => {
    const { token } = await signUp();
    const post = (body) => api('/api/bookings', { method: 'POST', token, server, body: { tourId: 'east-coast-30', date: '2099-01-01', travellers: 1, traveller: TRAVELLER, billing: BILLING, agreedToTerms: true, ...body } });

    assert.equal((await post({ agreedToTerms: false })).status, 400);
    assert.equal((await post({ agreedToTerms: undefined })).status, 400);
    assert.equal((await post({ traveller: { ...TRAVELLER, firstName: ' ' } })).status, 400);
    assert.equal((await post({ traveller: { ...TRAVELLER, email: 'nope' } })).status, 400);
    assert.equal((await post({ traveller: { ...TRAVELLER, dateOfBirth: '2999-01-01' } })).status, 400);
    assert.equal((await post({ traveller: { ...TRAVELLER, dateOfBirth: '1999-02-30' } })).status, 400);
    assert.equal((await post({ traveller: 'Asha' })).status, 400);
    assert.equal((await post({ billing: { ...BILLING, mobile: '' } })).status, 400);
    assert.equal((await post({ traveller: { ...TRAVELLER, health: 'x'.repeat(501) } })).status, 400);
    assert.equal((await post({})).status, 201);
  });
});

test('deleting an account removes traveller and billing details from its bookings', async () => {
  await withCheckoutServer(async (server) => {
    const admin = await adminToken();
    const { token } = await signUp();
    const { data } = await api('/api/bookings', { method: 'POST', token, server, body: { tourId: 'east-coast-30', date: '2099-01-01', travellers: 1, traveller: TRAVELLER, billing: BILLING, agreedToTerms: true } });
    await api('/api/me', { method: 'DELETE', token, body: { password: 'password123' } });
    const row = (await api('/api/admin/bookings', { token: admin })).data.bookings.find((item) => item.id === data.booking.id);
    assert.deepEqual(row.traveller, {});
    assert.deepEqual(row.billing, {});
  });
});

test('sign up cannot create an admin', async () => {
  const { user } = await signUp({ role: 'admin' });
  assert.equal(user.role, 'customer');
});

test('sign in, session and sign out', async () => {
  const { user } = await signUp({ email: 'flow@example.com' });
  const wrong = await api('/api/auth/signin', { method: 'POST', body: { email: user.email, password: 'wrong-password' } });
  assert.equal(wrong.status, 401);
  const unknown = await api('/api/auth/signin', { method: 'POST', body: { email: 'none@example.com', password: 'wrong-password' } });
  assert.equal(unknown.data.error, wrong.data.error);

  const { data } = await api('/api/auth/signin', { method: 'POST', body: { email: user.email, password: 'password123' } });
  assert.equal((await api('/api/me', { token: data.token })).data.user.email, user.email);
  assert.equal((await api('/api/auth/signout', { method: 'POST', token: data.token })).status, 204);
  assert.equal((await api('/api/me', { token: data.token })).status, 401);
});

test('remember me controls how long a session lasts', async () => {
  const { user } = await signUp();
  const expiryFor = async (remember) => {
    await api('/api/auth/signin', { method: 'POST', body: { email: user.email, password: 'password123', remember } });
    return db.prepare('SELECT expires_at FROM sessions WHERE user_id = ? ORDER BY rowid DESC LIMIT 1').get(user.id).expires_at;
  };
  const days = (iso) => (new Date(iso) - Date.now()) / 86400000;
  assert.ok(days(await expiryFor(true)) > 29);
  assert.ok(days(await expiryFor(false)) < 1.1);
});

test('tokens are not stored in plain text and expired sessions stop working', async () => {
  const { token, user } = await signUp();
  const row = db.prepare('SELECT token_hash FROM sessions WHERE user_id = ?').get(user.id);
  assert.notEqual(row.token_hash, token);
  db.prepare("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE user_id = ?").run(user.id);
  assert.equal((await api('/api/me', { token })).status, 401);
});

test('repeated failed sign ins are blocked', async () => {
  const { user } = await signUp();
  const attempt = () => api('/api/auth/signin', { method: 'POST', body: { email: user.email, password: 'wrong-password' } });
  for (let i = 0; i < 10; i += 1) assert.equal((await attempt()).status, 401);
  assert.equal((await attempt()).status, 429);
  const correct = await api('/api/auth/signin', { method: 'POST', body: { email: user.email, password: 'password123' } });
  assert.equal(correct.status, 429);
});

test('booking needs sign in, uses the account details and the database price', async () => {
  const body = { tourId: 'east-coast-30', date: '2099-01-01', travellers: 2, total: 1, name: 'Fake', email: 'fake@x.co' };
  assert.equal((await api('/api/bookings', { method: 'POST', body })).status, 401);

  const { token, user } = await signUp({ name: 'Mira', phone: '0400000555' });
  const { status, data } = await api('/api/bookings', { method: 'POST', body, token });
  assert.equal(status, 201);
  assert.equal(data.booking.total, 9790);
  const row = db.prepare('SELECT * FROM bookings WHERE id = ?').get(data.booking.id);
  assert.equal(row.customer_name, 'Mira');
  assert.equal(row.customer_email, user.email);
  assert.equal(row.customer_phone, '0400000555');
});

test('booking rejects invalid trips, dates and traveller counts', async () => {
  const { token } = await signUp();
  const post = (body) => api('/api/bookings', { method: 'POST', body, token });
  const good = { tourId: 'east-coast-30', date: '2099-01-01', travellers: 1 };
  assert.equal((await post({ ...good, tourId: 'missing' })).status, 404);
  assert.equal((await post({ ...good, date: '2020-01-01' })).status, 400);
  assert.equal((await post({ ...good, date: '2099-02-31' })).status, 400);
  assert.equal((await post({ ...good, travellers: 0 })).status, 400);
  assert.equal((await post({ ...good, travellers: 13 })).status, 400);
  assert.equal((await post({ ...good, travellers: 1.5 })).status, 400);
});

test('people can only see and cancel their own bookings', async () => {
  const owner = await signUp();
  const other = await signUp();
  const { data } = await api('/api/bookings', {
    method: 'POST',
    token: owner.token,
    body: { tourId: 'east-coast-37', date: '2099-01-01', travellers: 1 },
  });
  assert.equal((await api('/api/me/bookings', { token: other.token })).data.bookings.length, 0);
  assert.equal((await api(`/api/bookings/${data.booking.id}/cancel`, { method: 'POST', token: other.token })).status, 404);
  const cancelled = await api(`/api/bookings/${data.booking.id}/cancel`, { method: 'POST', token: owner.token });
  assert.equal(cancelled.data.booking.status, 'cancelled');
});

test('saved trips are stored per account', async () => {
  const a = await signUp();
  const b = await signUp();
  assert.equal((await api('/api/me/saved/east-coast-30', { method: 'PUT' })).status, 401);
  await api('/api/me/saved/east-coast-30', { method: 'PUT', token: a.token });
  await api('/api/me/saved/east-coast-30', { method: 'PUT', token: a.token });
  assert.deepEqual((await api('/api/me/saved', { token: a.token })).data.tourIds, ['east-coast-30']);
  assert.deepEqual((await api('/api/me/saved', { token: b.token })).data.tourIds, []);
  await api('/api/me/saved/east-coast-30', { method: 'DELETE', token: a.token });
  assert.deepEqual((await api('/api/me/saved', { token: a.token })).data.tourIds, []);
});

test('trip requests and help messages are stored', async () => {
  const { token } = await signUp();
  const body = { date: '2099-01-01', stay: 'Premium', transport: 'Bus', activities: ['Skydive'], startingPoint: 'Brisbane' };
  assert.equal((await api('/api/itineraries', { method: 'POST', body })).status, 401);
  const created = await api('/api/itineraries', { method: 'POST', body, token });
  assert.equal(created.status, 201);
  assert.deepEqual(created.data.itinerary.activities, ['Skydive']);

  assert.equal((await api('/api/messages', { method: 'POST', body: { name: 'A', email: 'bad', question: 'Q' } })).status, 400);
  const message = { name: 'Guest', email: 'guest@example.com', question: 'Is it fun?' };
  assert.equal((await api('/api/messages', { method: 'POST', body: message })).status, 201);
  const admin = await adminToken();
  const { data } = await api('/api/admin/messages', { token: admin });
  assert.equal(data.messages[0].question, 'Is it fun?');
});

test('admin routes reject guests and customers', async () => {
  const { token } = await signUp();
  const routes = [
    ['GET', '/api/admin/tours'],
    ['POST', '/api/admin/tours'],
    ['PUT', '/api/admin/tours/east-coast-30'],
    ['DELETE', '/api/admin/tours/east-coast-30'],
    ['GET', '/api/admin/bookings'],
    ['PATCH', '/api/admin/bookings/1'],
    ['GET', '/api/admin/users'],
    ['GET', '/api/admin/itineraries'],
    ['GET', '/api/admin/messages'],
  ];
  for (const [method, path] of routes) {
    assert.equal((await api(path, { method })).status, 401, `${method} ${path} guest`);
    assert.equal((await api(path, { method, token })).status, 403, `${method} ${path} customer`);
  }
  assert.equal((await uploadPhoto(token, JPEG)).status, 403);
});

test('admin can add, edit, hide and delete a trip, and bookings keep their title', async () => {
  const token = await adminToken();
  const { status, data } = await api('/api/admin/tours', { method: 'POST', body: NEW_TOUR, token });
  assert.equal(status, 201);
  const id = data.tour.id;
  assert.ok((await api('/api/tours')).data.tours.some((tour) => tour.id === id));

  const duplicate = await api('/api/admin/tours', { method: 'POST', body: NEW_TOUR, token });
  assert.notEqual(duplicate.data.tour.id, id);
  await api(`/api/admin/tours/${duplicate.data.tour.id}`, { method: 'DELETE', token });

  const edited = await api(`/api/admin/tours/${id}`, { method: 'PUT', token, body: { ...NEW_TOUR, title: 'Edited', price: 2000, published: false } });
  assert.equal(edited.data.tour.title, 'Edited');
  assert.ok(!(await api('/api/tours')).data.tours.some((tour) => tour.id === id));
  assert.ok((await api('/api/admin/tours', { token })).data.tours.some((tour) => tour.id === id));

  await api(`/api/admin/tours/${id}`, { method: 'PUT', token, body: { ...NEW_TOUR, title: 'Edited', price: 2000 } });
  const customer = await signUp();
  const booking = await api('/api/bookings', { method: 'POST', token: customer.token, body: { tourId: id, date: '2099-01-01', travellers: 1 } });

  assert.equal((await api(`/api/admin/tours/${id}`, { method: 'DELETE', token })).status, 204);
  assert.equal((await api(`/api/admin/tours/${id}`, { method: 'DELETE', token })).status, 404);
  const mine = await api('/api/me/bookings', { token: customer.token });
  assert.equal(mine.data.bookings[0].id, booking.data.booking.id);
  assert.equal(mine.data.bookings[0].tourTitle, 'Edited');
  assert.equal(mine.data.bookings[0].tourId, null);
});

test('trip validation', async () => {
  const token = await adminToken();
  const post = (body) => api('/api/admin/tours', { method: 'POST', body, token });
  assert.equal((await post({ ...NEW_TOUR, title: '' })).status, 400);
  assert.equal((await post({ ...NEW_TOUR, collection: 'moon' })).status, 400);
  assert.equal((await post({ ...NEW_TOUR, price: -1 })).status, 400);
  assert.equal((await post({ ...NEW_TOUR, price: '100' })).status, 400);
  assert.equal((await post({ ...NEW_TOUR, photo: 'https://evil.example/x.jpg' })).status, 400);
  assert.equal((await post({ ...NEW_TOUR, photo: '/uploads/../../secret' })).status, 400);
});

test('photo upload checks content and replaced photos are deleted', async () => {
  const token = await adminToken();
  const rejected = await uploadPhoto(token, Buffer.from('<script>alert(1)</script>'), 'evil.jpg');
  assert.equal(rejected.status, 400);
  const big = await uploadPhoto(token, Buffer.concat([JPEG, Buffer.alloc(6 * 1024 * 1024)]));
  assert.equal(big.status, 400);

  const before = readdirSync(uploadDir).length;
  const first = await uploadPhoto(token, JPEG, '../../evil.html');
  assert.equal(first.status, 201);
  assert.match(first.data.photo, /^\/uploads\/[a-f0-9]+\.jpg$/);
  assert.equal(readdirSync(uploadDir).length, before + 1);
  assert.equal((await fetch(base + first.data.photo)).status, 200);

  const created = await api('/api/admin/tours', { method: 'POST', token, body: { ...NEW_TOUR, title: 'Photo trip', photo: first.data.photo } });
  const second = await uploadPhoto(token, JPEG);
  const id = created.data.tour.id;
  await api(`/api/admin/tours/${id}`, { method: 'PUT', token, body: { ...NEW_TOUR, title: 'Photo trip', photo: second.data.photo } });
  assert.ok(!existsSync(join(uploadDir, first.data.photo.replace('/uploads/', ''))));
  await api(`/api/admin/tours/${id}`, { method: 'DELETE', token });
  assert.ok(!existsSync(join(uploadDir, second.data.photo.replace('/uploads/', ''))));
});

test('a photo shared by two trips stays until neither uses it', async () => {
  const token = await adminToken();
  const melbourneTrips = (await api('/api/admin/tours', { token })).data.tours.filter((tour) => tour.photo === '/uploads/melbourne.jpg');
  assert.equal(melbourneTrips.length, 2);
  const created = await api('/api/admin/tours', { method: 'POST', token, body: { ...NEW_TOUR, title: 'Shares photo', photo: '/uploads/melbourne.jpg' } });
  await api(`/api/admin/tours/${created.data.tour.id}`, { method: 'DELETE', token });
  assert.ok(existsSync(join(uploadDir, 'melbourne.jpg')));
});

test('admin sees all bookings and people, without password data', async () => {
  const token = await adminToken();
  const customer = await signUp({ name: 'Listed Person', phone: '0400000777' });
  const booked = await api('/api/bookings', { method: 'POST', token: customer.token, body: { tourId: 'east-coast-44', date: '2099-01-01', travellers: 3 } });

  const bookings = (await api('/api/admin/bookings', { token })).data.bookings;
  const found = bookings.find((item) => item.id === booked.data.booking.id);
  assert.equal(found.customerName, 'Listed Person');
  assert.equal(found.customerPhone, '0400000777');
  assert.equal(found.total, 19485);

  const { users } = (await api('/api/admin/users', { token })).data;
  const person = users.find((item) => item.email === customer.user.email);
  assert.equal(person.bookingCount, 1);
  assert.ok(!JSON.stringify(users).includes('password'));

  assert.equal((await api(`/api/admin/bookings/${found.id}`, { method: 'PATCH', token, body: { status: 'nope' } })).status, 400);
  assert.equal((await api(`/api/admin/bookings/${found.id}`, { method: 'PATCH', token, body: { status: 'confirmed' } })).status, 204);
  assert.equal((await api('/api/me/bookings', { token: customer.token })).data.bookings[0].status, 'confirmed');
});

test('deleting an account removes personal data but keeps the booking record', async () => {
  const admin = await adminToken();
  const { token, user } = await signUp({ name: 'Leaving Person', phone: '0400000888' });
  const booked = await api('/api/bookings', { method: 'POST', token, body: { tourId: 'east-coast-30', date: '2099-01-01', travellers: 1 } });

  assert.equal((await api('/api/me', { method: 'DELETE', token, body: { password: 'wrong-password' } })).status, 401);
  assert.equal((await api('/api/me', { method: 'DELETE', token, body: { password: 'password123' } })).status, 204);
  assert.equal((await api('/api/me', { token })).status, 401);

  const { users } = (await api('/api/admin/users', { token: admin })).data;
  assert.ok(!users.some((item) => item.email === user.email));
  const row = (await api('/api/admin/bookings', { token: admin })).data.bookings.find((item) => item.id === booked.data.booking.id);
  assert.equal(row.customerName, 'Deleted user');
  assert.equal(row.customerEmail, '');
  assert.equal(row.customerPhone, '');
});

test('the last admin cannot delete their account', async () => {
  const token = await adminToken();
  const response = await api('/api/me', { method: 'DELETE', token, body: { password: 'adminpass123' } });
  assert.equal(response.status, 400);
});

test('changing email needs the current password and a free address', async () => {
  const { token, user } = await signUp();
  const other = await signUp();
  const put = (body, auth = token) => api('/api/me/email', { method: 'PUT', token: auth, body });

  assert.equal((await api('/api/me/email', { method: 'PUT', body: { email: 'a@b.co' } })).status, 401);
  assert.equal((await put({ email: 'new@example.com', currentPassword: 'wrong-password' })).status, 401);
  assert.equal((await put({ email: 'not-an-email', currentPassword: 'password123' })).status, 400);
  assert.equal((await put({ email: other.user.email, currentPassword: 'password123' })).status, 409);

  const changed = await put({ email: 'New.Address@Example.com', currentPassword: 'password123' });
  assert.equal(changed.status, 200);
  assert.equal(changed.data.user.email, 'new.address@example.com');
  assert.equal((await put({ email: 'new.address@example.com', currentPassword: 'password123' })).status, 200);

  const signIn = (email) => api('/api/auth/signin', { method: 'POST', body: { email, password: 'password123' } });
  assert.equal((await signIn(user.email)).status, 401);
  assert.equal((await signIn('new.address@example.com')).status, 200);
});

test('changing password needs the current one and signs out other devices', async () => {
  const { token, user } = await signUp();
  const signIn = (password) => api('/api/auth/signin', { method: 'POST', body: { email: user.email, password } });
  const otherDevice = (await signIn('password123')).data.token;
  const put = (body) => api('/api/me/password', { method: 'PUT', token, body });

  assert.equal((await api('/api/me/password', { method: 'PUT', body: { newPassword: 'another-pass1' } })).status, 401);
  assert.equal((await put({ currentPassword: 'wrong-password', newPassword: 'another-pass1' })).status, 401);
  assert.equal((await put({ currentPassword: 'password123', newPassword: 'short' })).status, 400);
  assert.equal((await put({ currentPassword: 'password123', newPassword: 'another-pass1' })).status, 204);

  assert.equal((await api('/api/me', { token })).status, 200);
  assert.equal((await api('/api/me', { token: otherDevice })).status, 401);
  assert.equal((await signIn('password123')).status, 401);
  assert.equal((await signIn('another-pass1')).status, 200);
});

test('malformed requests get a clean error', async () => {
  const response = await fetch(`${base}/api/auth/signin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not json',
  });
  assert.equal(response.status, 400);
  assert.equal((await api('/api/nope')).status, 404);
  assert.equal((await api('/api/auth/signup', { method: 'POST', body: { name: 5, email: 'a@b.co', phone: '+61400000000', password: 'password123' } })).status, 400);
});

const bookTrip = (token, tourId = 'east-coast-30') =>
  api('/api/bookings', { method: 'POST', token, body: { tourId, date: '2099-01-01', travellers: 2 } }).then((response) => response.data.booking);

const setBookingStatus = (token, id, status) =>
  api(`/api/admin/bookings/${id}`, { method: 'PATCH', token, body: { status } });

test('a new booking stays a request and sends no message until an admin decides', async () => {
  const { token } = await signUp();
  const booking = await bookTrip(token);
  assert.equal(booking.status, 'new');
  assert.equal(booking.paymentStatus, 'pending');
  assert.deepEqual((await api('/api/me/notifications', { token })).data.notifications, []);
});

test('confirming and cancelling a booking sends an in-app message and an email once', async () => {
  const admin = await adminToken();
  const { token, user } = await signUp({ name: 'Notified Person' });
  const booking = await bookTrip(token);
  sentEmails.length = 0;

  assert.equal((await setBookingStatus(admin, booking.id, 'confirmed')).status, 204);
  assert.equal((await setBookingStatus(admin, booking.id, 'confirmed')).status, 204);
  let { notifications } = (await api('/api/me/notifications', { token })).data;
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].title, 'Booking confirmed');
  assert.equal(notifications[0].read, false);
  assert.equal(sentEmails.length, 1);
  assert.equal(sentEmails[0].to, user.email);
  assert.equal(sentEmails[0].subject, 'Booking confirmed');
  assert.ok(sentEmails[0].text.includes('Notified Person'));

  assert.equal((await setBookingStatus(admin, booking.id, 'cancelled')).status, 204);
  ({ notifications } = (await api('/api/me/notifications', { token })).data);
  assert.equal(notifications[0].title, 'Booking cancelled');
  assert.equal(sentEmails.length, 2);

  // Moving a booking back to a request tells nobody.
  assert.equal((await setBookingStatus(admin, booking.id, 'new')).status, 204);
  assert.equal(sentEmails.length, 2);

});

test('a status notification stays unread until that one is opened', async () => {
  const admin = await adminToken();
  const owner = await signUp();
  const other = await signUp();
  await setBookingStatus(admin, (await bookTrip(owner.token)).id, 'confirmed');
  await setBookingStatus(admin, (await bookTrip(owner.token)).id, 'confirmed');

  let { notifications } = (await api('/api/me/notifications', { token: owner.token })).data;
  const read = (id, token) => api(`/api/me/notifications/${id}/read`, { method: 'POST', token });
  assert.equal((await read(notifications[1].id, other.token)).status, 404);
  assert.equal((await read(notifications[1].id, owner.token)).status, 204);
  ({ notifications } = (await api('/api/me/notifications', { token: owner.token })).data);
  assert.equal(notifications[0].read, false);
  assert.equal(notifications[1].read, true);
});

test('an admin and a customer can chat back and forth, with unread tracked for each side', async () => {
  const admin = await adminToken();
  const { token, user } = await signUp({ name: 'Chatting Person' });
  const other = await signUp();
  const adminChat = () => api(`/api/admin/chats/${user.id}`, { token: admin });
  const summary = async () => (await api('/api/admin/chats', { token: admin })).data.chats.find((chat) => chat.userId === user.id);
  sentEmails.length = 0;

  // The admin starts the conversation.
  assert.equal((await api(`/api/admin/chats/${user.id}`, { method: 'POST', token: admin, body: { message: 'Please bring your passport.' } })).status, 201);
  assert.equal(sentEmails.length, 0);
  let { messages } = (await api('/api/me/chat', { token })).data;
  assert.equal(messages.length, 1);
  assert.equal(messages[0].sender, 'admin');
  assert.equal(messages[0].read, false);
  assert.equal((await summary()).unread, 0);

  // The customer opens it and replies.
  assert.equal((await api('/api/me/chat/read', { method: 'POST', token })).status, 204);
  assert.equal((await api('/api/me/chat', { method: 'POST', token, body: { message: 'Thanks, will do!' } })).status, 201);
  ({ messages } = (await api('/api/me/chat', { token })).data);
  assert.deepEqual(messages.map((item) => [item.sender, item.body]), [['admin', 'Please bring your passport.'], ['customer', 'Thanks, will do!']]);
  assert.equal(messages[0].read, true);

  // The admin sees it as unread, in order, until the chat is opened.
  const before = await summary();
  assert.equal(before.unread, 1);
  assert.equal(before.lastMessage, 'Thanks, will do!');
  assert.equal(before.lastSender, 'customer');
  assert.equal((await adminChat()).data.customer.name, 'Chatting Person');
  assert.equal((await adminChat()).data.messages[1].read, false);
  assert.equal((await api(`/api/admin/chats/${user.id}/read`, { method: 'POST', token: admin })).status, 204);
  assert.equal((await summary()).unread, 0);

  // Reading your own side doesn't mark the other person's messages as read.
  await api(`/api/admin/chats/${user.id}`, { method: 'POST', token: admin, body: { message: 'Great.' } });
  await api(`/api/admin/chats/${user.id}/read`, { method: 'POST', token: admin });
  assert.equal((await api('/api/me/chat', { token })).data.messages[2].read, false);

  assert.deepEqual((await api('/api/me/chat', { token: other.token })).data.messages, []);
});

test('chat checks who is asking and what is sent', async () => {
  const admin = await adminToken();
  const { token, user } = await signUp();
  assert.equal((await api('/api/me/chat')).status, 401);
  assert.equal((await api('/api/me/chat', { method: 'POST', body: { message: 'Hi' } })).status, 401);
  assert.equal((await api('/api/admin/chats', { token })).status, 403);
  assert.equal((await api(`/api/admin/chats/${user.id}`, { token })).status, 403);
  assert.equal((await api(`/api/admin/chats/${user.id}`, { method: 'POST', token, body: { message: 'Hi' } })).status, 403);
  assert.equal((await api(`/api/admin/chats/${user.id}/read`, { method: 'POST', token })).status, 403);

  assert.equal((await api('/api/me/chat', { method: 'POST', token, body: { message: '   ' } })).status, 400);
  assert.equal((await api('/api/me/chat', { method: 'POST', token, body: { message: 'x'.repeat(1001) } })).status, 400);
  assert.equal((await api('/api/admin/chats/999999', { method: 'POST', token: admin, body: { message: 'Hi' } })).status, 404);
});

test('deleting an account deletes its chat', async () => {
  const admin = await adminToken();
  const { token, user } = await signUp();
  await api('/api/me/chat', { method: 'POST', token, body: { message: 'Goodbye' } });
  await api('/api/me', { method: 'DELETE', token, body: { password: 'password123' } });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM chat_messages WHERE user_id = ?').get(user.id).count, 0);
  assert.equal((await api(`/api/admin/chats/${user.id}`, { token: admin })).status, 404);
});

test('admin messages saved as notifications move into the chat, once', () => {
  const path = join(dir, 'older.db');
  const older = openDatabase(path);
  const { lastInsertRowid } = older.prepare("INSERT INTO users (name, email, password_hash) VALUES ('Old', 'old@example.com', 'x')").run();
  const add = older.prepare('INSERT INTO notifications (user_id, title, body, read) VALUES (?, ?, ?, ?)');
  add.run(lastInsertRowid, 'Message about East Coast', 'Hello', 1);
  add.run(lastInsertRowid, 'Booking confirmed', 'Your booking is confirmed.', 0);
  older.close();

  for (let opened = 0; opened < 2; opened += 1) {
    const reopened = openDatabase(path);
    assert.deepEqual(reopened.prepare('SELECT title FROM notifications').all().map((row) => row.title), ['Booking confirmed']);
    const moved = reopened.prepare('SELECT sender, body, read FROM chat_messages').all();
    assert.equal(moved.length, 1);
    assert.equal(moved[0].sender, 'admin');
    assert.equal(moved[0].body, 'Hello');
    assert.equal(moved[0].read, 1);
    reopened.close();
  }
});

test('a failed email does not stop the status change or the in-app message', async () => {
  const admin = await adminToken();
  const { token } = await signUp();
  const booking = await bookTrip(token);
  const originalError = console.error;
  console.error = () => undefined;
  emailShouldFail = true;
  try {
    assert.equal((await setBookingStatus(admin, booking.id, 'confirmed')).status, 204);
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    emailShouldFail = false;
    console.error = originalError;
  }
  assert.equal((await api('/api/me/bookings', { token })).data.bookings[0].status, 'confirmed');
  assert.equal((await api('/api/me/notifications', { token })).data.notifications.length, 1);
});

test('confirming a trip request also notifies the customer', async () => {
  const admin = await adminToken();
  const { token } = await signUp();
  const { data } = await api('/api/itineraries', { method: 'POST', token, body: { date: '2099-01-01', stay: 'Premium', transport: 'Bus' } });
  sentEmails.length = 0;
  await api(`/api/admin/itineraries/${data.itinerary.id}`, { method: 'PATCH', token: admin, body: { status: 'confirmed' } });
  assert.equal((await api('/api/me/notifications', { token })).data.notifications[0].title, 'Trip request confirmed');
  assert.equal(sentEmails.length, 1);
});

test('notifications are private to each customer', async () => {
  const admin = await adminToken();
  const owner = await signUp();
  const other = await signUp();
  await setBookingStatus(admin, (await bookTrip(owner.token)).id, 'confirmed');
  assert.equal((await api('/api/me/notifications')).status, 401);
  assert.deepEqual((await api('/api/me/notifications', { token: other.token })).data.notifications, []);
});

test('paying uses the database price, reuses one link, and leaves the booking a request', async () => {
  const { token } = await signUp({ name: 'Paying Person' });
  const booking = await bookTrip(token);
  const pay = () => api(`/api/bookings/${booking.id}/pay`, { method: 'POST', token, body: { total: 1 } });

  const first = await pay();
  assert.equal(first.status, 200);
  const linkId = first.data.url.split('/').pop();
  const link = paymentLinks.get(linkId);
  assert.equal(link.details.amountCents, booking.total * 100);
  assert.equal(link.details.customer.contact, '+61400000000');
  assert.equal((await pay()).data.url, first.data.url);

  // Not paid yet, whatever the browser's return address claims.
  const fake = await fetch(`${base}/payments/razorpay/return?razorpay_payment_link_id=${linkId}&razorpay_payment_link_status=paid`);
  assert.ok((await fake.text()).includes('not confirmed'));
  let check = await api(`/api/bookings/${booking.id}/payment/check`, { method: 'POST', token });
  assert.equal(check.data.booking.paymentStatus, 'pending');

  link.status = 'paid';
  link.payments = [{ payment_id: 'pay_123', status: 'captured' }];
  const returned = await fetch(`${base}/payments/razorpay/return?razorpay_payment_link_id=${linkId}`);
  assert.ok((await returned.text()).includes('Payment received'));
  check = await api(`/api/bookings/${booking.id}/payment/check`, { method: 'POST', token });
  assert.equal(check.data.booking.paymentStatus, 'paid');
  assert.equal(check.data.booking.status, 'new');

  const again = await pay();
  assert.equal(again.data.url, null);
});

test('a cancelled link gets replaced, and a cancelled booking can’t be paid', async () => {
  const { token } = await signUp();
  const booking = await bookTrip(token);
  const pay = () => api(`/api/bookings/${booking.id}/pay`, { method: 'POST', token });

  const first = await pay();
  paymentLinks.get(first.data.url.split('/').pop()).status = 'cancelled';
  const second = await pay();
  assert.notEqual(second.data.url, first.data.url);

  await api(`/api/bookings/${booking.id}/cancel`, { method: 'POST', token });
  assert.equal((await pay()).status, 400);
});

test('cancelling a paid booking tells the customer about the refund', async () => {
  const admin = await adminToken();
  const { token } = await signUp();
  const booking = await bookTrip(token);
  const { data } = await api(`/api/bookings/${booking.id}/pay`, { method: 'POST', token });
  const link = paymentLinks.get(data.url.split('/').pop());
  link.status = 'paid';
  link.payments = [{ payment_id: 'pay_456', status: 'captured' }];
  await api(`/api/bookings/${booking.id}/payment/check`, { method: 'POST', token });

  await setBookingStatus(admin, booking.id, 'cancelled');
  const { notifications } = (await api('/api/me/notifications', { token })).data;
  assert.ok(notifications[0].body.includes('refund'));
  const row = (await api('/api/admin/bookings', { token: admin })).data.bookings.find((item) => item.id === booking.id);
  assert.equal(row.paymentId, 'pay_456');
});

test('customers can only pay for their own bookings', async () => {
  const owner = await signUp();
  const other = await signUp();
  const booking = await bookTrip(owner.token);
  assert.equal((await api(`/api/bookings/${booking.id}/pay`, { method: 'POST' })).status, 401);
  assert.equal((await api(`/api/bookings/${booking.id}/pay`, { method: 'POST', token: other.token })).status, 404);
  assert.equal((await api(`/api/bookings/${booking.id}/payment/check`, { method: 'POST', token: other.token })).status, 404);
});
