import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Le module config lit l'environnement a l'import : on le prepare avant.
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'livememes-test-'));
process.env.DISCORD_TOKEN = 'test-token';
process.env.DISCORD_CLIENT_ID = 'test-client';
process.env.DATA_DIR = tmpData;
process.env.PORT = '0';
process.env.DROP_DEFAULT_DURATION_MS = '6000';
process.env.DROP_MAX_DURATION_MS = '20000';
process.env.DROP_MAX_VIDEO_DURATION_MS = '60000';

const { resolveDuration } = await import('../src/bot/drop.ts');

describe('duree des drops', () => {
  it('garde la duree demandee pour une image, sans plafond video', () => {
    assert.deepEqual(resolveDuration('image', null), { durationMs: 6000 });
    assert.deepEqual(resolveDuration('image', 10_000), { durationMs: 10_000 });
    assert.deepEqual(resolveDuration('image', 45_000), { durationMs: 20_000 });
  });

  it('laisse une video aller jusqu au bout, sous le plafond video', () => {
    // Une video de 45 s passe sous le plafond par defaut de 60 s.
    assert.deepEqual(resolveDuration('video', null), { durationMs: 6000, maxDurationMs: 60_000 });
  });

  it('fait de la duree demandee le plafond d une video', () => {
    assert.deepEqual(resolveDuration('video', 5000), { durationMs: 5000, maxDurationMs: 5000 });
    assert.deepEqual(resolveDuration('video', 45_000), { durationMs: 20_000, maxDurationMs: 45_000 });
    assert.deepEqual(resolveDuration('video', 90_000), { durationMs: 20_000, maxDurationMs: 60_000 });
  });
});
