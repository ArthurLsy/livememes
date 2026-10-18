export {}; // fait de ce fichier un module : requis pour `declare global`.

interface AppState {
  serverUrl: string;
  linked: boolean;
  user: { id: string; username: string; avatarUrl: string | null } | null;
  volume: number;
  muted: boolean;
  displays: 'primary' | 'all' | number[];
  displayList: { id: number; label: string; primary: boolean; active: boolean }[];
  launchAtLogin: boolean;
  status: 'offline' | 'connecting' | 'online' | 'unauthorized';
  detail: string | null;
  updater: {
    mode: 'auto' | 'manual' | 'disabled';
    currentVersion: string;
    update:
      | { state: 'idle' | 'checking' | 'upToDate' }
      | { state: 'available' | 'ready'; version: string }
      | { state: 'downloading'; version: string; percent: number }
      | { state: 'error'; message: string };
  };
}

declare global {
  interface Window {
    livememes: {
      getState(): Promise<AppState>;
      pair(code: string): Promise<{ ok: true } | { ok: false; error: string }>;
      unlink(): Promise<void>;
      setSettings(patch: Record<string, unknown>): Promise<AppState>;
      preview(): Promise<void>;
      checkUpdate(): Promise<void>;
      applyUpdate(): Promise<void>;
      identifyDisplays(): Promise<void>;
      quit(): Promise<void>;
      onState(handler: (state: AppState) => void): void;
    };
  }
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const pairCard = $<HTMLElement>('pairCard');
const linkedCard = $<HTMLElement>('linkedCard');
const dot = $<HTMLElement>('dot');
const statusText = $<HTMLElement>('statusText');
const pairError = $<HTMLElement>('pairError');
const codeInput = $<HTMLInputElement>('code');
const pairButton = $<HTMLButtonElement>('pairButton');

const STATUS: Record<AppState['status'], { label: string; cls: string }> = {
  offline: { label: 'Deconnecte', cls: 'error' },
  connecting: { label: 'Connexion…', cls: 'connecting' },
  online: { label: 'Connecte', cls: 'online' },
  unauthorized: { label: 'Non lie', cls: 'error' },
};

let updateState: AppState['updater']['update']['state'] = 'idle';

function applyUpdater({ mode, currentVersion, update }: AppState['updater']): void {
  updateState = update.state;
  const card = $<HTMLElement>('updateCard');
  const text = $<HTMLElement>('updateText');
  const button = $<HTMLButtonElement>('updateButton');

  card.hidden = mode === 'disabled';
  if (mode === 'disabled') return;

  $<HTMLElement>('appVersion').textContent = `Version ${currentVersion}`;
  button.hidden = false;
  button.disabled = false;
  button.textContent = 'Rechercher';

  switch (update.state) {
    case 'idle':
      text.textContent = mode === 'auto' ? 'Mises a jour automatiques' : 'Mises a jour a installer a la main';
      break;
    case 'checking':
      text.textContent = 'Recherche en cours…';
      button.disabled = true;
      break;
    case 'upToDate':
      text.textContent = 'A jour';
      break;
    case 'available':
      text.textContent = `Version ${update.version} disponible`;
      button.textContent = 'Telecharger';
      break;
    case 'downloading':
      text.textContent = `Telechargement de la ${update.version} : ${update.percent} %`;
      button.hidden = true;
      break;
    case 'ready':
      text.textContent = `Version ${update.version} prete`;
      button.textContent = 'Redemarrer';
      break;
    case 'error':
      text.textContent = update.message;
      break;
  }
}

/** Derniere liste choisie, conservee si on repasse par "principal" ou "tous". */
let customDisplays: number[] = [];
let lastDisplayList: AppState['displayList'] = [];

function applyDisplays({ displays, displayList }: AppState): void {
  const mode = Array.isArray(displays) ? 'custom' : displays;
  if (Array.isArray(displays)) customDisplays = displays;
  lastDisplayList = displayList;

  for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="displayMode"]')) {
    radio.checked = radio.value === mode;
  }

  const list = $<HTMLElement>('displayList');
  list.hidden = mode !== 'custom';
  list.replaceChildren(
    ...displayList.map((display) => {
      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.value = String(display.id);
      box.checked = Array.isArray(displays) && displays.includes(display.id);
      label.append(box, ` ${display.label}${display.primary ? ' — principal' : ''}`);
      return label;
    }),
  );

  // Choix fait sur des ecrans aujourd'hui debranches : on le dit plutot que
  // d'afficher une liste vide de coches.
  const hint = $<HTMLElement>('displayHint');
  const connected = Array.isArray(displays) && displays.some((id) => displayList.some((d) => d.id === id));
  hint.hidden = mode !== 'custom' || connected;
  hint.textContent = 'Aucun ecran choisi parmi ceux branches : affichage sur l\'ecran principal.';
}

