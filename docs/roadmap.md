# Feuille de route et avancement

Ordre imposé par [AGENTS.md](../AGENTS.md). Légende : fait = implémenté et testé ; partiel = implémenté mais non mesuré ou non validé ; à faire.

## Phase 1 - Preuve de concept (partielle)

| Élément | État |
| --- | --- |
| Structure du dépôt, journalisation | fait |
| Transcription de fichiers (FFmpeg + faster-whisper), segments et langue estimée | fait (tests avec moteur factice ; le vrai modèle n'est pas exécuté dans les tests) |
| API testée (validation, erreurs, jeton, concurrence) | fait (Pytest) |
| Outillage d'évaluation (manifeste validé, WER/CER micro-moyennés, latence, facteur temps réel, pic mémoire, hallucinations sur silence, rapport) | fait : `python -m app.evaluation` ; 65 tests Pytest passés le 2026-10-30 (ruff propre) |
| Mesure FR / EN sur corpus **synthétique** (`tiny`, `base`, `small`) | fait : voir [evaluation-results.md](evaluation-results.md). Valide l'outillage et la vitesse, **pas** la qualité sur de vraies voix |
| Évaluation sur de **vraie parole** FR / EN, **wolof**, **mixte** | **à faire, bloquée par les données** : aucun clip autorisé avec transcription de référence. C'est la condition pour affirmer un support du wolof |
| Comparaison de modèles (`medium`, `large-v3`, autres moteurs) | à faire (poids non téléchargés sans accord) |

Prochaine action côté données : réunir 5 à 10 extraits autorisés par catégorie avec transcription de référence validée (un évaluateur wolophone pour le wolof), les placer dans `data/corpus/` avec un `manifest.csv`, puis relancer l'évaluation.

## Phase 2 - Transcription en direct (implémentée, validée avec la voix de synthèse)

| Élément | État |
| --- | --- |
| Contrat WebSocket (trames numérotées, accusés, journal d'événements, reprise, limites) | fait : [api-contracts.md](api-contracts.md), écrit avant le code |
| Découpage en énoncés aux silences, sans recouvrement ni perte d'échantillon de parole | fait : seuil d'énergie fixe (pas le VAD Silero), propriétés testées |
| Provisoire / final, réconciliation, déduplication des rejeux, cycle de vie des sessions | fait côté serveur, processus principal Electron et renderer |
| Reprise après coupure (rejeu des événements, renvoi de l'audio non acquitté) | fait : testée en simulation et **vérifiée contre le vrai service avec le vrai modèle** (coupure forcée en cours de diffusion : 3 énoncés, aucun doublon) |
| Interface : texte définitif et provisoire, état, notices d'erreur, micro libéré à l'arrêt, à l'erreur et à la fermeture | fait (tests de composants) |
| **Non vérifié** | la fenêtre Electron avec un vrai microphone ; la capture micro (ScriptProcessor, voir dette) ; la qualité sur de la parole réelle, bruitée ou en wolof ; la latence en conditions réelles (inférence sérialisée sur CPU : un énoncé est finalisé après quelques secondes) |

Limites connues : seuil de silence non adaptatif au bruit ambiant ; énoncé coupé de force après 15 s au point le plus silencieux (un mot peut être divisé) ; un `partial` est abandonné si le worker est occupé ; une seule session à la fois ; langue estimée par énoncé uniquement, sans reconnaissance du code-switching.

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

- [x] Lancer et arrêter le service Python depuis le processus principal Electron (port libre, jeton généré, arrêt de l'arbre de processus). Vérifié contre le vrai service ; la fenêtre Electron complète n'a pas encore été exercée de bout en bout.
- [ ] Embarquer le service (PyInstaller ou Python embarqué) ; décider de la livraison de FFmpeg (licence) et des modèles (cache dans `%LOCALAPPDATA%`, téléchargement avec consentement, mode hors-ligne).
- [ ] `electron-builder` (installateur NSIS), icône, signature de code, mises à jour.
- [ ] Déplacer le dossier de journaux hors de l'arborescence des sources pour la version installée.
- [ ] Vérifier l'application packagée (chemin `dist/index.html`, CSP, permissions).
- [ ] Verrouiller les dépendances Python (un seul outil) et fournir des scripts reproductibles dans `scripts/`.
- [x] Intégration continue : `.github/workflows/ci.yml` (Ruff + Pytest, ESLint + typecheck + Vitest + build). Écrit mais **jamais exécuté** : il faut un dépôt GitHub pour le valider.

## Dette connue

- Prettier non configuré (ESLint côté desktop et Ruff côté Python le sont).
- Une inférence déjà démarrée ne peut pas être annulée.
- Capture micro du direct via `ScriptProcessorNode` (déprécié mais fonctionnel) ; migration vers un `AudioWorklet` à faire quand l'application packagée pourra être exercée (chargement du module sous `file://` et CSP).
- Découpage des énoncés par seuil d'énergie fixe ; le VAD Silero (déjà utilisé par Whisper pour filtrer) pourrait servir au découpage.
- Pas de test Playwright / Electron de bout en bout.
- Pas de test d'intégration avec le vrai modèle (téléchargement volumineux).
- Pas de confirmation avant le téléchargement du modèle ; pas d'annulation d'une transcription en cours.
- Aucune mesure sur de la **parole réelle** (phase 1 : seul un corpus synthétique FR/EN a été mesuré) : le support du wolof et du code-switching reste non démontré.
