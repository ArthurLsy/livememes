import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { nextStep, normalizeCode, pairErrorMessage } from '../src/renderer/onboarding.ts';

describe('nextStep', () => {
  it('ouvre la bienvenue au premier lancement', () => {
    assert.equal(nextStep(null, null, { linked: false, onboarded: false }), 'welcome');
  });

  it("n'affiche rien si l'appareil est deja lie au lancement", () => {
    assert.equal(nextStep(null, null, { linked: true, onboarded: true }), null);
  });

  it('reste sur une etape d appairage tant que rien ne change', () => {
    assert.equal(nextStep('code', false, { linked: false, onboarded: false }), 'code');
    assert.equal(nextStep('welcome', false, { linked: false, onboarded: false }), 'welcome');
  });

  it("passe a la confirmation quand l'appairage reussit", () => {
    assert.equal(nextStep('code', false, { linked: true, onboarded: true }), 'done');
  });

  it("ramene a l'etape Discord quand l'appareil est delie", () => {
    assert.equal(nextStep(null, true, { linked: false, onboarded: true }), 'discord');
    assert.equal(nextStep('tips', true, { linked: false, onboarded: true }), 'discord');
  });

  it("ramene a l'etape Discord au lancement d'un appareil deja lie une fois", () => {
    assert.equal(nextStep(null, null, { linked: false, onboarded: true }), 'discord');
  });

  it('laisse le tutoriel rouvert depuis les reglages a son etape', () => {
    assert.equal(nextStep('discord', true, { linked: true, onboarded: true }), 'discord');
    assert.equal(nextStep(null, true, { linked: true, onboarded: true }), null);
  });
});

describe('normalizeCode', () => {
  it('accepte un code propre', () => {
    assert.deepEqual(normalizeCode('K7XQ4MPA'), { ok: true, code: 'K7XQ4MPA' });
  });

  it('nettoie un code colle depuis Discord', () => {
    assert.deepEqual(normalizeCode('  `k7xq-4mpa` \n'), { ok: true, code: 'K7XQ4MPA' });
  });

  it('refuse un code vide, tronque ou exotique', () => {
    assert.equal(normalizeCode('   ').ok, false);
    assert.equal(normalizeCode('K7XQ4').ok, false);
    assert.equal(normalizeCode('K7XQ4MPA9').ok, false);
    assert.equal(normalizeCode('K7XQ!MPA').ok, false);
  });
});

describe('pairErrorMessage', () => {
  it('explique un code invalide ou expire', () => {
    assert.match(pairErrorMessage(400, undefined), /\/livememes link/);
  });

  it('explique la limite de tentatives', () => {
    assert.match(pairErrorMessage(429, 'peu importe'), /Trop de tentatives/);
  });

  it('retombe sur le message du serveur sinon', () => {
    assert.equal(pairErrorMessage(403, 'Interdit'), 'Interdit');
    assert.equal(pairErrorMessage(418, undefined), 'Le serveur a repondu 418.');
  });
});
