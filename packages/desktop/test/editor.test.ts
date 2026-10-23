import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  fitTextRange,
  formatTime,
  initialTrim,
  moveTextEdge,
  moveTrimEnd,
  moveTrimStart,
  outlineFor,
  sendSummary,
  shiftTextRange,
  shiftTrim,
  wrapLines,
} from '../src/renderer/editor-model.ts';
import {
  fitWithin,
  gifArgs,
  parseRenderRequest,
  progressSeconds,
  tighten,
  videoArgs,
  videoBudget,
} from '../src/main/edit-plan.ts';

describe('coupe de la timeline', () => {
  it('prend tout le clip, plafonne a 30 s', () => {
    assert.deepEqual(initialTrim(12), { start: 0, end: 12 });
    assert.deepEqual(initialTrim(95), { start: 0, end: 30 });
  });

  it('ne laisse pas la coupe depasser 30 s', () => {
    const trim = { start: 40, end: 60 };
    assert.deepEqual(moveTrimStart(trim, 10, 95), { start: 30, end: 60 });
    assert.deepEqual(moveTrimEnd(trim, 90, 95), { start: 40, end: 70 });
  });

  it('garde une longueur minimale et reste dans la source', () => {
    const trim = { start: 2, end: 8 };
    assert.deepEqual(moveTrimStart(trim, 7.9, 10), { start: 7.5, end: 8 });
    assert.deepEqual(moveTrimEnd(trim, 1, 10), { start: 2, end: 2.5 });
    assert.deepEqual(moveTrimEnd(trim, 50, 10), { start: 2, end: 10 });
    assert.deepEqual(moveTrimStart(trim, -3, 10), { start: 0, end: 8 });
  });

  it('accepte une source plus courte que la longueur minimale', () => {
    assert.deepEqual(moveTrimEnd({ start: 0, end: 0.3 }, 0, 0.3), { start: 0, end: 0.3 });
  });

  it('glisse la coupe sans changer sa longueur', () => {
    assert.deepEqual(shiftTrim({ start: 0, end: 10 }, 85, 90), { start: 80, end: 90 });
    assert.deepEqual(shiftTrim({ start: 5, end: 10 }, -2, 90), { start: 0, end: 5 });
  });
});

describe('piste texte', () => {
  const trim = { start: 2, end: 10 };

  it('reste dans la coupe', () => {
    assert.deepEqual(fitTextRange({ start: 0, end: 5 }, trim), { start: 2, end: 5 });
    assert.deepEqual(fitTextRange({ start: 12, end: 20 }, trim), trim);
  });

  it('deplace un bord sans croiser l autre', () => {
    assert.deepEqual(moveTextEdge({ start: 3, end: 6 }, 'start', 9, trim), { start: 5.9, end: 6 });
    assert.deepEqual(moveTextEdge({ start: 3, end: 6 }, 'end', 20, trim), { start: 3, end: 10 });
  });

  it('glisse dans la coupe', () => {
    assert.deepEqual(shiftTextRange({ start: 3, end: 6 }, 9, trim), { start: 7, end: 10 });
  });

  it('coupe les lignes trop longues mot par mot', () => {
    const measure = (text: string) => text.length;
    assert.deepEqual(wrapLines('quand le code marche du premier coup', 12, measure), [
      'quand le',
      'code marche',
      'du premier',
      'coup',
    ]);
    assert.deepEqual(wrapLines('ligne 1\n\nligne 3', 50, measure), ['ligne 1', '', 'ligne 3']);
  });

  it('choisit un contour contrastant', () => {
    assert.equal(outlineFor('#ffffff'), '#000000');
    assert.equal(outlineFor('#0d1226'), '#ffffff');
    assert.equal(outlineFor('pas une couleur'), '#000000');
  });

  it('formate les temps au dixieme', () => {
    assert.equal(formatTime(4.24), '0:04.2');
    assert.equal(formatTime(62), '1:02.0');
    assert.equal(formatTime(-1), '0:00.0');
  });
});

describe('bilan d envoi', () => {
  const report = { channelName: 'Vocal', audience: 4, reached: 2, offline: 1, muted: 1, screens: 3 };

  it('resume les destinataires', () => {
    assert.equal(sendSummary(report), 'Envoye dans Vocal : 2 personne(s), 3 ecran(s). 1 sans overlay. 1 en sourdine.');
  });

  it('previent quand personne ne l a vu', () => {
    assert.match(sendSummary({ ...report, reached: 0, screens: 0 }), /personne n'a l'overlay/);
  });
});

