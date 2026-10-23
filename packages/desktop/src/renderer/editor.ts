import type { DropUploadResponse } from '@livememes/shared';
import type { RenderRequest, SourceKind } from '../main/edit-plan.ts';
import {
  clamp,
  DEFAULT_SEND,
  fitTextRange,
  formatTime,
  initialTrim,
  MAX_CLIP_SECONDS,
  MAX_IMAGE_SECONDS,
  moveTextEdge,
  moveTrimEnd,
  moveTrimStart,
  SEND_POSITIONS,
  SEND_SIZES,
  sendSummary,
  shiftTextRange,
  TEXT_COLORS,
  TEXT_FONTS,
  TEXT_SIZE_MAX,
  TEXT_SIZE_MIN,
  type Range,
  type SendOptions,
  type TextFont,
  type TextLayer,
} from './editor-model.ts';
import { drawText, renderTextPng, toBytes, type Box } from './text-layer.ts';

interface EditorState {
  linked: boolean;
  exportDir: string | null;
  maxBytes: number;
}

interface OpenedSource {
  name: string;
  kind: SourceKind;
  mime: string;
  url: string | null;
  bytes: Uint8Array | null;
}

interface RenderJob {
  request: RenderRequest;
  overlay: Uint8Array | null;
  photo: Uint8Array | null;
}

type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

declare global {
  interface Window {
    editor: {
      getState(): Promise<EditorState>;
      open(): Promise<Result<{ source: OpenedSource }> | null>;
      openFile(file: File): Promise<Result<{ source: OpenedSource }>>;
      chooseDir(): Promise<EditorState>;
      save(job: RenderJob): Promise<Result<{ name: string; dir: string }>>;
      send(job: RenderJob, options: SendOptions): Promise<Result<{ report: DropUploadResponse }>>;
      reveal(): Promise<void>;
      onProgress(handler: (fraction: number | null) => void): void;
      onState(handler: (state: EditorState) => void): void;
    };
  }
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const stage = $<HTMLElement>('stage');
const dropZone = $<HTMLElement>('dropZone');
const frame = $<HTMLElement>('frame');
const video = $<HTMLVideoElement>('video');
const image = $<HTMLImageElement>('image');
const textCanvas = $<HTMLCanvasElement>('textCanvas');
const side = $<HTMLElement>('side');
const timeline = $<HTMLElement>('timeline');
const tracks = $<HTMLElement>('tracks');
const ruler = $<HTMLElement>('ruler');
const videoLane = $<HTMLElement>('videoLane');
const thumbs = $<HTMLCanvasElement>('thumbs');
const trimEl = $<HTMLElement>('trim');
const textBar = $<HTMLElement>('textBar');
const playhead = $<HTMLElement>('playhead');
const textInput = $<HTMLTextAreaElement>('textInput');
const statusEl = $<HTMLElement>('status');
const saveButton = $<HTMLButtonElement>('saveButton');
const sendButton = $<HTMLButtonElement>('sendButton');

/* -------------------------------------------------------------------------- */
/* Etat                                                                       */
/* -------------------------------------------------------------------------- */

interface Loaded extends OpenedSource {
  width: number;
  height: number;
  /** Secondes ; 0 pour une image. */
  duration: number;
  objectUrl: string | null;
}

let app: EditorState = { linked: false, exportDir: null, maxBytes: 25 * 1024 * 1024 };
let source: Loaded | null = null;
let trim: Range = { start: 0, end: 0 };
let muted = false;
let busy = false;
const send: SendOptions = { ...DEFAULT_SEND };

const text: TextLayer = {
  content: '',
  x: 0.5,
  y: 0.82,
  size: 0.08,
  font: 'display',
  color: TEXT_COLORS[0],
  outline: true,
  range: { start: 0, end: 0 },
};

/** Cadre du texte dans l'apercu, en px CSS, pour le glisser. */
let textBox: Box | null = null;
let draggingText = false;
let hoveringText = false;

const isVideo = () => source?.kind === 'video';
const hasText = () => text.content.trim().length > 0;

/* -------------------------------------------------------------------------- */
/* Statut et boutons                                                          */
/* -------------------------------------------------------------------------- */

function setStatus(message: string, tone: 'info' | 'ok' | 'error' = 'info', action?: { label: string; run: () => void }): void {
  statusEl.className = `status status--${tone}`;
  statusEl.replaceChildren(message);
  if (action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'link';
    button.textContent = action.label;
    button.addEventListener('click', action.run);
    statusEl.append(' ', button);
  }
}

function setProgress(fraction: number | null | false): void {
  const bar = $<HTMLElement>('progress');
  bar.hidden = fraction === false;
  bar.classList.toggle('progress--busy', fraction === null);
  if (typeof fraction === 'number') $<HTMLElement>('progressFill').style.width = `${Math.round(fraction * 100)}%`;
}

function renderButtons(): void {
  saveButton.disabled = !source || busy;
  sendButton.disabled = !source || busy || !app.linked;
  sendButton.title = app.linked ? '' : "Lie l'app a ton compte Discord pour envoyer";
  $<HTMLElement>('openButton').hidden = !source;

  // Le nom du dossier suffit ; le chemin complet reste au survol.
  const dir = $<HTMLElement>('dirName');
  dir.textContent = app.exportDir?.split(/[\\/]/).filter(Boolean).pop() ?? 'pas encore choisi';
  dir.title = app.exportDir ?? '';
}

/* -------------------------------------------------------------------------- */
/* Ouverture d'un fichier                                                     */
/* -------------------------------------------------------------------------- */

/** Attend un evenement, avec un delai de garde : un media corrompu peut ne jamais repondre. */
function once(target: EventTarget, ok: string, ms = 8000): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (value: boolean) => {
      clearTimeout(timer);
      target.removeEventListener(ok, onOk);
      target.removeEventListener('error', onError);
      resolve(value);
    };
    const onOk = () => done(true);
    const onError = () => done(false);
    const timer = setTimeout(() => done(false), ms);
    target.addEventListener(ok, onOk);
    target.addEventListener('error', onError);
  });
}

