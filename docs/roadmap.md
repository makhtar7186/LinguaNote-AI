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
| Évaluation sur de **vraie parole** FR / EN, **wolof**, **mixte** | **partielle** : parole **lue** seulement (ALFFA wolof, FLEURS), voir [evaluation-wolof.md](evaluation-wolof.md). Whisper tiny, base et small échouent en wolof (WER ≥ 99 % ; tailles plus grandes non mesurées) ; des modèles ajustés (Kiriku, M9) fonctionnent mais restent faibles hors de leur domaine. Parole spontanée, bruitée, réunions et changement de langue dans une phrase : **non mesurés** |
| Routage par langue pour les fichiers (détection, découpe, un moteur par passage, réassemblage) | fait pour les **fichiers** (moteur optionnel `language-routing`) : WER de 56,0 % à 23,6 % (modèle M9, 10 enregistrements) et de 65,5 % à 21,2 % (Kiriku, 4 enregistrements) sur des enregistrements mixtes artificiels (clips lus collés), passages courts (≈ 2 s) mal étiquetés ; **pas de direct**. Voir [evaluation-wolof.md](evaluation-wolof.md) |
| Comparaison de modèles (`medium`, `large-v3`, autres moteurs) | à faire (poids non téléchargés sans accord) |

Prochaine action côté données : réunir des extraits **spontanés et bruités** autorisés (réunions, conversations mêlant français, wolof et anglais) avec transcription de référence validée par un locuteur wolophone, les placer dans `data/corpus/` avec un `manifest.csv`, puis relancer `scripts/eval_routing.py` et l'évaluation par modèle. Sans cela, on ne peut pas affirmer que le routage tient en conditions réelles.

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

## Phase 3 - Bulle flottante (implémentée, vérifiée sans affichage à l'écran)

| Élément | État |
| --- | --- |
| Fenêtre Electron séparée, cycle de vie explicite (création, position mémorisée, déploiement ancré, masquage) | fait : `bubble-controller.cjs`, testé avec de fausses fenêtres ; vérifié dans la vraie application (taille, toujours au-dessus, non focalisable, dans un écran, déploiement/réduction à la même place) |
| États : inactif, enregistrement, pause, traitement, erreur ; déployer / réduire | fait (tests de composants) |
| Démarrer, pause, reprise, arrêt | fait ; la pause libère le micro et envoie un silence final pour clore la phrase |
| Raccourcis globaux (démarrer/arrêter, pause/reprise, afficher/masquer) | fait : enregistrement signalé honnêtement si une touche est prise ; le test de fumée enregistre réellement les trois accélérateurs par défaut auprès d'Electron puis les libère aussitôt (il vérifie leur validité, pas leur effet) ; **jamais éprouvés avec de vraies touches** |
| Indicateur d'enregistrement clair, jamais caché | fait : anneau rouge pulsant + point REC ; démarrer ouvre toujours la bulle ; elle ne peut pas être masquée pendant l'enregistrement |
| Bulle réactive, indépendante des traitements longs | fait par construction (la session et les événements sont dans le processus principal, diffusés à toutes les fenêtres) |
| Micro : pas de fuite à l'arrêt, à la pause, à la fermeture ni quand ces actions croisent l'ouverture du micro | fait : jeton d'époque + verrou de démarrage ; 5 tests de course dont la suppression des gardes fait échouer |
| **Non vérifié** | l'apparence réelle (transparence, ombres, animations) ; le glisser-déposer de la bulle à la souris ; plusieurs écrans ; un vrai microphone ; l'application packagée ; Windows seulement |

Limites connues : la bulle n'insère pas encore le texte dans l'application active (phase 5) ; la capture micro reste dans une fenêtre (la bulle, ou la fenêtre principale qui a démarré la session) ; fermer la fenêtre principale ferme l'application.

## Phase 4 - Audio système (implémentée sous Windows, éprouvée avec une phrase synthétique)

