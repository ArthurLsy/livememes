import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { nudge } from '../src/renderer/close.ts';

const SCREEN = [1920, 1080] as const;

describe('nudge', () => {
  it('ne bouge pas une croix deja dans l ecran', () => {
    assert.deepEqual(nudge({ left: 900, top: 300, right: 940, bottom: 340 }, ...SCREEN), { x: 0, y: 0 });
  });

  it('ramene a gauche une croix qui deborde a droite', () => {
    assert.deepEqual(nudge({ left: 1900, top: 300, right: 1940, bottom: 340 }, ...SCREEN), { x: -28, y: 0 });
  });

  it('descend une croix qui sort par le haut', () => {
    assert.deepEqual(nudge({ left: 900, top: -50, right: 940, bottom: -10 }, ...SCREEN), { x: 0, y: 58 });
  });

  it('corrige les deux axes pour un meme ancre en coin', () => {
    assert.deepEqual(nudge({ left: 1950, top: -20, right: 1990, bottom: 20 }, ...SCREEN), { x: -78, y: 28 });
  });

  it('privilegie le bord gauche si la croix ne tient pas', () => {
    assert.deepEqual(nudge({ left: 0, top: 0, right: 30, bottom: 30 }, 20, 20), { x: 8, y: 8 });
  });
});
