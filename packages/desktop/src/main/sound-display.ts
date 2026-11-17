/**
 * Ecran qui porte le son d'un meme (#38). Chaque ecran cible a sa fenetre
 * d'overlay et sa propre lecture : sans arbitrage, une video sonore serait
 * entendue une fois par ecran, en echo. Une seule fenetre joue le son, les
 * autres affichent la meme video muette.
 *
 * Sans Electron : le main lui passe les ids d'ecrans, les tests aussi.
 */

/**
 * L'ecran principal s'il affiche des memes, sinon le premier ecran cible.
 * Null s'il n'y a aucun ecran cible.
 */
export function soundDisplay(targets: readonly number[], primary: number): number | null {
  if (targets.includes(primary)) return primary;
  return targets[0] ?? null;
}

/** Volume a envoyer a la fenetre de l'ecran `display` : celui du drop, ou 0. */
export function volumeFor(display: number, soundOn: number | null, volume: number): number {
  return display === soundOn ? volume : 0;
}
