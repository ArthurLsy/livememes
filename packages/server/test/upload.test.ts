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
process.env.MEDIA_MAX_BYTES = String(64 * 1024);
process.env.DROP_COOLDOWN_MS = '60000';

const { createApp, parseDisplayOptions } = await import('../src/http/app.ts');
const { attachGateway } = await import('../src/realtime/gateway.ts');
const { createPairingCode } = await import('../src/store/devices.ts');
const { WebSocket } = await import('ws');
type ServerMessage = import('@livememes/shared').ServerMessage;
type DropUploadResponse = import('@livememes/shared').DropUploadResponse;
type SenderLookup = import('../src/bot/drop.ts').SenderLookup;

/** PNG 1x1 valide : la signature est verifiee a l'upload. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

const SENDER = { id: '111111111111111111', username: 'Arthur', avatarUrl: null };
const VIEWER = '222222222222222222';

/** Salon vocal simule, par utilisateur : remplace le bot Discord. */
const voice = new Map<string, SenderLookup>();

let server: Server;
let baseUrl: string;
let wsUrl: string;

async function pair(user: { id: string; username: string; avatarUrl: string | null }): Promise<string> {
  const { code } = createPairingCode(user);
  const response = await fetch(`${baseUrl}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, deviceName: 'PC de test' }),
  });
  return ((await response.json()) as { token: string }).token;
}

function upload(token: string, body: Buffer, contentType = 'image/png', query = ''): Promise<Response> {
  return fetch(`${baseUrl}/api/drops${query}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': contentType },
    body,
  });
}

function nextDrop(socket: InstanceType<typeof WebSocket>): Promise<Extract<ServerMessage, { t: 'drop' }>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout en attendant "drop"')), 3000);
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw)) as ServerMessage;
      if (message.t !== 'drop') return;
      clearTimeout(timer);
      resolve(message);
    });
  });
}

before(async () => {
  const locateSender = async (userId: string): Promise<SenderLookup> =>
    voice.get(userId) ?? { ok: false, reason: 'not-in-voice' };
  server = createServer(createApp({ locateSender }));
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

describe('parseDisplayOptions', () => {
  it('applique les defauts de /meme', () => {
    assert.deepEqual(parseDisplayOptions({}), {
      durationMs: null,
      position: 'center',
      size: 'medium',
      volume: 0.6,
      caption: null,
    });
  });

  it('lit les options valides', () => {
    const options = parseDisplayOptions({ size: 'huge', position: 'top-left', volume: '0', duration: '12' });
    assert.deepEqual(options, { durationMs: 12_000, position: 'top-left', size: 'huge', volume: 0, caption: null });
  });

  it('refuse les valeurs hors bornes', () => {
    assert.equal(typeof parseDisplayOptions({ size: 'geant' }), 'string');
    assert.equal(typeof parseDisplayOptions({ position: 'milieu' }), 'string');
    assert.equal(typeof parseDisplayOptions({ volume: '101' }), 'string');
    assert.equal(typeof parseDisplayOptions({ volume: '-1' }), 'string');
    assert.equal(typeof parseDisplayOptions({ duration: '0' }), 'string');
    assert.equal(typeof parseDisplayOptions({ duration: '9999' }), 'string');
  });
});

describe('envoi direct depuis l editeur', () => {
  it('refuse un appareil non lie', async () => {
    const response = await upload('nimportequoi', PNG);
    assert.equal(response.status, 401);
  });

  it('refuse un utilisateur hors vocal', async () => {
    const token = await pair({ ...SENDER, id: '333' });
    const response = await upload(token, PNG);
    assert.equal(response.status, 409);
    assert.match(((await response.json()) as { error: string }).error, /salon vocal/);
  });

  it('refuse un utilisateur sans le role requis', async () => {
    const token = await pair({ ...SENDER, id: '444' });
    voice.set('444', { ok: false, reason: 'no-role' });
    assert.equal((await upload(token, PNG)).status, 403);
  });

  it('refuse un type hors allowlist et un contenu deguise', async () => {
    const token = await pair({ ...SENDER, id: '666' });
    voice.set('666', { ok: true, channelName: 'Vocal', sender: { author: SENDER, guildName: 'Test', audience: [] } });

    assert.equal((await upload(token, Buffer.from('<svg/>'), 'image/svg+xml')).status, 415);

    const disguised = await upload(token, Buffer.from('<html><script>alert(1)</script></html>'));
    assert.equal(disguised.status, 400);
    assert.match(((await disguised.json()) as { error: string }).error, /ne correspond pas/);
  });

  it('refuse un fichier trop lourd', async () => {
    const token = await pair({ ...SENDER, id: '888' });
    voice.set('888', { ok: true, channelName: 'Vocal', sender: { author: SENDER, guildName: 'Test', audience: [] } });
    const big = Buffer.concat([PNG, Buffer.alloc(128 * 1024)]);
    assert.equal((await upload(token, big)).status, 413);
  });

  it('livre le meme au salon vocal puis applique le cooldown', async () => {
    const senderToken = await pair(SENDER);
    const viewerToken = await pair({ id: VIEWER, username: 'Viewer', avatarUrl: null });
    voice.set(SENDER.id, {
      ok: true,
      channelName: 'Vocal',
      sender: { author: SENDER, guildName: 'Test', audience: [SENDER.id, VIEWER] },
    });

    const socket = new WebSocket(`${wsUrl}?token=${viewerToken}`);
    await new Promise((resolve) => socket.once('message', resolve));
    const dropped = nextDrop(socket);

    const response = await upload(senderToken, PNG, 'image/png', '?size=large&position=top-right&duration=4');
    assert.equal(response.status, 200);
    const report = (await response.json()) as DropUploadResponse;
    assert.deepEqual(report, { channelName: 'Vocal', audience: 2, reached: 1, offline: 1, muted: 0, screens: 1 });

    const { drop } = await dropped;
    assert.equal(drop.kind, 'image');
    assert.equal(drop.position, 'top-right');
    assert.equal(drop.durationMs, 4000);
    assert.equal(drop.author.id, SENDER.id);

    // Le media est re-servi par le backend, octet pour octet.
    const served = await fetch(`${baseUrl}/media/${drop.url.split('/media/')[1]}`);
    assert.equal(served.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), PNG);

    const again = await upload(senderToken, PNG);
    assert.equal(again.status, 429);

    socket.close();
  });
});
