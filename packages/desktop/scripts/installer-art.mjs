// Exporte les visuels d'installeur depuis leurs sources SVG (build/*.svg) :
// BMP 24 bits pour NSIS (seul format accepte), PNG 1x et 2x pour le DMG.
// A relancer apres avoir modifie un SVG : npm run art -w @livememes/desktop
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../build');

async function render(name, width) {
  const svg = await readFile(path.join(dir, `${name}.svg`), 'utf8');
  return new Resvg(svg, { fitTo: { mode: 'width', value: width }, background: '#0d1226' }).render();
}

/** BMP 24 bits non compresse : lignes de bas en haut, BGR, alignees sur 4 octets. */
function toBmp({ width, height, pixels }) {
  const stride = Math.ceil((width * 3) / 4) * 4;
  const size = 54 + stride * height;
  const out = Buffer.alloc(size);
  out.write('BM', 0);
  out.writeUInt32LE(size, 2);
  out.writeUInt32LE(54, 10);
  out.writeUInt32LE(40, 14);
  out.writeInt32LE(width, 18);
  out.writeInt32LE(height, 22);
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(24, 28);
  out.writeUInt32LE(stride * height, 34);
  out.writeInt32LE(2835, 38);
  out.writeInt32LE(2835, 42);
  for (let y = 0; y < height; y++) {
    const row = 54 + (height - 1 - y) * stride;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      out[row + x * 3] = pixels[i + 2];
      out[row + x * 3 + 1] = pixels[i + 1];
      out[row + x * 3 + 2] = pixels[i];
    }
  }
  return out;
}

for (const [name, width] of [
  ['installerSidebar', 164],
  ['installerHeader', 150],
]) {
  await writeFile(path.join(dir, `${name}.bmp`), toBmp(await render(name, width)));
}

await writeFile(path.join(dir, 'background.png'), (await render('background', 540)).asPng());
await writeFile(path.join(dir, 'background@2x.png'), (await render('background', 1080)).asPng());

console.log('[art] visuels d\'installeur regeneres dans build/');
