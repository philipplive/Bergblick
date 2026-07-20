# Vendor-Bibliotheken (lokal, für den GLB-Export)

Diese Dateien werden beim **Web-Export** von `assets/js/app.js` dynamisch
importiert, um das GLB mit `EXT_meshopt_compression` zu komprimieren
(`compressGLB()`). Sie liegen bewusst lokal im Projekt, damit der Export
ohne Internetzugang und ohne Drittanbieter-CDN funktioniert.

## Dateien

- **`meshopt_encoder.js`** — unverändert aus dem npm-Paket `meshoptimizer@1.2.0`
  (`node_modules/meshoptimizer/meshopt_encoder.js`). Das WebAssembly des
  Encoders ist als base64 in der Datei eingebettet, es gibt also keine separate
  `.wasm`-Datei. Exportiert `MeshoptEncoder`.

- **`gltf-transform.js`** — ein mit esbuild erzeugtes, self-contained ESM-Bundle
  aus `@gltf-transform/core`, `/functions` und `/extensions` (jeweils 4.4.1).
  Exportiert `WebIO`, `meshopt`, `EXTMeshoptCompression`.

Der passende Decoder im exportierten Viewer (`assets/js/exporter.js`) kommt aus
dem three.js-Addon `three/addons/libs/meshopt_decoder.module.js` (dasselbe CDN,
von dem der Viewer three.js ohnehin lädt).

## Neu bauen (bei Versions-Update)

```sh
# in einem temporären Ordner:
npm install @gltf-transform/core@4.4.1 @gltf-transform/functions@4.4.1 \
            @gltf-transform/extensions@4.4.1 meshoptimizer@1.2.0 esbuild

# Encoder direkt übernehmen:
cp node_modules/meshoptimizer/meshopt_encoder.js <projekt>/public/assets/vendor/

# gltf-transform bündeln (Entry re-exportiert nur die 3 benötigten Symbole):
printf "export { WebIO } from '@gltf-transform/core';\n\
export { meshopt } from '@gltf-transform/functions';\n\
export { EXTMeshoptCompression } from '@gltf-transform/extensions';\n" > entry.mjs

npx esbuild entry.mjs --bundle --format=esm --platform=browser --target=es2020 \
  --external:meshoptimizer --external:node:fs --external:node:path \
  --outfile=<projekt>/public/assets/vendor/gltf-transform.js
```

`node:fs`/`node:path` sind als external markiert, weil sie nur im (im Browser
ungenutzten) `NodeIO`-Zweig vorkommen; `meshoptimizer` ist external, weil der
Encoder separat als eigene Datei ausgeliefert wird.