function unload(): void {
  pause();
  if (source?.objectUrl) URL.revokeObjectURL(source.objectUrl);
  source = null;
  video.removeAttribute('src');
  video.load();
  image.removeAttribute('src');
}

async function load(result: Result<{ source: OpenedSource }> | null): Promise<void> {
  if (!result) return;
  if (!result.ok) {
    setStatus(result.error, 'error');
    return;
  }

  unload();
  const opened = result.source;
  let width: number;
  let height: number;
  let duration = 0;
  let objectUrl: string | null = null;

  if (opened.kind === 'video') {
    video.src = opened.url!;
    if (!(await once(video, 'loadedmetadata')) || !Number.isFinite(video.duration) || video.duration <= 0) {
      unload();
      setStatus("Apercu impossible : l'app ne sait pas lire cette video. Essaie un mp4 (H.264).", 'error');
      return;
    }
    width = video.videoWidth;
    height = video.videoHeight;
    duration = video.duration;
  } else {
    objectUrl = URL.createObjectURL(new Blob([new Uint8Array(opened.bytes!)], { type: opened.mime }));
    image.src = objectUrl;
    if (!(await once(image, 'load'))) {
      URL.revokeObjectURL(objectUrl);
      setStatus("Image illisible. Essaie un png ou un jpg.", 'error');
      return;
    }
    width = image.naturalWidth;
    height = image.naturalHeight;
  }

  source = { ...opened, width, height, duration, objectUrl };
  trim = opened.kind === 'video' ? initialTrim(duration) : { start: 0, end: 0 };
  text.range = { ...trim };

  video.hidden = opened.kind !== 'video';
  image.hidden = opened.kind === 'video';
  dropZone.hidden = true;
  frame.hidden = false;
  side.hidden = false;
  timeline.hidden = opened.kind !== 'video';
  $<HTMLElement>('volumeField').hidden = opened.kind !== 'video';
  $<HTMLElement>('durationField').hidden = opened.kind === 'video';
  $<HTMLElement>('fileName').textContent = opened.name;
  applyAudio();

  if (opened.kind === 'video') video.currentTime = 0;
  layout();
  renderTimeline();
  void buildThumbs();
  renderButtons();

  if (duration > MAX_CLIP_SECONDS) {
    setStatus(`Video de ${formatTime(duration)} : un clip fait 30 s au plus, glisse les bords pour choisir le passage.`);
  } else {
    setStatus(hasText() ? 'Pret.' : 'Ajoute un texte si tu veux, puis enregistre ou envoie.');
  }
}

