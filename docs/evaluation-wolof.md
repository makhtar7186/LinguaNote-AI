# Wolof et routage par langue — résultats mesurés (2026-11-01)

Ce document remplace, pour le wolof, le constat « 0 clip » de [evaluation-results.md](evaluation-results.md) (phase 1, corpus synthétique FR/EN). Les données brutes agrégées sont archivées dans [eval-results/2026-11-01-wolof/](eval-results/2026-11-01-wolof/) : résumés de chaque exécution et tableaux par modèle. Elles ne contiennent aucun audio ni texte de corpus.

**À retenir.** Whisper n'a pas de support du wolof : ses tailles tiny, base et small donnent un WER de 99 % ou plus sur du wolof lu, ce qui rend le texte inutilisable (ce n'est pas une preuve d'incapacité absolue de tout Whisper, les tailles plus grandes n'ont pas été mesurées). Des modèles ajustés au wolof existent et sont nettement meilleurs, surtout un modèle large, au prix d'une lenteur importante sur processeur. Un routage par langue qui envoie les passages wolof à un tel modèle fait passer le WER de 56 % à 24 % avec le petit modèle M9 (facteur ≈ 2,4) et de 66 % à 21 % avec Kiriku (facteur ≈ 3,1), sur des enregistrements mixtes **artificiels**. Rien de ceci ne démontre un support du wolof spontané, bruité, ni du changement de langue au milieu d'une phrase.

## Données

| Corpus | Contenu | Licence | Usage ici |
| --- | --- | --- | --- |
| ALFFA wolof (miroir Hugging Face `serge-wilson/wolof_speech_transcription`) | parole **lue**, wolof | MIT (getalp/ALFFA_PUBLIC, Gauthier et al., LREC 2016) ; le miroir ne déclare pas de licence propre | 250 clips : 150 `dev`, 100 `validation` |
| FLEURS (google/fleurs) | phrases **lues**, wolof, français, anglais, plusieurs locuteurs | CC BY 4.0 (Conneau et al., 2022) | wolof 72 `dev` + 48 `validation` ; français et anglais pareil |

Toutes les données sont dans `data/` (ignoré par Git). Aucun audio ni poids de modèle n'est dans le dépôt. Séparations : les modèles de reconnaissance (§1 et §2) sont mesurés sur `dev` (aucun n'a été réglé dessus par nous). Le détecteur de langue (§3) est entraîné sur `dev` et jugé sur `validation`. Le test de bout en bout (§4) n'utilise que des clips de `validation`, avec la version du détecteur qui ne les a jamais vus (`classifier-tiny-devonly.json`).

Limite générale : **toute la parole est lue**. Aucun enregistrement de réunion, aucun bruit de fond, aucune parole spontanée.

## 1. Whisper seul (tiny, base, small) ne convient pas au wolof

WER sur les 150 clips ALFFA `dev` (une valeur supérieure à 100 % est possible : insertions) :

| Modèle (faster-whisper, INT8, CPU) | WER |
| --- | --- |
| tiny | 104,5 % |
| base | 107,6 % |
| small | 140,4 % |

Sur FLEURS `dev`, `small` donne 99,1 % en wolof contre 12,4 % en français et 6,3 % en anglais. Whisper n'a pas de code de langue pour le wolof : son identification de langue range le wolof sous d'autres étiquettes (arabe, swahili, shona, français…), d'où le besoin d'un détecteur dédié (§3).

## 2. Modèles ajustés au wolof

Mesurés sur les clips wolof `dev`, convertis au format CTranslate2 INT8, CPU (Intel Core i5-1135G7, 4 threads). Le WER est le taux d'erreur de mots, plus bas = mieux.

| Modèle | Base | Licence | ALFFA (150) | FLEURS (72) | Temps réel (ALFFA / FLEURS) | Mémoire |
| --- | --- | --- | --- | --- | --- | --- |
| `M9and2M/whisper-small-wolof` | Whisper small | MIT | 18,8 % | 62,1 % | 2,5 / 0,6 | 0,6 Go |
| `AIHubSN/Kiriku-Wolof-ASR` | Whisper large-v2 | Apache-2.0, accès protégé | **8,1 %** | **37,5 %** | 5,9 / 1,6 | 2,2 Go |
| `AIHubSN/M-Kiriku-ASR` | Whisper large-v3 | Apache-2.0, accès protégé | non mesuré | 39,9 % | – / 1,7 | 4,1 Go |
| `asr-africa/wav2vec2-xls-r-wolof-…` (PyTorch, hors CTranslate2) | XLS-R | Apache-2.0 | 37,8 % | non mesuré | 0,5 | – |

Notes de lecture, toutes importantes :

