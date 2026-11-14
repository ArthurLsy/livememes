import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MEME_POSITIONS, MEME_SIZES } from '@livememes/shared';
import { anchorFor, edgeFor, fitHeight, MIN_MEDIA_HEIGHT, ringFor } from '../src/renderer/placement.ts';

describe('anchorFor', () => {
  it('colle les coins du meme aux coins de l ecran', () => {
    assert.deepEqual(anchorFor('top-left'), { fx: 0, fy: 0 });
    assert.deepEqual(anchorFor('top-right'), { fx: 1, fy: 0 });
    assert.deepEqual(anchorFor('bottom-left'), { fx: 0, fy: 1 });
    assert.deepEqual(anchorFor('bottom-right'), { fx: 1, fy: 1 });
    assert.deepEqual(anchorFor('center'), { fx: 0.5, fy: 0.5 });
  });

  it('garde le placement aleatoire a distance des bords', () => {
    assert.deepEqual(anchorFor('random', () => 0), { fx: 0.1, fy: 0.1 });
    const high = anchorFor('random', () => 0.999999);
    assert.ok(high.fx < 0.9 && high.fy < 0.9);
  });

  it('reste entre 0 et 1 pour toutes les positions', () => {
    for (const position of MEME_POSITIONS) {
      const { fx, fy } = anchorFor(position);
      assert.ok(fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1, position);
    }
  });
});

/**
 * Reproduit le calcul CSS de `.drop` : le meme entier doit tenir dans l'ecran,
 * marges comprises, pour toutes les positions et tailles.
 */
function box(position: Parameters<typeof anchorFor>[0], width: number, height: number, screenW: number, screenH: number) {
  const edge = edgeFor(screenH);
  const { fx, fy } = anchorFor(position, () => 0.5);
  const left = edge + fx * (screenW - 2 * edge) - fx * width;
  const top = edge + fy * (screenH - 2 * edge) - fy * height;
  return { left, top, right: left + width, bottom: top + height };
}

describe('fitHeight', () => {
  const screenW = 1920;
  const screenH = 1080;
  const extra = 90; // auteur + espacements, sans legende

  it('respecte la taille demandee quand elle tient', () => {
    assert.equal(fitHeight({ scale: MEME_SIZES.medium, viewportHeight: screenH, extra }), Math.round(0.45 * screenH));
  });

  it('reduit une taille enorme pour que l auteur reste visible', () => {
    const height = fitHeight({ scale: MEME_SIZES.huge, viewportHeight: screenH, extra });
    assert.ok(height + extra + 2 * edgeFor(screenH) + ringFor(screenH) <= screenH);
  });

  it('ne descend jamais sous la hauteur minimale', () => {
    assert.equal(fitHeight({ scale: 1, viewportHeight: 200, extra: 400 }), MIN_MEDIA_HEIGHT);
  });

  it('un grand meme en haut a gauche n est plus coupe (#27)', () => {
    for (const size of Object.values(MEME_SIZES)) {
      const mediaH = fitHeight({ scale: size, viewportHeight: screenH, extra });
      const total = mediaH + extra;
      // Video 16:9 plafonnee en largeur comme dans overlay.css.
      const width = Math.min((mediaH * 16) / 9, screenW - 2 * edgeFor(screenH));
      for (const position of MEME_POSITIONS) {
        const b = box(position, width, total, screenW, screenH);
        assert.ok(b.left >= 0 && b.top >= 0, `${position} ${size} deborde en haut/gauche`);
        assert.ok(b.right <= screenW && b.bottom <= screenH, `${position} ${size} deborde en bas/droite`);
      }
    }
  });
});