function apply(state: AppState): void {
  applyUpdater(state.updater);

  const status = STATUS[state.status];
  dot.className = `dot ${status.cls}`;
  statusText.textContent = state.detail && state.status !== 'online' ? state.detail : status.label;

  pairCard.hidden = state.linked;
  linkedCard.hidden = !state.linked;

  if (!state.linked) return;

  $<HTMLElement>('username').textContent = state.user?.username ?? '';
  $<HTMLElement>('serverLabel').textContent = state.serverUrl;

  const avatar = $<HTMLImageElement>('avatar');
  if (state.user?.avatarUrl) avatar.src = state.user.avatarUrl;

  $<HTMLInputElement>('muted').checked = state.muted;
  applyDisplays(state);
  $<HTMLInputElement>('launchAtLogin').checked = state.launchAtLogin;
  $<HTMLInputElement>('volume').value = String(Math.round(state.volume * 100));
}

/* -------------------------------------------------------------------------- */

codeInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') void submitPair();
});

pairButton.addEventListener('click', () => void submitPair());

async function submitPair(): Promise<void> {
  const code = codeInput.value.trim().toUpperCase();

  if (code.length < 4) {
    pairError.hidden = false;
    pairError.textContent = 'Entre le code donne par le bot Discord.';
    return;
  }

  pairButton.disabled = true;
  pairButton.textContent = 'Connexion…';
  pairError.hidden = true;

  const result = await window.livememes.pair(code);

  pairButton.disabled = false;
  pairButton.textContent = 'Connecter';

  if (!result.ok) {
    pairError.hidden = false;
    pairError.textContent = result.error;
    return;
  }
  codeInput.value = '';
}

$<HTMLInputElement>('muted').addEventListener('change', (event) => {
  void window.livememes.setSettings({ muted: (event.target as HTMLInputElement).checked });
});

for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="displayMode"]')) {
  radio.addEventListener('change', () => {
    if (!radio.checked) return;
    void window.livememes.setSettings({
      // Premiere selection : on part des ecrans utilises en ce moment.
      displays:
        radio.value !== 'custom'
          ? radio.value
          : customDisplays.length > 0
            ? customDisplays
            : lastDisplayList.filter((display) => display.active).map((display) => display.id),
    });
  });
}

$<HTMLElement>('displayList').addEventListener('change', () => {
  const ids = [...document.querySelectorAll<HTMLInputElement>('#displayList input:checked')].map((box) =>
    Number(box.value),
  );
  void window.livememes.setSettings({ displays: ids });
});

$<HTMLButtonElement>('identifyButton').addEventListener('click', () => {
  void window.livememes.identifyDisplays();
});

$<HTMLInputElement>('launchAtLogin').addEventListener('change', (event) => {
  void window.livememes.setSettings({ launchAtLogin: (event.target as HTMLInputElement).checked });
});

$<HTMLInputElement>('volume').addEventListener('change', (event) => {
  void window.livememes.setSettings({
    volume: Number((event.target as HTMLInputElement).value) / 100,
  });
});

$<HTMLButtonElement>('previewButton').addEventListener('click', () => {
  void window.livememes.preview();
});

$<HTMLButtonElement>('updateButton').addEventListener('click', () => {
  if (updateState === 'available' || updateState === 'ready') void window.livememes.applyUpdate();
  else void window.livememes.checkUpdate();
});

$<HTMLButtonElement>('unlinkButton').addEventListener('click', () => {
  void window.livememes.unlink();
});

window.livememes.onState(apply);
void window.livememes.getState().then(apply);