- **Conversion.** La version PyTorch de M9 donne 18,9 % (ALFFA) et 58,8 % (FLEURS) : la conversion en CTranslate2 INT8 ne change pas sensiblement le résultat.
- **Écart ALFFA / FLEURS.** Chaque modèle fait beaucoup moins bien sur FLEURS que sur ALFFA (M9 : 18,8 % contre 62,1 %). Le résultat dépend fortement de la voix, du micro et du vocabulaire.
- **Contamination possible.** Je n'ai pas pu vérifier si ALFFA fait partie des données d'entraînement de M9 ou de Kiriku (la fiche de Kiriku cite `galsenai/wolof-audio-data`, 88,27 h). Les scores ALFFA sont à lire comme possiblement optimistes. FLEURS, plus éloigné, reste difficile même pour le meilleur modèle (37,5 %).
- **Chiffre du fournisseur.** La fiche de Kiriku annonce 20,70 % de WER sur son propre jeu de test : non reproduit ici, et sans lien démontré avec nos données.
- **Vitesse.** Le facteur temps réel de Kiriku-Wolof (5,9 sur ALFFA) signifie environ six secondes de calcul par seconde d'audio sur ce processeur. Il convient au traitement de fichiers en différé, pas au direct sans carte graphique.
- **M-Kiriku.** Sa mesure sur ALFFA a été interrompue volontairement : sur FLEURS il n'est pas meilleur que Kiriku-Wolof et demande presque deux fois plus de mémoire. Ce n'est pas une mesure complète.
- **Taux de « langue détectée »** affiché à 0 % dans les tableaux archivés : ces modèles n'ont pas d'étiquette « wo » dans Whisper, ce taux n'a pas de sens pour eux.
- L'accès aux deux modèles Kiriku exige un compte Hugging Face et l'acceptation du partage de ses coordonnées avec l'éditeur ; les poids ne sont donc pas redistribués avec ce dépôt.

## 3. Détecteur de langue par fenêtre

Un petit classifieur (régression logistique, numpy seul, environ trois cents coefficients en JSON) lit le vecteur de probabilités des 99 langues du modèle Whisper `tiny` sur une fenêtre de 3 s et répond « français, anglais ou wolof ». Il est entraîné sur les clips `dev` et jugé sur des clips `validation` jamais vus.

| Test | Fenêtres | Exactitude |
| --- | --- | --- |
| Validation, tous corpus | 472 | 96,8 % |
| Validation, ALFFA seul | 285 | 96,5 % |
| Validation, FLEURS seul | 187 | 97,3 % |
| Entraîné sur le wolof de FLEURS, testé sur le wolof d'ALFFA | 723 | 97,9 % |
| Entraîné sur le wolof d'ALFFA, testé sur le wolof de FLEURS | 105 | 90,5 % |

