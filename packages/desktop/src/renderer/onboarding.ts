import { PAIRING_CODE_LENGTH } from '@livememes/shared';

/**
 * Logique du tutoriel de premiere ouverture, sans DOM : la fenetre de reglages
 * l'applique, les tests la verifient directement.
 */

export const STEPS = ['welcome', 'discord', 'code', 'done', 'tips'] as const;
export type Step = (typeof STEPS)[number];

/** Etapes qui menent a l'appairage : on y reste tant que l'appareil n'est pas lie. */
const PAIRING_STEPS: readonly Step[] = ['welcome', 'discord', 'code'];

export interface OnboardingState {
  linked: boolean;
  /** true si cet appareil a deja ete lie une fois : on saute alors la bienvenue. */
  onboarded: boolean;
}

/**
 * Etape a afficher apres reception d'un nouvel etat. `null` = vue reglages.
 * `wasLinked` vaut null au premier etat recu.
 */
export function nextStep(current: Step | null, wasLinked: boolean | null, state: OnboardingState): Step | null {
  if (!state.linked) {
    if (current !== null && PAIRING_STEPS.includes(current)) return current;
    // Premier lancement, appareil delie ou token refuse par le serveur.
    return state.onboarded ? 'discord' : 'welcome';
  }
  // Appairage reussi pendant le tutoriel : on confirme.
  if (wasLinked === false) return 'done';
  return current;
}

export type CodeCheck = { ok: true; code: string } | { ok: false; error: string };

/**
 * Nettoie un code colle depuis Discord : espaces, tirets et backticks du bloc
 * de code partent, la casse est ignoree.
 */
export function normalizeCode(raw: string): CodeCheck {
  const code = raw.replace(/[\s`'"-]/g, '').toUpperCase();

  if (code.length === 0) {
    return { ok: false, error: 'Colle le code donne par le bot dans Discord.' };
  }
  if (!/^[A-Z0-9]+$/.test(code)) {
    return { ok: false, error: 'Le code ne contient que des lettres et des chiffres. Recopie-le depuis Discord.' };
  }
  if (code.length !== PAIRING_CODE_LENGTH) {
    return {
      ok: false,
      error: `Le code fait ${PAIRING_CODE_LENGTH} caracteres, celui-ci en a ${code.length}. Verifie que tu l'as copie en entier.`,
    };
  }
  return { ok: true, code };
}

/** Message affiche quand le serveur refuse l'appairage. */
export function pairErrorMessage(status: number, serverMessage: string | undefined): string {
  if (status === 400) {
    return 'Code invalide ou expire. Refais /livememes link dans Discord pour en obtenir un nouveau.';
  }
  if (status === 429) {
    return 'Trop de tentatives. Patiente une dizaine de minutes avant de reessayer.';
  }
  if (status >= 500) {
    return `Le serveur rencontre un probleme (${status}). Reessaie dans un moment.`;
  }
  return serverMessage ?? `Le serveur a repondu ${status}.`;
}
