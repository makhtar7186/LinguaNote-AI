# Résultats d'évaluation — phase 1

Ces résultats **valident l'outillage d'évaluation et mesurent la vitesse et la mémoire sur la machine de développement**. Ils ne mesurent pas la qualité de reconnaissance sur de vrais locuteurs, et ils ne disent **rien** du wolof ni du code-switching : aucun clip wolof ni mixte n'existe encore dans le corpus (0 extrait).

## Ce qui a été mesuré

- Date : 2026-10-30. Machine : Intel Core i5-1135G7 (8 threads logiques), Windows 11, CPU uniquement, `cpu_threads=4`.
- Logiciels : Python 3.11.5, faster-whisper 1.2.1, ctranslate2 4.5.0, av 18.0.0, onnxruntime 1.20.1, FFmpeg 9.0.1. Quantification INT8, `beam_size=3`, filtre VAD actif, langue non imposée.
- Corpus : **synthétique**, généré par `scripts/make-synthetic-corpus.ps1` avec les voix Windows Hortense (français), Zira et David (anglais). 8 phrases françaises, 8 anglaises, 2 silences de 3 s. Phrases rédigées par le projet ; aucun droit tiers. Voix propres et uniformes : ce corpus est bien plus facile que de la parole réelle.
- Chaque modèle est évalué dans son propre processus (la mémoire de pointe ne concerne que lui). Aucun poids n'a été téléchargé : `tiny`, `base` et `small` étaient déjà en cache local (mode hors-ligne forcé).

## Résultats (phrases en chiffres : « 8 heures », « 20 minutes »)

Chaque score est donné sur 8 clips ; un échantillon aussi petit ne permet aucune conclusion statistique.

| Modèle | Catégorie | WER | CER | Langue détectée = attendue | Latence médiane | Facteur temps réel | Pic mémoire |
| --- | --- | --- | --- | --- | --- | --- | --- |
| tiny | fr (8) | 2,3 % | 0,4 % | 100 % | 0,92 s | 0,22 | 278 Mio |
| tiny | en (8) | 0,0 % | 0,0 % | 100 % | 0,90 s | 0,24 | 278 Mio |
| base | fr (8) | 2,3 % | 1,3 % | 100 % | 1,68 s | 0,41 | 354 Mio |
| base | en (8) | 0,0 % | 0,0 % | 100 % | 1,67 s | 0,45 | 354 Mio |
| small | fr (8) | 2,3 % | 1,3 % | 100 % | 5,13 s | 1,24 | 724 Mio |
| small | en (8) | 0,0 % | 0,0 % | 100 % | 5,06 s | 1,39 | 724 Mio |

Silences (2 clips) : 0 mot produit par les trois modèles, donc aucune hallucination observée ici. Le WER d'un silence est indéfini (référence vide) et n'est pas affiché comme 0 %.

Erreurs restantes (français uniquement) : `tiny` écrit « par » pour « part » et « cuir » pour « cuire » ; `base` et `small` écrivent « 8h » pour « 8 heures » (différence de format). Aucune erreur en anglais.

## Constats utiles

1. **La normalisation des nombres change le résultat plus que le modèle.** Avec les nombres écrits en toutes lettres dans les références (« huit », « vingt »), les trois modèles affichaient 2,2 % de WER en anglais et 3,4 à 4,6 % en français, et **toutes ces erreurs étaient des différences de format** : Whisper écrit « 8 » et « 20 ». Les résultats bruts de ce premier essai sont conservés localement (`data/eval-results/_numbers-as-words/`). Convention retenue : les références écrivent les nombres en chiffres, comme le moteur. Un corpus réel devra fixer cette règle avant le calcul, sans quoi l'écart entre deux modèles peut être un artefact.
2. **Vitesse sur cette machine** : `tiny` ≈ 0,2× le temps réel, `base` ≈ 0,4×, `small` ≈ 1,2 à 1,4× (**plus lent que le temps réel**). Pour le direct (phase 2), `small` n'est pas utilisable sur ce CPU en traitement par blocs sans autre optimisation ; `base` laisse une marge d'environ 2×.
3. **Mémoire** : 278 / 354 / 724 Mio de pic pour `tiny` / `base` / `small`. Le chargement du modèle prend 2 à 3 s (une première mesure de `small` a pris 20 s, probablement parce que le fichier n'était pas encore en cache disque ; non vérifié).
4. **Pas de différence de qualité observable entre les modèles** sur ce corpus : il est trop facile (voix de synthèse, phrases courtes, aucun bruit) pour les distinguer.

## Ce qui n'est pas mesuré

- Vraie parole : accents, bruit, débit spontané, locuteurs variés.
- Wolof : 0 clip. Whisper ne documente pas de prise en charge validée du wolof ; rien ici ne la confirme ni ne l'infirme.
- Code-switching (alternance dans une phrase) : 0 clip.
- Omnilingual (candidat wolof) : non installable sur cet environnement Windows (voir [model-selection.md](model-selection.md)).
- Détection de langue par fenêtre courte, mots perdus ou dupliqués aux frontières, hallucinations sur bruit (seul le silence numérique a été testé).
- Seuils d'acceptation : aucun n'est fixé ; ils dépendent des résultats sur un vrai corpus.

## Reproduire

```powershell
powershell -File scripts\make-synthetic-corpus.ps1
cd services\transcription
.\.venv\Scripts\python.exe -m app.evaluation run --manifest ..\..\data\corpus\synthetic\manifest.csv --models tiny,base,small
```

Sans `--allow-download`, un modèle absent du cache fait échouer la commande au lieu de le télécharger.