| Élément | État |
| --- | --- |
| Sources séparées : microphone, son de l'ordinateur, les deux mélangés ; choix explicite, affiché, mémorisé | fait (tests de composants) |
| Pas de basculement silencieux : une source perdue termine la session avec un message ; « micro + ordinateur » ne devient jamais « micro seul » si l'ordinateur échoue | fait, testé |
| Choix du microphone | fait (liste du système, relue quand un périphérique est branché ou débranché) |
| Capture du son de l'ordinateur (loopback Windows via Electron) | fait et **vérifié dans la vraie application** : refusée par défaut, armée par la fenêtre qui la demande, à usage unique, liée à cette fenêtre ; piste vidéo d'écran, exigée par Electron, coupée aussitôt |
| Indicateur de niveau et avertissement de silence | fait |
| Gestion des erreurs et des permissions | fait : refus, absence de piste audio, API indisponible (aperçu navigateur), source perdue |
| Scénario réel de lecture de média | **éprouvé une fois** : une phrase prononcée par la voix Windows, capturée comme son de l'ordinateur par la vraie interface, retranscrite (69 % des mots ; le modèle `base` a mal entendu « Dakar ») |
| **Non vérifié** | une vraie réunion (Teams, Zoom, Meet) ; plusieurs sorties audio (casque Bluetooth, HDMI) ; contenus protégés (DRM) qui peuvent rendre un silence ; la qualité du mélange micro + ordinateur sans casque (écho) ; macOS et Linux (non pris en charge, non testés) ; la perte du périphérique par débranchement réel |

Limites connues : le son capturé est celui de tout le système, notifications comprises, sans filtre par application ; pas de séparation des locuteurs (diarisation, phase 6), donc une réunion est transcrite en un seul flux ; le mélange est une simple somme avec marge de volume.

## Phase 5 - Productivité (implémentée sous Windows ; insertion éprouvée dans une fenêtre de test)

| Élément | État |
| --- | --- |
| Politique de conservation et de suppression, définie **avant** la base | fait ([security.md](security.md)) : désactivé par défaut, durée au choix, suppression réelle |
| Stockage SQLite (WAL, `secure_delete`, migrations par `user_version`, refuse un schéma plus récent) | fait ; suppression vérifiée en relisant les octets bruts du fichier et de son journal |
| Recherche plein texte (FTS5, sans accents ni casse, entrées hostiles neutralisées) | fait |
| Enregistrement du direct énoncé par énoncé ; import de fichier enregistré si l'historique est activé | fait ; échec de stockage signalé sans perdre le texte |
| Export `txt`, `md`, `srt`, `vtt`, `json` | fait ; `srt`/`vtt` refusés sans horodatage (jamais inventé) |
| Interface d'historique (recherche, ouverture, copie, renommage, export, suppression, tout supprimer avec confirmation) | fait, 12 tests de composant ; **l'aspect à l'écran n'a pas été regardé** |
| Insertion dans l'application active (cible verrouillée, presse-papiers emprunté puis remis) | fait ; **éprouvé une fois pour de vrai** dans une fenêtre de test (`LINGUANOTE_SMOKE_INSERTION=1 npm run smoke`) : phrases accentuées arrivées dans l'ordre, presse-papiers de l'utilisateur remis |
| **Non vérifié** | l'insertion dans de vraies applications (Word, navigateurs, éditeurs, champs protégés, applications lancées en administrateur) ; le comportement du presse-papiers avec des contenus riches venant d'Office ; des historiques volumineux (milliers de sessions) ; la lecture de l'historique par plusieurs fenêtres en même temps ; macOS et Linux |

Limites connues : historique **non chiffré** par l'application (protégé seulement par le compte Windows) ; pas de dictée « raccourci maintenu » (appuyer-parler-relâcher) ; pas d'import de lot ni de recherche par langue ou par date ; la pagination de la liste s'arrête à 200 résultats (affiner la recherche) ; l'insertion coûte environ une demi-seconde par collage (démarrage de PowerShell) ; une application lancée en administrateur ignore le collage.

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
- Aucune mesure sur de la **parole spontanée ou bruitée** : seules de la parole lue (ALFFA, FLEURS) et un corpus synthétique FR/EN ont été mesurés. Le wolof est reconnu par des modèles dédiés avec des erreurs importantes hors de leur domaine, et le changement de langue **dans une phrase** reste non démontré.
