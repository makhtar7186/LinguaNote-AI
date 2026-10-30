# Comparaison initiale des moteurs ASR

## Décision de conception

Garder un contrat `SpeechEngine` indépendant du fournisseur. Utiliser faster-whisper `base` en CPU INT8 comme moteur de prototype Windows pour français/anglais ; le choix est provisoire et doit être mesuré sur le corpus du projet. Les poids ne sont pas inclus dans le dépôt. Leur téléchargement se déclenche uniquement après que l’utilisateur demande une transcription, jamais au démarrage.

## Mesures disponibles (voir [evaluation-results.md](evaluation-results.md))

Sur corpus synthétique FR/EN uniquement et sur le CPU de référence : `tiny` ≈ 0,2× le temps réel (278 Mio), `base` ≈ 0,4× (354 Mio), `small` ≈ 1,2–1,4× (724 Mio, plus lent que le temps réel). `base` reste le choix provisoire : marge d'environ 2× pour un traitement par blocs. `small` est écarté du direct sur cette machine tant qu'aucune optimisation n'est démontrée. Aucune mesure sur vraie parole, sur le wolof ou sur l'alternance de langues : le choix du moteur pour ces cas reste ouvert.

## Blocage Windows constaté

L’installation de l’extra `omnilingual-asr` a été tentée dans l’environnement Python 3.11 Windows du projet. La résolution s’arrête car `fairseq2n` ne dispose pas d’une distribution compatible pour cette plateforme depuis l’index utilisé. Les poids n’ont pas été téléchargés. Omnilingual reste un candidat de conception, mais ne peut pas servir de moteur testable dans cette installation sans résoudre le support Windows ou choisir un autre moteur.

## Candidats

| Candidat | Langues visées | Atouts | Contraintes à mesurer |
| --- | --- | --- | --- |
| faster-whisper, modèle `base` | Français et anglais | Installation Windows native ; exécution CPU INT8 | Poids à télécharger au premier usage ; wolof et code-switching non validés ; mesurer temps CPU et mémoire sur le i5-1135G7 |
| Meta Omnilingual ASR CTC 300M v2 | Français, anglais, wolof et autres langues listées | Modèle unique ; le dépôt publie un modèle CTC 300M à 1,3 Gio et environ 2 Gio de VRAM dans son tableau de référence ; licence annoncée Apache 2.0 pour code et modèles | Pipeline d’inférence limité à des extraits <40 s ; transcription sans ponctuation ni majuscules ; besoin CPU sur cette machine à mesurer ; intégration Windows/librairies à valider ; disponibilité des horodatages non établie par l’API de haut niveau |
| Modèle wolof séparé + moteur FR/EN | Chaque moteur pour son domaine | Peut donner une meilleure base au wolof monolingue | Routage fragile dans une phrase mixte, ruptures aux frontières, plusieurs poids et dépendances ; licences à contrôler modèle par modèle |

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
