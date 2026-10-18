import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Le module config lit l'environnement a l'import : on le prepare avant.
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'livememes-test-'));
process.env.DISCORD_TOKEN = 'test-token';
process.env.DISCORD_CLIENT_ID = 'test-client';
process.env.DATA_DIR = tmpData;
process.env.PORT = '0';
const MAX_BYTES = 1024;
process.env.MEDIA_MAX_BYTES = String(MAX_BYTES);

const { createApp } = await import('../src/http/app.ts');
const { ingest, MediaError, purgeExpired, resolve } = await import('../src/media/cache.ts');
const { isPublicAddress } = await import('../src/media/fetch.ts');
const { matchesSignature } = await import('../src/media/sniff.ts');

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('0000000dIHDR-faux-png-de-test'),
]);

/**
 * Le serveur de test ecoute sur 127.0.0.1, refuse par defaut. Cette politique
 * l'autorise lui seul : toute autre adresse interne reste bloquee.
 */
const localOnly = { isAllowedAddress: (ip: string) => ip === '127.0.0.1' || isPublicAddress(ip) };

let origin: Server;
let originUrl: string;
let port: number;
let app: Server;
let appUrl: string;
/** Requetes recues par le serveur d'origine, par chemin. */
const hits = new Map<string, number>();

function listen(server: Server): Promise<string> {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)),
  );
}

before(async () => {
  origin = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://origine').pathname;
    hits.set(pathname, (hits.get(pathname) ?? 0) + 1);
    switch (pathname) {
      case '/vrai.png':
        res.writeHead(200, { 'content-type': 'image/png' }).end(PNG);
        return;
      case '/html-deguise.png':
        res.writeHead(200, { 'content-type': 'image/png' }).end('<!doctype html><script>alert(1)</script>');
        return;
      case '/svg-deguise.gif':
        res.writeHead(200, { 'content-type': 'image/gif' }).end('<svg xmlns="http://www.w3.org/2000/svg"/>');
        return;
      case '/vers-prive':
        res.writeHead(302, { location: `http://127.0.0.2:${port}/vrai.png` }).end();
        return;
      case '/vers-metadonnees':
        res.writeHead(301, { location: 'http://169.254.169.254/latest/meta-data/' }).end();
        return;
      case '/vers-public':
        res.writeHead(302, { location: '/vrai.png' }).end();
        return;
      case '/annonce-lourd.png':
        res
          .writeHead(200, { 'content-type': 'image/png', 'content-length': String(MAX_BYTES * 4) })
          .end(Buffer.concat([PNG, Buffer.alloc(MAX_BYTES * 4 - PNG.length)]));
        return;
      case '/flux-lourd.png':
        // Sans content-length : seule la coupure du flux protege.
        res.writeHead(200, { 'content-type': 'image/png' });
        res.write(PNG);
        res.end(Buffer.alloc(MAX_BYTES * 2));
        return;
      case '/page.html':
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<p>salut</p>');
        return;
      case '/vide.png':
        res.writeHead(200, { 'content-type': 'image/png' }).end();
        return;
      case '/panne.png':
        res.writeHead(500).end();
        return;
      case '/boucle':
        res.writeHead(302, { location: '/boucle' }).end();
        return;
      default:
        res.writeHead(404).end();
    }
  });
  originUrl = await listen(origin);
  port = (origin.address() as AddressInfo).port;

  app = createServer(createApp());
  appUrl = await listen(app);
});

after(() => {
  origin.close();
  app.close();
  fs.rmSync(tmpData, { recursive: true, force: true });
});

function mediaDir(): string {
  return path.join(tmpData, 'media');
}

/** Fichiers du cache pour une URL source (meme derivation d'id que cache.ts). */
function filesFor(url: string): string[] {
  const id = createHash('sha256').update(url).digest('base64url').slice(0, 22);
  return fs.readdirSync(mediaDir()).filter((file) => file.startsWith(`${id}.`));
}

/** Attend un rejet MediaError dont le message contient `fragment`. */
async function rejects(promise: Promise<unknown>, fragment: RegExp): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof MediaError, `MediaError attendue, recu ${String(error)}`);
    assert.match(error.message, fragment);
    return true;
  });
}

describe('ssrf', () => {
  for (const url of [
    'http://127.0.0.1/x.png',
    'http://10.1.2.3/x.png',
    'http://192.168.1.1/x.png',
    'http://172.20.0.5/x.png',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/x.png',
    'http://[::ffff:127.0.0.1]/x.png',
    'http://[fd00::1]/x.png',
    'http://0.0.0.0/x.png',
  ]) {
    it(`refuse ${url}`, async () => {
      await rejects(ingest(url), /reseau interne/);
    });
  }

  it('refuse un nom de domaine qui resout vers une adresse interne', async () => {
    await rejects(ingest(`http://localhost:${port}/vrai.png`), /reseau interne/);
  });

  it('refuse par defaut le serveur local de test', async () => {
    await rejects(ingest(`${originUrl}/vrai.png`), /reseau interne/);
  });

  it('refuse une redirection vers une adresse interne', async () => {
    await rejects(ingest(`${originUrl}/vers-prive`, localOnly), /reseau interne/);
    await rejects(ingest(`${originUrl}/vers-metadonnees`, localOnly), /reseau interne/);
  });

  it('suit une redirection autorisee', async () => {
    const cached = await ingest(`${originUrl}/vers-public`, localOnly);
    assert.equal(cached.contentType, 'image/png');
  });

  it('borne le nombre de redirections', async () => {
    await rejects(ingest(`${originUrl}/boucle`, localOnly), /Trop de redirections/);
  });

  it('refuse les schemas non http', async () => {
    await rejects(ingest('file:///etc/passwd'), /http\(s\)/);
  });

  it('classe correctement les adresses', () => {
    assert.equal(isPublicAddress('8.8.8.8'), true);
    assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
    assert.equal(isPublicAddress('100.64.0.1'), false);
    assert.equal(isPublicAddress('fe80::1'), false);
    assert.equal(isPublicAddress('pas-une-ip'), false);
  });
});