$<HTMLButtonElement>('pickButton').addEventListener('click', async () => load(await window.editor.open()));
$<HTMLButtonElement>('openButton').addEventListener('click', async () => load(await window.editor.open()));

// Glisser-deposer sur toute la fenetre ; la navigation vers le fichier est bloquee par le main.
window.addEventListener('dragover', (event) => {
  event.preventDefault();
  document.body.classList.add('dragging');
});
window.addEventListener('dragleave', (event) => {
  if (event.relatedTarget === null) document.body.classList.remove('dragging');
});
window.addEventListener('drop', async (event) => {
  event.preventDefault();
  document.body.classList.remove('dragging');
  const file = event.dataTransfer?.files[0];
  if (file && !busy) await load(await window.editor.openFile(file));
});

/* -------------------------------------------------------------------------- */
/* Apercu et texte                                                            */
/* -------------------------------------------------------------------------- */

/** Le cadre epouse le media a sa taille maximale dans la scene ; le canvas texte le recouvre. */
function layout(): void {
  if (!source) return;
  const box = stage.getBoundingClientRect();
  const scale = Math.min((box.width - 48) / source.width, (box.height - 48) / source.height);
  const width = Math.max(1, Math.floor(source.width * scale));
  const height = Math.max(1, Math.floor(source.height * scale));
  frame.style.width = `${width}px`;
  frame.style.height = `${height}px`;
  textCanvas.width = Math.round(width * devicePixelRatio);
  textCanvas.height = Math.round(height * devicePixelRatio);
  drawPreview();
}

function textVisibleAt(time: number): boolean {
  return !isVideo() || (time >= text.range.start && time <= text.range.end);
}

function drawPreview(): void {
  const ctx = textCanvas.getContext('2d')!;
  ctx.clearRect(0, 0, textCanvas.width, textCanvas.height);
  textBox = null;
  if (!source || !hasText()) return;

  const visible = textVisibleAt(video.currentTime);
  // En lecture, le texte suit sa plage ; a l'arret, il reste editable, en transparence hors plage.
  if (!visible && !video.paused) return;
  ctx.globalAlpha = visible ? 1 : 0.35;
  const box = drawText(ctx, text, textCanvas.width, textCanvas.height);
  ctx.globalAlpha = 1;
  if (!box) return;

  const ratio = devicePixelRatio;
  textBox = { left: box.left / ratio, top: box.top / ratio, right: box.right / ratio, bottom: box.bottom / ratio };
  if (draggingText || hoveringText) {
    ctx.save();
    ctx.setLineDash([6 * ratio, 5 * ratio]);
    ctx.lineWidth = 2 * ratio;
    ctx.strokeStyle = 'rgba(238, 241, 255, 0.8)';
    ctx.strokeRect(box.left - 6 * ratio, box.top - 4 * ratio, box.right - box.left + 12 * ratio, box.bottom - box.top + 8 * ratio);
    ctx.restore();
  }
}

