# Comparaison initiale des moteurs ASR

## Décision de conception

Garder un contrat `SpeechEngine` indépendant du fournisseur. Utiliser faster-whisper `base` en CPU INT8 comme moteur de prototype Windows pour français/anglais ; le choix est provisoire et doit être mesuré sur le corpus du projet. Les poids ne sont pas inclus dans le dépôt. Leur téléchargement se déclenche uniquement après que l’utilisateur demande une transcription, jamais au démarrage.

## Mesures disponibles (voir [evaluation-results.md](evaluation-results.md))

Observations préliminaires, corpus synthétique FR/EN uniquement, CPU de référence, deux exécutions : facteur temps réel `tiny` 0,17–0,24 (pic processus 278 Mio), `base` 0,41–0,46 (≈ 353 Mio), `small` 1,24–2,52 (724 Mio). `base` reste le choix **provisoire** par défaut ; ce n'est pas une conclusion mesurée sur le direct, qui n'a pas été testé. `small` a été plus lent que le temps réel sur ces clips : il faudra le re-mesurer en traitement par blocs avant de l'écarter ou de le retenir. Ces mesures-là ne portent que sur du français et de l'anglais synthétiques. Pour le wolof, voir la section suivante et [evaluation-wolof.md](evaluation-wolof.md) ; l'alternance de langues au milieu d'une phrase reste non mesurée.

## Wolof : modèles et licences (mesures au 2026-11-01)

Whisper n'a pas de code de langue wolof et échoue sur cette langue (WER 100 % ou plus, [evaluation-wolof.md](evaluation-wolof.md)). Le moteur optionnel `language-routing` envoie donc les passages détectés comme wolof à un modèle ajusté au wolof et tout le reste au modèle multilingue. Il se règle par `LINGUANOTE_ROUTING_WOLOF_MODEL` (dossier CTranslate2 contenant `model.bin`), sans rien télécharger pour ce chemin.

| Modèle wolof | Licence | WER ALFFA / FLEURS | Vitesse (CPU) | Remarque |
| --- | --- | --- | --- | --- |
| `AIHubSN/Kiriku-Wolof-ASR` (Whisper large-v2) | Apache-2.0 | 8,1 % / 37,5 % | ≈ 6× plus lent que le temps réel | Meilleur mesuré. Accès protégé : compte Hugging Face et partage des coordonnées avec l'éditeur ; ne pas redistribuer les poids sans vérifier. Données d'entraînement non vérifiées (contamination ALFFA possible) |
| `M9and2M/whisper-small-wolof` (Whisper small) | MIT | 18,8 % / 62,1 % | ≈ 2,5× | Léger, bien plus faible hors de ses données |
| `AIHubSN/M-Kiriku-ASR` (large-v3) | Apache-2.0 | non mesuré / 39,9 % | ≈ 1,7× (FLEURS) | Pas meilleur que Kiriku-Wolof sur FLEURS, plus gourmand en mémoire ; non retenu |

Choix actuel : **Kiriku-Wolof-ASR pour les fichiers traités en différé**, M9 comme solution légère. Un modèle large n'est pas utilisable en direct sur ce processeur. Le choix reste provisoire : un corpus de parole spontanée et bruitée du projet est nécessaire avant de le figer.

Données utilisées pour mesurer et régler le détecteur de langue : ALFFA wolof (MIT, Gauthier et al., LREC 2016) et FLEURS (CC BY 4.0, Conneau et al., 2022) ; attribution à conserver si ces données ou le détecteur entraîné dessus sont diffusés. Le fichier du détecteur (`classifier-tiny.json`) est un dérivé de ces corpus : il ne contient que des coefficients numériques, aucun audio ni texte.

## Blocage Windows constaté

L’installation de l’extra `omnilingual-asr` a été tentée dans l’environnement Python 3.11 Windows du projet. La résolution s’arrête car `fairseq2n` ne dispose pas d’une distribution compatible pour cette plateforme depuis l’index utilisé. Les poids n’ont pas été téléchargés. Omnilingual reste un candidat de conception, mais ne peut pas servir de moteur testable dans cette installation sans résoudre le support Windows ou choisir un autre moteur.

## Candidats

| Candidat | Langues visées | Atouts | Contraintes à mesurer |
| --- | --- | --- | --- |
| faster-whisper, modèle `base` | Français et anglais | Installation Windows native ; exécution CPU INT8 | Poids à télécharger au premier usage ; wolof et code-switching non validés ; mesurer temps CPU et mémoire sur le i5-1135G7 |
| Meta Omnilingual ASR CTC 300M v2 | Français, anglais, wolof et autres langues listées | Modèle unique ; le dépôt publie un modèle CTC 300M à 1,3 Gio et environ 2 Gio de VRAM dans son tableau de référence ; licence annoncée Apache 2.0 pour code et modèles | Pipeline d’inférence limité à des extraits <40 s ; transcription sans ponctuation ni majuscules ; besoin CPU sur cette machine à mesurer ; intégration Windows/librairies à valider ; disponibilité des horodatages non établie par l’API de haut niveau |
| Modèle wolof séparé + moteur FR/EN (**implémenté**, moteur `language-routing`) | Chaque moteur pour son domaine | Mesuré : divise l'erreur par ≈ 3 sur des enregistrements mixtes lus (voir [evaluation-wolof.md](evaluation-wolof.md)) | Routage fragile dans une phrase mixte (non mesuré), ruptures aux frontières, passages courts mal étiquetés, plusieurs poids ; licences à contrôler modèle par modèle ; fichiers uniquement, pas de direct |

Les tailles et limites ci-dessus sont celles documentées par le dépôt Omnilingual ASR : [pipeline d’inférence](https://github.com/facebookresearch/omnilingual-asr/blob/main/src/omnilingual_asr/models/inference/README.md) et [tableau des modèles/licence](https://github.com/facebookresearch/omnilingual-asr/blob/main/README.md). Les résultats rapportés ne prédisent pas la performance sur LinguaNote AI.

## Plan de comparaison sur la machine de référence

1. Commencer avec des WAV courts, mono si possible, en gardant les originaux et les références.
2. Mesurer faster-whisper `base` sur les extraits français et anglais ; ne pas extrapoler son résultat au wolof.
3. Mesurer Omnilingual CTC 300M sur extraits de moins de 30 secondes pour FR, EN, wolof et code-switching ; noter qu’il ne fournit pas nécessairement des segments horodatés via son interface de haut niveau.
4. Comparer temps d’inférence, facteur temps réel, mémoire maximale, taille du cache, WER/CER et erreurs aux changements de langue.
5. N’ajouter un deuxième moteur que si les gains mesurés compensent la complexité de routage, d’installation et de maintenance.

## Conséquence produit

Le premier prototype doit pouvoir retourner un texte brut sans inventer des timestamps, une langue détectée ou une ponctuation que le moteur ne fournit pas. Si les horodatages sont requis dès la première démo, ils devront être pris en charge par un moteur qui les fournit réellement ou par un composant d’alignement évalué séparément. Le code-switching ne doit pas être présenté comme pris en charge avant une évaluation dédiée.

## Critères avant de figer le moteur

- Résultats comparatifs sur le même corpus et les mêmes conventions d’évaluation.
- Vérification des licences du code, du modèle et des données associées.
- Démarrage sans téléchargement implicite et indication claire du poids à obtenir.
- Exécution CPU documentée sur la machine de référence.
- Plan de compatibilité avec Windows et avec les futurs utilisateurs CPU uniquement.
- Décision explicite sur texte brut, segmentation et horodatage pour le prototype.
