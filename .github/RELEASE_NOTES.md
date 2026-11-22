LiveMemes sait maintenant monter tes memes. Balance un meme depuis Discord ou
depuis l'app, il s'affiche en plein ecran chez tous les membres de ton salon vocal.

![LiveMemes](https://raw.githubusercontent.com/ArthurLsy/livememes/main/docs/captures/overlay.png)

## Nouveau dans cette version

- **Correctif : la banque de memes defile** : les memes ne retrecissent plus
  quand la banque se remplit, la liste defile normalement. Meme correctif
  pour la banque de sons.

Deja dans la 0.6.0 :

- **Banque de sons** : dans l'editeur, pioche un son dans la banque (ecoute-le
  avant de choisir) ou importe le tien (mp3, m4a, wav, ogg, ou la bande son
  d'une video). Tu peux partager ton son dans la banque pour tout le monde.
- **Un son sur une photo** : ajoute un son a une image, elle part en plein
  ecran avec le son, pendant la duree choisie.
- **Remplace la bande son d'une video** : le son ajoute prend la place du son
  d'origine, ou s'y melange si tu remets le son d'origine. Cale-le en le
  glissant dans la piste "Ajout" de la timeline.
- **Plusieurs ecrans, un seul son** : un meme affiche sur plusieurs ecrans ne
  joue plus son son en echo, une seule fois suffit.

Deja dans la 0.5.0 : partager tes videos dans la banque de memes. Dans la
0.4.0 : la colonne "qui est dans le vocal", la banque de memes et les memes qui
se calent dans les coins.

Depuis la 0.1.0, l'installeur Windows et l'AppImage se mettent a jour tout
seuls : redemarre l'app quand elle le propose.

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
2. Suis le tutoriel : dans Discord, tape `/livememes link`, le bot te donne un
   code a coller dans l'app. Il n'y a aucune adresse de serveur a renseigner.
3. Rejoins un salon vocal, puis `/meme url` ou `/meme fichier`, ou passe par
   l'editeur de l'app et clique sur Envoyer.

Le meme s'affiche chez tous les membres du vocal qui ont l'app ouverte. Les
reponses du bot sont privees : personne d'autre que toi ne les voit dans le
salon textuel.

## Reglages utiles

`/livememes mute` coupe la reception, `/livememes clear` efface ce qui est a
l'ecran, `/livememes status` dit qui, dans ton vocal, peut recevoir des memes.
Dans l'app : sourdine, volume, choix des ecrans d'affichage, memes en haut a
gauche, croix de fermeture, lancement au demarrage.

L'overlay ne bloque jamais un clic : la souris le traverse.

## Connu

- Mises a jour automatiques sur Windows (installeur) et Linux (AppImage) :
  l'app telecharge la nouvelle version et propose de redemarrer. Sur macOS et
  avec le zip Windows, elle signale la nouvelle version, a telecharger a la main.
  Depuis une version anterieure a cette fonctionnalite, reinstalle une fois a la
  main.
- Un jeu en mode video exclusif (plein ecran natif) peut passer devant
  l'overlay. Le mode fenetre sans bordure marche toujours.
