# Charte LiveMemes

Reference visuelle du client desktop (reglages, tutoriel, overlay, installeurs).
La maquette d'origine est l'artboard "Refonte - fenetre de reglages" du canvas
lie dans l'issue #19 ; le reste en decline les memes regles.

Les variables vivent dans [`src/renderer/tokens.css`](src/renderer/tokens.css),
importe par `settings.css` et `overlay.css`. Ne code pas une couleur en dur
ailleurs : ajoute une variable.

## Direction

Fun et meme-culture, mais lisible : un fond bleu nuit, deux couleurs vives qui
claquent (violet, citron), du rouge pour le "live" et les actions dangereuses.
Les elements actifs ont une **tranche** pleine sous eux (ombre portee sans
flou) et s'enfoncent au clic, comme une touche. Formes tres arrondies, pas de
degrade, pas de bordure gauche coloree.

Un seul theme, sombre : l'app vit par-dessus des jeux et en barre de menus. La
variante claire ne sert qu'au fond du DMG macOS (Finder y ecrit les noms
d'icones en noir).

## Couleurs

| Variable | Valeur | Role |
| --- | --- | --- |
| `--bg` | `#0D1226` | Fond de fenetre, cadre des memes, texte sur citron |
| `--surface` | `#161C3A` | Cartes, pastilles |
| `--surface-2` | `#1F2650` | Vignettes inactives (choix d'ecran) |
| `--raised` | `#252D5C` | Boutons secondaires, fonds d'icone, barres eteintes |
| `--track` | `#2A3266` | Rail d'interrupteur eteint |
| `--edge` / `--edge-deep` | `#0A0F22` / `#080B1B` | Tranches des elements sombres |
| `--text` | `#EEF1FF` | Texte principal ("papier") |
| `--text-2` | `#C5CBF0` | Texte sur vignette, icones eteintes |
| `--muted` | `#9AA3D4` | Texte secondaire |
| `--accent` / `--accent-edge` | `#6C5CFF` / `#3F33B8` | Violet : selection, bulle du logo, tranche des memes |
| `--lime` / `--lime-edge` | `#C8FF3A` / `#86A80E` | Citron : action principale, etat actif, chiffres |
| `--red` / `--red-edge` | `#FF4D4D` / `#A32A3A` | Rouge live : sourdine, erreur, pastille du logo |
| `--red-text` / `--red-deep` | `#FF7070` / `#4A1A28` | Texte rouge sur fond sombre, tranche du bouton danger |
| `--orange` | `#F5A524` | Connexion en cours |

Sur fond clair (DMG) : texte `#0D1226`, accent texte `#5B49F0`, cercles `#E0E4FF`.

Contrastes verifies (WCAG AA = 4,5:1) : texte/fond 16,5 ; secondaire/carte
6,8 ; citron/carte 14,1 ; nuit/citron 15,7 ; nuit/rouge 5,7 ; rouge texte/fond
6,9 ; blanc/violet 4,6 ; violet fonce/papier 5,1. Une nouvelle paire de
couleurs doit passer 4,5:1, meme pour un petit libelle gris.

## Typographie

| Usage | Police | Graisse | Taille |
| --- | --- | --- | --- |
| Titres, chiffres, boutons principaux, legende des memes | Unbounded | 700 | 13-24 px (reglages), `clamp()` en vh (overlay) |
| Texte courant, libelles, boutons secondaires | Figtree | 500-700 | 12,5-14 px |
| Codes (`/meme`, code d'appairage dans le mock Discord) | monospace systeme | - | 12 px |
| Etiquettes en capitales (statut, etapes du tutoriel) | Figtree | 700 | 12 px, `letter-spacing: 0.08em` |

Les deux polices sont embarquees (`src/renderer/fonts/`, licence SIL OFL, sous-
ensemble latin) : la CSP interdit toute police distante. Les SVG charges en
`<img>` (meme de test, installeurs) n'ont pas acces aux polices : leur texte est
converti en traces.

## Formes et espacements

- Rayons : `--r-card` 24 px (cartes, tuiles), `--r-btn` 18 px (gros boutons,
  vignettes), `--r-icon` 14 px, `--r-small` 12 px, `--r-pill` pour les pastilles.
- Espacement : `--gap` 12 px entre blocs, `--pad-card` 16x18 px dans les cartes,
  20x24 px autour de la fenetre.
- Tranches : 3 px (petits boutons), 4 px (vignettes), 5 px (tuiles, gros
  boutons). Au clic : `translateY(3px)` et la tranche disparait (`.press`).

## Composants (fenetre de reglages)

- **Bouton** `.btn` : gris releve ; `--lime` pour l'action principale (texte
  Unbounded nuit), `--accent` pour avancer dans le tutoriel, `--danger` en
  contour rouge pour delier. Toujours un `<button>`.
- **Tuile interrupteur** `.tile` : `role="switch"` + `aria-checked`. Eteinte :
  carte sombre. Allumee : remplie de sa couleur (`--on`, citron par defaut,
  rouge pour la sourdine, violet pour la croix avec texte blanc), icone et rail
  passent en nuit. `.tile--row` la met en ligne pour un reglage secondaire.
- **Vignette de choix** `.screen` : `role="radio"` dans un `radiogroup`, violet
  quand selectionnee, ecrans dessines en citron.
- **Pastille** `.pill` : statut (point qui pulse en ligne), bouton Tutoriel.
- **Egaliseur de volume** `.volume` : `role="slider"`, 10 barres de hauteurs en
  dents de scie, pilotable au clavier (fleches, Page, Debut/Fin).
- **Notice** `.notice` : bandeau rouge translucide pour un etat a expliquer
  (deconnexion, appareil revoque).
- **Avatar** `.avatar` : initiale nuit sur citron, l'avatar Discord par-dessus
  quand il charge.

## Overlay

- Le meme garde ses proportions ; il recoit un **lisere bleu nuit** et une
  **tranche violette** dessous, plus une ombre large qui le detache d'un fond
  clair comme sombre. Tout passe par `box-shadow` (rasterise une fois), jamais
  par `filter` (recalcule a chaque image d'une video).
- Legende : sticker nuit en Unbounded, legerement penche (-1,5 deg), tranche
  citron.
- Auteur : pastille sombre, avatar ou initiale citron.
- "Identifier" : numero citron geant dans une carte nuit cerclee de violet.
- Animations sur `transform` et `opacity` uniquement. `prefers-reduced-motion`
  remplace chute et rebond par un fondu.
- Croix de fermeture : rond bleu nuit translucide cercle de clair, en haut a
  droite du meme, opacite 0,65 au repos ; rouge plein avec tranche au survol.
  Zone cliquable elargie de 10 px autour du rond, recalee dans l'ecran quand le
  meme deborde.
- L'overlay ne capte la souris que sur la croix : `pointer-events: none`
  partout ailleurs, et la fenetre ne quitte `setIgnoreMouseEvents(true)` que
  pendant que le curseur, releve par le main, est sur la croix.

## Mouvement et accessibilite

- Focus clavier : contour citron 3 px, decale de 3 px, sur tout element
  focusable.
- Toute animation en boucle (point de statut, egaliseur du logo) s'arrete avec
  `prefers-reduced-motion: reduce`.
- Pas d'information portee par la couleur seule : chaque etat a aussi un texte
  (statut, sous-titres des tuiles, "A jour").

## Ton des textes

Tutoiement, phrases courtes, verbes d'action ("Colle le code ici", "Delier cet
appareil"). Francais **sans accents** comme tout le depot. Un message d'erreur
dit quoi faire ensuite.

## Assets

| Fichier | Source | Regeneration |
| --- | --- | --- |
| `assets/icon.png`, `assets/tray*.png` | `livememes-logo/` a la racine | Kit logo (voir `LISEZMOI.txt`) |
| `src/renderer/logo.svg` | Kit logo | - |
| `src/renderer/preview.svg` | Meme de test, texte en traces | A la main |
| `build/installerSidebar.bmp`, `build/installerHeader.bmp` | `build/*.svg` | `npm run art -w @livememes/desktop` |
| `build/background.png`, `build/background@2x.png` (DMG) | `build/background.svg` | idem |
| `docs/captures/*.png` (racine) | Captures pour le README | A refaire quand l'UI change |
