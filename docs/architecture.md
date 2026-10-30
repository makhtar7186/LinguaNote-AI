# Architecture — LinguaNote AI

## État actuel (après la phase 3)

Implémenté : transcription de fichiers et d'enregistrements micro courts, **dictée en direct par WebSocket** (texte provisoire puis final, reprise après coupure), client Electron/React, service FastAPI, moteur faster-whisper. **bulle flottante** (fenêtre séparée toujours visible) et **raccourcis globaux**. Non implémenté : capture de l'audio système, insertion de texte dans l'application active, persistance, export. Voir [roadmap.md](roadmap.md). Les modèles ne sont pas dans le dépôt ; leur téléchargement se produit à la première transcription (voir [security.md](security.md)).

Organisation du service (`services/transcription/app`) : `main.py` (fabrique `create_app`, authentification par jeton, CORS, hôtes de confiance), `config.py` (variables d'environnement, validation au démarrage), `security.py` (limite de corps avant lecture multipart), `api/routes.py` (routes, admission bornée, worker d'inférence unique avec délai), `audio/convert.py` (FFmpeg et validation, sans reconnaissance), `engines/` (interface `SpeechEngine`, capacités, adaptateurs, `registry.py` qui charge un seul modèle sous verrou), `schemas/` (Pydantic), `errors.py` (erreurs à code stable), `mcp_server.py` (pont MCP local), `inference.py` (worker d'inférence unique partagé), `live/` (`segmenter.py` : découpage aux silences ; `session.py` : session, journal d'événements, worker séquentiel ; `manager.py` : une session à la fois, expiration ; `protocol.py` : messages validés), `api/live.py` (WebSocket), `evaluation/` (outil d'évaluation hors ligne). Côté desktop (`apps/desktop`) : `electron/backend-launcher.cjs` (démarre et arrête le service : port libre, jeton éphémère, nouvelle tentative si le port est pris), `electron/ipc-trust.cjs` (confiance IPC : frame principal d'une de nos fenêtres, propriétaire du micro de la session, surveillance de sa disparition), `src/hooks/useLiveTranscription.ts` (capture du micro et état du direct vus d'une fenêtre ; jeton d'époque contre les fuites), `electron/bubble-controller.cjs` + `bubble-geometry.cjs` + `position-store.cjs` (fenêtre de la bulle : création, position mémorisée, déploiement ancré sur le coin le plus proche, toujours dans un écran), `electron/shortcuts.cjs` (raccourcis globaux, échecs signalés), `electron/app-urls.cjs` (pages de confiance), `src/bubble/` (page de la bulle, deuxième entrée Vite `bubble.html`), `electron/live-client.cjs` (client WebSocket du direct : tampon d'audio non acquitté, reprise, déduplication), `electron/api-client.cjs` (client du backend, validation IPC, délais, limites lues dans `/health`), `electron/main.cjs` (fenêtre, permissions, CSP, cycle de vie du service), `src/services/` (validation des réponses), `src/hooks/useRecorder.ts` (micro), `src/App.tsx` (présentation).

## Architecture cible du prototype (schéma initial du pipeline de fichier ; le direct et la bulle sont décrits ci-dessus)

```text
Fichier audio
    │
    ▼
API locale FastAPI ── validation / limites / cycle de requête
    │
    ├── Prétraitement audio (FFmpeg au besoin, 16 kHz mono)
    │
    ├── Orchestrateur de transcription
    │     └── Interface SpeechEngine
    │           ├── adaptateur candidat multilingue FR/EN
    │           └── adaptateur candidat wolof (à évaluer)
    │
    └── Résultat normalisé : segments, temps, langue, confiance disponible
```

Le backend Python est l’unique propriétaire du traitement audio et de l’inférence. L’API accepte un fichier, contrôle le type et la taille, prépare un fichier temporaire dans un emplacement dédié, lance l’orchestration et supprime les temporaires en succès comme en erreur. Les chemins transmis par le client ne doivent jamais déterminer les chemins d’écriture. Le service écoute uniquement sur loopback pour ce prototype.

Electron/React est le client local (implémenté). Il appelle l’API, sans importer de modèles ni traiter l’audio, et possède le processus du service : il le lance avec un jeton aléatoire par session sur un port libre, puis l'arrête à la fermeture. Sa configuration de sécurité suit les recommandations Electron : isolation de contexte, sandbox renderer, API preload minimale et validation des IPC.

**Direct et fenêtres.** La session en direct appartient au processus principal, qui diffuse ses événements à toutes les fenêtres : la bulle et la fenêtre principale affichent la même chose, et n'importe laquelle peut arrêter ou mettre en pause. La fenêtre qui démarre la session possède le micro (seul un renderer peut capturer l'audio) ; elle le libère à la pause, à l'arrêt, en cas d'erreur et à sa fermeture (qui arrête alors la session). Pause et reprise sont gérées dans le processus principal, ce qui permet aux raccourcis de les déclencher sans renderer.

