# Revue du plan — LinguaNote AI

Cette revue s’appuie sur la conception et le protocole d’évaluation dans `docs/`, ainsi que sur l’état du prototype décrit par `README.md` (client Electron, import média et capture microphone déjà présents). Le dépôt ne contenait pas de `PLAN.md` : ce fichier consigne les remarques de revue, sans réécrire le plan d’architecture.

## Revue Codex

### Priorités et séquencement

- **Le séquencement du plan est dépassé par le prototype.** L’architecture initiale traite Electron, le microphone et la persistance comme des jalons ultérieurs, alors qu’un client Electron, l’import audio/vidéo et l’enregistrement micro existent déjà. Rebaser la feuille de route sur l’état réel, distinguer ce qui est implémenté, validé et seulement esquissé, puis éviter de refaire ces étapes.
- **La validation du produit doit précéder l’élargissement des fonctionnalités.** Le README indique que faster-whisper `base` vise FR/EN, tandis que Wolof et code-switching restent à évaluer. Faire du corpus autorisé, des mesures reproductibles et des seuils d’acceptation par scénario le prochain jalon de décision. Ne pas présenter les trois langues ou le temps réel comme capacités acquises avant ces résultats.
- **Le flux fichier actuel est fortement borné** (50 Mio et moins de 39 secondes d’audio selon le README). Le plan devrait décider explicitement si ces limites sont temporaires et préciser les scénarios visés avant de prioriser historique, insertion de texte ou résumés.
- **La persistance est absente de la première conception mais figure parmi les objectifs produit.** Décider tôt si les premières transcriptions doivent être conservées. Si oui, spécifier avant implémentation l’emplacement local, le chiffrement éventuel, la durée de rétention, l’effacement et les migrations/sauvegardes SQLite. Ne pas ajouter une base sans politique de cycle de vie des données.
- **Les seuils restent ouverts.** Le protocole propose des métriques, mais aucun seuil de qualité, de latence ou de ressources n’autorise une décision de lancement. Après le pilote, fixer des critères par langue et par scénario, avec un corpus de validation tenu à part, plutôt qu’une moyenne globale masquant les échecs wolof ou mixtes.

### Sécurité et confidentialité

- **Loopback et CORS ne constituent pas une authentification.** `127.0.0.1` limite l’exposition réseau, mais n’empêche pas à lui seul les appels de processus locaux ou certains scénarios de requêtes initiées depuis un navigateur. Pour le client Electron, préférer IPC étroit ou un canal local authentifié par un secret éphémère; si HTTP reste accessible, valider l’origine et les en-têtes, limiter CORS aux origines nécessaires et ajouter une protection contre les requêtes intersites. Ne pas considérer une origine autorisée comme une preuve d’identité.
- **Le traitement de médias nécessite des limites de ressources en plus de la taille du fichier.** Fixer durée et taille après décodage, délais d’exécution FFmpeg et d’inférence, quotas temporaires, nettoyage garanti à l’annulation/erreur, et comportement de concurrence. Traiter les extensions et le type MIME déclarés comme non fiables; vérifier le décodage réel et éviter toute écriture basée sur un chemin fourni par le client.
- **Les téléchargements de modèles sont un flux de confiance distinct.** Documenter l’hôte source, la licence exacte du code et des poids, le cache, l’espace requis, la vérification d’intégrité si disponible, l’absence de téléchargement silencieux et le comportement hors ligne/échec. Le démarrage du serveur ne doit pas déclencher une récupération de poids.
- **La capture microphone et l’insertion externe ont besoin de garde-fous produit explicites.** Définir indicateur visible, arrêt immédiat, permissions et erreurs de périphérique; distinguer microphone, audio système et fichiers sans bascule silencieuse. Pour l’insertion, traiter focus et presse-papiers comme des opérations à risque de perte de données : annoncer l’action, préserver/restaurer le presse-papiers et signaler les échecs.
- **La rétention est un risque aussi important que la transmission.** Compléter les règles de confidentialité par la durée de conservation par défaut, l’effacement vérifiable des transcriptions/fichiers temporaires, l’absence de contenu dans les journaux/crash reports et le comportement en cas de fermeture forcée.

### Fiabilité et décisions techniques manquantes

- **Le plan live ne définit pas encore un protocole suffisamment résilient.** Avant d’implémenter le WebSocket, préciser identifiants de session et de séquence, accusés de réception/rejeu ou règle de perte, déduplication, ordre, reprise après reconnexion, fin de session, annulation, heartbeat et limites de buffer/backpressure. Sans ces règles, une reconnexion peut perdre ou répéter du texte.
- **Le plan audio doit préciser les invariants temporels.** Définir format/horloge canonique, propagation des timestamps après conversion, segmentation des longs fichiers, stratégie déterministe de fusion des fenêtres chevauchantes, distinction partiel/final, et tests aux frontières. La limite actuelle de moins de 39 secondes ne valide pas encore le traitement fiable de longs enregistrements.
- **Les capacités et métadonnées ASR doivent rester honnêtes.** Tous les moteurs ne fournissent pas langue, confiance ou timestamps comparables. Conserver moteur/version/paramètres, représenter les champs inconnus comme absents, et ne pas afficher un score comme probabilité calibrée. Les résultats sans horodatage doivent rester sans horodatage fabriqué.
- **L’exécution locale et le packaging sont des risques de livraison.** Le plan parle de plusieurs plateformes, mais l’état documenté et l’environnement testé sont Windows. Cibler explicitement Windows d’abord; vérifier sur installation propre le démarrage/arrêt du backend enfant, les ports en conflit, dépendances natives, FFmpeg, poids hors ligne, mises à jour et désinstallation avant de promettre d’autres systèmes.
- **Observabilité sans contenu sensible à définir.** Prévoir des journaux structurés avec identifiants de requête, étapes, durées et codes d’erreur, mais sans audio, texte transcrit, secrets ou chemins personnels. Ajouter des diagnostics exportables seulement après revue de ce qu’ils contiennent.

### Ordre de travail recommandé

1. Mettre à jour le plan selon le prototype réel et nommer les critères de sortie de chaque jalon.
2. Verrouiller corpus, droits, conventions d’annotation et protocole; mesurer FR, EN, wolof et mélange sur la machine cible, puis décider du moteur et des limites produit.
3. Fermer les risques du flux fichier (validation après décodage, plafonds temps/ressources, nettoyage, erreurs et limites concurrentes) et documenter le téléchargement des modèles.
4. Définir puis tester le contrat de sessions live et la réconciliation des segments avant de bâtir des fonctionnalités de productivité autour de ce flux.
5. Stabiliser sécurité/packaging Windows, puis ajouter persistance avec politique de rétention et de suppression explicite.
6. Étendre aux autres plateformes, à la capture audio système, à l’insertion, puis aux résumés/diarisation seulement après validation qualité et fiabilité des étapes précédentes.

