# Révélateur Photo

Logiciel Windows de développement photo, pensé pour les photos de smartphone prises avec peu de lumière. Il éclaircit, débruite et corrige les couleurs automatiquement, avec des préréglages pro, un historique complet et le traitement par lot. Tout le traitement est local : les photos ne quittent pas l'ordinateur.

## Télécharger

**[Télécharger l'installateur Windows](https://github.com/Jepht3/revelateur-photo/releases/latest)** : fichier `Revelateur-Photo-Setup-x.y.z.exe` dans la dernière Release.

L'installateur n'est pas signé numériquement. Windows SmartScreen peut afficher « Windows a protégé votre ordinateur » : cliquez sur « Informations complémentaires » puis « Exécuter quand même ».

## Fonctions

- **Amélioration auto à l'ouverture** : mesure la luminosité, la dominante de couleur et le niveau de bruit de chaque photo, puis règle l'éclaircissement, l'exposition, le débruitage et la netteté.
- **Basse lumière** : l'éclaircissement intelligent relève les zones sombres selon leur voisinage, sans brûler le ciel ni les lampes. La réduction du bruit traite séparément le grain (luminance) et les taches colorées (chrominance).
- **47 préréglages pro** en 10 catégories : Essentiels, Smartphone & basse lumière, Portrait, Mariage, Paysage, Commercial, Urbain & nuit, Cinéma, Argentique, Noir & blanc. Ils s'adaptent à chaque photo. Survolez-en un pour voir le résultat avant de cliquer.
- **Mes préréglages** : enregistrez vos réglages, puis importez-les ou exportez-les en fichier `.json`.
- **Historique** de chaque étape (Ctrl+Z / Ctrl+Y, ou un clic sur une étape) et **instantanés** nommés. Les retouches, l'historique, les notes et les instantanés sont mémorisés : rouvrir une photo les restaure.
- **Réglages complets** : lumière, couleur, texture, clarté, voile, courbe des tonalités (RVB et par canal), mixeur TSL sur 8 couleurs, étalonnage, netteté, vignetage, grain.
- **Géométrie** : recadrage avec formats (1:1, 4:5 Instagram, 9:16 story…), rotation, miroir, redressement.
- **Traitement par lot** : photos ouvertes (filtrables par note) ou dossier entier, avec sous-dossiers en option. Choix des réglages, du format JPEG/PNG/WebP, de la taille, du nom des fichiers (`{nom}`, `{n}`, `{date}`) et d'un filigrane. Traitement en parallèle avec progression et bouton d'arrêt.
- **Tri** : notes de 0 à 5 étoiles, filtre de la pellicule, synchronisation et copier/coller des réglages.
- **Affichage** : avant/après côte à côte (Y), original maintenu (\\), alerte d'écrêtage (J), zoom à la molette. Touche F1 pour tous les raccourcis.

Formats acceptés : JPEG, PNG, WebP, AVIF, BMP. Les fichiers RAW et HEIC doivent d'abord être convertis en JPEG.

## Développement

```
npm install
npm start
```

Compiler l'installateur localement : `npm run dist` (résultat dans `dist/`). Sous Windows, placez le projet dans un chemin court (par exemple `C:\dev\revelateur-photo`), car NSIS ne gère pas les chemins de plus de 260 caractères.

## Publier une nouvelle version

1. Changez `version` dans `package.json`.
2. Créez et poussez le tag correspondant :
   ```
   git tag v1.1.0
   git push origin v1.1.0
   ```
3. GitHub Actions compile l'installateur et le publie dans la Release `v1.1.0`.

## Structure

- `src/main.js` : processus principal Electron (fenêtre, menus, fichiers, stockage).
- `src/preload.js` : pont sécurisé entre l'interface et le système.
- `src/renderer/engine.js` : moteur de traitement d'image (partagé entre l'interface et les workers).
- `src/renderer/worker.js` : calculs d'aperçu et d'export hors du fil de l'interface.
- `src/renderer/app.js`, `index.html`, `styles.css` : interface.
- `web/index.html` : première version, autonome, à ouvrir dans un navigateur.
