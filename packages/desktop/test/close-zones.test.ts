import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hitsAny, sanitizeZones } from '../src/main/close-zones.ts';

describe('sanitizeZones', () => {
  it('garde les rectangles bien formes', () => {
    const zones = [{ left: 10, top: 20, right: 50, bottom: 60 }];
    assert.deepEqual(sanitizeZones(zones), zones);
  });

  it('rejette tout ce qui n est pas un tableau', () => {
    assert.deepEqual(sanitizeZones(null), []);
    assert.deepEqual(sanitizeZones({ left: 0, top: 0, right: 1, bottom: 1 }), []);
  });

  it('ecarte les valeurs non numeriques, infinies ou les rectangles vides', () => {
    const zones = sanitizeZones([
      { left: '0', top: 0, right: 10, bottom: 10 },
      { left: 0, top: 0, right: Infinity, bottom: 10 },
      { left: 10, top: 0, right: 10, bottom: 10 },
      null,
      { left: 0, top: 0, right: 10, bottom: 10, extra: 'x' },
    ]);
    assert.deepEqual(zones, [{ left: 0, top: 0, right: 10, bottom: 10 }]);
  });

  it('plafonne le nombre de zones', () => {
    const many = Array.from({ length: 100 }, () => ({ left: 0, top: 0, right: 1, bottom: 1 }));
    assert.equal(sanitizeZones(many).length, 32);
  });
});

describe('hitsAny', () => {
  const zones = [
    { left: 100, top: 100, right: 140, bottom: 140 },
    { left: 500, top: 50, right: 540, bottom: 90 },
  ];

  it('detecte un point dans une croix', () => {
    assert.equal(hitsAny(zones, 120, 120), true);
    assert.equal(hitsAny(zones, 500, 50), true);
  });

  it('laisse passer un point hors des croix', () => {
    assert.equal(hitsAny(zones, 99, 120), false);
    assert.equal(hitsAny(zones, 140, 120), false);
    assert.equal(hitsAny([], 0, 0), false);
  });
});
