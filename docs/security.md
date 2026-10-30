# Sécurité et confidentialité

État au jalon 1 (fichier uniquement). Ce document décrit ce qui est réellement en place et ce qui reste à faire.

## Données et traitement

- Audio et texte sont traités localement. Aucune API cloud n'est utilisée, aucune télémétrie n'existe.
- Seul accès réseau : téléchargement des poids Whisper depuis Hugging Face à la première transcription. Hors-ligne, la transcription échoue avec `model_unavailable`. Il n'y a pas encore de confirmation explicite avant ce téléchargement (limite connue).
- Les fichiers envoyés sont écrits dans un dossier temporaire (`tempfile.mkdtemp`) supprimé à la fin de la requête, succès ou erreur. Si une inférence dépasse son délai et continue de lire le fichier, la suppression est différée jusqu'à la fin de cette inférence. Une fermeture forcée du processus peut laisser un dossier `linguanote-*` dans le répertoire temporaire de l'utilisateur. Le nom du client n'est jamais utilisé comme chemin.
- Rien n'est conservé : pas d'historique ni de base de données à ce stade. La rétention et la suppression seront à définir avec SQLite (phase 5).
- Les journaux (`data/logs/linguanote.log`, rotation 5 Mio x 3) contiennent des métadonnées (extension, taille, durée audio, moteur, durée de traitement). La langue estimée et la longueur du texte ne sont plus journalisées. Pas d'audio ni de texte transcrit. Pas de purge automatique au-delà de la rotation.

## Menaces et mesures

| Menace | Mesure | Reste à faire |
| --- | --- | --- |
| Page web ou processus local quelconque envoyant des requêtes vers le port local (le CORS n'empêche pas l'envoi d'un POST multipart) | Jeton **obligatoire** `X-LinguaNote-Token` (16 caractères minimum, comparé en temps constant) : le service refuse de démarrer sans lui. L'en-tête personnalisé impose un préflight CORS, refusé pour les origines non configurées. Electron génère un jeton aléatoire par lancement, sur un port libre ; le renderer ne le voit jamais (IPC) | Un autre processus du même utilisateur qui lirait l'environnement du service peut obtenir le jeton : limite acceptée pour un service local mono-utilisateur |
| DNS rebinding | `TrustedHostMiddleware` : seuls `127.0.0.1` et `localhost` | - |
| Exposition réseau | Lancement documenté sur `127.0.0.1` ; l'URL du backend côté Electron doit être une adresse loopback http | Ne pas lancer uvicorn avec `--host 0.0.0.0` |
| Fichier hostile ou énorme | Corps refusé avant l'analyse multipart (en-tête `Content-Length` et comptage du flux), puis extension en liste blanche, 50 Mio, durée max (calculée par moteur), FFmpeg sans shell avec délai, première piste audio uniquement | Limites de ressources FFmpeg (mémoire) |
| Saturation CPU | Un seul worker d'inférence ; modèle chargé une seule fois ; délai d'inférence (`504 inference_timeout`), les tâches en attente sont annulées | Une inférence déjà démarrée ne peut pas être interrompue (elle se termine en arrière-plan) ; pas encore de file d'attente bornée |
| Pont MCP redirigé vers un hôte distant | `LINGUANOTE_API_URL` limitée à http loopback ; hôte distant uniquement avec `LINGUANOTE_ALLOW_REMOTE_API=1` et https ; limites lues depuis `/health` | - |
| Renderer compromis | `contextIsolation`, `sandbox`, pas de `nodeIntegration`, preload à deux fonctions, vérification de l'URL de l'émetteur IPC, validation de la charge utile, navigation et `window.open` bloqués | - |
| Injection de scripts | CSP : stricte dans le build packagé (meta `Content-Security-Policy` plus en-tête de session), assouplie en développement pour Vite | Vérifier le comportement dans l'application packagée |
| Accès caméra ou écran | Gestionnaires de permission : micro (audio) uniquement, fenêtre principale uniquement | Choix explicite du périphérique |
| Fuite d'information par les erreurs | Erreurs inattendues : message générique, traces dans les journaux | - |

## Enregistrement et consentement

L'enregistrement micro est toujours initié par l'utilisateur, avec un indicateur visible et un compteur dans la fenêtre. Il s'arrête automatiquement après 5 minutes. Pas d'enregistrement caché. Avant d'enregistrer ou de transcrire une conversation impliquant d'autres personnes, l'utilisateur doit obtenir leur consentement selon les règles de protection des données applicables.

## Secrets

Aucun secret n'est stocké dans le dépôt. `LINGUANOTE_API_TOKEN` se transmet par variable d'environnement (voir `.env.example`). `.env` est ignoré par Git mais n'est pas chargé automatiquement.

## Licences des composants

faster-whisper et les poids Whisper sont publiés sous licence MIT ; FFmpeg est externe (non redistribué) : sa licence (LGPL/GPL selon le build) devra être vérifiée avant toute livraison d'un installateur qui l'embarque. Omnilingual ASR (Apache 2.0 annoncé) n'est pas utilisé.
