# Résultats d'évaluation — phase 1 (préliminaires)

Ces résultats **valident l'outillage d'évaluation** et donnent des **ordres de grandeur exploratoires** de vitesse et de mémoire sur la machine de développement. Ils ne mesurent pas la qualité de reconnaissance sur de vraies voix, et ils ne disent **rien** du wolof ni du code-switching : aucun clip wolof ni mixte n'existe encore dans le corpus (0 extrait).

Les données brutes (un JSON par modèle et par passage, avec versions logicielles, machine et texte reconnu) sont archivées dans [eval-results/2026-10-30-synthetic/](eval-results/2026-10-30-synthetic/) : on peut recalculer chaque chiffre ci-dessous à partir de ces fichiers.

## Ce qui a été mesuré

- Date : 2026-10-30. Machine : Intel Core i5-1135G7 (8 threads logiques), Windows 11, CPU uniquement, `cpu_threads=4`. D'autres applications tournaient pendant les mesures (non contrôlé).
- Logiciels : Python 3.11.5, faster-whisper 1.2.1, ctranslate2 4.5.0, av 18.0.0, onnxruntime 1.20.1, FFmpeg 9.0.1. Quantification INT8, `beam_size=3`, filtre VAD actif, langue non imposée.
- Corpus : **synthétique**, généré par `scripts/make-synthetic-corpus.ps1` avec les voix Windows Hortense (français), Zira et David (anglais). 8 phrases françaises, 8 anglaises, 2 silences numériques de 3 s. Phrases rédigées par le projet ; aucun droit tiers. Voix propres et uniformes : ce corpus est bien plus facile que de la parole réelle.
- Chaque modèle est évalué dans son propre processus, dans l'ordre `tiny`, `base`, `small`, **un seul passage par clip et par exécution**, deux exécutions complètes (run-1 et run-2). Aucun poids n'a été téléchargé : les trois modèles étaient déjà en cache local, mode hors-ligne Hugging Face forcé.
- Périmètre des mesures : la latence est le temps de `transcribe` (segments consommés) hors conversion FFmpeg ; le facteur temps réel = inférence totale / durée audio totale des clips réussis ; la mémoire est le **pic du processus d'évaluation** (interpréteur et bibliothèques compris), relevé après tous les clips, pas la mémoire propre au modèle.

## Résultats (phrases en chiffres : « 8 heures », « 20 minutes »)

Chaque score porte sur 8 clips : aucune conclusion statistique n'est possible. Les erreurs sont identiques dans les deux exécutions ; les temps varient, d'où des plages.

| Modèle | WER fr | WER en | CER fr | Langue détectée = attendue | Facteur temps réel (plage sur les 2 exécutions, fr–en) | Pic mémoire du processus |
| --- | --- | --- | --- | --- | --- | --- |
| tiny | 2,3 % | 0,0 % | 0,4 % | 16/16 | 0,17 – 0,24 | 278 Mio |
| base | 2,3 % | 0,0 % | 1,3 % | 16/16 | 0,41 – 0,46 | 352–354 Mio |
| small | 2,3 % | 0,0 % | 1,3 % | 16/16 | 1,24 – 2,52 | 724 Mio |

Silences (2 clips) : 0 mot produit par les trois modèles, donc aucune hallucination observée sur du silence numérique (pas sur du bruit). Le WER d'un silence est indéfini (référence vide) et n'est pas affiché comme 0 %.

Erreurs restantes (français uniquement) : `tiny` écrit « par » pour « part » et « cuir » pour « cuire » ; `base` et `small` écrivent « 8h » pour « 8 heures » (différence de format). Aucune erreur en anglais.

## Constats

1. **La normalisation des nombres change le résultat plus que le modèle.** Avec les nombres écrits en toutes lettres dans les références (« huit », « vingt »), les trois modèles affichaient 2,2 % de WER en anglais et 3,4 à 4,6 % en français, et **toutes ces erreurs étaient des différences de format** : Whisper écrit « 8 » et « 20 ». Convention retenue : les références écrivent les nombres en chiffres. Un corpus réel devra fixer cette règle avant le calcul, sans quoi l'écart entre deux modèles peut être un artefact.
2. **Les temps sont très variables d'une exécution à l'autre** (`small` : 1,24 puis 2,52 en facteur temps réel sur les mêmes clips). Le facteur de `tiny` et de `base` est resté sous 0,5 dans les deux exécutions ; celui de `small` a dépassé 1 dans les deux. **Sur ces clips courts et ce CPU**, `small` a donc été plus lent que le temps réel. Cela n'est pas une mesure du traitement en direct par blocs, qui n'a pas été testé.
3. **Les modèles ne se distinguent pas sur la qualité** : ce corpus est trop facile (voix de synthèse, phrases courtes, aucun bruit).

## Ce qui n'est pas mesuré

- Vraie parole : accents, bruit, débit spontané, locuteurs variés.
- Wolof : 0 clip. Whisper ne documente pas de prise en charge validée du wolof ; rien ici ne la confirme ni ne l'infirme.
- Code-switching (alternance dans une phrase) : 0 clip.
- Omnilingual (candidat wolof) : non installable sur cet environnement Windows (voir [model-selection.md](model-selection.md)).
- Détection de langue par fenêtre courte, mots perdus ou dupliqués aux frontières, hallucinations sur bruit.
- Traitement en direct par blocs, mémoire propre au modèle, répétabilité des temps (un passage par clip, ordre fixe, cache disque et thermique non contrôlés).
- Seuils d'acceptation : aucun n'est fixé ; ils dépendent des résultats sur un vrai corpus.

## Reproduire

```powershell
powershell -File scripts\make-synthetic-corpus.ps1
cd services\transcription
.\.venv\Scripts\python.exe -m app.evaluation run --manifest ..\..\data\corpus\synthetic\manifest.csv --models tiny,base,small
```

Sans `--allow-download`, un modèle absent du cache fait échouer la commande au lieu de le télécharger (garantie testée pour la sélection de variables d'environnement ; le comportement des bibliothèques de modèles hors-ligne n'est pas testé de façon automatisée).
