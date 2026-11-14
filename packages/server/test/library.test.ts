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
type LibraryAddResponse = import('@livememes/shared').LibraryAddResponse;
const { LIBRARY_MAX_ADDS } = await import('../src/http/app.ts');

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

/** Debut valide d'un MP4 : boite ftyp, assez pour la verification de signature. */
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(64, 1)]);

function addVideo(query: string, body: Buffer = MP4, type = 'video/mp4', auth = token) {
  return fetch(`${baseUrl}/api/library?${query}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${auth}`, 'content-type': type },
    body,
  });
}

describe('ajout a la banque', () => {
  it('nettoie titre et tags', () => {
    assert.deepEqual(catalog.parseSubmission('  Chat   surpris ', '#Chat, reaction,,chat'), {
      title: 'Chat surpris',
      tags: ['chat', 'reaction'],
    });
    assert.equal(typeof catalog.parseSubmission('', ''), 'string');
    assert.equal(catalog.slugify('Été à fond !!'), 'ete-a-fond');
    assert.equal(catalog.slugify('???'), 'video');
  });

  it('publie la video tout de suite dans le catalogue', async () => {
    writeCatalog([{ id: 'chat', title: 'Chat surpris', file: 'chat.mp4' }]);
    const response = await addVideo(new URLSearchParams({ title: 'Foule en délire', tags: 'sport, joie' }).toString());
    assert.equal(response.status, 201);
    const { video } = (await response.json()) as LibraryAddResponse;
    assert.match(video.id, /^foule-en-delire-[0-9a-f]{6}$/);
    assert.deepEqual(video.tags, ['sport', 'joie']);
    assert.equal(video.url, `https://memes.example/library/${video.id}`);

    const listed = ((await (await getLibrary()).json()) as LibraryResponse).videos;
    assert.deepEqual(listed.map((entry) => entry.id), ['chat', video.id]);
    assert.deepEqual(Buffer.from(await (await fetch(`${baseUrl}/library/${video.id}`)).arrayBuffer()), MP4);

    // Les entrees existantes et la trace de l'auteur sont gardees.
    const manifest = JSON.parse(fs.readFileSync(path.join(libraryDir, catalog.MANIFEST), 'utf8'));
    assert.equal(manifest.videos[1].addedBy, '400000000000000001');
  });

  it('refuse sans appareil, sans titre, hors video ou deguise', async () => {
    assert.equal((await addVideo('title=x', MP4, 'video/mp4', 'inconnu')).status, 401);
    assert.equal((await addVideo('title=')).status, 400);
    assert.equal((await addVideo('title=x', Buffer.from('GIF89a........'), 'image/gif')).status, 415);
    assert.equal((await addVideo('title=x', Buffer.from('<html>pas une video</html>'))).status, 400);
  });

  it('n ecrase pas un catalogue illisible', async () => {
    const file = path.join(libraryDir, catalog.MANIFEST);
    fs.writeFileSync(file, '{ casse');
    assert.equal((await addVideo('title=Test')).status, 500);
    assert.equal(fs.readFileSync(file, 'utf8'), '{ casse');
    writeCatalog([]);
  });

  it('limite le nombre d ajouts par heure', async () => {
    writeCatalog([]);
    const { code } = createPairingCode({ id: '400000000000000009', username: 'Pressé', avatarUrl: null });
    const other = redeemPairingCode(code, 'PC')!.token;
    for (let i = 0; i < LIBRARY_MAX_ADDS; i++) {
      assert.equal((await addVideo(`title=Video ${i}`, MP4, 'video/mp4', other)).status, 201);
    }
    assert.equal((await addVideo('title=Une de trop', MP4, 'video/mp4', other)).status, 429);
  });

  it('serialise les ajouts simultanes', async () => {
    writeCatalog([]);
    const { code } = createPairingCode({ id: '400000000000000010', username: 'Rapide', avatarUrl: null });
    const fast = redeemPairingCode(code, 'PC')!.token;
    const statuses = await Promise.all(
      Array.from({ length: 5 }, (_, i) => addVideo(`title=Parallele ${i}`, MP4, 'video/mp4', fast).then((r) => r.status)),
    );
    assert.deepEqual(statuses, [201, 201, 201, 201, 201]);
    const manifest = JSON.parse(fs.readFileSync(path.join(libraryDir, catalog.MANIFEST), 'utf8'));
    assert.equal(manifest.videos.length, 5);
  });
});
