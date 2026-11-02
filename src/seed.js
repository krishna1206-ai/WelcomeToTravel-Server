import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PHOTO_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'seed', 'photos');

const EAST_COAST_STOPS = [
  { place: 'Byron Bay', note: 'Surf town vibes, try a lesson and find dolphins by kayak.' },
  { place: 'Noosa', note: 'Learn to surf, hike the coastal path, then hit the beach.' },
  { place: "K'gari", note: 'The largest sand island in the world: 4×4, freshwater lakes, shipwrecks.' },
  { place: 'The Whitsundays', note: 'Sail out to Whitehaven Beach and fly over Heart Reef.' },
  { place: 'Cairns', note: 'Snorkel the Great Barrier Reef. Tour ends.' },
];

const EAST_COAST_HIGHLIGHTS = ['4×4 on K’gari', 'Scenic flight', 'Whitsundays sail', 'Reef snorkel', 'Surf towns'];

const CITY_DEFAULTS = {
  collection: 'city',
  duration: '[DURATION]',
  style: '[STYLE]',
  travel: 'Group',
  price: null,
  description: 'Land, settle in and explore with a group of new mates.',
  route: [],
};

const TOURS = [
  {
    id: 'east-coast-30',
    collection: 'east',
    title: 'East Coast 30 Days',
    badge: 'Best Seller',
    subtitle: 'Sydney → Cairns',
    duration: '30 days',
    style: 'Semi-guided',
    travel: 'Group',
    price: 4895,
    summary: 'Semi-guided with new mates: drive a 4×4 on K’gari, fly over the Whitsundays and snorkel the reef.',
    description: 'Tick off every East Coast must-do with a group of new mates: drive a 4×4 on K’gari, fly over and cruise the Whitsundays, then snorkel the Great Barrier Reef.',
    highlights: EAST_COAST_HIGHLIGHTS,
    route: [{ place: 'Sydney', note: 'Tour starts. Meet your new travel family.' }, ...EAST_COAST_STOPS],
    photo: 'kgari.jpg',
  },
  {
    id: 'east-coast-37',
    collection: 'east',
    title: 'East Coast 37 Days',
    badge: 'Most Iconic',
    subtitle: 'Sydney → Cairns',
    duration: '37 days',
    style: 'Semi-guided',
    travel: 'Group',
    price: 5695,
    summary: 'Start by exploring Sydney like a local, Bondi and the Harbour included, then head up the coast.',
    description: 'Start by exploring Sydney like a local, Bondi and the Harbour included, then head up the coast.',
    highlights: ['Sydney like a local', 'Bondi', ...EAST_COAST_HIGHLIGHTS],
    route: [{ place: 'Sydney', note: 'Tour starts. Explore like a local, Bondi and the Harbour included.' }, ...EAST_COAST_STOPS],
    photo: 'bondi.jpg',
  },
  {
    id: 'east-coast-44',
    collection: 'east',
    title: 'East Coast 44 Days',
    badge: 'See it all',
    subtitle: 'Melbourne → Cairns',
    duration: '44 days',
    style: 'Semi-guided',
    travel: 'Group',
    price: 6495,
    summary: 'Melbourne, Sydney and the full East Coast combined. For travellers who want to do it all.',
    description: 'Melbourne, Sydney and the full East Coast combined. For travellers who want to do it all.',
    highlights: ['Melbourne', 'Sydney', ...EAST_COAST_HIGHLIGHTS],
    route: [
      { place: 'Melbourne', note: 'Tour starts. Laneway coffee, street art and the Great Ocean Road.' },
      { place: 'Sydney', note: 'The Harbour, Bondi Beach and Manly sunsets.' },
      ...EAST_COAST_STOPS,
    ],
    photo: 'reef.jpg',
  },
  { ...CITY_DEFAULTS, id: 'welcome-to-melbourne', title: 'Welcome to Melbourne', badge: 'Community Fave', subtitle: 'Melbourne city tour', summary: 'Melbourne city tour', highlights: ['Laneway coffee', 'Street art'], photo: 'melbourne.jpg' },
  { ...CITY_DEFAULTS, id: 'great-ocean-road-trip', title: 'Great Ocean Road Trip', badge: 'Road Trip', subtitle: 'Add-on from Melbourne', summary: 'Add-on from Melbourne', highlights: ['Great Ocean Road'], photo: 'great-ocean-road.jpg' },
  { ...CITY_DEFAULTS, id: 'melbourne-mini-pack', title: 'Melbourne Mini Pack', badge: 'Short Stay', subtitle: 'Melbourne essentials', summary: 'Melbourne essentials', highlights: [], photo: 'melbourne.jpg' },
  { ...CITY_DEFAULTS, id: 'welcome-to-sydney', title: 'Welcome to Sydney', badge: 'Bucket List', subtitle: 'Sydney city tour', summary: 'Sydney city tour', highlights: ['The Harbour', 'Bondi Beach', 'Manly sunsets'], photo: 'sydney.jpg' },
  { ...CITY_DEFAULTS, id: 'blue-mountains-port-stephens', title: 'Blue Mountains & Port Stephens', badge: 'Road Trip', subtitle: 'Add-on from Sydney', summary: 'Add-on from Sydney', highlights: ['Blue Mountains', 'Port Stephens'], photo: 'blue-mountains.jpg' },
  { ...CITY_DEFAULTS, id: 'sydney-mini-pack', title: 'Sydney Mini Pack', badge: 'Short Stay', subtitle: 'Sydney essentials', summary: 'Sydney essentials', highlights: [], photo: 'bondi.jpg' },
];

// Runs only on an empty database, so trips the admin deleted never come back.
export function seedTours(db, uploadDir) {
  if (db.prepare('SELECT COUNT(*) AS count FROM tours').get().count > 0) return 0;
  if (db.prepare("SELECT value FROM meta WHERE key = 'seeded'").get()) return 0;

  mkdirSync(uploadDir, { recursive: true });
  const insert = db.prepare(
    `INSERT INTO tours (id, collection, title, badge, subtitle, duration, style, travel, price, summary,
       description, highlights, route, photo, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  TOURS.forEach((tour, index) => {
    const source = join(PHOTO_DIR, tour.photo);
    const target = join(uploadDir, tour.photo);
    if (existsSync(source) && !existsSync(target)) copyFileSync(source, target);
    insert.run(
      tour.id, tour.collection, tour.title, tour.badge, tour.subtitle, tour.duration, tour.style, tour.travel,
      tour.price, tour.summary, tour.description, JSON.stringify(tour.highlights), JSON.stringify(tour.route),
      `/uploads/${tour.photo}`, index,
    );
  });
  db.prepare("INSERT INTO meta (key, value) VALUES ('seeded', '1')").run();
  return TOURS.length;
}
