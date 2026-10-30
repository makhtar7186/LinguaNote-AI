# Contrats d'API

Service local FastAPI, `http://127.0.0.1:8765`. Schémas : `services/transcription/app/schemas/transcription.py`. Documentation interactive : `/docs`.

## Authentification

`LINGUANOTE_API_TOKEN` (16 caractères minimum) est obligatoire : le service ne démarre pas sans lui (sauf `LINGUANOTE_ALLOW_NO_AUTH=1`, développement uniquement). Chaque requête (hors préflight CORS `OPTIONS`) doit porter `X-LinguaNote-Token: <jeton>`, sinon réponse `401` `unauthorized`. Les en-têtes `Host` autres que `127.0.0.1` et `localhost` sont refusés (`400`).

Démarrage : `uvicorn --factory app.main:create_app` (il n'existe plus d'objet `app` global).

## `GET /health`

Ne charge aucun modèle et ne télécharge rien.

```json
{
  "status": "ok",
  "engine_selected": true,
  "engine": "faster-whisper",
  "model": "base",
  "setup_message": null,
  "ffmpeg_available": true,
  "limits": { "max_upload_bytes": 52428800, "max_audio_seconds": 600.0, "extensions": [".aac", ".flac", "..."] }
}
```

`limits.max_audio_seconds` est la limite **effective** : la valeur configurée, abaissée à ce que le moteur choisi peut traiter (Omnilingual : 39 s). Les clients (interface, pont MCP, client Electron) lisent ici la taille maximale et les extensions au lieu de les dupliquer ; ils ne gardent que des valeurs de repli (50 Mio, extensions usuelles) quand le service est injoignable, et le serveur reste l'autorité finale.

`engine_selected: true` signifie que la dépendance est installée, pas que les poids sont déjà téléchargés. `setup_message` décrit ce qui manque (moteur ou FFmpeg).

## `POST /api/v1/transcriptions`

Requête `multipart/form-data`, champ `file` (extension en liste blanche, voir `limits.extensions`). FFmpeg extrait la première piste audio en PCM mono 16 kHz.

Réponse `200` :

```json
{
  "text": "bonjour tout le monde",
  "engine": "faster-whisper",
  "model": "base",
  "duration_seconds": 3.2,
  "timing_available": true,
  "language": "fr",
  "language_probability": 0.93,
  "segments": [{ "start_seconds": 0.0, "end_seconds": 3.1, "text": "bonjour tout le monde" }]
}
```

- `language` et `language_probability` sont des **estimations** du moteur pour l'ensemble du fichier. Elles peuvent être `null`.
- `timing_available` n'est vrai que si le moteur fournit réellement des segments.
- Un audio sans parole détectée renvoie `text: ""` et `segments: []`.
- Le texte n'est jamais traduit ni corrigé.

## Erreurs

Corps : `{ "detail": "<message lisible>", "code": "<code stable>" }`.

| HTTP | `code` | Cause |
| --- | --- | --- |
| 400 | `empty_file` | Fichier vide |
| 401 | `unauthorized` | Jeton absent ou invalide |
| 413 | `file_too_large` | Dépasse `LINGUANOTE_MAX_UPLOAD_MIB` (le corps entier est refusé avant lecture au-delà de cette taille + 64 Kio de surcoût multipart) |
| 413 | `audio_too_long` | Audio plus long que `LINGUANOTE_MAX_AUDIO_SECONDS` (ou que la limite du moteur) |
| 415 | `unsupported_extension` | Extension non autorisée |
| 415 | `no_audio_stream` | FFmpeg ne trouve aucune piste audio décodable |
| 415 | `invalid_audio` | WAV intermédiaire invalide ou vide |
| 422 | (FastAPI) | Requête mal formée (champ `file` absent) ; `detail` est alors une liste |
| 429 | `busy` | Déjà `LINGUANOTE_MAX_PENDING` transcriptions en cours ou en attente ; réessayer plus tard (le fichier est reçu mais rejeté avant conversion) |
| 500 | `inference_failed` | Erreur inattendue ; détails dans les journaux, jamais dans la réponse |
| 503 | `ffmpeg_missing` | FFmpeg introuvable |
| 503 | `model_unavailable` | Moteur ou modèle non chargeable (dépendance absente, hors-ligne au premier usage) |
| 504 | `conversion_timeout` | Conversion FFmpeg au-delà de `LINGUANOTE_FFMPEG_TIMEOUT_SECONDS` |
| 504 | `inference_timeout` | Inférence au-delà de `LINGUANOTE_INFERENCE_TIMEOUT_SECONDS` (l'inférence déjà démarrée se termine en arrière-plan) |

## Pont IPC Electron

Le renderer n'appelle jamais le service directement dans l'application packagée. `window.linguaNote` expose `health()` et `transcribe({name, type, bytes})`. Le processus principal valide l'émetteur et la charge utile, applique des délais (5 s pour `health`, 15 min pour `transcribe`) et répond **toujours** par une enveloppe, sans lever d'exception :

- succès : `{ "ok": true, "data": <réponse du service> }` (pour `health` : `{ "ok": true, ...champs de /health }`)
- échec : `{ "ok": false, "code": "...", "message": "..." }`, avec en plus les codes locaux `invalid_payload`, `service_unavailable`, `timeout`, `http_error`, `unknown`, `starting` (le service local démarre encore) et `backend_start_failed` (il n'a pas pu démarrer ; `message` en donne la cause). Avant l'envoi, le processus principal lit les limites dans `/health` et refuse localement un fichier trop gros ou d'une extension non prise en charge.

Le renderer revalide la forme des réponses (`src/services/transcriptionClient.ts`).

## Évolutions prévues (non implémentées)

Sessions de transcription en direct par WebSocket (phase 2), avec événements partiels/finaux : le contrat sera ajouté ici avant son implémentation.
