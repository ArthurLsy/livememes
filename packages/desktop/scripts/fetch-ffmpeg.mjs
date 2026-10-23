// Telecharge le binaire ffmpeg embarque par l'editeur dans vendor/ffmpeg/<os>-<arch>/,
// ou electron-builder le reprend (extraResources). Builds statiques du projet
// ffmpeg-static, version et sha256 epingles : un binaire modifie est refuse.
//
//   npm run ffmpeg -w @livememes/desktop                 plateforme courante
//   npm run ffmpeg -w @livememes/desktop -- mac-x64 mac-arm64
import { createHash } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const RELEASE = 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1';
const vendor = path.join(path.dirname(fileURLToPath(import.meta.url)), '../vendor/ffmpeg');

/** Cle au format des macros electron-builder `${os}-${arch}`. */
const TARGETS = {
  'win-x64': {
    name: 'win32-x64',
    binary: '8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77',
    license: '8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903',
  },
  'mac-x64': {
    name: 'darwin-x64',
    binary: '929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106',
    license: '2e1d16c72fd74e12063776371da757322f8b77589386532f4fd8634bde7de1af',
  },
  'mac-arm64': {
    name: 'darwin-arm64',
    binary: '8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa',
    license: 'cb48bf09a11f5fb576cddb0431c8f5ed0a60157a9ec942adffc13907cbe083f2',
  },
  'linux-x64': {
    name: 'linux-x64',
    binary: 'bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa',
    license: '8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903',
  },
};

const OS = { win32: 'win', darwin: 'mac', linux: 'linux' };

async function download(asset, sha256) {
  const response = await fetch(`${RELEASE}/${asset}`);
  if (!response.ok) throw new Error(`${asset} : HTTP ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  const actual = createHash('sha256').update(data).digest('hex');
  if (actual !== sha256) throw new Error(`${asset} : sha256 inattendu (${actual})`);
  return data;
}

async function fetchTarget(key) {
  const target = TARGETS[key];
  if (!target) throw new Error(`Cible inconnue : ${key}. Connues : ${Object.keys(TARGETS).join(', ')}`);

  const dir = path.join(vendor, key);
  await mkdir(dir, { recursive: true });
  const exe = path.join(dir, key.startsWith('win') ? 'ffmpeg.exe' : 'ffmpeg');

  console.log(`[ffmpeg] ${key} : telechargement...`);
  const binary = gunzipSync(await download(`ffmpeg-${target.name}.gz`, target.binary));
  await writeFile(exe, binary);
  await chmod(exe, 0o755);
  // Licence GPL du build, livree a cote du binaire.
  await writeFile(path.join(dir, 'LICENSE.txt'), await download(`${target.name}.LICENSE`, target.license));
  console.log(`[ffmpeg] ${key} : ${exe}`);
}

const keys = process.argv.slice(2);
if (keys.length === 0) keys.push(`${OS[process.platform]}-${process.arch}`);
for (const key of keys) await fetchTarget(key);