function pointIn(event: PointerEvent | WheelEvent): { x: number; y: number } {
  const rect = textCanvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function onText(point: { x: number; y: number }): boolean {
  if (!textBox) return false;
  const margin = 10;
  return (
    point.x >= textBox.left - margin &&
    point.x <= textBox.right + margin &&
    point.y >= textBox.top - margin &&
    point.y <= textBox.bottom + margin
  );
}

let dragOrigin: { x: number; y: number; textX: number; textY: number } | null = null;

textCanvas.addEventListener('pointerdown', (event) => {
  const point = pointIn(event);
  if (!onText(point)) {
    // Un clic sur l'image vide invite a ecrire.
    if (!hasText()) textInput.focus();
    return;
  }
  textCanvas.setPointerCapture(event.pointerId);
  dragOrigin = { ...point, textX: text.x, textY: text.y };
  draggingText = true;
  drawPreview();
});

textCanvas.addEventListener('pointermove', (event) => {
  const point = pointIn(event);
  if (dragOrigin) {
    const rect = textCanvas.getBoundingClientRect();
    text.x = clamp(dragOrigin.textX + (point.x - dragOrigin.x) / rect.width, 0, 1);
    text.y = clamp(dragOrigin.textY + (point.y - dragOrigin.y) / rect.height, 0, 1);
    drawPreview();
    return;
  }
  const hovering = onText(point);
  if (hovering !== hoveringText) {
    hoveringText = hovering;
    textCanvas.style.cursor = hovering ? 'move' : '';
    drawPreview();
  }
});

const endTextDrag = () => {
  dragOrigin = null;
  draggingText = false;
  drawPreview();
};
textCanvas.addEventListener('pointerup', endTextDrag);
textCanvas.addEventListener('pointercancel', endTextDrag);
textCanvas.addEventListener('pointerleave', () => {
  if (!hoveringText) return;
  hoveringText = false;
  textCanvas.style.cursor = '';
  drawPreview();
});

// Molette sur le texte : taille, comme le pincement de Snapchat.
textCanvas.addEventListener(
  'wheel',
  (event) => {
    if (!onText(pointIn(event))) return;
    event.preventDefault();
    setTextSize(text.size - event.deltaY * 0.0002);
  },
  { passive: false },
);

const textSize = $<HTMLInputElement>('textSize');
textSize.min = String(TEXT_SIZE_MIN * 100);
textSize.max = String(TEXT_SIZE_MAX * 100);

function setTextSize(size: number): void {
  text.size = clamp(size, TEXT_SIZE_MIN, TEXT_SIZE_MAX);
  textSize.value = String(text.size * 100);
  drawPreview();
}

textSize.addEventListener('input', () => setTextSize(Number(textSize.value) / 100));

textInput.addEventListener('input', () => {
  const hadText = hasText();
  text.content = textInput.value;
  // Premier texte : visible sur tout le clip, a raccourcir ensuite.
  if (!hadText && hasText()) text.range = { ...trim };
  drawPreview();
  renderTimeline();
});

$<HTMLButtonElement>('clearText').addEventListener('click', () => {
  textInput.value = '';
  text.content = '';
  drawPreview();
  renderTimeline();
});

const outlineSwitch = $<HTMLButtonElement>('outlineSwitch');
outlineSwitch.addEventListener('click', () => {
  text.outline = !text.outline;
  outlineSwitch.setAttribute('aria-checked', String(text.outline));
  drawPreview();
});

/**
 * Groupe de boutons radio : un seul `aria-checked`, fleches pour se deplacer.
 * Renvoie la fonction qui resynchronise l'affichage.
 */
function radioGroup<T extends string>(
  container: HTMLElement,
  options: { value: T; label: string }[],
  current: () => T,
  pick: (value: T) => void,
  decorate?: (button: HTMLButtonElement, value: T) => void,
): () => void {
  const buttons = options.map((option) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'radio');
    button.className = 'seg press';
    button.textContent = option.label;
    button.addEventListener('click', () => {
      pick(option.value);
      refresh();
    });
    decorate?.(button, option.value);
    return button;
  });

  const refresh = () => {
    buttons.forEach((button, i) => {
      const checked = options[i]!.value === current();
      button.setAttribute('aria-checked', String(checked));
      button.tabIndex = checked ? 0 : -1;
    });
  };

  container.addEventListener('keydown', (event) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const index = options.findIndex((option) => option.value === current());
    const next = (index + step + options.length) % options.length;
    pick(options[next]!.value);
    refresh();
    buttons[next]!.focus();
  });

  container.replaceChildren(...buttons);
  refresh();
  return refresh;
}

