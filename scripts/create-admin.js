// Creates an admin account, or makes an existing account an admin and resets its password.
// Run with: npm run create-admin
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { openDatabase } from '../src/db.js';
import { hashPassword } from '../src/security.js';
import * as check from '../src/validate.js';

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (text) => {
        if (text.includes(question)) process.stdout.write(question);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer);
    });
  });
}

const dataDir = process.env.DATA_DIR ?? join(import.meta.dirname, '..', 'data');
const db = openDatabase(join(dataDir, 'app.db'));

try {
  const name = check.text(process.env.ADMIN_NAME ?? (await ask('Admin name: ')), 'Name', { max: 100, required: true });
  const email = check.email(process.env.ADMIN_EMAIL ?? (await ask('Admin email: ')));
  const password = check.newPassword(process.env.ADMIN_PASSWORD ?? (await ask('Password (at least 8 characters): ', { hidden: true })));
  const passwordHash = await hashPassword(password);

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    db.prepare("UPDATE users SET name = ?, password_hash = ?, role = 'admin' WHERE id = ?").run(name, passwordHash, existing.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(existing.id);
    console.log(`Updated ${email}. It is now an admin account.`);
  } else {
    db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'admin')").run(name, email, passwordHash);
    console.log(`Created admin account ${email}.`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
