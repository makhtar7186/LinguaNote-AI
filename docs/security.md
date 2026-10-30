# Sécurité et confidentialité

État au jalon 1 (fichier uniquement). Ce document décrit ce qui est réellement en place et ce qui reste à faire.

## Données et traitement

- Audio et texte sont traités localement. Aucune API cloud n'est utilisée, aucune télémétrie n'existe.
- Seul accès réseau : téléchargement des poids Whisper depuis Hugging Face à la première transcription. Hors-ligne, la transcription échoue avec `model_unavailable`. Il n'y a pas encore de confirmation explicite avant ce téléchargement (limite connue).
- Les fichiers envoyés sont écrits dans un dossier temporaire (`tempfile.mkdtemp`) supprimé à la fin de la requête, succès ou erreur. Si une inférence dépasse son délai et continue de lire le fichier, la suppression est différée jusqu'à la fin de cette inférence. Une fermeture forcée du processus peut laisser un dossier `linguanote-*` dans le répertoire temporaire de l'utilisateur. Le nom du client n'est jamais utilisé comme chemin.
- Rien n'est conservé : pas d'historique ni de base de données à ce stade. La rétention et la suppression seront à définir avec SQLite (phase 5).
- L'interface n'émet plus de requête vers Google Fonts : l'import de polices distantes a été supprimé (polices système de repli), pour tenir la promesse « aucun accès réseau » hors téléchargement du modèle.
- Les journaux (`data/logs/linguanote.log`, rotation 5 Mio x 3) contiennent des métadonnées (extension, taille, durée audio, moteur, durée de traitement). La langue estimée et la longueur du texte ne sont plus journalisées. Pas d'audio ni de texte transcrit. Pas de purge automatique au-delà de la rotation.

## Menaces et mesures

