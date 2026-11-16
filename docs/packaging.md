# Construire et vérifier l'installateur Windows

## Construire

Prérequis : `services\transcription\.venv` installé depuis `requirements-lock.txt` (voir le [README](../README.md)), `npm ci` fait, et FFmpeg avec son fichier `LICENSE` (dossier parent de `bin\ffmpeg.exe`, comme dans les archives de gyan.dev).

```powershell
npm run package
# ou, pour choisir FFmpeg ou réutiliser le service déjà gelé :
powershell -ExecutionPolicy Bypass -File scripts\build-installer.ps1 -FfmpegPath C:\chemin\bin\ffmpeg.exe -SkipService
```

Résultat dans `release\` : `LinguaNote-AI-Setup-0.1.0.exe` (environ 216 Mo ; 710 Mo une fois installé) et `win-unpacked\` (les fichiers installés).

## Ce qui est livré

| Élément | Emplacement installé | Remarque |
| --- | --- | --- |
| Application Electron | `resources\app.asar` | Verrous de sécurité : voir [security.md](security.md) |
| Service Python gelé (PyInstaller, dossier) | `resources\service\` | Sans le serveur MCP, l'outil d'évaluation ni le moteur Omnilingual, disponibles depuis les sources seulement |
| FFmpeg et sa licence | `resources\ffmpeg\` | Copié depuis la machine de build, jamais téléchargé par le script |
| Modèles | **non livrés** | Cache Hugging Face de l'utilisateur, après son accord |

Données, historique et journaux : `%APPDATA%\@linguanote\desktop\data`. La désinstallation les conserve ([security.md](security.md)).

## Vérifier

À refaire après chaque changement de dépendance : ces contrôles sont les seuls à exercer l'application empaquetée.

```powershell
# 1. Le service gelé, sans Python ni FFmpeg dans le PATH, sur de la parole synthétique (fichier et direct).
.\services\transcription\.venv\Scripts\python.exe scripts\verify_frozen_service.py
# Idem avec le moteur language-routing, si ses modèles sont installés et configurés.
.\services\transcription\.venv\Scripts\python.exe scripts\verify_frozen_service.py --routing

# 2. L'application empaquetée : toutes les vérifications du test de fumée.
npm run smoke:packaged

# 3. L'installation réelle : installer, vérifier, désinstaller.
.\release\LinguaNote-AI-Setup-0.1.0.exe /S /currentuser "/D=C:\Temp\LinguaNote test"
$env:LINGUANOTE_SMOKE_EXE = "C:\Temp\LinguaNote test\LinguaNote AI.exe"; npm run smoke:packaged
& "C:\Temp\LinguaNote test\Uninstall LinguaNote AI.exe" /S /currentuser
```

Ces vérifications utilisent des modèles déjà en cache : aucune ne télécharge quoi que ce soit (`HF_HUB_OFFLINE=1`).

## Ce qui a été vérifié (2026-11-06, Windows 11, machine de développement)

- Service gelé : démarre sans environnement de développement ; une phrase synthétique en français revient en texte (85 % des mots) par fichier et en direct, avec `faster-whisper base` et avec `language-routing` configuré sur cette machine. Ce n'est **pas** une mesure de qualité : voix de synthèse, français seulement.
- Wolof dans le service gelé (contrôle ponctuel, pas une nouvelle mesure de qualité) : 12 clips ALFFA `dev`, 49 s de parole lue, moteur `language-routing`. Textes **identiques** entre le service gelé et les sources pour les 12 clips, par fichier (Kiriku) et en direct (M9). L'échantillon est trop petit pour remplacer les chiffres de [evaluation-wolof.md](evaluation-wolof.md). Temps total, chargement des modèles compris, sur un Core i5-1135G7 : environ 10 fois la durée de l'audio par fichier et 3,5 fois en direct.
- **Direct en wolof continu** (2026-11-16, service gelé, `language-routing` avec M9 pour le direct, `LINGUANOTE_LIVE_JOB_TIMEOUT_SECONDS=120`). Les clips ALFFA `dev` sont collés bout à bout, sans pause, et envoyés au rythme réel :
  - 5 min (301 s) : 24 passages finalisés, aucune erreur, arrêt propre. Le retard du texte passe de 12 s à 72 s, soit environ 0,2 s de plus par seconde de parole : le modèle est environ 1,25 fois plus lent que l'audio sur ce Core i5-1135G7.
  - 10 min (642 s) : texte reçu jusqu'à la 502ᵉ seconde (40 passages, retard d'environ 112 s). Puis, à 627 s, erreur explicite `overloaded` et fin de session. Les passages encore en file sont abandonnés : à peu près les deux dernières minutes de parole n'ont jamais donné de texte.
  - Conséquence : sur cette machine, le direct en wolof convient à quelques minutes de parole continue, pas à une réunion entière. Une vraie conversation contient des pauses, ce qui retarde ce seuil sans le supprimer (non mesuré). Pour une réunion longue, mieux vaut enregistrer puis transcrire le fichier.
- Installateur : installation silencieuse, mise à niveau par-dessus, désinstallation.
- Application installée : test de fumée complet, y compris le service, la CSP, les permissions, une session en direct par IPC et l'historique.
- Lancement réel : boîte de consentement affichée et refus respecté, second lancement sans seconde instance, fermeture sans processus orphelin, fenêtre principale et bulle regardées à l'écran (état de repos).

## Non vérifié

- **Un Windows neuf**, sans Python, sans FFmpeg, sans modèles en cache et sans les bibliothèques déjà présentes ici. C'est le prochain test à faire, par exemple dans le Bac à sable Windows. Le service gelé embarque le runtime Visual C++ repéré par PyInstaller, mais rien n'a confirmé qu'il suffit.
- **Le téléchargement réel du modèle après accord** : le modèle était déjà en cache sur cette machine.
- Un vrai microphone dans l'application installée.
- La présence d'un antivirus tiers. Un exécutable non signé produit par PyInstaller peut être signalé à tort.

## Licences : à régler avant toute diffusion publique

| Composant | Licence | Conséquence |
| --- | --- | --- |
| LinguaNote AI | **aucune déclarée** | Sans licence, personne d'autre n'a le droit de réutiliser ce code. À choisir par l'auteur |
| FFmpeg (build « essentials » de gyan.dev) | **GPLv3** (`--enable-gpl --enable-version3`) | La licence est livrée, mais distribuer ce binaire impose aussi de donner accès à son code source correspondant. Pour une diffusion publique : fournir cet accès, ou construire avec un FFmpeg sous LGPL qui suffit à décoder l'audio (`-FfmpegPath`) |
| Electron, Chromium | MIT et licences tierces | `LICENSE.electron.txt` et `LICENSES.chromium.html` sont installés |
| Dépendances Python gelées | Variables | Inventaire à établir (`faster-whisper` MIT, `ctranslate2` MIT, `onnxruntime` MIT, PyAV BSD avec FFmpeg embarqué). Aucun avis de tiers n'est encore livré pour elles |
| Modèles Whisper (non livrés) | MIT (Systran/OpenAI) | Téléchargés par l'utilisateur |
| Modèles wolof (non livrés) | Voir [model-selection.md](model-selection.md) | Kiriku : accès protégé, ne pas redistribuer sans vérifier |

Cette table est un repérage technique, pas un avis juridique.
