# Protocole d’évaluation initial

## Objectif

Comparer des moteurs sur les mêmes extraits avant de retenir un modèle pour le prototype. Les résultats décrivent uniquement les voix, variantes linguistiques, conditions audio et conventions orthographiques effectivement testées. La présence d’une langue dans une fiche modèle ne suffit pas à déclarer sa transcription adéquate.

## Machine de référence

Les informations fournies pour la machine de développement sont : Intel Core i5-1135G7 (4 cœurs / 8 threads), 20 Go de RAM (19,7 Go utilisables), Intel Iris Xe intégré (128 Mo de mémoire graphique dédiée déclarée) et environ 0,72 To libres sur 1,82 To. Ces valeurs servent de profil local de test, pas de minimum système pour les futurs utilisateurs. L’Iris Xe n’offre pas l’environnement CUDA attendu par l’accélération NVIDIA de faster-whisper ; commencer les mesures en CPU, et noter l’usage mémoire système partagé si le GPU est exploré plus tard.

Mesurer les temps avec le même nombre de threads et sur fichiers comparables. Le disque disponible localement suffit pour des essais de modèles usuels, mais les poids ne doivent pas être poussés dans Git. Mesurer la taille téléchargée et l’espace de cache réel de chaque candidat. La compatibilité et les exigences minimales destinées aux utilisateurs devront être établies sur plusieurs profils de machines avant publication.

## Corpus pilote

Préparer un corpus de développement autorisé, séparé d’un petit corpus de validation gardé à part. Pour le premier essai technique, viser 5 à 10 extraits par catégorie : français seul, anglais seul, wolof seul et alternance de langues dans une même phrase. Ce corpus sert à trouver les défauts et à vérifier le pipeline, pas à revendiquer une performance générale. Avant toute affirmation de qualité, augmenter le corpus avec des locuteurs, accents et conditions d’enregistrement variés.

Chaque élément doit inclure l’audio original, une transcription de référence, les bornes temporelles approximatives des changements de langue, la langue dominante, le contexte d’enregistrement et les droits/autorisations. Anonymiser les noms et informations sensibles. Ne pas versionner d’audio privé dans Git.

## Préparation et conventions

Garder les originaux en lecture seule. Pour comparer les modèles, décoder à un format commun (mono, 16 kHz PCM) avec la même chaîne de prétraitement et consigner les versions d’outil. Éviter le débruitage ou le filtrage sélectif qui pourrait favoriser un moteur.

Fixer avant calcul une normalisation de référence : casse, ponctuation, espaces, nombres, contractions et variantes d’écriture wolof. Conserver aussi le texte brut. Les évaluateurs wolof doivent valider les formes de référence ; ne pas assimiler automatiquement une variante orthographique à une erreur sémantique.

### Conventions retenues (implémentées dans `app/evaluation/metrics.py`)

- Normalisation avant comparaison : Unicode NFC, minuscules, ponctuation supprimée, apostrophes unifiées (`’` → `'`), espaces réduits. **Les accents sont conservés** (pour ne pas masquer des erreurs françaises ni fusionner des orthographes wolof distinctes).
- **Nombres en chiffres dans les références** (« 8 heures », « 20 minutes »), car les moteurs testés écrivent en chiffres. Une différence de format (« 8h » contre « 8 heures ») reste comptée comme une erreur visible, pas corrigée en silence.
- Aucune équivalence orthographique wolof automatique : les variantes sont des erreurs jusqu'à décision d'un évaluateur wolophone.
- WER et CER agrégés par catégorie en **micro-moyenne** (total des erreurs / total des mots de référence), pas en moyenne de taux par clip. Le WER d'une référence vide est indéfini.
- Un clip qui échoue (conversion, moteur) est compté dans la colonne « échecs » et exclu des taux, jamais ignoré.

## Mise en œuvre

Le manifeste est un CSV (`id, audio_path, category, reference, split, synthetic, rights, speaker, context`), validé en entier avant tout calcul (catégorie, séparation `dev`/`validation`, droits renseignés, audio présent, silence sans référence). Les catégories sont `fr`, `en`, `wo`, `mixed`, `silence`. Les corpus et les résultats vivent dans `data/` (ignoré par Git) ; ne jamais y déposer d'audio sans l'autorisation des locuteurs. Commandes et premiers résultats : [evaluation-results.md](evaluation-results.md).

## Mesures à enregistrer

Pour chaque modèle, fichier et langue :

- WER et CER sur le texte normalisé, plus résultats par langue dans les extraits mixtes.
- Taux de mots omis, hallucinations dans les silences et erreurs de langue aux frontières de changement.
- Durée audio, durée d’inférence, facteur temps réel (`temps de calcul / durée audio`), mémoire maximale, matériel et mode CPU/GPU.
- Modèle exact, quantification, paramètres, version des bibliothèques et licence.

Publier des résultats par catégorie et des exemples d’erreurs typiques, pas uniquement une moyenne globale. Pour un échantillon pilote aussi petit, afficher le nombre d’extraits avec chaque score.

## Comparaisons et décision

1. Établir un résultat de référence pour chaque candidat sur français, anglais et wolof monolingues.
2. Tester ensuite les extraits mixtes sans langue imposée si possible.
3. Comparer, sur les mêmes fichiers mixtes, la transcription multilingue entière avec un routage expérimental par régions détectées. Compter les mots perdus/dupliqués autour des frontières.
4. Vérifier séparément licence, poids, dépendances, taille disque et mémoire avant de retenir un moteur. Les poids ne sont téléchargés qu’après accord sur le candidat et contrôle des ressources machine.

Le premier prototype ne sera déclaré fonctionnel que pour les scénarios effectivement mesurés. Les seuils d’acceptation qualité et de temps de traitement restent à convenir avec le produit après examen des premiers résultats ; ne pas inventer de seuil universel pour le wolof.

## Modèle de compte rendu

| Champ | Valeur |
| --- | --- |
| Date et machine | À renseigner |
| Moteur / modèle / quantification | À renseigner |
| Licence et URL de la fiche | À renseigner |
| Catégorie / nombre d’extraits | À renseigner |
| WER / CER | À renseigner |
| Temps médian / facteur temps réel | À renseigner |
| Pic mémoire / périphérique | À renseigner |
| Erreurs notables et limites | À renseigner |

