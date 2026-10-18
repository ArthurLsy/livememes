/**
 * Verification du type reel d'un media par sa signature (magic bytes).
 *
 * Le content-type HTTP est declare par l'hote distant : il peut annoncer
 * image/png et servir du HTML. On compare les premiers octets au type annonce.
 */

/** Octets a lire en tete de fichier pour trancher. */
export const SNIFF_BYTES = 16;

function ascii(head: Uint8Array, offset: number, text: string): boolean {
  if (head.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (head[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

function bytes(head: Uint8Array, offset: number, expected: number[]): boolean {
  if (head.length < offset + expected.length) return false;
  return expected.every((value, i) => head[offset + i] === value);
}

/** Conteneur ISO BMFF (MP4, MOV, AVIF) : boite `ftyp` en tete, marque en 8..12. */
function ftypBrand(head: Uint8Array): string | null {
  if (!ascii(head, 4, 'ftyp') || head.length < 12) return null;
  return String.fromCharCode(...head.subarray(8, 12));
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const AVIF_BRANDS = new Set(['avif', 'avis', 'mif1', 'msf1']);
/** Premiers atomes possibles d'un vieux .mov sans boite ftyp. */
const QUICKTIME_ATOMS = ['moov', 'mdat', 'wide', 'free', 'skip', 'pnot'];

const SIGNATURES: Record<string, (head: Uint8Array) => boolean> = {
  'image/png': (head) => bytes(head, 0, PNG),
  'image/apng': (head) => bytes(head, 0, PNG),
  'image/jpeg': (head) => bytes(head, 0, [0xff, 0xd8, 0xff]),
  'image/gif': (head) => ascii(head, 0, 'GIF87a') || ascii(head, 0, 'GIF89a'),
  'image/webp': (head) => ascii(head, 0, 'RIFF') && ascii(head, 8, 'WEBP'),
  'image/avif': (head) => AVIF_BRANDS.has(ftypBrand(head) ?? ''),
  'video/mp4': (head) => ftypBrand(head) !== null,
  'video/quicktime': (head) =>
    ftypBrand(head) !== null || QUICKTIME_ATOMS.some((atom) => ascii(head, 4, atom)),
  'video/webm': (head) => bytes(head, 0, [0x1a, 0x45, 0xdf, 0xa3]),
};

/** Vrai si les premiers octets correspondent au type annonce. */
export function matchesSignature(contentType: string, head: Uint8Array): boolean {
  const check = SIGNATURES[contentType];
  return check ? check(head) : false;
}
