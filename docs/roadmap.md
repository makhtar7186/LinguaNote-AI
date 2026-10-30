# Feuille de route et avancement

Ordre imposé par [AGENTS.md](../AGENTS.md). Légende : fait = implémenté et testé ; partiel = implémenté mais non mesuré ou non validé ; à faire.

## Phase 1 - Preuve de concept (partielle)

| Élément | État |
| --- | --- |
| Structure du dépôt, journalisation | fait |
| Transcription de fichiers (FFmpeg + faster-whisper), segments et langue estimée | fait (tests avec moteur factice ; le vrai modèle n'est pas exécuté dans les tests) |
| API testée (validation, erreurs, jeton, concurrence) | fait (Pytest) |
| Évaluation FR / EN / Wolof / mixte, WER, CER, latence, mémoire | **à faire** : aucun corpus ni script. C'est la condition pour affirmer un support du wolof. |
| Comparaison de modèles (`small`, `medium`, `large-v3`, autres moteurs) | à faire |

Prochaine action : constituer le corpus selon [evaluation-protocol.md](evaluation-protocol.md), écrire `scripts/evaluate.py`, décider du moteur avant la phase 2.

## Phase 2 - Transcription en direct (à faire)

Traitement par blocs (VAD Silero), contrat WebSocket (partiel / final), réconciliation des fenêtres, cycle de vie des sessions. Le contrat sera documenté dans `api-contracts.md` avant l'implémentation.

## Phase 3 - Bulle flottante (à faire)

Fenêtre Electron séparée, états (inactif, enregistrement, traitement, erreur), raccourcis globaux.

## Phase 4 - Audio système (à faire)

Micro validé (jalon 1, enregistrement court) ; capture de l'audio système sous Windows à valider séparément.

## Phase 5 - Productivité (à faire)

SQLite, historique, recherche, import/export, dictée et insertion de texte.

## Phase 6 - Intelligence avancée (à faire)

Diarisation, résumés, adaptation du wolof si l'évaluation le justifie, fournisseurs cloud optionnels.

## Packaging et distribution (à faire)

Non commencé, volontairement : il dépend du choix du moteur (phase 1) et d'un backend lançable par Electron.

- [ ] Lancer et arrêter le service Python depuis le processus principal Electron (port libre, jeton généré, arrêt propre).
- [ ] Embarquer le service (PyInstaller ou Python embarqué) ; décider de la livraison de FFmpeg (licence) et des modèles (cache dans `%LOCALAPPDATA%`, téléchargement avec consentement, mode hors-ligne).
- [ ] `electron-builder` (installateur NSIS), icône, signature de code, mises à jour.
- [ ] Déplacer le dossier de journaux hors de l'arborescence des sources pour la version installée.
- [ ] Vérifier l'application packagée (chemin `dist/index.html`, CSP, permissions).
- [ ] Verrouiller les dépendances Python (un seul outil) et fournir des scripts reproductibles dans `scripts/`.
- [ ] Intégration continue (lint, typecheck, tests, build).

## Dette connue

- ESLint/Prettier non configurés côté desktop (Ruff côté Python).
- Pas de test Playwright / Electron de bout en bout.
- Pas de test d'intégration avec le vrai modèle (téléchargement volumineux).
- Pas de confirmation avant le téléchargement du modèle ; pas d'annulation d'une transcription en cours.
