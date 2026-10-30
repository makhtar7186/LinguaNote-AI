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

## Transcription en direct : `WebSocket /api/v1/live` (protocole 1)

Contrat écrit **avant** l'implémentation (phase 2). Il vise à ce qu'une coupure de connexion ne perde ni ne duplique jamais de texte.

### Principes

- **Audio** : trames binaires PCM signé 16 bits little-endian, mono, 16 000 Hz. Le client convertit avant l'envoi ; le serveur ne rééchantillonne pas.
- **Segmentation** : le serveur découpe l'audio en énoncés aux silences (pas de recouvrement : aucun mot dupliqué entre deux énoncés). Un énoncé trop long est coupé à son point le plus silencieux, sans perdre ni répéter d'échantillon ; un mot peut alors être coupé en deux, limite connue.
- **Provisoire / final** : un `partial` est une hypothèse révisable d'un énoncé en cours ; le `final` du même `utterance_id` la remplace définitivement et n'est jamais révisé. Le texte n'est jamais traduit ni corrigé ; la langue est une estimation par énoncé.
- **Temps** : `start_seconds` / `end_seconds` sont relatifs au début de la session et calculés à partir du nombre d'échantillons reçus (pas d'horloge système).
- **Un seul moteur, une seule session** : l'inférence est partagée avec l'import de fichiers (un worker). Une deuxième session reçoit `busy`.

### Ouverture et authentification

Les WebSocket ne sont pas soumis au CORS et le middleware HTTP ne s'y applique pas. Le serveur : (1) refuse (fermeture 1008) toute connexion dont l'en-tête `Origin` est présent et absent de `LINGUANOTE_CORS_ORIGINS` (le client Electron, côté Node, n'en envoie pas) ; (2) exige un **premier message texte** dans les 5 s, contenant le jeton ; sinon fermeture 1008. Le jeton est comparé en temps constant et n'est jamais journalisé.

### Messages client → serveur

| Message | Contenu |
| --- | --- |
| `{"type":"start","token":"…","protocol":1}` | Ouvre une session. |
| `{"type":"resume","token":"…","protocol":1,"session_id":"…","last_event_id":N}` | Rattache une nouvelle connexion à une session détachée ; le serveur rejoue les événements d'`event_id` > N. |
| trame binaire | 4 octets `seq` (uint32 big-endian, commence à 1, +1 par trame) puis le PCM (2 à 65 536 octets, nombre pair). |
| `{"type":"stop"}` | Termine proprement : le reste de l'audio est finalisé, puis `session_ended`. |
| `{"type":"ping"}` | Répond `{"type":"pong"}` (sans `event_id`). |

### Événements serveur → client

**Messages de transport** (propres à une connexion, sans `event_id`, jamais rejoués) :

| `type` | Champs |
| --- | --- |
| `session_started` | `session_id`, `protocol`, `resumed`, `audio_ack` (plus grand `seq` reçu sans trou), `audio` (`format`, `sample_rate`, `channels`, `max_frame_bytes`), `limits` (`max_session_seconds`), `engine` (`name`, `model`, `timestamps`) |
| `audio_ack` | `seq` : cumulatif ; le client peut oublier les trames ≤ `seq` |
| `pong` | réponse à `ping` |

**Événements de session** (journalisés pour la reprise ; chacun porte un `event_id` entier strictement croissant dans la session) :

| `type` | Champs |
| --- | --- |
| `partial` | `utterance_id`, `revision` (croissante), `text`, `start_seconds`, `end_seconds` |
| `final` | `utterance_id`, `text`, `start_seconds`, `end_seconds`, `language`, `language_probability` (estimations, éventuellement `null`) |
| `error` | `code`, `message`, `fatal`, et `utterance_id` quand l'erreur concerne un énoncé |
| `session_ended` | `reason` (`client_stop`, `max_duration`, `idle_timeout`, `error`), `utterances` (nombre de `final` émis) |

Un énoncé dont la transcription échoue ne disparaît jamais en silence : un `error` non fatal (`inference_failed` ou `inference_timeout`) portant son `utterance_id` est émis, et aucun `final` ne suit pour cet énoncé. Un énoncé sans parole reconnue ne produit ni `partial` ni `final`.

### Règles de fiabilité

- **Doublon** : une trame de `seq` ≤ `audio_ack` est ignorée (aucun traitement ni erreur) et réacquittée.
- **Trou** : une trame de `seq` > `audio_ack + 1` est rejetée par un `error` non fatal `sequence_gap` (avec `expected`). Le client doit renvoyer à partir de `expected`.
- **Réconciliation côté client** : ignorer tout événement dont l'`event_id` ≤ le dernier traité (rejeu) ; un `partial` remplace le précédent du même `utterance_id` s'il a une `revision` plus grande ; un `final` remplace tout `partial` du même `utterance_id` et clôt cet énoncé ; un `partial` reçu après son `final` est ignoré.
- **Reprise** : après coupure, la session est conservée 30 s (`LINGUANOTE_LIVE_RESUME_SECONDS`). Le serveur garde les 500 derniers événements ; au-delà, `resume` échoue avec `resume_gap` (fatal) et le client doit ouvrir une nouvelle session. Le client garde les trames non acquittées (borné à 30 s d'audio) pour les renvoyer après `session_started.audio_ack`.
- **Limites** : durée de session `LINGUANOTE_LIVE_MAX_SECONDS` (3600) ; 30 s sans aucune trame ni `ping` : `session_ended` `idle_timeout` ; file d'inférence bornée : saturation = `error` fatal `overloaded`, jamais une perte silencieuse. Un `partial` est abandonné (pas mis en file) si le worker est occupé ; un `final` ne l'est jamais.
- **Erreurs fatales** : `unauthorized` (fermeture 1008), `busy`, `model_unavailable`, `invalid_message`, `frame_too_large`, `session_not_found`, `resume_gap`, `overloaded`. Non fatales : `sequence_gap`, `inference_failed`, `inference_timeout`. Les erreurs survenues avant l'ouverture de la session (jeton, `busy`, message invalide, modèle indisponible) sont envoyées comme message de transport `{"type":"error","code":…,"fatal":true}` sans `event_id`, puis la connexion est fermée.
- **Confidentialité** : ni l'audio ni le texte ne sont journalisés ; le serveur ne conserve en mémoire que la fenêtre de rejeu et l'énoncé en cours, effacés à la fin de la session.