Limites : fenêtres de 3 s issues de parole lue ; des locuteurs peuvent se retrouver des deux côtés de la séparation dev/validation (le corpus ne fournit pas d'identifiant de locuteur fiable), ce qui peut gonfler ces scores ; seules trois langues sont connues du classifieur, une quatrième langue sera forcément rangée dans l'une d'elles.

## 4. Routage de bout en bout

Pour chaque enregistrement, 4 à 6 clips de validation (wolof, français, anglais, au hasard) sont collés avec de courtes pauses : les langues, frontières et textes exacts sont connus. Quatre systèmes traitent le même audio :

- **multilingue** : Whisper `small` seul, comme avant ;
- **wolof seul** : le modèle wolof seul ;
- **routé** : détection → découpe à chaque changement de langue → un moteur par passage → texte réassemblé dans l'ordre ;
- **oracle** : les mêmes moteurs avec les vraies frontières et les vraies langues (le meilleur que le routage pourrait donner avec un détecteur parfait).

| Exécution | Enregistrements | Multilingue | Wolof seul | **Routé** | Oracle |
| --- | --- | --- | --- | --- | --- |
| 1. M9, avant correction du seuil de silence | 10 | 55,8 % | 89,7 % | 47,0 % | 19,2 % |
| 2. M9, après correction | 10 | 56,0 % | 89,7 % | **23,6 %** | 19,2 % |
| 3. Kiriku-Wolof | 4 | 65,5 % | 59,4 % | **21,2 %** | 16,8 % |

(WER ; les exécutions 2 et 3 n'ont pas le même nombre d'enregistrements : ne pas les comparer entre elles.)

Détection, exécutions 2 et 3 :

| | Exécution 2 (M9) | Exécution 3 (Kiriku) |
| --- | --- | --- |
| Parole étiquetée dans la bonne langue | 96,0 % | 95,8 % |
| Changements de langue | 33 | 10 |
| Manqués ou placés à plus de 1,5 s | 6 | 2 |
| Erreur de frontière, médiane | 0,43 s | 0,37 s |
| Erreur de frontière, maximum | 4,2 s | 4,2 s |
| Frontières en trop | 10 | 4 |

Temps de traitement, exécution 3 (≈215 s d'audio) : multilingue 111 s, routé 443 s, oracle 409 s. Le routage coûte environ deux fois le temps réel avec Kiriku sur ce processeur.

### Un défaut trouvé et corrigé pendant ces mesures

La première exécution donnait 47 % : le détecteur était bon fenêtre par fenêtre, mais le découpage traitait comme du silence toute fenêtre de volume inférieur à 0,005, alors que ces corpus enregistrent l'anglais et le wolof environ 50 fois plus bas que le français (volume 0,001 à 0,002). La langue précédente se prolongeait sur la parole douce. Le seuil est maintenant proche du silence numérique (0,0005) et un test de non-régression le vérifie (il échoue avec l'ancien seuil). Conséquence pratique : **un seuil absolu ne distingue pas la parole douce du bruit de fond** ; avec du bruit réel, la détection des silences devra être revue.

### Vérification avec les vrais modèles via l'API

Un fichier mixte de 30 s (anglais, trois passages wolof, français) envoyé à l'API avec le moteur `language-routing` a donné un statut 200, aucun avertissement, 83 s de traitement, et un texte correctement ordonné et étiqueté sauf un cas : un passage wolof d'environ 2 s a été étiqueté « anglais », et le modèle multilingue a produit du texte en écriture devanagari (hallucination) au lieu de wolof. **Les passages très courts sont le point faible du routage** : la durée minimale d'un passage est de 2 s et la fenêtre de détection de 3 s.

## Ce qui n'est pas démontré

- Parole spontanée, bruit, plusieurs locuteurs simultanés, réunions : non testés.
- Changement de langue **à l'intérieur d'une phrase** : non mesuré. Le découpage travaille par fenêtres de 3 s avec un passage minimal de 2 s ; une alternance plus rapide ne sera pas suivie.
- Les mélanges de ces mesures sont des clips lus collés bout à bout : ils testent le mécanisme, pas la façon dont les gens alternent réellement.
- Petits échantillons (4 et 10 enregistrements ; 20 et 56 clips) : aucune conclusion statistique.
- Wolof sur d'autres voix, accents ou micros que ceux d'ALFFA et de FLEURS.
- Direct (streaming) : le routage n'y est pas disponible et n'a pas été testé.
- Les frontières sont ramenées à l'instant le plus silencieux dans ±0,6 s ; sans vraie pause à cet endroit, elles peuvent tomber à l'intérieur d'un mot. Mesuré seulement avec des pauses de 0,4 à 0,8 s entre clips.
- Le texte des passages est simplement joint par des espaces : majuscules et ponctuation ne sont pas réconciliées d'un passage à l'autre, et un mot coupé à une frontière n'est pas recollé.
- Les chemins configurés (modèle wolof, détecteur) ne sont contrôlés que par leur existence, pas par leur intégrité.
- Les tests automatiques du routage utilisent un détecteur et des moteurs factices (ils prouvent la logique, pas la qualité) ; les chiffres de ce document viennent des exécutions réelles listées plus haut.

## Reproduire

```powershell
# données (voir les en-têtes des scripts pour les sources et les droits)
python scripts/prepare_alffa_wolof.py ...      python scripts/prepare_fleurs.py ...
# détecteur
python scripts/extract_lid_features.py --manifest data/corpus/fleurs/manifest.csv --manifest data/corpus/alffa_wolof/manifest.csv --lid-model tiny --out data/lid/features-tiny.npz
python scripts/train_language_classifier.py --features data/lid/features-tiny.npz --out data/lid/classifier-tiny.json
# routage de bout en bout (classifier-tiny-devonly.json : le détecteur qui n'a pas vu la validation)
python scripts/eval_routing.py --manifest data/corpus/fleurs/manifest.csv --manifest data/corpus/alffa_wolof/manifest.csv `
  --classifier data/lid/classifier-tiny-devonly.json --wolof-model data/models/kiriku-wolof-ct2 --recordings 4 --out data/eval-results/routing/run.json
```

Environnement : exécuter avec `PYTHONPATH=services/transcription` et l'environnement Python du service (voir le README). La conversion d'un modèle Hugging Face vers CTranslate2 utilise `ct2-transformers-converter --quantization int8 --copy_files tokenizer.json preprocessor_config.json`, après avoir généré `tokenizer.json` avec `WhisperTokenizerFast.save_pretrained`.
