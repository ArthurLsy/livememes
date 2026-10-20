/**
 * Avatar Discord par-dessus une initiale, partage par les reglages et
 * l'overlay : l'initiale reste visible tant que l'image n'a pas charge, ou si
 * elle echoue.
 */

/** Initiale affichee tant que l'avatar Discord n'est pas charge (ou s'il n'y en a pas). */
export function initialOf(username: string | undefined): string {
  const first = username?.trim().charAt(0) ?? '';
  return first ? first.toUpperCase() : '?';
}
