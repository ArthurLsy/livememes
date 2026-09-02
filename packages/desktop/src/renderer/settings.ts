export {}; // fait de ce fichier un module : requis pour `declare global`.

interface AppState {
  serverUrl: string;
  linked: boolean;
  user: { id: string; username: string; avatarUrl: string | null } | null;
  volume: number;
  muted: boolean;
  allDisplays: boolean;
  launchAtLogin: boolean;
  status: 'offline' | 'connecting' | 'online' | 'unauthorized';
  detail: string | null;
}

declare global {
  interface Window {
    livememes: {
      getState(): Promise<AppState>;
      pair(code: string): Promise<{ ok: true } | { ok: false; error: string }>;
      unlink(): Promise<void>;
      setSettings(patch: Record<string, unknown>): Promise<AppState>;
      preview(): Promise<void>;
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

function apply(state: AppState): void {
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
  $<HTMLInputElement>('allDisplays').checked = state.allDisplays;
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

$<HTMLInputElement>('allDisplays').addEventListener('change', (event) => {
  void window.livememes.setSettings({ allDisplays: (event.target as HTMLInputElement).checked });
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

$<HTMLButtonElement>('unlinkButton').addEventListener('click', () => {
  void window.livememes.unlink();
});

window.livememes.onState(apply);
void window.livememes.getState().then(apply);
