import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');
const start = process.argv.includes('--start');

/** Electron charge le main en CJS : on bundle tout, ws inclus. */
const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  logLevel: 'info',
  external: ['electron'],
};

const builds = [
  {
    ...common,
    entryPoints: [path.join(here, 'src/main/index.ts')],
    outfile: path.join(here, 'dist/main/index.cjs'),
    format: 'cjs',
  },
  {
    ...common,
    entryPoints: [path.join(here, 'src/preload/index.ts')],
    outfile: path.join(here, 'dist/preload/index.cjs'),
    format: 'cjs',
  },
  {
    ...common,
    platform: 'browser',
    target: 'chrome126',
    entryPoints: [
      path.join(here, 'src/renderer/overlay.ts'),
      path.join(here, 'src/renderer/settings.ts'),
    ],
    outdir: path.join(here, 'dist/renderer'),
    format: 'iife',
  },
];

async function copyStatic() {
  await fs.mkdir(path.join(here, 'dist/renderer'), { recursive: true });
  const dir = path.join(here, 'src/renderer');
  for (const name of await fs.readdir(dir)) {
    if (/\.(html|css|svg)$/.test(name)) {
      await fs.copyFile(path.join(dir, name), path.join(here, 'dist/renderer', name));
    }
  }
}

await copyStatic();

if (watch) {
  const contexts = await Promise.all(builds.map((options) => esbuild.context(options)));
  await Promise.all(contexts.map((context) => context.watch()));
  console.log('[build] watch actif');

  if (start) {
    const electron = (await import('electron')).default;
    spawn(electron, [here], { stdio: 'inherit' }).on('exit', () => process.exit(0));
  }
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
}