radioGroup(
  $('fontGroup'),
  (Object.keys(TEXT_FONTS) as TextFont[]).map((font) => ({ value: font, label: TEXT_FONTS[font].label })),
  () => text.font,
  (font) => {
    text.font = font;
    drawPreview();
  },
  (button, font) => {
    button.style.fontFamily = TEXT_FONTS[font].family;
  },
);

const COLOR_NAMES = ['Blanc', 'Nuit', 'Citron', 'Violet', 'Rouge', 'Jaune'];
radioGroup(
  $('colorGroup'),
  TEXT_COLORS.map((color, i) => ({ value: color as string, label: COLOR_NAMES[i] ?? color })),
  () => text.color,
  (color) => {
    text.color = color;
    drawPreview();
  },
  (button, color) => {
    button.className = 'swatch press';
    button.setAttribute('aria-label', button.textContent ?? color);
    button.textContent = '';
    button.style.setProperty('--swatch', color);
  },
);

/* -------------------------------------------------------------------------- */
/* Options d'envoi                                                            */
/* -------------------------------------------------------------------------- */

radioGroup($('sizeGroup'), SEND_SIZES, () => send.size, (size) => (send.size = size));
radioGroup($('positionGroup'), SEND_POSITIONS, () => send.position, (position) => (send.position = position));

const volume = $<HTMLInputElement>('volume');
const duration = $<HTMLInputElement>('duration');
duration.max = String(MAX_IMAGE_SECONDS);

function renderSendValues(): void {
  volume.value = String(send.volume);
  $<HTMLElement>('volumeValue').textContent = `${send.volume} %`;
  duration.value = String(send.duration);
  $<HTMLElement>('durationValue').textContent = `${send.duration} s`;
}

volume.addEventListener('input', () => {
  send.volume = Number(volume.value);
  applyAudio();
  renderSendValues();
});
duration.addEventListener('input', () => {
  send.duration = Number(duration.value);
  renderSendValues();
});

/** L'apercu joue au volume d'envoi : ce qu'on entend est ce que le salon entendra. */
function applyAudio(): void {
  video.muted = muted;
  video.volume = send.volume / 100;
  const button = $<HTMLButtonElement>('muteButton');
  button.setAttribute('aria-pressed', String(muted));
  button.textContent = muted ? 'Muet' : 'Son';
  $<HTMLElement>('audioBar').classList.toggle('audio-bar--muted', muted);
  $<HTMLElement>('audioLabel').textContent = muted ? 'Son coupe' : "Son d'origine";
}

$<HTMLButtonElement>('muteButton').addEventListener('click', () => {
  muted = !muted;
  applyAudio();
});

/* -------------------------------------------------------------------------- */
/* Timeline                                                                   */
/* -------------------------------------------------------------------------- */

const laneWidth = () => videoLane.clientWidth;
const xOf = (time: number) => (source && source.duration > 0 ? (time / source.duration) * laneWidth() : 0);
function timeAt(clientX: number): number {
  const rect = videoLane.getBoundingClientRect();
  return clamp((clientX - rect.left) / rect.width, 0, 1) * (source?.duration ?? 0);
}

