# Conception initiale — LinguaNote AI

## État actuel (jalon 1)

Implémenté : transcription de fichiers et d'enregistrements micro courts, client Electron/React, service FastAPI, moteur faster-whisper. Non implémenté : flux temps réel, bulle flottante, audio système, persistance, export. Voir [roadmap.md](roadmap.md). Les modèles ne sont pas dans le dépôt ; leur téléchargement se produit à la première transcription (voir [security.md](security.md)).

Organisation du service (`services/transcription/app`) : `config.py` (variables d'environnement), `api/routes.py` (routes), `audio/convert.py` (FFmpeg et validation, sans reconnaissance), `engines/` (interface `SpeechEngine`, capacités, adaptateurs, `registry.py` qui charge un seul modèle sous verrou), `schemas/` (Pydantic), `errors.py` (erreurs à code stable). Côté desktop (`apps/desktop`) : `electron/api-client.cjs` (client du backend, validation IPC, délais), `electron/main.cjs` (fenêtre, permissions, CSP), `src/services/` (validation des réponses), `src/hooks/useRecorder.ts` (micro), `src/App.tsx` (présentation).

## Architecture cible du prototype

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

Electron/React sera un client local séparé lors d’un jalon ultérieur. Il appellera l’API, sans importer de modèles ni traiter l’audio. Sa configuration de sécurité devra suivre les recommandations Electron : isolation de contexte, sandbox renderer, API preload minimale et validation des IPC.

## Contrat de transcription

Le contrat réel (champs, codes d'erreur, IPC) est documenté dans [api-contracts.md](api-contracts.md). Chaque réponse contient le texte, le moteur et le modèle, la durée audio, une langue estimée optionnelle et une liste de segments horodatés quand le moteur les fournit. `SpeechEngine` déclare ses capacités (`EngineCapabilities` : horodatages, détection de langue, streaming, durée maximale) ; l'API s'y adapte au lieu de supposer des fonctions absentes. Aucun texte partiel n'est émis dans ce jalon.

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

- Taille maximale des fichiers et durée maximale du prototype.
- Modèle(s) à télécharger après vérification des ressources machine.
- API locale lancée par l’application ou service lancé séparément en développement.
- Corpus de référence, droits d’usage et critères d’acceptation pour chaque langue.
- Stratégie de code-switching : modèle multilingue seul, détection par régions ou comparaison de plusieurs candidats.
