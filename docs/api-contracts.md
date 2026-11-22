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
  "languages": ["en", "fr"],
  "limits": { "max_upload_bytes": 52428800, "max_audio_seconds": 600.0, "extensions": [".aac", ".flac", "..."] }
}
```

`limits.max_audio_seconds` est la limite **effective** : la valeur configurée, abaissée à ce que le moteur choisi peut traiter (Omnilingual : 39 s). Les clients (interface, pont MCP, client Electron) lisent ici la taille maximale et les extensions au lieu de les dupliquer ; ils ne gardent que des valeurs de repli (50 Mio, extensions usuelles) quand le service est injoignable, et le serveur reste l'autorité finale.

`languages` : les langues que le **mode une seule langue** peut imposer avec le moteur configuré (`faster-whisper` : `en`, `fr` ; `language-routing` : `fr`, `en`, `wo` ; liste vide si le moteur est indisponible). Le mode plusieurs langues (sans `language`) est toujours possible.

`engine_selected: true` signifie que la dépendance est installée, pas que les poids sont déjà téléchargés. `setup_message` décrit ce qui manque (moteur ou FFmpeg).

## `POST /api/v1/transcriptions`

Requête `multipart/form-data`, champ `file` (extension en liste blanche, voir `limits.extensions`). FFmpeg extrait la première piste audio en PCM mono 16 kHz.

Champ facultatif `language` : absent, vide ou `auto` = **plusieurs langues** (la langue est estimée passage par passage, comportement historique). `fr`, `en` ou `wo` = **une seule langue** pour tout le fichier : la détection est sautée, le moteur de cette langue reçoit tout l'audio (Whisper avec la langue imposée ; le modèle wolof du moteur `language-routing` pour `wo`). La réponse porte alors `language` = la langue choisie et `language_probability` = `null` (rien n'a été estimé). Une langue que le moteur ne sait pas imposer (`wo` sans `language-routing`) ou inconnue est refusée en `422 unsupported_language`, jamais remplacée par une autre. Attention : imposer une langue fait transcrire **toute** la parole dans cette langue ; un passage dans une autre langue est mal transcrit, voire traduit.

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
- `segments[].language` (chaîne ou `null`, par défaut absent des moteurs classiques) : langue **estimée** du passage, fournie uniquement par le moteur `language-routing` (`fr`, `en`, `wo`). Quand elle est présente, `language` au niveau du fichier n'est renseigné que si tout l'enregistrement est dans une seule langue. Cette étiquette indique le modèle choisi pour le passage, pas une garantie que la langue est la bonne.
- `warnings` (liste de chaînes, vide par défaut) : non vide quand une partie de l'audio n'a pas pu être transcrite (`passage_failed: 12.0-15.5 s (wo) is missing from the text`). Le texte est alors **incomplet** ; si tous les passages échouent, le moteur renvoie une erreur `500` plutôt qu'un texte vide.
- Le texte n'est jamais traduit ni corrigé.
- `saved_session_id` (chaîne ou `null`) : identifiant de la session créée dans l'historique, **uniquement si l'historique est activé** et que l'enregistrement a réussi. Un échec de stockage ne fait jamais échouer la transcription (le champ vaut alors `null`). Le nom du fichier envoyé n'est jamais conservé.

## Historique : `/api/v1/history`

**Activé par défaut** depuis le 2026-11-22 (choix du porteur du projet ; voir [security.md](security.md)) ; l'utilisateur peut le désactiver à tout moment et ce choix est conservé. Toutes les routes exigent le jeton. Lire les réglages ou la liste ne crée aucun fichier ; la base est créée à la première session enregistrée. Désactivé, plus rien n'est écrit.

| Route | Rôle |
| --- | --- |
| `GET /settings` | `{ "enabled": false, "retention_days": 30 }` |
| `PUT /settings` | Corps `{ "enabled": bool, "retention_days": 7 \| 30 \| 90 \| 365 \| null }` (`null` = sans limite). Toute autre durée : `422 invalid_retention`. Les sessions devenues trop anciennes sont supprimées **immédiatement**. |
| `GET /sessions?query=&limit=&offset=` | `{ "items": [...], "total": N }`, plus récentes d'abord. `limit` 1 à 200 (50 par défaut), `query` 200 caractères au plus. La recherche est insensible à la casse et aux accents (« jerejef » trouve « Jërëjëf »), le dernier mot est un préfixe ; `snippet` entoure les mots trouvés des caractères de contrôle `\x02` (début) et `\x03` (fin), à afficher comme du texte et jamais comme du HTML. |
| `GET /sessions/{id}` | Session avec ses `segments` (`position`, `start_seconds`, `end_seconds`, `text`, `language`, `language_probability`). Les temps sont `null` quand le moteur n'en fournit pas. |
| `PATCH /sessions/{id}` | Corps `{ "title": "..." }` (non vide, 200 caractères au plus ; `422 invalid_title` sinon). |
| `DELETE /sessions/{id}` | `204`. Suppression réelle : les données sont écrasées dans le fichier (`secure_delete`) puis le fichier est compacté. |
| `DELETE /sessions?confirm=all` | Supprime tout (`{ "deleted": N }`). Sans `confirm=all` : `400 confirmation_required`. |
| `GET /sessions/{id}/export?format=` | `txt` (défaut), `md`, `srt`, `vtt`, `json`. `Content-Disposition: attachment; filename*=UTF-8''…` avec un nom assaini. `srt` et `vtt` sont **refusés** (`422 export_not_possible`) pour une session sans horodatage : les temps ne sont jamais inventés. Format inconnu : `422 unsupported_format`. |

`id` : `^[A-Za-z0-9_-]{1,64}$`, sinon `404`/`422`. Session inconnue : `404 session_not_found`. Une session `kind` = `live` ou `file`, `source` = `microphone`, `system`, `both` ou `null`, `status` = `recording`, `complete` ou `interrupted` (le service s'est arrêté avant la fin ; le texte peut être incomplet). Le direct enregistre chaque énoncé **à sa finalisation** ; si l'écriture échoue, un seul événement non fatal `history_write_failed` est émis et le direct continue.

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

### Direct via IPC

`window.linguaNote.live` expose `start()` (enveloppe `{ok}` comme ci-dessus), `sendAudio(pcm)` (sans réponse ; PCM s16le 16 kHz mono, nombre d'octets pair, rejeté sinon), `stop()` et `onEvent(listener)` (renvoie la fonction de désabonnement). Le processus principal possède la connexion WebSocket, envoie le jeton, numérote et conserve les trames non acquittées (30 s au maximum, avertissement `audio_buffer_overflow` au-delà), reprend la session après une coupure avec temporisation croissante (250 ms à 4 s, dans la fenêtre de 30 s du serveur), **déduplique** les événements par `event_id` avant de les transmettre, et ajoute des événements locaux : `client_state` (`connecting`, `active`, `reconnecting`, `stopping`, `ended`, `failed`) et des `error` locaux (`service_unavailable`, `session_lost`, `audio_lost`, `audio_buffer_overflow`). `live.prepare({source})` est la **première étape** d'une session : elle déclare la source, affiche la bulle avant l'ouverture de tout périphérique et refuse une source inconnue (`invalid_source`) ; `capture.armSystemAudio()` n'est accepté qu'après une déclaration utilisant le son de l'ordinateur, ou pour la session en cours qui l'utilise (`not_declared` sinon). `live.start({source})` prend la source écoutée (`microphone` par défaut, `system`, `both`) ; une valeur inconnue est **refusée** (`invalid_source`), jamais remplacée par le micro ; le processus principal diffuse l'événement `capture_source` à toutes les fenêtres et `live.status()` renvoie `source`. `window.linguaNote.capture.armSystemAudio()` doit précéder toute demande de son de l'ordinateur (`getDisplayMedia`) sinon elle est refusée ; l'armement est à usage unique, lié à la fenêtre et expire en 10 s ; `capture.disarm()` l'annule. `live.pause()`, `live.resume()` et `live.status()` complètent l'API : la pause ignore l'audio du micro (sans le mettre en tampon) après avoir envoyé 0,9 s de silence qui clôt la phrase en cours, la session et ses accusés continuent ; elle émet `pause_state`. `live.status()` permet à une fenêtre ouverte en cours de session de se synchroniser. Les événements sont **diffusés à toutes les fenêtres**. `window.linguaNote.bubble` expose `setExpanded`, `setVisible` (refusé avec `recording_active` pendant un enregistrement), `getState` et `onCommand` (commandes des raccourcis globaux, par exemple `toggle_live`) ; `window.linguaNote.shortcuts.getReport()` renvoie les raccourcis enregistrés et ceux qui ont échoué. Le renderer revalide chaque événement (`src/services/liveEvents.ts`) et applique la réconciliation provisoire/final (`src/services/liveReducer.ts`).

### Historique et insertion via IPC

`window.linguaNote.history` expose `getSettings()`, `setSettings(enabled, retentionDays)`, `list({query, limit, offset})`, `get(id)`, `rename(id, title)`, `remove(id)`, `removeAll(confirm)` et `export(id, format)`. Chaque appel correspond à une opération d'une **liste fermée** (`electron/history-client.cjs`) dont les arguments sont validés dans le processus principal avant toute requête (identifiant, durée de conservation, pagination, titre, format) ; `removeAll` ne supprime que si `confirm === true`. Réponse : `{ok, data}` ou `{ok:false, code, message}`. `export` ouvre la boîte « Enregistrer sous » **dans le processus principal** et écrit le fichier lui-même : le renderer ne fournit jamais de chemin ; il reçoit `{ok:true, saved}` (`saved:false` si l'utilisateur annule) ou `write_failed`.

`window.linguaNote.insertion` (Windows) expose `arm()`, `stop()`, `status()` et `onStatus(listener)`. `arm()` exige une session en direct en cours (`no_live_session`), refuse sur une autre plateforme (`unsupported`) et lance un décompte de 3 s à l'issue duquel la fenêtre au premier plan est **verrouillée** comme cible (jamais une fenêtre de LinguaNote : `target_is_self`). État : `{supported, state: off|locking|on|paused, target:{title}|null, pendingChars, inserted, problem:{code,message}|null}`. Problèmes possibles : `target_left` (l'utilisateur a quitté la fenêtre cible : pause, le texte attend), `clipboard_not_restorable`, `insertion_failed`, `clipboard_restore_failed`, `pending_overflow`, `target_unknown`.

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
| `{"type":"start","token":"…","protocol":1,"source":"microphone","language":"fr"}` | Ouvre une session. `source` (`microphone`, `system` ou `both`, facultatif) est **purement informatif** : il est enregistré avec la session si l'historique est activé, et ne change rien au traitement. `language` (`fr`, `en` ou `wo`, facultatif) impose une seule langue à toute la session, comme pour les fichiers ; absent = plusieurs langues. Avec `language-routing`, une session imposée en `fr` ou `en` retrouve des énoncés courts et du texte provisoire ; en `wo` ou sans langue, elle garde les passages de 10 à 20 s sans texte provisoire. Toute autre valeur est refusée (`invalid_message`) ; une langue que le moteur ne sait pas imposer ferme la session avec l'erreur fatale `unsupported_language`. |
| `{"type":"resume","token":"…","protocol":1,"session_id":"…","last_event_id":N}` | Rattache une nouvelle connexion à une session détachée ; le serveur rejoue les événements d'`event_id` > N. |
| trame binaire | 4 octets `seq` (uint32 big-endian, commence à 1, +1 par trame) puis le PCM (2 à 65 536 octets, nombre pair). Le client Electron envoie au plus 32 000 octets (1 s) par trame. |
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
- **Trou** : une trame de `seq` > `audio_ack + 1` est rejetée par un `error` de transport non fatal `sequence_gap` (avec `expected`) **sans `audio_ack`** : une trame rejetée n'est jamais acquittée. Le client renvoie à partir de `expected`, ou termine la session s'il ne les a plus (`audio_lost`).
- **Réconciliation côté client** : ignorer tout événement dont l'`event_id` ≤ le dernier traité (rejeu) ; un `partial` remplace le précédent du même `utterance_id` s'il a une `revision` plus grande ; un `final` remplace tout `partial` du même `utterance_id` et clôt cet énoncé ; un `partial` reçu après son `final` est ignoré.
- **Reprise** : après coupure, la session est conservée 30 s (`LINGUANOTE_LIVE_RESUME_SECONDS`). Le serveur garde les 500 derniers événements ; au-delà, `resume` échoue avec `resume_gap` (fatal). L'application Electron n'ouvre alors pas de nouvelle session automatiquement : elle signale l'interruption (`resume_gap`, `session_not_found`, `session_lost`) et conserve le texte déjà reçu ; l'utilisateur relance le direct, et les identifiants d'énoncé repartent de 1. **Une reprise réussie invalide l'ancienne connexion** si elle est encore ouverte : son émetteur d'événements est réveillé aussitôt et s'arrête, ses messages entrants sont ignorés, elle ne peut plus terminer ni supprimer la session (délai d'inactivité compris), puis elle est fermée. Un envoi déjà engagé au moment de la reprise peut encore partir ; c'est sans effet, la connexion étant remplacée et les événements dédupliqués par `event_id`. Le client garde les trames non acquittées (borné à 30 s d'audio) pour les renvoyer après `session_started.audio_ack`.
- **Limites** : durée de session `LINGUANOTE_LIVE_MAX_SECONDS` (3600) ; 30 s sans aucune trame ni `ping` : `session_ended` `idle_timeout` ; file d'inférence bornée : saturation = `error` fatal `overloaded`, jamais une perte silencieuse. Un `partial` est abandonné (pas mis en file) si le worker est occupé ; un `final` ne l'est jamais.
- **Tailles et débit** : message d'ouverture ≤ 4 096 octets, messages de contrôle ≤ 256 octets, message WebSocket ≤ 256 Kio (`--ws-max-size` d'uvicorn, fixé par le lanceur Electron et par la commande documentée) ; plus de 5 000 trames sur 10 s (plus de 10 fois un envoi normal, rejeu de 30 s compris) = `rate_limited` fatal.
- **Ordre** : les `partial` et `final` sont journalisés dans l'ordre des énoncés (le worker est séquentiel et sert les tâches dans l'ordre de mise en file) : l'`utterance_id` ne décroît jamais dans le journal.
- **Erreurs fatales** : `unauthorized` (fermeture 1008), `rate_limited`, `busy`, `model_unavailable`, `invalid_message`, `frame_too_large`, `session_not_found`, `resume_gap`, `overloaded`. Non fatales : `sequence_gap`, `inference_failed`, `inference_timeout`. Les erreurs survenues avant l'ouverture de la session (jeton, `busy`, message invalide, modèle indisponible) sont envoyées comme message de transport `{"type":"error","code":…,"fatal":true}` sans `event_id`, puis la connexion est fermée.
- **Confidentialité** : ni l'audio ni le texte ne sont journalisés ; le serveur ne conserve en mémoire que la fenêtre de rejeu et l'énoncé en cours, effacés à la fin de la session.