describe('demande d export', () => {
  const video = { kind: 'video', width: 1920, height: 1080, trim: { start: 1, end: 11 }, muted: false, text: null };

  it('accepte une demande valide', () => {
    assert.deepEqual(parseRenderRequest(video, 'video'), video);
    assert.deepEqual(parseRenderRequest({ kind: 'photo', mime: 'image/png' }, 'photo'), {
      kind: 'photo',
      mime: 'image/png',
    });
  });

  it('refuse un type qui ne correspond pas a la source ouverte', () => {
    assert.equal(parseRenderRequest(video, 'photo'), null);
  });

  it('refuse un clip de plus de 30 s ou des valeurs aberrantes', () => {
    assert.equal(parseRenderRequest({ ...video, trim: { start: 0, end: 31 } }, 'video'), null);
    assert.equal(parseRenderRequest({ ...video, trim: { start: 5, end: 5 } }, 'video'), null);
    assert.equal(parseRenderRequest({ ...video, width: 1920.5 }, 'video'), null);
    assert.equal(parseRenderRequest({ ...video, text: { start: 'a', end: 2 } }, 'video'), null);
    assert.equal(parseRenderRequest({ kind: 'photo', mime: 'image/svg+xml' }, 'photo'), null);
  });
});

describe('plan ffmpeg', () => {
  it('vise un debit qui tient sous la limite', () => {
    const budget = videoBudget(30, 25 * 1024 * 1024, false);
    const bytes = ((budget.videoKbps + budget.audioKbps) * 1000 * 30) / 8;
    assert.ok(bytes < 25 * 1024 * 1024 * 0.95, `${bytes} octets`);
    assert.equal(budget.longSide, 1920);
  });

  it('plafonne le debit d un clip court et baisse la resolution d un debit faible', () => {
    assert.equal(videoBudget(3, 25 * 1024 * 1024, true).videoKbps, 8000);
    assert.equal(videoBudget(30, 5 * 1024 * 1024, false).longSide, 854);
    assert.ok(tighten(videoBudget(30, 25 * 1024 * 1024, false)).videoKbps < 6000);
  });

  it('reduit sans agrandir et garde des cotes pairs', () => {
    assert.deepEqual(fitWithin(3840, 2160, 1920), { width: 1920, height: 1080 });
    assert.deepEqual(fitWithin(1080, 1920, 1280), { width: 720, height: 1280 });
    assert.deepEqual(fitWithin(641, 359, 1920), { width: 640, height: 358 });
  });

  it('coupe, incruste le texte sur sa plage et garde le son', () => {
    const args = videoArgs(
      { kind: 'video', width: 1920, height: 1080, trim: { start: 2, end: 12 }, muted: false, text: { start: 4, end: 20 } },
      { source: 'in.mov', overlay: 'text.png', output: 'out.mp4' },
      videoBudget(10, 25 * 1024 * 1024, false),
    );
    assert.deepEqual(args.slice(3, 9), ['-ss', '2.000', '-t', '10.000', '-i', 'in.mov']);
    const filter = args[args.indexOf('-filter_complex') + 1]!;
    assert.match(filter, /enable='between\(t,2\.000,10\.000\)'/);
    assert.ok(args.includes('0:a:0?'));
    assert.equal(args.at(-1), 'out.mp4');
  });

  it('retire le son et le calque quand il n y en a pas', () => {
    const args = videoArgs(
      { kind: 'video', width: 1280, height: 720, trim: { start: 0, end: 5 }, muted: true, text: null },
      { source: 'in.mp4', overlay: 'text.png', output: 'out.mp4' },
      videoBudget(5, 25 * 1024 * 1024, true),
    );
    assert.ok(args.includes('-an'));
    assert.equal(args.filter((arg) => arg === '-i').length, 1);
  });

  it('garde un GIF en GIF avec sa palette', () => {
    const args = gifArgs({ kind: 'gif', width: 480, height: 270, text: true }, {
      source: 'in.gif',
      overlay: 'text.png',
      output: 'out.gif',
    });
    const filter = args[args.indexOf('-filter_complex') + 1]!;
    assert.match(filter, /overlay=0:0,split/);
    assert.match(filter, /paletteuse/);
  });

  it('lit l avancement de ffmpeg', () => {
    assert.equal(progressSeconds('out_time_us=2500000'), 2.5);
    assert.equal(progressSeconds('frame=12'), null);
  });
});
