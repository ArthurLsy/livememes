import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { soundDisplay, volumeFor } from '../src/main/sound-display.ts';

describe('son sur plusieurs ecrans (#38)', () => {
  it('joue le son sur l ecran principal quand il affiche des memes', () => {
    assert.equal(soundDisplay([7, 1, 3], 1), 1);
  });

  it('se rabat sur le premier ecran cible sinon', () => {
    assert.equal(soundDisplay([7, 3], 1), 7);
    assert.equal(soundDisplay([], 1), null);
  });

  it('coupe le son de toutes les autres fenetres', () => {
    const targets = [7, 1, 3];
    const soundOn = soundDisplay(targets, 1);
    const volumes = targets.map((id) => volumeFor(id, soundOn, 0.6));
    assert.deepEqual(volumes, [0, 0.6, 0]);
    assert.equal(volumes.filter((volume) => volume > 0).length, 1);
  });
});
