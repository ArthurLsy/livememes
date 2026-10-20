import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { initialOf } from '../src/renderer/avatar.ts';
import {
  levelFromKey,
  levelFromPointer,
  statusView,
  VOLUME_BAR_HEIGHTS,
  VOLUME_STEPS,
  volumeLevel,
} from '../src/renderer/settings-view.ts';

const base = { linked: true, status: 'online' as const, detail: null, muted: false };

describe('statusView', () => {
  it('pulse en vert quand tout est connecte', () => {
    assert.deepEqual(statusView(base), { label: 'Connecte', cls: 'online', detail: null });
  });

  it('passe en rouge "Sourdine" quand la reception est coupee', () => {
    assert.deepEqual(statusView({ ...base, muted: true }), { label: 'Sourdine', cls: 'error', detail: null });
  });

  it('garde le detail de reconnexion sous la pastille', () => {
    const view = statusView({ ...base, status: 'offline', detail: 'Reconnexion dans 4s' });
    assert.equal(view.label, 'Deconnecte');
    assert.equal(view.detail, 'Reconnexion dans 4s');
  });

  it('affiche "Non lie" sans detail tant que l appareil n est pas lie', () => {
    assert.deepEqual(statusView({ ...base, linked: false, status: 'unauthorized', detail: 'revoque' }), {
      label: 'Non lie',
      cls: 'error',
      detail: null,
    });
  });

  it('signale la connexion en cours en orange', () => {
    assert.equal(statusView({ ...base, status: 'connecting' }).cls, 'connecting');
  });
});

describe('volume', () => {
  it('a une barre par tranche', () => {
    assert.equal(VOLUME_BAR_HEIGHTS.length, VOLUME_STEPS);
  });

  it('arrondit un ancien reglage au pas de 5 %', () => {
    assert.equal(volumeLevel(0.7), 7);
    assert.equal(volumeLevel(0.75), 8);
    assert.equal(volumeLevel(0), 0);
    assert.equal(volumeLevel(1.4), 10);
  });

  it('allume la barre sous le pointeur', () => {
    assert.equal(levelFromPointer(1, 400), 1);
    assert.equal(levelFromPointer(200, 400), 5);
    assert.equal(levelFromPointer(399, 400), 10);
    assert.equal(levelFromPointer(800, 400), 10);
  });

  it('coupe le son a gauche de la premiere barre', () => {
    assert.equal(levelFromPointer(0, 400), 0);
    assert.equal(levelFromPointer(-30, 400), 0);
  });

  it('se pilote au clavier dans les bornes', () => {
    assert.equal(levelFromKey('ArrowRight', 7), 8);
    assert.equal(levelFromKey('ArrowLeft', 0), 0);
    assert.equal(levelFromKey('End', 2), 10);
    assert.equal(levelFromKey('Home', 6), 0);
    assert.equal(levelFromKey('PageUp', 9), 10);
    assert.equal(levelFromKey('a', 5), null);
  });
});

describe('initialOf', () => {
  it('prend la premiere lettre en majuscule', () => {
    assert.equal(initialOf('gowey'), 'G');
    assert.equal(initialOf('  zed'), 'Z');
  });

  it('retombe sur un point d interrogation', () => {
    assert.equal(initialOf(''), '?');
    assert.equal(initialOf(undefined), '?');
  });
});
