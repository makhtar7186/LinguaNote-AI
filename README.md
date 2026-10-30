# LinguaNote AI

Prototype local de transcription (français, anglais ; wolof et phrases mixtes **non validés**). Le client desktop Electron/React importe un fichier audio/vidéo ou enregistre au microphone, l'envoie au service local FastAPI, puis affiche le texte, la langue estimée et les segments horodatés.

Tout le traitement reste sur la machine. Une seule action utilise le réseau : le téléchargement des poids du modèle Whisper depuis Hugging Face lors de la **première transcription**.

## Prérequis (Windows)

- Python 3.11 à 3.13
- Node.js 22 ou plus récent et npm
- FFmpeg dans le `PATH` (ou variable `LINGUANOTE_FFMPEG` vers `ffmpeg.exe`) ; vérifier avec `ffmpeg -version`

## Installation et démarrage

Installation du service Python (une fois) :

```powershell
cd services\transcription
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e ".[api,windows-asr,dev]"
```

Application Electron (depuis la racine du dépôt) :

```powershell
npm install
npm run dev
```

Electron **démarre lui-même le service Python** (`services/transcription/.venv`, ou `LINGUANOTE_PYTHON`) sur un port libre de `127.0.0.1`, avec un jeton secret généré à chaque lancement, et l'arrête à la fermeture. Aucun terminal séparé n'est nécessaire.

**Bulle flottante.** Une petite bulle ronde reste au-dessus des autres applications (en bas à droite au premier lancement, puis là où vous l'avez laissée). Cliquez-la pour la déployer : état, derniers mots, boutons Démarrer / Pause / Reprendre / Arrêter. Un anneau rouge qui pulse et un point « REC » signalent que le micro est ouvert ; la pause libère le micro. Raccourcis globaux par défaut : `Ctrl+Alt+D` (D comme dicter) démarrer/arrêter, `Ctrl+Alt+P` pause/reprise, `Ctrl+Alt+B` afficher/masquer la bulle (modifiables par variables d'environnement, voir `.env.example` ; un raccourci déjà pris par une autre application est signalé dans la bulle). Démarrer la dictée affiche toujours la bulle, et on ne peut pas la masquer pendant qu'elle enregistre.

Service seul (API, tests manuels, serveur MCP) : voir [services/transcription/README.md](services/transcription/README.md). Le jeton `LINGUANOTE_API_TOKEN` y est obligatoire.

Aperçu navigateur sans Electron : démarrer le service à la main avec `LINGUANOTE_CORS_ORIGINS=http://127.0.0.1:5173`, définir `VITE_TRANSCRIPTION_TOKEN` avec le même jeton, puis `npm run dev:web` et `http://127.0.0.1:5173`. Dans ce mode seulement, le renderer appelle directement le service ; dans l'application Electron, il passe par IPC et ne voit jamais le jeton.

Toutes les variables d'environnement sont listées dans [.env.example](.env.example).

## Commandes de développement

| Objet | Commande | Dossier |
| --- | --- | --- |
| Tests frontend (Vitest) | `npm test` | racine |
| Vérification TypeScript | `npm run typecheck` | racine |
| Lint frontend (ESLint) | `npm run lint` | racine |
| Test de fumée de l'application réelle (Electron, fenêtres cachées, service Python réel) | `npm run build` puis `npm run smoke` | racine |
| Build du renderer | `npm run build` | racine |
| Tests backend (Pytest) | `python -m pytest` | `services/transcription` |
| Lint backend (Ruff) | `python -m ruff check app tests` | `services/transcription` |
| Évaluation d'un corpus (WER/CER, vitesse, mémoire) | `python -m app.evaluation run --manifest <manifest.csv> --models base` | `services/transcription` |
| Corpus de synthèse de contrôle | `powershell -File scripts\make-synthetic-corpus.ps1` | racine |

Les tests Pytest qui convertissent de l'audio exigent FFmpeg ; ils sont ignorés s'il est absent. Aucun test ne télécharge de modèle.

## Limites actuelles

- Fichier : 50 Mio maximum, audio de 10 minutes maximum par défaut (`LINGUANOTE_MAX_AUDIO_SECONDS`). Le traitement est séquentiel : une transcription à la fois.
- Moteur : faster-whisper `base`, CPU INT8. La qualité n'a pas été mesurée sur le wolof ni sur le code-switching ; la langue affichée est une estimation du modèle, pas une garantie.
- Deux modes micro : enregistrement jusqu'à 5 minutes puis transcription, et **dictée en direct** dans la fenêtre Electron (texte provisoire en gris, définitif à la fin de la phrase). Le direct découpe l'audio aux silences avec un seuil d'énergie fixe (non adaptatif au bruit), n'a été validé qu'avec de la voix de synthèse FR/EN, et un énoncé très long est coupé à son point le plus silencieux (un mot peut être coupé). La bulle flottante et les raccourcis globaux existent (phase 3) mais leur rendu à l'écran n'a jamais été regardé ni les raccourcis éprouvés avec de vraies touches ; pas de capture de l'audio système, pas d'historique ni d'export (phases 4 et 5, voir [docs/roadmap.md](docs/roadmap.md)).
- Le service Python est lancé par Electron depuis l'environnement de développement (`.venv`). Il n'est pas encore embarqué : aucun installateur n'existe (voir « Packaging » dans [docs/roadmap.md](docs/roadmap.md)).
- Testé uniquement sous Windows 11. Le lanceur a été vérifié contre le vrai service (démarrage, 401 sans jeton, 200 avec jeton, arrêt sans processus orphelin). Le test de fumée (`npm run smoke`) ouvre la vraie application Electron avec fenêtres cachées et valide ses deux pages, la sécurité du renderer, le service Python, la bulle (taille, position, déploiement) et une session en direct par IPC. Non vérifié : l'apparence réelle à l'écran, un vrai microphone dans la fenêtre, les raccourcis globaux avec de vraies touches, plusieurs écrans, l'application packagée.

## Sécurité et confidentialité

Résumé ; détails dans [docs/security.md](docs/security.md).

- Le service écoute sur `127.0.0.1` uniquement et refuse tout autre nom d'hôte.
- Jeton `LINGUANOTE_API_TOKEN` **obligatoire** : le service ne démarre pas sans lui, et toute requête sans l'en-tête `X-LinguaNote-Token` correct reçoit 401. Il protège contre les autres processus locaux et contre les pages web qui enverraient des requêtes vers le port local. Electron le génère à chaque lancement.
- Les corps de requête trop grands sont refusés (413) avant toute lecture multipart ; une inférence a un délai maximal (504).
- Electron : `contextIsolation`, `sandbox`, pas de `nodeIntegration`, API preload minimale, messages IPC validés, CSP, micro seul autorisé.
- Les journaux (`data/logs`) ne contiennent ni audio ni texte transcrit.
- Direct (WebSocket) : l'en-tête `Origin` est contrôlé (une page web ne peut pas ouvrir la socket), le jeton est envoyé dans le premier message et jamais dans l'URL, et le renderer ne le voit jamais (la connexion appartient au processus principal).

## Documentation

- [docs/architecture.md](docs/architecture.md) : architecture et décisions
- [docs/api-contracts.md](docs/api-contracts.md) : contrat HTTP et codes d'erreur
- [docs/security.md](docs/security.md) : menaces et mesures
- [docs/roadmap.md](docs/roadmap.md) : avancement par phase
- [docs/evaluation-protocol.md](docs/evaluation-protocol.md) et [docs/model-selection.md](docs/model-selection.md) : évaluation des moteurs
- [AGENTS.md](AGENTS.md) : règles de développement
