export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function text(value, field, { max = 200, required = false } = {}) {
  if (value !== undefined && value !== null && typeof value !== 'string') {
    throw new HttpError(400, `${field} must be text.`);
  }
  const trimmed = (value ?? '').trim();
  if (required && !trimmed) throw new HttpError(400, `${field} is required.`);
  if (trimmed.length > max) throw new HttpError(400, `${field} is too long.`);
  return trimmed;
}

export function email(value) {
  const normalized = text(value, 'Email', { max: 254, required: true }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new HttpError(400, 'Enter a valid email address.');
  }
  return normalized;
}

// 8 to 14 characters including any "+" country code, which is what Razorpay accepts.
export function isPhone(value) {
  return /^(?=.{8,14}$)\+?\d+$/.test(value);
}

export function phone(value) {
  const normalized = text(value, 'Mobile number', { max: 30, required: true }).replace(/[\s()-]/g, '');
  if (!isPhone(normalized)) throw new HttpError(400, 'Enter a valid mobile number.');
  return normalized;
}

export function newPassword(value) {
  if (typeof value !== 'string' || value.length < 8) {
    throw new HttpError(400, 'Password must be at least 8 characters.');
  }
  if (value.length > 200) throw new HttpError(400, 'Password is too long.');
  return value;
}

export function futureDate(value, today = new Date()) {
  const raw = text(value, 'Start date', { max: 10, required: true });
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  const invalid = new HttpError(400, 'Enter a future date as YYYY-MM-DD.');
  if (!match) throw invalid;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(year, month - 1, day);
  const isReal =
    date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  if (!isReal || date < startOfToday) throw invalid;
  return raw;
}

export function stringList(value, field, { maxItems = 50, maxLength = 200 } = {}) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new HttpError(400, `${field} must be a list of up to ${maxItems} items.`);
  }
  return value.map((item) => text(item, field, { max: maxLength, required: true }));
}

const DETAIL_LENGTH = 500;
const TRAVELLER_FIELDS = ['firstName', 'lastName', 'mobile', 'email', 'dateOfBirth', 'country', 'gender', 'health', 'dietary', 'previousTour'];
const REQUIRED_TRAVELLER_FIELDS = ['firstName', 'lastName', 'mobile', 'email', 'dateOfBirth', 'country'];
const BILLING_FIELDS = [...TRAVELLER_FIELDS.filter((field) => field !== 'previousTour'), 'specialRequirements', 'travellingWith', 'visa'];

function details(value, field, fields, required) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, `${field} details are missing.`);
  }
  const result = Object.fromEntries(fields.map((key) => [key, text(value[key], field, { max: DETAIL_LENGTH })]));
  const missing = required.filter((key) => !result[key]);
  if (missing.length > 0) throw new HttpError(400, `${field}: please fill in ${missing.join(', ')}.`);
  if (result.email) result.email = email(result.email);
  if (result.dateOfBirth) result.dateOfBirth = pastDate(result.dateOfBirth, `${field} date of birth`);
  return result;
}

export function travellerDetails(value, field) {
  return details(value, field, TRAVELLER_FIELDS, REQUIRED_TRAVELLER_FIELDS);
}

export function billingDetails(value) {
  return details(value, 'Billing', BILLING_FIELDS, REQUIRED_TRAVELLER_FIELDS);
}

export function pastDate(value, field) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const invalid = new HttpError(400, `Enter ${field} as YYYY-MM-DD.`);
  if (!match) throw invalid;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(year, month - 1, day);
  const isReal = date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
  if (!isReal || date >= new Date() || year < 1900) throw invalid;
  return value;
}

export const INCLUSION_GROUPS = ['experiences', 'accommodation', 'included', 'addOns', 'transport', 'meals'];

// Every group is always returned, empty when not given, so the app never has to check for missing ones.
export function inclusions(value) {
  if (value === undefined || value === null) value = {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'Inclusions must be grouped, like experiences, transport and meals.');
  }
  return Object.fromEntries(INCLUSION_GROUPS.map((group) => [group, stringList(value[group], 'Inclusions')]));
}

// Trips saved before inclusions were grouped kept them as one list.
export function storedInclusions(json) {
  const value = JSON.parse(json);
  return Array.isArray(value) ? inclusions({ included: value }) : inclusions(value);
}

const UPLOADED_PHOTO = /^\/uploads\/[A-Za-z0-9._-]+$/;
const MAX_GALLERY_PHOTOS = 12;

export function rating(value) {
  if (!Number.isInteger(value) || value < 1 || value > 5) {
    throw new HttpError(400, 'Choose a rating from 1 to 5 stars.');
  }
  return value;
}

export function tourPrice(price) {
  if (price !== null && (!Number.isInteger(price) || price < 0 || price > 10_000_000)) {
    throw new HttpError(400, 'Price must be a whole number of 0 or more.');
  }
  return price;
}

export function tourInput(body) {
  const collection = text(body?.collection, 'Collection', { required: true });
  if (!['city', 'east'].includes(collection)) {
    throw new HttpError(400, 'Collection must be city or east.');
  }

  const price = tourPrice(body?.price ?? null);

  const rawRoute = body?.route ?? [];
  if (!Array.isArray(rawRoute) || rawRoute.length > 50) {
    throw new HttpError(400, 'Route must be a list of up to 50 stops.');
  }
  const route = rawRoute.map((stop) => ({
    place: text(stop?.place, 'Route place', { required: true }),
    note: text(stop?.note, 'Route note', { max: 500 }),
  }));

  const photo = body?.photo ?? null;
  if (photo !== null && !UPLOADED_PHOTO.test(photo)) {
    throw new HttpError(400, 'Photo must be an uploaded file.');
  }

  const gallery = body?.gallery ?? [];
  if (!Array.isArray(gallery) || gallery.length > MAX_GALLERY_PHOTOS) {
    throw new HttpError(400, `Gallery can have up to ${MAX_GALLERY_PHOTOS} photos.`);
  }
  if (gallery.some((item) => typeof item !== 'string' || !UPLOADED_PHOTO.test(item))) {
    throw new HttpError(400, 'Gallery photos must be uploaded files.');
  }

  return {
    collection,
    title: text(body?.title, 'Title', { required: true }),
    badge: text(body?.badge, 'Badge', { max: 50 }),
    subtitle: text(body?.subtitle, 'Destination', { max: 200 }),
    duration: text(body?.duration, 'Duration', { max: 50 }),
    style: text(body?.style, 'Style', { max: 50 }),
    travel: text(body?.travel, 'Travel', { max: 50 }),
    transport: text(body?.transport, 'Transport', { max: 50 }),
    groupSize: text(body?.groupSize, 'Group size', { max: 50 }),
    ageRange: text(body?.ageRange, 'Traveller age', { max: 50 }),
    price,
    summary: text(body?.summary, 'Summary', { max: 500 }),
    description: text(body?.description, 'Description', { max: 5000 }),
    highlights: stringList(body?.highlights, 'Highlights'),
    inclusions: inclusions(body?.inclusions),
    route,
    photo,
    gallery,
    meetingPoint: text(body?.meetingPoint, 'Meeting point', { max: 300 }),
    published: body?.published === false ? 0 : 1,
  };
}
