import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  fitTextRange,
  formatTime,
  initialTrim,
  moveSoundStart,
  moveTextEdge,
  moveTrimEnd,
  moveTrimStart,
  outlineFor,
  sendSummary,
  shiftTextRange,
  shiftTrim,
  soundRange,
  soundTimeAt,
  wrapLines,
} from '../src/renderer/editor-model.ts';
import {
  fitWithin,
  gifArgs,
  hasAudioStream,
  parseRenderRequest,
  photoSoundArgs,
  soundArgs,
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
  const video = { kind: 'video', width: 1920, height: 1080, trim: { start: 1, end: 11 }, muted: false, text: null, sound: null };

  it('accepte une demande valide', () => {
    assert.deepEqual(parseRenderRequest(video, 'video'), video);
    assert.deepEqual(parseRenderRequest({ kind: 'photo', mime: 'image/png' }, 'photo'), {
      kind: 'photo',
      mime: 'image/png',
    });
  });

  it('accepte une demande d un renderer anterieur au son ajoute', () => {
    const { sound: _sound, ...old } = video;
    assert.deepEqual(parseRenderRequest(old, 'video'), video);
  });

  it('valide le son ajoute a une video', () => {
    const sound = { from: 3, at: 2, gain: 0.8 };
    assert.deepEqual(parseRenderRequest({ ...video, sound }, 'video'), { ...video, sound });
    assert.equal(parseRenderRequest({ ...video, sound: { ...sound, gain: 3 } }, 'video'), null);
    assert.equal(parseRenderRequest({ ...video, sound: { ...sound, from: -1 } }, 'video'), null);
    // Le son demarrerait apres la fin du clip de 10 s.
    assert.equal(parseRenderRequest({ ...video, sound: { ...sound, at: 10 } }, 'video'), null);
  });

  it('accepte une photo avec un son, pour une source photo seulement', () => {
    const photo = { kind: 'photo-sound', mime: 'image/png', width: 1200, height: 800, seconds: 6, sound: { from: 0, at: 0, gain: 1 } };
    assert.deepEqual(parseRenderRequest(photo, 'photo'), photo);
    assert.equal(parseRenderRequest(photo, 'video'), null);
    assert.equal(parseRenderRequest({ ...photo, seconds: 25 }, 'photo'), null);
    assert.equal(parseRenderRequest({ ...photo, sound: null }, 'photo'), null);
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
      { kind: 'video', width: 1920, height: 1080, trim: { start: 2, end: 12 }, muted: false, text: { start: 4, end: 20 }, sound: null },
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
      { kind: 'video', width: 1280, height: 720, trim: { start: 0, end: 5 }, muted: true, text: null, sound: null },
      { source: 'in.mp4', overlay: 'text.png', output: 'out.mp4' },
      videoBudget(5, 25 * 1024 * 1024, true),
    );
    assert.ok(args.includes('-an'));
    assert.equal(args.filter((arg) => arg === '-i').length, 1);
  });

  it('remplace la bande son par le son ajoute (#37)', () => {
    const args = videoArgs(
      { kind: 'video', width: 1280, height: 720, trim: { start: 2, end: 7 }, muted: true, text: null, sound: { from: 1.5, at: 2, gain: 0.8 } },
      { source: 'in.mp4', overlay: null, output: 'out.mp4', sound: 'son.mp3' },
      videoBudget(5, 25 * 1024 * 1024, false),
    );
    assert.deepEqual(args.slice(args.indexOf('son.mp3') - 3, args.indexOf('son.mp3') + 1), ['-ss', '1.500', '-i', 'son.mp3']);
    const filter = args[args.indexOf('-filter_complex') + 1]!;
    assert.match(filter, /\[1:a\]aformat=[^;]*volume=0\.80,adelay=2000\|2000,apad,atrim=end=5\.000\[a\]$/);
    assert.doesNotMatch(filter, /\[0:a\]/);
    assert.ok(!args.includes('-an'));
    assert.ok(!args.includes('0:a:0?'));
    assert.equal(args[args.indexOf('[a]') - 1], '-map');
  });

  it('mixe le son ajoute au son d origine, sauf si la source n en a pas', () => {
    const request = {
      kind: 'video' as const, width: 1280, height: 720, trim: { start: 0, end: 4 }, muted: false,
      text: { start: 0, end: 4 }, sound: { from: 0, at: 0, gain: 1 },
    };
    const paths = { source: 'in.mp4', overlay: 'text.png', output: 'out.mp4', sound: 'son.m4a' };
    const budget = videoBudget(4, 25 * 1024 * 1024, false);
    const mixed = videoArgs(request, paths, budget);
    const filter = mixed[mixed.indexOf('-filter_complex') + 1]!;
    // Le calque texte est l'entree 1, le son l'entree 2.
    assert.match(filter, /\[2:a\]/);
    assert.match(filter, /\[orig\]\[snd\]amix=inputs=2:duration=first:normalize=0\[a\]/);
    assert.doesNotMatch(filter, /adelay/);

    const silent = videoArgs(request, paths, budget, false);
    assert.doesNotMatch(silent[silent.indexOf('-filter_complex') + 1]!, /amix|\[0:a\]/);
  });

  it('fait une video d une photo et de son son (#36)', () => {
    const args = photoSoundArgs(
      { kind: 'photo-sound', mime: 'image/jpeg', width: 2560, height: 1440, seconds: 6, sound: { from: 4, at: 0, gain: 1 } },
      { source: 'photo.jpg', overlay: null, output: 'out.mp4', sound: 'son.mp3' },
      videoBudget(6, 25 * 1024 * 1024, false),
    );
    assert.deepEqual(args.slice(3, 10), ['-loop', '1', '-framerate', '25', '-t', '6.000', '-i']);
    assert.deepEqual(args.slice(11, 15), ['-ss', '4.000', '-i', 'son.mp3']);
    const filter = args[args.indexOf('-filter_complex') + 1]!;
    assert.match(filter, /scale=1920:1080/);
    assert.match(filter, /atrim=end=6\.000\[a\]$/);
    assert.equal(args[args.indexOf('-t', 12) + 1], '6.000');
    assert.ok(Number.parseInt(args[args.indexOf('-b:v') + 1]!, 10) <= 2500);
  });

  it('extrait un passage de son pour la banque (#35)', () => {
    const args = soundArgs(12.5, 30, 'film.mov', 'son.m4a');
    assert.deepEqual(args.slice(3, 9), ['-ss', '12.500', '-t', '30.000', '-i', 'film.mov']);
    assert.ok(args.includes('-vn'));
    assert.equal(args.at(-1), 'son.m4a');
  });

  it('repere une piste audio dans le journal de ffmpeg', () => {
    assert.ok(hasAudioStream('  Stream #0:1[0x2](und): Audio: aac (LC), 48000 Hz, stereo'));
    assert.ok(!hasAudioStream('  Stream #0:0[0x1](und): Video: h264 (High), yuv420p'));
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

describe('son ajoute dans la timeline', () => {
  const trim = { start: 10, end: 20 };

  it('place le son a son decalage, coupe a la fin du clip ou du son', () => {
    assert.deepEqual(soundRange(trim, { from: 0, at: 2, gain: 1 }, 30), { start: 12, end: 20 });
    assert.deepEqual(soundRange(trim, { from: 1, at: 0, gain: 1 }, 4), { start: 10, end: 13 });
    assert.equal(soundRange(trim, { from: 5, at: 0, gain: 1 }, 5), null);
  });

  it('donne la position a lire dans le son', () => {
    const sound = { from: 3, at: 2, gain: 1 };
    assert.equal(soundTimeAt(11, trim, sound, 30), null);
    assert.equal(soundTimeAt(12, trim, sound, 30), 3);
    assert.equal(soundTimeAt(15.5, trim, sound, 30), 6.5);
    assert.equal(soundTimeAt(20, trim, sound, 30), null);
  });

  it('garde le debut du son dans le clip', () => {
    assert.equal(moveSoundStart(-3, trim), 0);
    assert.equal(moveSoundStart(4, trim), 4);
    assert.equal(moveSoundStart(15, trim), 9.9);
  });
});
