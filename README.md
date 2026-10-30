# LinguaNote AI

Prototype local de transcription (français, anglais ; wolof et phrases mixtes **non validés**). Le client desktop Electron/React importe un fichier audio/vidéo ou enregistre au microphone, l'envoie au service local FastAPI, puis affiche le texte, la langue estimée et les segments horodatés.

Tout le traitement reste sur la machine. Une seule action utilise le réseau : le téléchargement des poids du modèle Whisper depuis Hugging Face lors de la **première transcription**.

## Prérequis (Windows)

- Python 3.11 à 3.13
- Node.js 22 ou plus récent et npm
- FFmpeg dans le `PATH` (ou variable `LINGUANOTE_FFMPEG` vers `ffmpeg.exe`) ; vérifier avec `ffmpeg -version`

## Installation et démarrage

Service Python (terminal 1) :

```powershell
cd services\transcription
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e ".[api,windows-asr,dev]"
python -m uvicorn app.main:app --host 127.0.0.1 --port 8765
```

Interface Electron (terminal 2, depuis la racine du dépôt) :

```powershell
npm install
npm run dev
```

Aperçu navigateur sans Electron : `npm run dev:web`, puis `http://127.0.0.1:5173`. Le renderer appelle alors directement `http://127.0.0.1:8765` (CORS limité à l'origine 5173, modifiable via `LINGUANOTE_CORS_ORIGINS`). Le client Electron passe, lui, par IPC.

Toutes les variables d'environnement sont listées dans [.env.example](.env.example).

## Commandes de développement

| Objet | Commande | Dossier |
| --- | --- | --- |
| Tests frontend (Vitest) | `npm test` | racine |
| Vérification TypeScript | `npm run typecheck` | racine |
| Build du renderer | `npm run build` | racine |
| Tests backend (Pytest) | `python -m pytest` | `services/transcription` |
| Lint backend (Ruff) | `python -m ruff check app tests` | `services/transcription` |

Les tests Pytest qui convertissent de l'audio exigent FFmpeg ; ils sont ignorés s'il est absent. Aucun test ne télécharge de modèle.

## Limites actuelles

- Fichier : 50 Mio maximum, audio de 10 minutes maximum par défaut (`LINGUANOTE_MAX_AUDIO_SECONDS`). Le traitement est séquentiel : une transcription à la fois.
- Moteur : faster-whisper `base`, CPU INT8. La qualité n'a pas été mesurée sur le wolof ni sur le code-switching ; la langue affichée est une estimation du modèle, pas une garantie.
- Le micro enregistre jusqu'à 5 minutes puis transcrit. Pas de transcription en direct, pas de bulle flottante, pas de capture de l'audio système, pas d'historique ni d'export (phases 2 à 5 de la feuille de route, voir [docs/roadmap.md](docs/roadmap.md)).
- Le service Python n'est pas encore lancé par Electron et aucun installateur n'existe (voir « Packaging » dans [docs/roadmap.md](docs/roadmap.md)).
- Testé uniquement sous Windows 11. L'application Electron n'a pas été lancée dans cette session de travail : seuls les tests unitaires, le typecheck et le build ont été exécutés.

## Sécurité et confidentialité

Résumé ; détails dans [docs/security.md](docs/security.md).

- Le service écoute sur `127.0.0.1` uniquement et refuse tout autre nom d'hôte.
- Jeton optionnel `LINGUANOTE_API_TOKEN` : s'il est défini, toute requête sans l'en-tête `X-LinguaNote-Token` correct reçoit 401. Il protège contre les pages web qui enverraient des requêtes vers le port local.
- Electron : `contextIsolation`, `sandbox`, pas de `nodeIntegration`, API preload minimale, messages IPC validés, CSP, micro seul autorisé.
- Les journaux (`data/logs`) ne contiennent ni audio ni texte transcrit.

## Documentation

- [docs/architecture.md](docs/architecture.md) : architecture et décisions
- [docs/api-contracts.md](docs/api-contracts.md) : contrat HTTP et codes d'erreur
- [docs/security.md](docs/security.md) : menaces et mesures
- [docs/roadmap.md](docs/roadmap.md) : avancement par phase
- [docs/evaluation-protocol.md](docs/evaluation-protocol.md) et [docs/model-selection.md](docs/model-selection.md) : évaluation des moteurs
- [AGENTS.md](AGENTS.md) : règles de développement
