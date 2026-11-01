# Architecture — LinguaNote AI

## État actuel (après la phase 3)

Implémenté : transcription de fichiers et d'enregistrements micro courts, **dictée en direct par WebSocket** (texte provisoire puis final, reprise après coupure), client Electron/React, service FastAPI, moteur faster-whisper. **bulle flottante** (fenêtre séparée toujours visible) et **raccourcis globaux**. **capture du son de l'ordinateur** (Windows) et choix de la source. **Historique optionnel** (SQLite local, recherche, export) et **insertion de texte dans l'application active** (Windows). Non implémenté : diarisation, résumés, installateur. Voir [roadmap.md](roadmap.md). Les modèles ne sont pas dans le dépôt ; leur téléchargement se produit à la première transcription (voir [security.md](security.md)).

Organisation du service (`services/transcription/app`) : `main.py` (fabrique `create_app`, authentification par jeton, CORS, hôtes de confiance), `config.py` (variables d'environnement, validation au démarrage), `security.py` (limite de corps avant lecture multipart), `api/routes.py` (routes, admission bornée, worker d'inférence unique avec délai), `audio/convert.py` (FFmpeg et validation, sans reconnaissance), `engines/` (interface `SpeechEngine`, capacités, adaptateurs, `registry.py` qui charge un seul modèle sous verrou), `schemas/` (Pydantic), `errors.py` (erreurs à code stable), `mcp_server.py` (pont MCP local), `inference.py` (worker d'inférence unique partagé), `live/` (`segmenter.py` : découpage aux silences ; `session.py` : session, journal d'événements, worker séquentiel ; `manager.py` : une session à la fois, expiration ; `protocol.py` : messages validés), `api/live.py` (WebSocket), `storage/` (`database.py` : SQLite, migrations, suppression réelle ; `history.py` : dépôt des sessions et `SessionRecorder` qui enregistre le direct ; `search.py` : requête FTS sûre), `export/formats.py` (txt, md, srt, vtt, json), `api/history.py` (routes de l'historique), `evaluation/` (outil d'évaluation hors ligne). Côté desktop (`apps/desktop`) : `electron/backend-launcher.cjs` (démarre et arrête le service : port libre, jeton éphémère, nouvelle tentative si le port est pris), `electron/capture-gate.cjs` (porte à usage unique pour le son de l'ordinateur), `src/services/micCapture.ts` (capture du microphone, du son de l'ordinateur ou des deux mélangés ; niveau ; source perdue), `src/services/audioSource.ts` + `capturePreferences.ts` + `components/SourcePicker.tsx` (choix de la source, mémorisé, jamais implicite), `electron/ipc-trust.cjs` (confiance IPC : frame principal d'une de nos fenêtres, propriétaire du micro de la session, surveillance de sa disparition), `src/hooks/useLiveTranscription.ts` (capture du micro et état du direct vus d'une fenêtre ; jeton d'époque contre les fuites), `electron/bubble-controller.cjs` + `bubble-geometry.cjs` + `position-store.cjs` (fenêtre de la bulle : création, position mémorisée, déploiement ancré sur le coin le plus proche, toujours dans un écran), `electron/shortcuts.cjs` (raccourcis globaux, échecs signalés), `electron/app-urls.cjs` (pages de confiance), `src/bubble/` (page de la bulle, deuxième entrée Vite `bubble.html`), `electron/live-client.cjs` (client WebSocket du direct : tampon d'audio non acquitté, reprise, déduplication), `electron/history-client.cjs` (opérations d'historique en liste fermée, arguments validés, le jeton reste dans le processus principal), `electron/text-inserter.cjs` (insertion : cible verrouillée, file séquentielle, pause si la cible est quittée, presse-papiers emprunté), `electron/electron-clipboard.cjs` (port presse-papiers asynchrone d'Electron 45 : instantané et restauration, formats non restaurables refusés), `electron/windows-desktop.cjs` (fenêtre au premier plan et Ctrl+V via PowerShell), `src/components/HistoryPanel.tsx` + `src/services/historyClient.ts` (interface et validation des réponses d'historique), `src/components/InsertionControl.tsx`, `electron/api-client.cjs` (client du backend, validation IPC, délais, limites lues dans `/health`), `electron/main.cjs` (fenêtre, permissions, CSP, cycle de vie du service), `src/services/` (validation des réponses), `src/hooks/useRecorder.ts` (micro), `src/App.tsx` (présentation).

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

### Routage par langue (fichiers, moteur optionnel `language-routing`)

Implémenté dans `services/transcription/app/language/` ; mesures et limites dans [evaluation-wolof.md](evaluation-wolof.md). Chaîne de traitement, chaque étape étant un module séparé :

1. `whisper_lid.py` : vecteur des probabilités de langue de Whisper `tiny` sur des fenêtres de 3 s (pas de 1,5 s).
2. `classifier.py` : régression logistique (numpy seul) qui convertit ce vecteur en français / anglais / wolof ; poids dans un fichier JSON (`LINGUANOTE_ROUTING_CLASSIFIER`). Alternative sans fichier, `rule.py` (`LINGUANOTE_ROUTING_DETECTOR=fr-en-else-wolof`) : français ou anglais si Whisper en est assez sûr, sinon wolof.
3. `segmentation.py` : lissage de Viterbi avec pénalité de changement, fusion des passages de moins de 2 s, frontières ramenées à l'instant le plus silencieux voisin, passages numérotés qui couvrent tout l'audio. Les fenêtres quasi silencieuses (volume < 0,0005) ne sont pas envoyées au détecteur.
4. `routing.py` : un moteur par passage (modèle multilingue par défaut pour les langues inconnues, modèles éventuellement distincts pour le français et l'anglais, modèle wolof pour le wolof ; la langue détectée est imposée aux passages français et anglais, jamais au wolof), isolation des échecs, réassemblage **par numéro de passage**, décalage des temps vers l'enregistrement entier, `warnings` si un passage est perdu.
5. `engines/language_routing.py` : assemble le tout depuis la configuration et le publie dans le registre. Refusé par le direct (WebSocket) : le routage a besoin de passages entiers.

Le texte reconnu n'est jamais traduit ni corrigé, et la langue de chaque passage est une estimation qui indique le modèle choisi, pas une garantie.

## Risques spécifiques

- Une langue fournie au modèle au niveau du fichier peut dégrader les mots prononcés dans une autre langue.
- Une détection de langue par fenêtres courtes peut confondre mots empruntés et vrais changements de langue ; le découpage peut aussi couper les mots.
- Les ressources wolof peuvent refléter un domaine, un dialecte ou une orthographe distincts des conversations ciblées.
- Un modèle wolof séparé peut améliorer les passages monolingues mais échouer sur les phrases mixtes ou créer des ruptures aux frontières.
- Les fichiers longs, bruités ou multi-locuteurs peuvent produire de mauvais résultats ; le prototype ne promet pas diarisation ni qualité temps réel.
- Les poids, dépendances natives, versions CUDA/cuDNN et conditions de redistribution affectent la portabilité et le packaging desktop.

## Jalons proposés au départ (historique : plan initial du pipeline de fichier ; l'état réel est dans [roadmap.md](roadmap.md))

1. Définir le corpus de référence et les critères d’acceptation, sans télécharger de modèles.
2. Confirmer les capacités matérielles et sélectionner les premiers candidats/licences.
3. Créer le squelette minimal FastAPI et les tests de contrat/validation sans inférence lourde.
4. Ajouter le prétraitement et un seul adaptateur de modèle choisi, puis mesurer FR/EN/Wolof.
5. Évaluer explicitement le code-switching et comparer détection par segments à transcription multilingue sans langue imposée.
6. Décider si le résultat justifie un client Electron, puis traiter capture live comme jalon séparé.

## Décisions encore ouvertes (la liste ci-dessous est maintenue à jour)

- Taille et durée maximales : décidées pour le prototype (50 Mio, 600 s par défaut, abaissées par moteur) ; à réviser après la phase 1.
- Modèle(s) à télécharger après vérification des ressources machine.
- (Tranché) L'API locale est lancée par l'application Electron ; un service lancé séparément reste possible en développement, avec jeton obligatoire.
- Corpus de référence, droits d’usage et critères d’acceptation pour chaque langue.
- Stratégie de code-switching : modèle multilingue seul, détection par régions ou comparaison de plusieurs candidats.
