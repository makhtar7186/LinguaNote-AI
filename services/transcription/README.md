# Service de transcription (prototype)

Ce premier jalon accepte des fichiers audio/vidéo courants (WAV, MP3, M4A, FLAC, OGG/Opus, MP4, MOV, MKV, WebM, WMA et AAC) jusqu’à 50 MiB. FFmpeg extrait et convertit la première piste audio en PCM mono 16 kHz. La durée audio maximale est de 10 minutes par défaut (`LINGUANOTE_MAX_AUDIO_SECONDS`) ; un moteur peut imposer une limite plus basse (Omnilingual : 39 s). La réponse contient le texte, la langue estimée, des segments horodatés et les identifiants du moteur/modèle. La qualité du wolof et du code-switching n’est pas garantie. Voir `docs/api-contracts.md`.

## Développement

Depuis `services/transcription`, installer l’API et le moteur CPU compatible Windows :

```powershell
python -m pip install -e ".[api,windows-asr,dev]"
$env:LINGUANOTE_API_TOKEN = python -c "import secrets; print(secrets.token_urlsafe(32))"
python -m uvicorn --factory app.main:create_app --host 127.0.0.1 --port 8765
```

Le service **refuse de démarrer sans `LINGUANOTE_API_TOKEN`** (16 caractères minimum). Seul `LINGUANOTE_ALLOW_NO_AUTH=1` désactive l'authentification, pour du développement ponctuel. Toute requête doit porter l'en-tête `X-LinguaNote-Token`, y compris pour ouvrir `/docs` depuis un outil externe. Quand l'application Electron est lancée (`npm run dev`), elle démarre elle-même ce service avec un jeton éphémère sur un port libre : la commande ci-dessus n'est utile que pour développer ou tester l'API seule.

FFmpeg doit être installé séparément et accessible dans le `PATH`. Si nécessaire, définir `LINGUANOTE_FFMPEG` avec le chemin complet de `ffmpeg.exe`. Swagger UI (`/docs`) n'envoie pas l'en-tête de jeton : utiliser `curl` ou un client HTTP avec `X-LinguaNote-Token`.

`faster-whisper` utilise le modèle multilingue `base` par défaut, le charge en CPU INT8, et détecte la langue automatiquement. Les poids du modèle sont téléchargés depuis Hugging Face lors de la première demande explicite de transcription, jamais au démarrage. Pour choisir un autre modèle, définir `LINGUANOTE_WHISPER_MODEL` avant de lancer le service. La machine doit avoir accès à Internet pour ce premier téléchargement. Le service écoute uniquement sur loopback dans la commande ci-dessus.

## État du moteur sur Windows

Le moteur Windows actuel cible le français et l’anglais. Whisper ne fournit pas de prise en charge Wolof validée ; les phrases mêlant les langues restent à mesurer et leur transcription ne doit pas être considérée comme fiable. L’adaptateur Omnilingual CTC reste expérimental. Sur l’environnement Windows testé, son installation échoue car `fairseq2n` ne prend pas en charge Windows.

Ne pas committer les poids. Aucun test d’exactitude Wolof ou de phrases mixtes n’est encore réalisé. Omnilingual documente des poids CTC d’environ 1,3 Gio, toujours sans téléchargement dans ce prototype.

## Tests et qualité

```powershell
python -m pytest
python -m ruff check app tests
```

Les tests utilisent un moteur factice (aucun modèle téléchargé) et le vrai FFmpeg s’il est disponible.

## Serveur MCP local

Le serveur stdio expose `service_status` et `transcribe_file`. La configuration racine `.mcp.json` le lance avec l'environnement Python du backend. Installez le SDK MCP dans cet environnement avec `python -m pip install -e ".[api,windows-asr,mcp-server]"`, puis démarrez FastAPI sur `127.0.0.1:8765` avant d'appeler les outils. `transcribe_file` accepte un chemin de média local et retourne le résultat fourni par l'API. Le téléchargement des poids du modèle peut nécessiter Internet.

Le jeton étant obligatoire, définissez la même valeur de `LINGUANOTE_API_TOKEN` dans l'environnement du service et du processus MCP. L'URL (`LINGUANOTE_API_URL`) doit rester une adresse **loopback en http** : le fichier audio et le jeton y sont envoyés, donc un hôte distant est refusé sauf `LINGUANOTE_ALLOW_REMOTE_API=1` avec une URL https. Les limites de taille et les extensions sont lues auprès du service (`/health`), pas dupliquées dans le pont MCP.