function place(element: HTMLElement, range: Range): void {
  element.style.left = `${xOf(range.start)}px`;
  element.style.width = `${Math.max(2, xOf(range.end) - xOf(range.start))}px`;
}

function renderRuler(): void {
  if (!source) return;
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const step = steps.find((value) => xOf(value) >= 64) ?? 1200;
  const ticks: HTMLElement[] = [];
  for (let time = 0; time <= source.duration + 1e-6; time += step) {
    const tick = document.createElement('span');
    tick.className = 'tick';
    tick.style.left = `${xOf(time)}px`;
    tick.textContent = time < 60 ? `${Number(time.toFixed(1))}s` : formatTime(time).replace(/\.\d$/, '');
    ticks.push(tick);
  }
  ruler.replaceChildren(...ticks);
}

function renderPlayhead(): void {
  playhead.style.left = `${videoLane.offsetLeft + xOf(video.currentTime)}px`;
  $<HTMLElement>('timeNow').textContent = formatTime(video.currentTime);
}

function renderTimeline(): void {
  if (!source || !isVideo()) return;
  place(trimEl, trim);
  $<HTMLElement>('scrimBefore').style.width = `${xOf(trim.start)}px`;
  $<HTMLElement>('scrimAfter').style.left = `${xOf(trim.end)}px`;
  place($('audioBar'), trim);

  textBar.classList.toggle('text-bar--empty', !hasText());
  place(textBar, hasText() ? text.range : trim);
  $<HTMLElement>('textBarLabel').textContent = hasText() ? text.content.split('\n')[0]! : 'Pas de texte';

  const length = trim.end - trim.start;
  const clip = $<HTMLElement>('clipLength');
  clip.textContent = `Clip ${formatTime(length)} / ${MAX_CLIP_SECONDS} s max`;
  clip.classList.toggle('clip--full', length >= MAX_CLIP_SECONDS - 0.05);
  $<HTMLElement>('timeTotal').textContent = formatTime(source.duration);

  renderRuler();
  renderPlayhead();
}

function seek(time: number): void {
  video.currentTime = clamp(time, trim.start, trim.end);
  renderPlayhead();
  drawPreview();
}

