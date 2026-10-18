Beta ouverte. Balance un meme depuis Discord, il s'affiche en plein ecran chez
tous les membres de ton salon vocal.

## Nouveau dans cette version

- Les videos sont jouees une fois, jusqu'a la fin (60 s max), au lieu de boucler
  ou d'etre coupees.
- Plusieurs memes d'affilee s'affichent l'un apres l'autre au lieu de se
  superposer.
- Choix des ecrans d'affichage dans les reglages, avec un bouton "Identifier".
- Mises a jour automatiques (voir plus bas).

## Installer

| Systeme | Fichier |
| --- | --- |
| Windows | `LiveMemes-*-win-x64.exe` (installeur) ou `...-win-x64.zip` pour lancer sans installer |
| macOS Apple Silicon | `LiveMemes-*-mac-arm64.dmg` |
| macOS Intel | `LiveMemes-*-mac-x64.dmg` |
| Linux | `LiveMemes-*-linux-x86_64.AppImage` |

Les binaires ne sont pas signes :

- **Windows** — SmartScreen affiche "Windows a protege votre ordinateur" :
  Informations complementaires puis Executer quand meme.
- **macOS** — au premier lancement, clic droit sur l'app puis Ouvrir. Si macOS
  refuse malgre tout, `xattr -cr /Applications/LiveMemes.app` dans le Terminal.
- **Linux** — rends l'AppImage executable : `chmod +x LiveMemes-*.AppImage`.

## Utiliser

1. Lance l'app. Elle vit dans la barre de menus (macOS) ou la zone de
   notification (Windows), pas dans la barre des taches.
2. Dans Discord, tape `/livememes link`. Le bot te donne un code.
3. Colle le code dans l'app. Il n'y a aucune adresse de serveur a renseigner.
4. Rejoins un salon vocal, puis `/meme url` ou `/meme fichier`.

Le meme s'affiche chez tous les membres du vocal qui ont l'app ouverte. Les
reponses du bot sont privees : personne d'autre que toi ne les voit dans le
salon textuel.

## Reglages utiles

`/livememes mute` coupe la reception, `/livememes clear` efface ce qui est a
l'ecran, `/livememes status` dit qui, dans ton vocal, peut recevoir des memes.
Dans l'app : sourdine, volume, choix des ecrans d'affichage, lancement au
demarrage.

L'overlay ne bloque jamais un clic : la souris le traverse.

## Connu

- L'app porte encore l'icone Electron par defaut.
- Mises a jour automatiques sur Windows (installeur) et Linux (AppImage) :
  l'app telecharge la nouvelle version et propose de redemarrer. Sur macOS et
  avec le zip Windows, elle signale la nouvelle version, a telecharger a la main.
  Depuis une version anterieure a cette fonctionnalite, reinstalle une fois a la
  main.
- Un jeu en mode video exclusif (plein ecran natif) peut passer devant
  l'overlay. Le mode fenetre sans bordure marche toujours.
