import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Le module config lit l'environnement a l'import : on le prepare avant.
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'livememes-test-'));
process.env.DISCORD_TOKEN = 'test-token';
process.env.DISCORD_CLIENT_ID = 'test-client';
process.env.DATA_DIR = tmpData;
process.env.PORT = '0';
// Un proxy devant le backend : req.ip vient de X-Forwarded-For.
process.env.TRUST_PROXY = '1';

const { createApp } = await import('../src/http/app.ts');
const { attachGateway } = await import('../src/realtime/gateway.ts');
const { createPairingCode, isMuted, listDevices } = await import('../src/store/devices.ts');
const hub = await import('../src/realtime/hub.ts');
const { WebSocket } = await import('ws');
const { PROTOCOL_VERSION } = await import('@livememes/shared');
type ServerMessage = import('@livememes/shared').ServerMessage;
type MemeDrop = import('@livememes/shared').MemeDrop;

const USER = { id: '123456789012345678', username: 'Arthur', avatarUrl: null };

let server: Server;
let baseUrl: string;
let wsUrl: string;

/** Attend le prochain message correspondant au type demande. */
function waitFor<T extends ServerMessage['t']>(
  socket: InstanceType<typeof WebSocket>,
  type: T,
  timeoutMs = 3000,
): Promise<Extract<ServerMessage, { t: T }>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error(`Timeout en attendant "${type}"`));
    }, timeoutMs);

    function onMessage(raw: unknown): void {
      const message = JSON.parse(String(raw)) as ServerMessage;
      if (message.t !== type) return;
      clearTimeout(timer);
      socket.off('message', onMessage);
      resolve(message as Extract<ServerMessage, { t: T }>);
    }

    socket.on('message', onMessage);
  });
}

function makeDrop(id: string): MemeDrop {
  return {
    id,
    url: 'http://example.test/media/x',
    kind: 'image',
    durationMs: 5000,
    position: 'center',
    scale: 0.45,
    volume: 0.6,
    caption: null,
    author: { id: USER.id, username: USER.username, avatarUrl: null },
    guildName: 'Test',
    sentAt: Date.now(),
  };
}

before(async () => {
  server = createServer(createApp());
  attachGateway(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}/ws`;
});

after(() => {
  server.close();
  fs.rmSync(tmpData, { recursive: true, force: true });
});

describe('appairage', () => {
  it('echange un code contre un token et enregistre le device', async () => {
    const { code } = createPairingCode(USER);

    const response = await fetch(`${baseUrl}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, deviceName: 'PC de test' }),
    });

    assert.equal(response.status, 200);
    const body = (await response.json()) as { token: string; user: { id: string } };
    assert.ok(body.token.length > 20);
    assert.equal(body.user.id, USER.id);

    const devices = listDevices(USER.id);
    assert.equal(devices.length, 1);
    assert.equal(devices[0]?.deviceName, 'PC de test');
  });

  it('refuse un code inconnu', async () => {
    const response = await fetch(`${baseUrl}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'ZZZZZZZZ', deviceName: 'PC' }),
    });
    assert.equal(response.status, 400);
  });

  it('compte les tentatives par client derriere le proxy', async () => {
    const attempt = (ip: string) =>
      fetch(`${baseUrl}/api/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
        body: JSON.stringify({ code: 'ZZZZZZZZ', deviceName: 'PC' }),
      }).then((response) => response.status);

    for (let i = 0; i < 10; i++) assert.equal(await attempt('203.0.113.10'), 400);
    assert.equal(await attempt('203.0.113.10'), 429);
    // Un autre client, meme proxy : compteur intact.
    assert.equal(await attempt('203.0.113.20'), 400);
  });

  it('refuse de reutiliser un code deja consomme', async () => {
    const { code } = createPairingCode({ ...USER, id: '999' });
    const payload = { code, deviceName: 'PC' };
    const options = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    };

    assert.equal((await fetch(`${baseUrl}/api/pair`, options)).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/pair`, options)).status, 400);
  });
});

describe('relais websocket', () => {
  it('rejette un token invalide', async () => {
    const socket = new WebSocket(`${wsUrl}?token=nimportequoi`);
    const message = await waitFor(socket, 'error');
    assert.equal(message.code, 'unauthorized');
    socket.close();
  });

  it('livre un drop a toutes les machines de l utilisateur', async () => {
    const { code } = createPairingCode({ ...USER, id: '555' });
    const paired = await fetch(`${baseUrl}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, deviceName: 'Poste 1' }),
    });
    const { token } = (await paired.json()) as { token: string };

    // Deux onglets/machines avec le meme token : les deux doivent recevoir.
    const a = new WebSocket(`${wsUrl}?token=${token}`);
    const b = new WebSocket(`${wsUrl}?token=${token}`);

    const helloA = await waitFor(a, 'hello');
    await waitFor(b, 'hello');
    assert.equal(helloA.protocol, PROTOCOL_VERSION);
    assert.equal(helloA.muted, false);

    const dropped = waitFor(a, 'drop');
    const droppedB = waitFor(b, 'drop');

    const result = hub.broadcast(['555'], makeDrop('drop-1'), new Set());
    assert.deepEqual(result.reached, ['555']);
    assert.equal(result.screens, 2);

    assert.equal((await dropped).drop.id, 'drop-1');
    assert.equal((await droppedB).drop.id, 'drop-1');

    a.close();
    b.close();
  });

  it('ne livre rien a un utilisateur en sourdine', async () => {
    const result = hub.broadcast(['555'], makeDrop('drop-2'), new Set(['555']));
    assert.deepEqual(result.muted, ['555']);
    assert.equal(result.screens, 0);
  });

  it('signale les cibles sans overlay connecte', () => {
    const result = hub.broadcast(['id-hors-ligne'], makeDrop('drop-3'), new Set());
    assert.deepEqual(result.offline, ['id-hors-ligne']);
    assert.deepEqual(result.reached, []);
  });

  it('persiste la sourdine demandee par le client', async () => {
    const { code } = createPairingCode({ ...USER, id: '777' });
    const paired = await fetch(`${baseUrl}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, deviceName: 'Poste mute' }),
    });
    const { token } = (await paired.json()) as { token: string };

    const socket = new WebSocket(`${wsUrl}?token=${token}`);
    await waitFor(socket, 'hello');

    const confirmed = waitFor(socket, 'muted');
    socket.send(JSON.stringify({ t: 'setMuted', muted: true }));

    assert.equal((await confirmed).muted, true);
    assert.equal(isMuted('777'), true);
    socket.close();
  });
});

describe('media', () => {
  it('renvoie 404 pour un id inconnu', async () => {
    const response = await fetch(`${baseUrl}/media/inexistant`);
    assert.equal(response.status, 404);
  });

  it('rejette un id malforme', async () => {
    const response = await fetch(`${baseUrl}/media/..%2F..%2Fetc%2Fpasswd`);
    assert.equal(response.status, 400);
  });
});
