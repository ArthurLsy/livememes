import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.ts';

fs.mkdirSync(config.dataDir, { recursive: true });

export const db = new DatabaseSync(path.join(config.dataDir, 'livememes.db'));

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS devices (
    token       TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    username    TEXT NOT NULL,
    avatar_url  TEXT,
    device_name TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    last_seen   INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS devices_user_id ON devices (user_id);

  CREATE TABLE IF NOT EXISTS user_prefs (
    user_id INTEGER PRIMARY KEY,
    muted   INTEGER NOT NULL DEFAULT 0
  );
`);

// user_prefs.user_id doit etre un TEXT : les snowflakes Discord depassent
// Number.MAX_SAFE_INTEGER. Corrige les bases creees avant ce constat.
const prefsType = db
  .prepare(`SELECT type FROM pragma_table_info('user_prefs') WHERE name = 'user_id'`)
  .get() as { type?: string } | undefined;

if (prefsType?.type?.toUpperCase() === 'INTEGER') {
  db.exec(`
    ALTER TABLE user_prefs RENAME TO user_prefs_legacy;
    CREATE TABLE user_prefs (
      user_id TEXT PRIMARY KEY,
      muted   INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO user_prefs (user_id, muted)
      SELECT CAST(user_id AS TEXT), muted FROM user_prefs_legacy;
    DROP TABLE user_prefs_legacy;
  `);
}