| Menace | Mesure | Reste à faire |
| --- | --- | --- |
| Page web ou processus local quelconque envoyant des requêtes vers le port local (le CORS n'empêche pas l'envoi d'un POST multipart) | Jeton **obligatoire** `X-LinguaNote-Token` (16 caractères minimum, comparé en temps constant) : le service refuse de démarrer sans lui. L'en-tête personnalisé impose un préflight CORS, refusé pour les origines non configurées. Electron génère un jeton aléatoire par lancement, sur un port libre ; le renderer ne le voit jamais (IPC) | Un autre processus du même utilisateur qui lirait l'environnement du service peut obtenir le jeton : limite acceptée pour un service local mono-utilisateur |
| DNS rebinding | `TrustedHostMiddleware` : seuls `127.0.0.1` et `localhost` | - |
| Exposition réseau | Lancement documenté sur `127.0.0.1` ; l'URL du backend côté Electron doit être une adresse loopback http | Ne pas lancer uvicorn avec `--host 0.0.0.0` |
| Fichier hostile ou énorme | Corps refusé avant l'analyse multipart (en-tête `Content-Length` et comptage du flux), puis extension en liste blanche, 50 Mio, durée max (calculée par moteur), FFmpeg sans shell avec délai, première piste audio uniquement | Limites de ressources FFmpeg (mémoire) |
| Saturation CPU | Un seul worker d'inférence ; modèle chargé une seule fois ; admission bornée (`429 busy` au-delà de `LINGUANOTE_MAX_PENDING`) ; délai d'inférence (`504 inference_timeout`), les tâches en attente sont annulées | Une inférence déjà démarrée ne peut pas être interrompue (elle se termine en arrière-plan). Le refus 429 intervient après la réception du fichier (borné par la limite de taille), pas avant |
| Pont MCP redirigé vers un hôte distant | `LINGUANOTE_API_URL` limitée à http loopback ; hôte distant uniquement avec `LINGUANOTE_ALLOW_REMOTE_API=1` et https ; limites lues depuis `/health` | - |
| WebSocket du direct ouvert depuis une page web (les WebSocket échappent au CORS et au middleware HTTP) | Contrôle de l'en-tête `Origin` (refus 1008), jeton exigé dans le premier message sous 5 s, comparé en temps constant, jamais dans l'URL ni les journaux ; hôtes de confiance (Host) | Le client Electron (Node) n'envoie pas d'`Origin` : un processus local connaissant le jeton reste hors de portée de cette mesure |
| Capture d'écran ou de son par un script de la page (`getDisplayMedia`) | Refusée par défaut : le gestionnaire de capture n'accorde que si la fenêtre de confiance (frame principal) a armé la porte juste avant (`capture-gate.cjs`), et l'armement lui-même n'est possible qu'après que la fenêtre a **déclaré** la source au processus principal (`live.prepare`, `capture-plan.cjs`) ou pour la session en cours qui l'utilise : la bulle (indicateur d'enregistrement) est alors rendue visible avant l'ouverture de tout périphérique, et un script ne peut pas armer seul ; l'armement est à usage unique, expire en 10 s et est lié à la fenêtre qui l'a demandé ; la permission `display-capture` n'est accordée que pendant l'armement ; la réponse est toujours « son loopback », jamais autre chose. Électron exige aussi une source d'écran : sa piste vidéo est coupée dès l'obtention et aucune image n'est lue. Vérifié dans la vraie application (refus sans armement, refus à l'autre fenêtre, accord, usage unique) | Une page de confiance compromise pourrait armer puis demander : la surface reste celle d'un renderer déjà compromis ; l'indicateur d'enregistrement de la bulle reste affiché |
| Enregistrement d'une réunion sans l'accord des participants | L'application affiche en permanence la source écoutée ; la documentation rappelle d'obtenir le consentement. Elle ne peut pas le vérifier | Responsabilité de l'utilisateur (règles de protection des données applicables) |
| Deuxième fenêtre (bulle) élargissant la surface IPC | Les deux fenêtres ont les mêmes réglages durcis (`contextIsolation`, `sandbox`, pas de `nodeIntegration`, navigation et `window.open` bloqués) ; chaque canal IPC vérifie que l'émetteur est le **frame principal** de l'une des deux fenêtres (jamais un iframe, même chargeant une page autorisée) **et** que sa page est exactement `index.html` ou `bubble.html` (`ipc-trust.cjs`, `app-urls.cjs`) ; la CSP interdit tout frame (`frame-src 'none'`, vérifié dans le test de fumée) ; l'audio n'est accepté que de la fenêtre qui a démarré la session (propriétaire du micro) ; le micro n'est accordé qu'à ces deux fenêtres | - |
| Enregistrement à l'insu de l'utilisateur | Démarrer la dictée (bouton ou raccourci) affiche toujours la bulle ; elle ne peut pas être masquée pendant l'enregistrement (`recording_active`) ; tout masquage venant d'ailleurs (système, autre outil) est annulé aussitôt pendant l'enregistrement, et une bulle fermée est recréée ; si la fenêtre qui capture le micro disparaît, la session est arrêtée ; indicateur rouge pulsant + point REC ; la pause libère le micro | Un raccourci global peut démarrer l'enregistrement sans que la fenêtre ait le focus : c'est voulu, d'où l'indicateur permanent |
| Raccourcis globaux détournés ou en conflit | Accélérateurs fixes ou fournis par l'environnement de l'utilisateur ; échec d'enregistrement signalé ; ils ne déclenchent que des actions locales (démarrer/arrêter, pause, afficher/masquer) | - |
| Fuite du jeton vers le renderer pendant le direct | La connexion appartient au processus principal ; le renderer ne transmet que de l'audio (octets validés) et reçoit des événements validés | - |
| Renderer compromis | `contextIsolation`, `sandbox`, pas de `nodeIntegration`, preload à deux fonctions, vérification de l'URL de l'émetteur IPC, validation de la charge utile, navigation et `window.open` bloqués | - |
| Injection de scripts | CSP : stricte dans le build packagé (meta `Content-Security-Policy` plus en-tête de session), assouplie en développement pour Vite | Vérifier le comportement dans l'application packagée |
| Accès caméra ou écran | Gestionnaires de permission : micro (audio) uniquement, fenêtre principale uniquement | Choix explicite du périphérique |
| Fuite d'information par les erreurs | Erreurs inattendues : message générique, traces dans les journaux | - |

## Enregistrement et consentement

L'enregistrement micro est toujours initié par l'utilisateur, avec un indicateur visible dans la fenêtre. L'enregistrement classique s'arrête après 5 minutes ; le direct s'arrête sur demande, après 30 s sans audio ni ping, ou à la durée maximale de session (`LINGUANOTE_LIVE_MAX_SECONDS`). Le micro est libéré à l'arrêt, en cas d'erreur et à la fermeture de la fenêtre. Pas d'enregistrement caché. Le direct ne conserve ni l'audio ni le texte au-delà de la session : la fenêtre de rejeu (500 événements) et l'énoncé en cours sont effacés à la fin. Avant d'enregistrer ou de transcrire une conversation impliquant d'autres personnes, l'utilisateur doit obtenir leur consentement selon les règles de protection des données applicables.

## Environnement d'exécution d'Electron

Les éditeurs construits sur Electron définissent `ELECTRON_RUN_AS_NODE=1` ; hérité, il fait démarrer l'application comme un simple Node et la fait planter. `scripts/start-electron.cjs` retire cette variable de l'environnement de l'application (utilisé par `npm run dev` et `npm run smoke`).

## Secrets

Aucun secret n'est stocké dans le dépôt. `LINGUANOTE_API_TOKEN` se transmet par variable d'environnement (voir `.env.example`). `.env` est ignoré par Git mais n'est pas chargé automatiquement.

## Licences des composants

faster-whisper et les poids Whisper sont publiés sous licence MIT ; FFmpeg est externe (non redistribué) : sa licence (LGPL/GPL selon le build) devra être vérifiée avant toute livraison d'un installateur qui l'embarque. Omnilingual ASR (Apache 2.0 annoncé) n'est pas utilisé.