describe('type reel des medias', () => {
  it('accepte un vrai PNG', async () => {
    const cached = await ingest(`${originUrl}/vrai.png`, localOnly);
    assert.equal(cached.kind, 'image');
    assert.equal(cached.bytes, PNG.length);
  });

  it('refuse du HTML deguise en PNG', async () => {
    await rejects(ingest(`${originUrl}/html-deguise.png`, localOnly), /ne correspond pas/);
  });

  it('refuse du SVG deguise en GIF', async () => {
    await rejects(ingest(`${originUrl}/svg-deguise.gif`, localOnly), /ne correspond pas/);
  });

  it('ne laisse pas de fichier apres un refus', () => {
    for (const name of ['html-deguise.png', 'svg-deguise.gif']) {
      assert.deepEqual(filesFor(`${originUrl}/${name}`), [], `${name} est reste sur disque`);
    }
  });

  it('reconnait les signatures des formats acceptes', () => {
    const ftyp = (brand: string) => Buffer.from(`\0\0\0\x18ftyp${brand}\0\0\0\0`, 'latin1');
    assert.ok(matchesSignature('image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0])));
    assert.ok(matchesSignature('image/gif', Buffer.from('GIF89a')));
    assert.ok(matchesSignature('image/webp', Buffer.from('RIFF\0\0\0\0WEBPVP8 ')));
    assert.ok(matchesSignature('image/avif', ftyp('avif')));
    assert.ok(matchesSignature('video/mp4', ftyp('isom')));
    assert.ok(matchesSignature('video/quicktime', ftyp('qt  ')));
    assert.ok(matchesSignature('video/webm', Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01])));

    assert.ok(!matchesSignature('image/avif', ftyp('isom')));
    assert.ok(!matchesSignature('image/png', Buffer.from([0xff, 0xd8, 0xff, 0xe0])));
    assert.ok(!matchesSignature('text/html', Buffer.from('<html>')));
  });

  it('sert les medias avec nosniff', async () => {
    const cached = await ingest(`${originUrl}/vrai.png`, localOnly);
    const response = await fetch(`${appUrl}/media/${cached.id}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('content-type'), 'image/png');
  });
});

describe('cache media', () => {
  it('refuse un fichier annonce trop lourd', async () => {
    const url = `${originUrl}/annonce-lourd.png`;
    await rejects(ingest(url, localOnly), /trop lourd/);
    assert.deepEqual(filesFor(url), []);
  });

  it('coupe un flux qui depasse la taille max sans content-length', async () => {
    const url = `${originUrl}/flux-lourd.png`;
    await rejects(ingest(url, localOnly), /trop lourd/);
    assert.deepEqual(filesFor(url), []);
  });

  it('refuse un type hors liste', async () => {
    await rejects(ingest(`${originUrl}/page.html`, localOnly), /non supporte \(text\/html\)/);
  });

  it('refuse un fichier vide', async () => {
    const url = `${originUrl}/vide.png`;
    await rejects(ingest(url, localOnly), /vide/);
    assert.deepEqual(filesFor(url), []);
  });

  it('remonte une erreur HTTP distante', async () => {
    await rejects(ingest(`${originUrl}/panne.png`, localOnly), /repondu 500/);
  });

  it('ne retelecharge pas un media deja en cache', async () => {
    const url = `${originUrl}/vrai.png?cache`;
    const before = hits.get('/vrai.png') ?? 0;
    const first = await ingest(url, localOnly);
    const second = await ingest(url, localOnly);
    assert.equal(second.id, first.id);
    assert.equal(hits.get('/vrai.png'), before + 1);
  });

  it('purge les medias non consultes depuis le TTL', async () => {
    const stale = `${originUrl}/vrai.png?ancien`;
    const fresh = `${originUrl}/vrai.png?recent`;
    const old = await ingest(stale, localOnly);
    await ingest(fresh, localOnly);

    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(path.join(mediaDir(), filesFor(stale)[0]!), twoDaysAgo, twoDaysAgo);
    await purgeExpired();

    assert.deepEqual(filesFor(stale), []);
    assert.equal(filesFor(fresh).length, 1);
    assert.equal(resolve(old.id), null);
  });

  it('retrouve un media sur disque apres un redemarrage', async () => {
    // Fichier absent de l'index memoire, comme apres un redemarrage du process.
    fs.writeFileSync(path.join(mediaDir(), 'repriseApresRedemarrage.gif'), 'GIF89a');
    assert.equal(resolve('repriseApresRedemarrage')?.contentType, 'image/gif');

    const response = await fetch(`${appUrl}/media/repriseApresRedemarrage`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/gif');
  });

  it('ignore un fichier a l extension inconnue', () => {
    fs.writeFileSync(path.join(mediaDir(), 'intrus.html'), '<script></script>');
    assert.equal(resolve('intrus'), null);
  });
});