/** Glisser sur la timeline : capture du pointeur, temps lu sous le curseur. */
function drag(element: HTMLElement, onMove: (time: number, origin: number) => void): void {
  element.addEventListener('pointerdown', (event) => {
    if (!source || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    pause();
    element.setPointerCapture(event.pointerId);
    const origin = timeAt(event.clientX);
    onMove(origin, origin);
    const move = (next: PointerEvent) => onMove(timeAt(next.clientX), origin);
    const up = () => {
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerup', up);
      element.removeEventListener('pointercancel', up);
    };
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', up);
    element.addEventListener('pointercancel', up);
  });
}

// Bords de la coupe : l'apercu montre l'image sous le bord deplace.
for (const handle of trimEl.querySelectorAll<HTMLElement>('.handle')) {
  const edge = handle.dataset.edge as 'start' | 'end';
  drag(handle, (time) => {
    if (!source) return;
    trim = edge === 'start' ? moveTrimStart(trim, time, source.duration) : moveTrimEnd(trim, time, source.duration);
    text.range = fitTextRange(text.range, trim);
    renderTimeline();
    seek(edge === 'start' ? trim.start : trim.end);
  });
}

for (const handle of textBar.querySelectorAll<HTMLElement>('.handle')) {
  const edge = handle.dataset.edge as 'start' | 'end';
  drag(handle, (time) => {
    if (!hasText()) return;
    text.range = moveTextEdge(text.range, edge, time, trim);
    renderTimeline();
    seek(edge === 'start' ? text.range.start : text.range.end);
  });
}

// Corps de la barre texte : glisse toute la plage.
let textGrab = 0;
textBar.addEventListener('pointerdown', (event) => {
  textGrab = timeAt(event.clientX) - text.range.start;
});
drag(textBar, (time) => {
  if (!hasText()) return;
  text.range = shiftTextRange(text.range, time - textGrab, trim);
  renderTimeline();
  seek(text.range.start);
});

// Partout ailleurs sur la timeline : deplace la tete de lecture.
for (const id of ['ruler', 'videoLane', 'audioLane', 'textLane']) {
  drag($(id), (time) => seek(time));
}

/* Miniatures de la piste video, tirees d'un second lecteur muet. */
let thumbsToken = 0;

async function buildThumbs(): Promise<void> {
  const token = ++thumbsToken;
  const width = Math.round(videoLane.clientWidth * devicePixelRatio);
  const height = Math.round(videoLane.clientHeight * devicePixelRatio);
  thumbs.width = width;
  thumbs.height = height;
  const ctx = thumbs.getContext('2d')!;
  ctx.clearRect(0, 0, width, height);
  if (!source || !isVideo() || width === 0 || height === 0) return;

  const probe = document.createElement('video');
  probe.muted = true;
  probe.preload = 'auto';
  probe.src = source.url!;
  try {
    if (!(await once(probe, 'loadeddata'))) return;
    const thumbWidth = height * (source.width / source.height);
    const count = Math.ceil(width / thumbWidth);
    for (let i = 0; i < count && token === thumbsToken; i++) {
      probe.currentTime = Math.min(source.duration - 0.05, ((i + 0.5) * thumbWidth * source.duration) / width);
      if (!(await once(probe, 'seeked', 3000))) break;
      if (token !== thumbsToken) break;
      ctx.drawImage(probe, i * thumbWidth, 0, thumbWidth, height);
    }
  } finally {
    probe.removeAttribute('src');
    probe.load();
  }
}

/* -------------------------------------------------------------------------- */
/* Lecture                                                                    */
/* -------------------------------------------------------------------------- */

let frameRequest = 0;

function tick(): void {
  if (video.paused) return;
  // Lecture en boucle sur la partie gardee, comme l'apercu d'une story.
  if (video.currentTime >= trim.end || video.currentTime < trim.start - 0.1) video.currentTime = trim.start;
  renderPlayhead();
  drawPreview();
  frameRequest = requestAnimationFrame(tick);
}

function play(): void {
  if (!isVideo()) return;
  if (video.currentTime < trim.start || video.currentTime >= trim.end - 0.05) video.currentTime = trim.start;
  void video.play();
}

function pause(): void {
  if (!video.paused) video.pause();
}

video.addEventListener('play', () => {
  $<HTMLElement>('playButton').classList.add('playing');
  $<HTMLElement>('playButton').setAttribute('aria-label', 'Pause');
  cancelAnimationFrame(frameRequest);
  tick();
});
video.addEventListener('pause', () => {
  $<HTMLElement>('playButton').classList.remove('playing');
  $<HTMLElement>('playButton').setAttribute('aria-label', 'Lecture');
  drawPreview();
});
video.addEventListener('seeked', () => {
  renderPlayhead();
  drawPreview();
});

$<HTMLButtonElement>('playButton').addEventListener('click', () => (video.paused ? play() : pause()));

window.addEventListener('keydown', (event) => {
  if (event.code !== 'Space') return;
  const target = event.target as HTMLElement;
  if (target.closest('input, textarea, button')) return;
  event.preventDefault();
  if (video.paused) play();
  else pause();
});

/* -------------------------------------------------------------------------- */
/* Export                                                                     */
/* -------------------------------------------------------------------------- */

/** Plus grand cote d'une photo exportee : au-dela, l'overlay n'en tire rien. */
const PHOTO_LONG_SIDE = 2560;

async function composePhoto(loaded: Loaded): Promise<{ mime: 'image/png' | 'image/jpeg'; bytes: Uint8Array }> {
  const scale = Math.min(1, PHOTO_LONG_SIDE / Math.max(loaded.width, loaded.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(loaded.width * scale);
  canvas.height = Math.round(loaded.height * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  drawText(ctx, text, canvas.width, canvas.height);

  // Un png ou un webp peut etre transparent : on garde le png tant qu'il passe.
  if (loaded.mime !== 'image/jpeg') {
    const png = await toBytes(canvas, 'image/png');
    if (png.byteLength <= app.maxBytes) return { mime: 'image/png', bytes: png };
  }
  return { mime: 'image/jpeg', bytes: await toBytes(canvas, 'image/jpeg', 0.9) };
}

async function buildJob(loaded: Loaded): Promise<RenderJob> {
  if (loaded.kind === 'photo') {
    const photo = await composePhoto(loaded);
    return { request: { kind: 'photo', mime: photo.mime }, overlay: null, photo: photo.bytes };
  }

  const overlay = hasText() ? await renderTextPng(text, loaded.width, loaded.height) : null;
  if (loaded.kind === 'gif') {
    return { request: { kind: 'gif', width: loaded.width, height: loaded.height, text: overlay !== null }, overlay, photo: null };
  }
  return {
    request: {
      kind: 'video',
      width: loaded.width,
      height: loaded.height,
      trim: { ...trim },
      muted,
      text: overlay ? fitTextRange(text.range, trim) : null,
    },
    overlay,
    photo: null,
  };
}

async function run(action: 'save' | 'send'): Promise<void> {
  if (!source || busy) return;
  const loaded = source;
  pause();
  busy = true;
  renderButtons();
  setStatus(loaded.kind === 'video' ? 'Export de la video...' : 'Preparation...');
  setProgress(loaded.kind === 'photo' ? null : 0);

  try {
    const job = await buildJob(loaded);
    if (action === 'save') {
      const result = await window.editor.save(job);
      if (result.ok) setStatus(`Enregistre : ${result.name}`, 'ok', { label: 'Afficher', run: () => void window.editor.reveal() });
      else setStatus(result.error, 'error');
      app = await window.editor.getState();
    } else {
      const result = await window.editor.send(job, { ...send });
      if (result.ok) setStatus(sendSummary(result.report), 'ok');
      else setStatus(result.error, 'error');
    }
  } catch (error) {
    console.error(error);
    setStatus("L'export a echoue. Reessaie.", 'error');
  } finally {
    busy = false;
    setProgress(false);
    renderButtons();
  }
}

saveButton.addEventListener('click', () => void run('save'));
sendButton.addEventListener('click', () => void run('send'));

window.editor.onProgress((fraction) => {
  if (!busy) return;
  if (fraction === null) {
    setStatus('Envoi...');
    setProgress(null);
    return;
  }
  setProgress(fraction);
  if (isVideo()) setStatus(`Export de la video... ${Math.round(fraction * 100)} %`);
});

$<HTMLButtonElement>('dirButton').addEventListener('click', async () => {
  app = await window.editor.chooseDir();
  renderButtons();
});

/* -------------------------------------------------------------------------- */
/* Demarrage                                                                  */
/* -------------------------------------------------------------------------- */

window.editor.onState((state) => {
  app = state;
  renderButtons();
});

new ResizeObserver(() => layout()).observe(stage);

let thumbsTimer: ReturnType<typeof setTimeout> | undefined;
new ResizeObserver(() => {
  renderTimeline();
  clearTimeout(thumbsTimer);
  thumbsTimer = setTimeout(() => void buildThumbs(), 200);
}).observe(tracks);

// Le canvas n'attend pas les polices : sans ca, le premier rendu tomberait sur system-ui.
void Promise.all(
  Object.values(TEXT_FONTS).map((font) => document.fonts.load(`${font.weight} 32px ${font.family}`)),
).then(drawPreview);

textSize.value = String(text.size * 100);
renderSendValues();
void window.editor.getState().then((state) => {
  app = state;
  renderButtons();
});