Limite connue : si le service s'arrête de façon inattendue, l'application l'indique mais ne le redémarre pas automatiquement.

## Contrat de transcription

Le contrat réel (champs, codes d'erreur, IPC) est documenté dans [api-contracts.md](api-contracts.md). Chaque réponse contient le texte, le moteur et le modèle, la durée audio, une langue estimée optionnelle et une liste de segments horodatés quand le moteur les fournit. `SpeechEngine` déclare ses capacités (`EngineCapabilities` : horodatages, détection de langue, streaming, durée maximale) ; l'API s'y adapte au lieu de supposer des fonctions absentes. L'import de fichier ne renvoie aucun texte partiel ; le direct émet des `partial` (hypothèses révisables) et des `final` par énoncé, selon le contrat WebSocket.

## Langues et stratégie d’évaluation

Les résultats doivent être évalués séparément pour le français, l’anglais, le wolof et les échantillons mixtes. Constituer un petit corpus autorisé avec transcription de référence, locuteurs variés et conditions acoustiques décrites. Inclure des phrases où le changement de langue se produit au milieu d’une phrase et annoter les frontières utiles.

Mesures initiales : WER pour comparaison usuelle, CER pour mieux observer les variations orthographiques du wolof, taux d’erreurs sur mots wolof/français/anglais, temps de traitement par durée audio et mémoire maximale. Documenter la normalisation avant calcul (ponctuation, casse, nombres, variantes d’écriture) afin de ne pas masquer les erreurs.

Comparer deux pistes sans présumer du résultat : un moteur multilingue général pour français/anglais et un candidat distinct couvrant le wolof. Omnilingual ASR répertorie le code `wol_Latn`, mais ses poids ont un coût matériel et de téléchargement substantiel. Ne pas télécharger de modèle avant d’avoir relevé mémoire disponible, GPU et espace disque, choisi les extraits d’évaluation et vérifié les licences. Un modèle déclaré multilingue n’est pas réputé fiable en code-switching sans résultats mesurés.

## Risques spécifiques

- Une langue fournie au modèle au niveau du fichier peut dégrader les mots prononcés dans une autre langue.
- Une détection de langue par fenêtres courtes peut confondre mots empruntés et vrais changements de langue ; le découpage peut aussi couper les mots.
- Les ressources wolof peuvent refléter un domaine, un dialecte ou une orthographe distincts des conversations ciblées.
- Un modèle wolof séparé peut améliorer les passages monolingues mais échouer sur les phrases mixtes ou créer des ruptures aux frontières.
- Les fichiers longs, bruités ou multi-locuteurs peuvent produire de mauvais résultats ; le prototype ne promet pas diarisation ni qualité temps réel.
- Les poids, dépendances natives, versions CUDA/cuDNN et conditions de redistribution affectent la portabilité et le packaging desktop.

## Jalons proposés

1. Définir le corpus de référence et les critères d’acceptation, sans télécharger de modèles.
2. Confirmer les capacités matérielles et sélectionner les premiers candidats/licences.
3. Créer le squelette minimal FastAPI et les tests de contrat/validation sans inférence lourde.
4. Ajouter le prétraitement et un seul adaptateur de modèle choisi, puis mesurer FR/EN/Wolof.
5. Évaluer explicitement le code-switching et comparer détection par segments à transcription multilingue sans langue imposée.
6. Décider si le résultat justifie un client Electron, puis traiter capture live comme jalon séparé.

## Décisions encore ouvertes

- Taille et durée maximales : décidées pour le prototype (50 Mio, 600 s par défaut, abaissées par moteur) ; à réviser après la phase 1.
- Modèle(s) à télécharger après vérification des ressources machine.
- (Tranché) L'API locale est lancée par l'application Electron ; un service lancé séparément reste possible en développement, avec jeton obligatoire.
- Corpus de référence, droits d’usage et critères d’acceptation pour chaque langue.
- Stratégie de code-switching : modèle multilingue seul, détection par régions ou comparaison de plusieurs candidats.
