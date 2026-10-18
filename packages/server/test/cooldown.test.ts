import assert from 'node:assert/strict';
import { after, before, describe, it, mock } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Le module config lit l'environnement a l'import : on le prepare avant.
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'livememes-test-'));
process.env.DISCORD_TOKEN = 'test-token';
process.env.DISCORD_CLIENT_ID = 'test-client';
process.env.DATA_DIR = tmpData;
process.env.PORT = '0';
process.env.DROP_COOLDOWN_MS = '8000';

const { cooldownRemaining, startCooldown } = await import('../src/bot/drop.ts');

before(() => mock.timers.enable({ apis: ['Date'], now: 1_000_000 }));
after(() => {
  mock.timers.reset();
  fs.rmSync(tmpData, { recursive: true, force: true });
});

describe('cooldown des drops', () => {
  it('laisse passer un utilisateur qui n a jamais envoye', () => {
    assert.equal(cooldownRemaining('jamais-vu'), 0);
  });

  it('bloque pendant DROP_COOLDOWN_MS puis relache', () => {
    startCooldown('arthur');
    assert.equal(cooldownRemaining('arthur'), 8000);

    mock.timers.tick(5000);
    assert.equal(cooldownRemaining('arthur'), 3000);

    mock.timers.tick(3000);
    assert.equal(cooldownRemaining('arthur'), 0);
    mock.timers.tick(60_000);
    assert.equal(cooldownRemaining('arthur'), 0, 'jamais negatif');
  });

  it('isole les utilisateurs', () => {
    startCooldown('a');
    assert.ok(cooldownRemaining('a') > 0);
    assert.equal(cooldownRemaining('b'), 0);
  });

  it('repart de zero a chaque drop', () => {
    startCooldown('c');
    mock.timers.tick(7000);
    startCooldown('c');
    assert.equal(cooldownRemaining('c'), 8000);
  });
});
