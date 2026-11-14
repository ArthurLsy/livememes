import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Le module config lit l'environnement a l'import : on le prepare avant.
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'livememes-library-'));
const libraryDir = path.join(tmpData, 'library');
fs.mkdirSync(libraryDir);
process.env.DISCORD_TOKEN = 'test-token';
process.env.DISCORD_CLIENT_ID = 'test-client';
process.env.DATA_DIR = tmpData;
process.env.PORT = '0';
process.env.PUBLIC_URL = 'https://memes.example';

const { createApp } = await import('../src/http/app.ts');
const { createPairingCode, redeemPairingCode } = await import('../src/store/devices.ts');
const catalog = await import('../src/library/catalog.ts');
type LibraryResponse = import('@livememes/shared').LibraryResponse;

let server: Server;
let baseUrl: string;
let token: string;

const VIDEO = Buffer.from('faux mp4 de test, assez long pour une requete Range');

function writeCatalog(videos: unknown[]): void {
  const file = path.join(libraryDir, catalog.MANIFEST);
  fs.writeFileSync(file, JSON.stringify({ videos }));
  // Force une date differente : deux ecritures dans la meme milliseconde
  // garderaient le meme mtime et le cache.
  const later = new Date(Date.now() + Math.random() * 100_000);
  fs.utimesSync(file, later, later);
}

before(async () => {
  fs.writeFileSync(path.join(libraryDir, 'chat.mp4'), VIDEO);
  fs.writeFileSync(path.join(libraryDir, 'texte.txt'), 'pas une video');
  fs.writeFileSync(path.join(tmpData, 'secret.mp4'), 'hors de la banque');

  server = createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;

  const { code } = createPairingCode({ id: '400000000000000001', username: 'Equipe', avatarUrl: null });
  token = redeemPairingCode(code, 'PC')!.token;
});

after(() => {
  server.close();
  fs.rmSync(tmpData, { recursive: true, force: true });
});

const getLibrary = (auth = token) =>
  fetch(`${baseUrl}/api/library`, { headers: { authorization: `Bearer ${auth}` } });

describe('catalogue', () => {
  it('ignore les entrees invalides sans casser les autres', () => {
    const logs: string[] = [];
    writeCatalog([
      { id: 'chat', title: 'Chat surpris', tags: ['Chat', ' Reaction '], file: 'chat.mp4' },
      { id: 'chat', title: 'Doublon', file: 'chat.mp4' },
      { id: 'Majuscules', title: 'Id invalide', file: 'chat.mp4' },
      { id: 'texte', title: 'Pas une video', file: 'texte.txt' },
      { id: 'absent', title: 'Fichier absent', file: 'absent.mp4' },
      { id: 'evasion', title: 'Hors banque', file: '../secret.mp4' },
      { id: 'absolu', title: 'Chemin absolu', file: path.join(tmpData, 'secret.mp4') },
    ]);
    const entries = catalog.readCatalog(libraryDir, (message) => logs.push(message));
    assert.deepEqual(entries.map((entry) => entry.id), ['chat']);
    assert.deepEqual(entries[0]?.tags, ['chat', 'reaction']);
    assert.equal(entries[0]?.contentType, 'video/mp4');
    assert.equal(logs.length, 6);
  });

  it('renvoie une banque vide sans catalogue', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'livememes-vide-'));
    assert.deepEqual(catalog.list(empty), []);
    fs.rmSync(empty, { recursive: true });
  });
});

describe('routes de la banque', () => {
  it('refuse le catalogue sans appareil lie', async () => {
    assert.equal((await getLibrary('inconnu')).status, 401);
  });

  it('liste les videos avec leur URL publique', async () => {
    writeCatalog([{ id: 'chat', title: 'Chat surpris', tags: ['chat'], file: 'chat.mp4' }]);
    const response = await getLibrary();
    assert.equal(response.status, 200);
    const body = (await response.json()) as LibraryResponse;
    assert.deepEqual(body.videos, [
      {
        id: 'chat',
        title: 'Chat surpris',
        tags: ['chat'],
        url: 'https://memes.example/library/chat',
        contentType: 'video/mp4',
        bytes: VIDEO.length,
      },
    ]);
  });

  it('prend en compte un catalogue modifie sans redemarrage', async () => {
    writeCatalog([]);
    assert.deepEqual(((await (await getLibrary()).json()) as LibraryResponse).videos, []);
    writeCatalog([{ id: 'chat', title: 'Chat surpris', file: 'chat.mp4' }]);
    assert.equal(((await (await getLibrary()).json()) as LibraryResponse).videos.length, 1);
  });

  it('sert le fichier, requetes Range comprises', async () => {
    writeCatalog([{ id: 'chat', title: 'Chat surpris', file: 'chat.mp4' }]);
    const full = await fetch(`${baseUrl}/library/chat`);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('content-type'), 'video/mp4');
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), VIDEO);

    const partial = await fetch(`${baseUrl}/library/chat`, { headers: { range: 'bytes=0-3' } });
    assert.equal(partial.status, 206);
    assert.equal(await partial.text(), 'faux');
  });

  it('repond 404 pour une video inconnue ou un id malforme', async () => {
    assert.equal((await fetch(`${baseUrl}/library/inconnue`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/library/..%2Fsecret.mp4`)).status, 404);
  });
});
