import { PCF_POISSON_BRANCH } from './terrain.js';

/**
 * Erzeugt ein wasserdichtes Binär-STL (Z nach oben, Millimeter):
 * Geländeoberfläche + Seitenwände entlang des Rands + Boden als Fächer.
 * Funktioniert für alle konvexen Grundformen (Rechteck, Kreis, Sechseck).
 *
 * @param mesh    Geländenetz aus mesh.js
 * @param options { exaggeration, basePercent, modelWidthMM }
 * @returns ArrayBuffer
 */
export function buildBinarySTL(mesh, { exaggeration, basePercent, modelWidthMM }) {
    const { positionsXY, heights, indices, boundary, widthMeters } = mesh;

    const scale = modelWidthMM / widthMeters; // mm pro Meter
    const baseMM = (basePercent / 100) * 0.25 * modelWidthMM;

    let minH = Infinity;
    for (const h of heights) if (h < minH) minH = h;

    // Vertexkoordinaten in mm vorberechnen (x = Ost, y = Nord, z = Höhe)
    const n = heights.length;
    const vx = new Float32Array(n);
    const vy = new Float32Array(n);
    const vz = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        vx[i] = positionsXY[i * 2] * scale;
        vy[i] = positionsXY[i * 2 + 1] * scale;
        vz[i] = (heights[i] - minH) * scale * exaggeration + baseMM;
    }

    const topTriangles = indices.length / 3;
    const wallTriangles = 2 * boundary.length;
    const bottomTriangles = boundary.length;
    const total = topTriangles + wallTriangles + bottomTriangles;

    const buffer = new ArrayBuffer(84 + total * 50);
    const view = new DataView(buffer);
    new Uint8Array(buffer, 0, 80).set(new TextEncoder().encode('berglick terrain export'));
    view.setUint32(80, total, true);

    let offset = 84;
    const tri = (ax, ay, az, bx, by, bz, cx, cy, cz) => {
        // Normale aus dem Kreuzprodukt (B-A) × (C-A)
        const ux = bx - ax, uy = by - ay, uz = bz - az;
        const wx = cx - ax, wy = cy - ay, wz = cz - az;
        let nx = uy * wz - uz * wy;
        let ny = uz * wx - ux * wz;
        let nz = ux * wy - uy * wx;
        const len = Math.hypot(nx, ny, nz) || 1;
        nx /= len; ny /= len; nz /= len;
        for (const v of [nx, ny, nz, ax, ay, az, bx, by, bz, cx, cy, cz]) {
            view.setFloat32(offset, v, true);
            offset += 4;
        }
        view.setUint16(offset, 0, true);
        offset += 2;
    };

    // Oberfläche (Dreiecke sind im Netz bereits gegen den Uhrzeigersinn von oben)
    for (let t = 0; t < indices.length; t += 3) {
        const a = indices[t], b = indices[t + 1], c = indices[t + 2];
        tri(vx[a], vy[a], vz[a], vx[b], vy[b], vz[b], vx[c], vy[c], vz[c]);
    }

    // Wände: Randumlauf gegen den Uhrzeigersinn → Normalen zeigen nach aussen
    for (let i = 0; i < boundary.length; i++) {
        const a = boundary[i];
        const b = boundary[(i + 1) % boundary.length];
        tri(vx[a], vy[a], vz[a], vx[a], vy[a], 0, vx[b], vy[b], 0);
        tri(vx[a], vy[a], vz[a], vx[b], vy[b], 0, vx[b], vy[b], vz[b]);
    }

    // Boden als Fächer um den Mittelpunkt (Normale nach unten)
    for (let i = 0; i < boundary.length; i++) {
        const a = boundary[i];
        const b = boundary[(i + 1) % boundary.length];
        tri(0, 0, 0, vx[b], vy[b], 0, vx[a], vy[a], 0);
    }

    return buffer;
}

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(data) {
    let crc = 0xffffffff;
    for (let i = 0; i < data.length; i++) {
        crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Baut ein unkomprimiertes ZIP (STORE) aus { name, data: Uint8Array }-Einträgen —
 * die grossen Inhalte (JPEG, GLB) sind ohnehin schon komprimiert.
 */
export function buildZip(files) {
    const encoder = new TextEncoder();
    const parts = [];
    const centralParts = [];
    let offset = 0;
    const dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1; // fixes Datum, irrelevant

    for (const file of files) {
        const nameBytes = encoder.encode(file.name);
        const crc = crc32(file.data);

        const local = new DataView(new ArrayBuffer(30));
        local.setUint32(0, 0x04034b50, true);
        local.setUint16(4, 20, true);
        local.setUint16(12, dosDate, true);
        local.setUint32(14, crc, true);
        local.setUint32(18, file.data.length, true);
        local.setUint32(22, file.data.length, true);
        local.setUint16(26, nameBytes.length, true);
        parts.push(new Uint8Array(local.buffer), nameBytes, file.data);

        const central = new DataView(new ArrayBuffer(46));
        central.setUint32(0, 0x02014b50, true);
        central.setUint16(4, 20, true);
        central.setUint16(6, 20, true);
        central.setUint16(14, dosDate, true);
        central.setUint32(16, crc, true);
        central.setUint32(20, file.data.length, true);
        central.setUint32(24, file.data.length, true);
        central.setUint16(28, nameBytes.length, true);
        central.setUint32(42, offset, true);
        centralParts.push(new Uint8Array(central.buffer), nameBytes);

        offset += 30 + nameBytes.length + file.data.length;
    }

    const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true);
    eocd.setUint16(8, files.length, true);
    eocd.setUint16(10, files.length, true);
    eocd.setUint32(12, centralSize, true);
    eocd.setUint32(16, offset, true);

    const allParts = [...parts, ...centralParts, new Uint8Array(eocd.buffer)];
    const zip = new Uint8Array(allParts.reduce((sum, part) => sum + part.length, 0));
    let position = 0;
    for (const part of allParts) {
        zip.set(part, position);
        position += part.length;
    }
    return zip;
}

/**
 * Erzeugt die Viewer-HTML-Datei für den Web-Export. Die Datei ist statisch —
 * die gesamte Konfiguration (Licht, Schatten, Wolken, Ortstafeln, Dateinamen)
 * liest der Viewer zur Laufzeit aus projekt.json, die zusammen mit Modell
 * und Texturen im selben Ordner liegt.
 */
export function buildWebViewerHTML() {
    return `<!DOCTYPE html>
<!--
  Interaktive 3D-Karte — erstellt mit dem Berglick Map-Generator.

  WICHTIG: Alle Dateien aus dem ZIP (diese HTML-Datei, projekt.json, das
  Modell *.glb und die Textur-Dateien) gehören zusammen in denselben Ordner
  auf dem Webserver. Der Viewer liest seine gesamte Konfiguration aus
  projekt.json; ein Öffnen direkt aus dem Dateisystem (file://) funktioniert
  nicht — es braucht einen Webserver.

  Die projekt.json lässt sich im Berglick Map-Generator über "Projekt importieren"
  wieder laden, um das Projekt weiterzubearbeiten. Direkt in der projekt.json
  editierbar (ohne Neu-Export): Hintergrundfarbe (viewer.backdrop), Marker-
  und Wegfarben (markers[].color / paths[].color), Wolken (viewer.clouds),
  Nebelschwaden (viewer.fogDensity / viewer.fogSize), Licht und Schatten (viewer.sunPosition /
  shadowRadius / shadowIntensity).

  Einbindung auf einer Website:
    <iframe id="karte" src="terrain-3d.html" width="800" height="600" style="border:0"></iframe>

  Bei aktivierter Option "Transparenter Hintergrund" ist die Seite durchsichtig
  und die einbettende Website scheint durch den iframe hindurch:
    <iframe id="karte" src="terrain-3d.html" width="800" height="600"
            style="border:0; background: transparent" allowtransparency="true"></iframe>

  Schnittstelle: einzelne Marker/Wege/Ortstafeln per JavaScript ein- und
  ausblenden. Die Namen lauten "marker-<Nr>", "weg-<Nr>" und "tafel-<Nr>"
  (Nummern wie in der App).

  Von der einbettenden Seite aus (funktioniert auch cross-origin):
    const karte = document.getElementById('karte');
    karte.contentWindow.postMessage({ type: 'overlay-visibility', name: 'weg-1', visible: false }, '*');
    karte.contentWindow.postMessage({ type: 'overlay-toggle', name: 'marker-2' }, '*');

    // Verfügbare Namen abfragen:
    window.addEventListener('message', (e) => {
        if (e.data && e.data.type === 'overlay-list') console.log(e.data.names);
    });
    karte.contentWindow.postMessage({ type: 'overlay-list' }, '*');

  Bei gleicher Herkunft (same-origin) auch direkt:
    karte.contentWindow.terrainViewer.setVisible('weg-1', false);
    karte.contentWindow.terrainViewer.toggle('marker-2');
    karte.contentWindow.terrainViewer.getVisible('weg-1');  // true | false | null
    karte.contentWindow.terrainViewer.list();

  Wolken steuern (alle Felder optional: count, speed, size, opacity, color, rain, lightning):
    karte.contentWindow.postMessage({ type: 'clouds', count: 10, speed: 80, size: 150, opacity: 60, rain: 40 }, '*');
    karte.contentWindow.postMessage({ type: 'clouds', count: 0 }, '*'); // Wolken aus
    karte.contentWindow.postMessage({ type: 'clouds', color: '#cbd5e1' }, '*'); // Wolkenfarbe (z. B. graue Regenwolken)
    karte.contentWindow.postMessage({ type: 'clouds', rain: 0 }, '*');  // Regen aus
    karte.contentWindow.postMessage({ type: 'clouds', lightning: 60 }, '*'); // Gewitter an

  Bei gleicher Herkunft auch direkt:
    karte.contentWindow.terrainViewer.setClouds({ opacity: 50 });
    karte.contentWindow.terrainViewer.getClouds(); // { count, speed, size, opacity, color, rain, lightning }

  Nebelschwaden steuern (density: 0–100, size: Grösse in Prozent):
    karte.contentWindow.postMessage({ type: 'fog', density: 60 }, '*');
    karte.contentWindow.postMessage({ type: 'fog', density: 0 }, '*'); // Nebel aus
    karte.contentWindow.postMessage({ type: 'fog', size: 150 }, '*');  // grössere Schwaden

  Bei gleicher Herkunft auch direkt:
    karte.contentWindow.terrainViewer.setFog({ density: 60, size: 150 });
    karte.contentWindow.terrainViewer.getFog(); // { density, size }

  Schneefall steuern (snow: 0–100, size: Flockengrösse in %):
    karte.contentWindow.postMessage({ type: 'snow', snow: 70 }, '*');
    karte.contentWindow.postMessage({ type: 'snow', snow: 70, size: 150 }, '*');
    karte.contentWindow.postMessage({ type: 'snow', snow: 0 }, '*'); // Schnee aus

  Bei gleicher Herkunft auch direkt:
    karte.contentWindow.terrainViewer.setSnow(70);      // oder { snow: 70, size: 150 }
    karte.contentWindow.terrainViewer.getSnow();        // { snow, size }
-->
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>3D-Karte</title>
<style>
/* Hintergrund bleibt transparent, bis die Config geladen ist und ihn setzt */
html, body { margin: 0; height: 100%; overflow: hidden; background: transparent; }
canvas { width: 100%; height: 100%; display: block; touch-action: none; }
#lader {
    position: fixed; inset: 0; z-index: 10;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 14px; background: transparent; color: rgba(128,128,128,0.9);
    font: 14px system-ui, sans-serif;
    transition: opacity 0.5s ease;
}
#lader.fertig { opacity: 0; pointer-events: none; }
#lader .spinner {
    width: 42px; height: 42px; border-radius: 50%;
    border: 3px solid rgba(128,128,128,0.25);
    border-top-color: rgba(128,128,128,0.8);
    animation: drehen 0.9s linear infinite;
}
#lader.hell { color: rgba(0,0,0,0.65); }
#lader.hell .spinner {
    border-color: rgba(0,0,0,0.15);
    border-top-color: rgba(0,0,0,0.6);
}
#lader.dunkel { color: rgba(255,255,255,0.75); }
#lader.dunkel .spinner {
    border-color: rgba(255,255,255,0.2);
    border-top-color: rgba(255,255,255,0.85);
}
@keyframes drehen { to { transform: rotate(360deg); } }
</style>
<script type="importmap">
{ "imports": {
    "three": "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js",
    "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/"
} }
</${'script'}>
</head>
<body>
<canvas id="viewer"></canvas>
<div id="lader">
    <div class="spinner"></div>
    <div class="text">3D-Karte wird geladen …</div>
</div>
<script type="module">
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

// Weicher PCF-Schatten: Poisson-Disk-Kernel statt des stufigen Rasterkernels
const PCF_BRANCH = ${JSON.stringify(PCF_POISSON_BRANCH)};
{
    const chunk = THREE.ShaderChunk.shadowmap_pars_fragment;
    const pcfStart = chunk.indexOf('#if defined( SHADOWMAP_TYPE_PCF )');
    const pcfEnd = chunk.indexOf('#elif defined( SHADOWMAP_TYPE_PCF_SOFT )');
    if (pcfStart !== -1 && pcfEnd !== -1 && pcfEnd > pcfStart) {
        THREE.ShaderChunk.shadowmap_pars_fragment =
            chunk.slice(0, pcfStart) + PCF_BRANCH + chunk.slice(pcfEnd);
    }
}

const lader = document.getElementById('lader');
function laderFehler(text) {
    lader.querySelector('.spinner').style.display = 'none';
    lader.querySelector('.text').textContent = text;
}

// Gesamte Konfiguration aus projekt.json (liegt im selben Ordner)
let PROJEKT;
try {
    PROJEKT = await (await fetch('projekt.json')).json();
} catch (fehler) {
    laderFehler('Fehler: projekt.json konnte nicht geladen werden.');
    throw fehler;
}
const CONFIG = PROJEKT.viewer;
if (!CONFIG) {
    laderFehler('Fehler: projekt.json enthält keine Viewer-Konfiguration.');
    throw new Error('projekt.json enthält keine Viewer-Konfiguration');
}

const TRANSPARENT = CONFIG.transparentBackground === true;

// Lade-Overlay: verschwindet, sobald Modell und alle Texturen da sind.
// Der Hintergrund bleibt bis hierher transparent — erst die geladene Config
// setzt die Backdrop-Farbe (bei transparentem Hintergrund gar keine).
if (!TRANSPARENT) {
    lader.style.background = CONFIG.backdrop;
    const hex = String(CONFIG.backdrop).replace('#', '');
    const brightness = parseInt(hex.slice(0, 2), 16) * 0.299
        + parseInt(hex.slice(2, 4), 16) * 0.587
        + parseInt(hex.slice(4, 6), 16) * 0.114;
    lader.classList.add(brightness > 140 ? 'hell' : 'dunkel');
}
let ladeSchritte = 1 // Modell (GLB)
    + (CONFIG.terrainTexture ? 1 : 0)
    + (CONFIG.skirtTexture ? 1 : 0)
    + (CONFIG.backgroundImage ? 1 : 0);
function ladeFertig() {
    ladeSchritte--;
    if (ladeSchritte > 0) return;
    lader.classList.add('fertig');
    setTimeout(() => lader.remove(), 600);
}

const GLB_FILE = CONFIG.glb;
const TERRAIN_TEXTURE = CONFIG.terrainTexture; // null = keine (Höhenfarben)
const SOCKEL_TEXTURE = CONFIG.skirtTexture;    // null = einfarbiger Sockel
document.documentElement.style.background = TRANSPARENT ? 'transparent' : CONFIG.backdrop;
document.body.style.background = TRANSPARENT ? 'transparent' : CONFIG.backdrop;

const canvas = document.getElementById('viewer');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap; // vereinigt überlappende Schatten korrekt
// AgX Tone Mapping wie im Editor (Belichtung aus der Konfiguration)
renderer.toneMapping = THREE.AgXToneMapping;
renderer.toneMappingExposure = CONFIG.exposure ?? 1;

const scene = new THREE.Scene();
// Environment-Map wie im Editor: weiche indirekte Beleuchtung für alle PBR-
// Materialien. Intensität kommt aus der Konfiguration (Regler im Editor),
// Fallback 0.35 für ältere Exporte ohne den Wert.
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = CONFIG.envIntensity ?? 0.35;
pmrem.dispose();
if (TRANSPARENT) {
    renderer.setClearAlpha(0); // Hintergrund bleibt durchsichtig (iframe!)
} else {
    scene.background = new THREE.Color(CONFIG.backdrop);
}
const BACKGROUND_IMAGE = TRANSPARENT ? null : CONFIG.backgroundImage;
let backgroundTexture = null;
// Hintergrundbild wie CSS "cover": füllen und beschneiden statt verzerren
function updateBackgroundCover() {
    if (!backgroundTexture || !backgroundTexture.image) return;
    const canvasAspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
    const imageAspect = backgroundTexture.image.width / backgroundTexture.image.height;
    if (imageAspect > canvasAspect) {
        const repeat = canvasAspect / imageAspect;
        backgroundTexture.repeat.set(repeat, 1);
        backgroundTexture.offset.set((1 - repeat) / 2, 0);
    } else {
        const repeat = imageAspect / canvasAspect;
        backgroundTexture.repeat.set(1, repeat);
        backgroundTexture.offset.set(0, (1 - repeat) / 2);
    }
}
if (BACKGROUND_IMAGE) {
    new THREE.TextureLoader().load(BACKGROUND_IMAGE, (texture) => {
        texture.colorSpace = THREE.SRGBColorSpace;
        backgroundTexture = texture;
        scene.background = texture;
        updateBackgroundCover();
        ladeFertig();
    }, undefined, ladeFertig);
}

// Isometrisch = orthografische Kamera (Sichtfeld wird nach dem Laden eingepasst)
const camera = CONFIG.isometric
    ? new THREE.OrthographicCamera(-100, 100, 100, -100, 1, 6000)
    : new THREE.PerspectiveCamera(50, 2, 0.1, 5000);
let orthoFit = 200;
function applyOrthoFrustum() {
    if (!camera.isOrthographicCamera) return;
    const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
    camera.top = orthoFit / 2;
    camera.bottom = -orthoFit / 2;
    camera.left = (-orthoFit * aspect) / 2;
    camera.right = (orthoFit * aspect) / 2;
    camera.updateProjectionMatrix();
}
scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x54492e, 1.1));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(CONFIG.sunPosition[0], CONFIG.sunPosition[1], CONFIG.sunPosition[2]);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
sun.shadow.bias = -0.0002;
sun.shadow.normalBias = 0.5;
sun.shadow.radius = CONFIG.shadowRadius;
sun.shadow.intensity = CONFIG.shadowIntensity;
scene.add(sun);

// Untergrund + Schattenfänger (Schlagschatten des Modells), wie in der App
if (CONFIG.groundVisible) {
    scene.fog = new THREE.Fog(CONFIG.backdrop, 400, 900);
    const groundGeometry = new THREE.PlaneGeometry(4000, 4000).rotateX(-Math.PI / 2);
    // Radialer Alphaverlauf: Platte fadet gegen aussen weich aus (wie in der App)
    const fadeCanvas = document.createElement('canvas');
    fadeCanvas.width = 512;
    fadeCanvas.height = 512;
    const fadeCtx = fadeCanvas.getContext('2d');
    const fadeGradient = fadeCtx.createRadialGradient(256, 256, 0, 256, 256, 256);
    fadeGradient.addColorStop(0.0, '#ffffff');
    fadeGradient.addColorStop(0.12, '#ffffff');
    fadeGradient.addColorStop(0.42, '#000000');
    fadeGradient.addColorStop(1.0, '#000000');
    fadeCtx.fillStyle = fadeGradient;
    fadeCtx.fillRect(0, 0, 512, 512);
    const ground = new THREE.Mesh(
        groundGeometry,
        new THREE.MeshBasicMaterial({
            color: CONFIG.backdrop,
            alphaMap: new THREE.CanvasTexture(fadeCanvas),
            transparent: true,
            depthWrite: false,
        })
    );
    ground.position.y = -0.6;
    // Immer als Erstes unter den transparenten Objekten zeichnen: three.js
    // sortiert Transparentes nach Objektursprung, wodurch die riesige Platte
    // je nach Blickwinkel sonst ÜBER die Tafel-Sprites gemalt würde
    ground.renderOrder = -2;
    scene.add(ground);

    const shadowCatcher = new THREE.Mesh(
        groundGeometry,
        new THREE.ShadowMaterial({ color: CONFIG.shadowColor, opacity: 1 })
    );
    shadowCatcher.position.y = -0.3;
    shadowCatcher.receiveShadow = true;
    shadowCatcher.renderOrder = -1; // wie ground: nie über Sprites malen
    // an der Lichtrichtung ausrichten und auf den Schattenkamera-Bereich
    // begrenzen, sonst zeichnet sich dessen Grenze als Saum ab
    const azimuth = Math.atan2(sun.position.z, sun.position.x);
    const elevation = Math.atan2(sun.position.y, Math.hypot(sun.position.x, sun.position.z));
    const catcherExtent = CONFIG.shadowExtent;
    shadowCatcher.rotation.y = -azimuth;
    shadowCatcher.scale.set(
        ((catcherExtent / Math.sin(elevation)) * 0.9) / 2000,
        1,
        (catcherExtent * 0.75) / 2000
    );
    scene.add(shadowCatcher);
}

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.enablePan = false; // kein Verschieben (Maus + Zwei-Finger) — das Modell bleibt zentriert
controls.autoRotate = true;
controls.autoRotateSpeed = 1.0;
canvas.addEventListener('pointerdown', () => { controls.autoRotate = false; }, { once: true });
// Neigungslimit aus der Konfiguration (wird nach dem Laden des Modells gesetzt);
// die 0-Ebene wird davon unabhängig pro Frame als harte Untergrenze erzwungen
let tiltMaxPolar = Math.PI;

// --- Wolken (weiche Sprite-Puffs + unsichtbare Schattenwerfer) ---
const cloudConfig = { count: 0, speed: 50, size: 100, opacity: 90, color: '#ffffff', rain: 0, lightning: 0, ...CONFIG.clouds };
const CLOUD_BASE_Y = CONFIG.cloudBaseY;
const CLOUD_DEPTH = CONFIG.cloudDepth;
const RAIN_FLOOR_Y = CONFIG.rainFloorY || 0; // Regen/Blitze enden an der Modellunterkante
const CLOUD_LIMIT = 60;  // max. 10 % der Modellbreite (100 Einheiten) über den Rand
const CLOUD_FADE_DIST = 20;
const RAIN_MAX_DROPS = 60;
const RAIN_FALL_SPEED = 42;
const RAIN_DROP_LENGTH = 1.4;
const LIGHTNING_MAX_SEGMENTS = 90;
const LIGHTNING_DURATION = 0.3;

// --- Nebelschwaden (flache, weiche Sprite-Bänder über den unteren Hanglagen) ---
const fogConfig = { density: CONFIG.fogDensity ?? 0, size: CONFIG.fogSize ?? 100 };
const FOG_BASE_Y = CONFIG.fogBaseY ?? 0;
const FOG_BAND_HEIGHT = CONFIG.fogBandHeight ?? 8;      // Rückfall ohne Höhenfeld
const FOG_FIELD = CONFIG.fogHeightField || null;         // Geländeoberfläche (Szenen-Y)
const FOG_SHAPE = CONFIG.fogShape || 'rect';
const FOG_MAX_WISPS = 16;
const FOG_EDGE_MARGIN = 14;   // Randabstand einer Schwade (bei 100 % Grösse)
const FOG_FADE_DIST = 20;
const FOG_DRIFT_SPEED = 1.6;
const WORLD_HALF_WIDTH = 50;  // Modell ist 100 Einheiten breit (wie im Editor)

// --- Schnee ---
const snowConfig = { snow: CONFIG.snow ?? 0, size: CONFIG.snowSize ?? 100 };
const SNOW_MAX_FLAKES = 1400;
const SNOW_FALL_SPEED = 3.5;
const SNOW_DRIFT = 2.2;
const SNOW_FADE_TIME = 2.5;   // Dauer für sanftes Ein-/Ausblenden (Sekunden)
const SNOW_EDGE_INSET = 0.02; // Sicherheitsabstand zum Kartenrand (Anteil der halben Breite)
const SNOW_BASE_SIZE = 1.1;   // Flockengrösse in Welteinheiten bei 100 %

// Bewegungsraum der Schwaden: Modellgrundfläche minus Randabstand, damit auch
// grosse Schwaden vollständig über dem Gelände bleiben
const fogSizeFactor = () => Math.max(0.1, fogConfig.size / 100);
const fogXLimit = () => Math.max(6, WORLD_HALF_WIDTH - FOG_EDGE_MARGIN * fogSizeFactor());
const fogZHalf = () => Math.max(2, CLOUD_DEPTH / 2 - FOG_EDGE_MARGIN * fogSizeFactor());

// Liegt (x, z) innerhalb der um den Randabstand geschrumpften Grundform?
function fogInsideShape(x, z) {
    const halfD = CLOUD_DEPTH / 2;
    const margin = FOG_EDGE_MARGIN * fogSizeFactor();
    const ux = (x / WORLD_HALF_WIDTH) / Math.max(0.1, 1 - margin / WORLD_HALF_WIDTH);
    const uy = (-z / halfD) / Math.max(0.1, 1 - margin / halfD);
    if (FOG_SHAPE === 'circle') return ux * ux + uy * uy <= 1.0001;
    if (FOG_SHAPE === 'hexagon') {
        const hy = (uy * Math.sqrt(3)) / 2;
        const r = Math.hypot(ux, hy);
        const sectorAngle = Math.PI / 3;
        const theta = Math.atan2(hy, ux);
        const phi = ((theta % sectorAngle) + sectorAngle) % sectorAngle;
        return r <= Math.cos(Math.PI / 6) / Math.cos(phi - Math.PI / 6) + 1e-4;
    }
    return Math.abs(ux) <= 1 && Math.abs(uy) <= 1;
}

// Geländeoberfläche (Szenen-Y) an (x, z), bilinear aus dem Höhenfeld
function fogGroundY(x, z) {
    if (!FOG_FIELD) return FOG_BASE_Y;
    const { gridW, gridH, data } = FOG_FIELD;
    const fx = Math.min(Math.max(x / (WORLD_HALF_WIDTH * 2) + 0.5, 0), 1) * (gridW - 1);
    const fz = Math.min(Math.max(z / CLOUD_DEPTH + 0.5, 0), 1) * (gridH - 1);
    const x0 = Math.min(Math.floor(fx), gridW - 2);
    const z0 = Math.min(Math.floor(fz), gridH - 2);
    const tx = fx - x0;
    const tz = fz - z0;
    return (data[z0 * gridW + x0] * (1 - tx) + data[z0 * gridW + x0 + 1] * tx) * (1 - tz)
        + (data[(z0 + 1) * gridW + x0] * (1 - tx) + data[(z0 + 1) * gridW + x0 + 1] * tx) * tz;
}

// Schwade an eine gültige Position setzen; atEntry = an die westliche Eintrittskante
function fogRespawn(wisp, atEntry) {
    const xLimit = fogXLimit();
    const zHalf = fogZHalf();
    const data = wisp.userData;
    data.heightFraction = Math.random();
    for (let attempt = 0; attempt < 30; attempt++) {
        const z = (Math.random() * 2 - 1) * zHalf;
        let x = atEntry ? -xLimit : (Math.random() * 2 - 1) * xLimit;
        while (atEntry && x < xLimit && !fogInsideShape(x, z)) x += 3;
        if (fogInsideShape(x, z)) {
            wisp.position.x = x;
            wisp.position.z = z;
            data.entryX = atEntry ? x : x - FOG_FADE_DIST;
            return;
        }
    }
    wisp.position.set(0, FOG_BASE_Y, 0); // Rückfall: Mitte ist immer gültig
    data.entryX = -FOG_FADE_DIST;
}

const cloudGroup = new THREE.Group();
scene.add(cloudGroup);
const rainGroup = new THREE.Group();
scene.add(rainGroup);
const fogGroup = new THREE.Group();
scene.add(fogGroup);
const cloudGeometry = new THREE.SphereGeometry(1, 14, 10);
const cloudShadowMaterial = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });

// Blitze: Zickzack-Liniensegmente + gepulstes Punktlicht (wie im Editor)
const boltGeometry = new THREE.BufferGeometry();
boltGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(LIGHTNING_MAX_SEGMENTS * 6), 3));
boltGeometry.setDrawRange(0, 0);
const boltMesh = new THREE.LineSegments(boltGeometry, new THREE.LineBasicMaterial({
    color: 0xeaf2ff,
    transparent: true,
    opacity: 0,
    toneMapped: false,
    depthWrite: false,
}));
boltMesh.visible = false;
boltMesh.frustumCulled = false;
scene.add(boltMesh);
const lightningLight = new THREE.PointLight(0xcfe0ff, 0, 0, 2);
scene.add(lightningLight);
let boltActive = false;
let boltTime = 0;
let lightningCooldown = 0;
let flashCloud = null;

function makePuffTexture() {
    const size = 128;
    const puffCanvas = document.createElement('canvas');
    puffCanvas.width = size;
    puffCanvas.height = size;
    const ctx = puffCanvas.getContext('2d');
    const blob = (x, y, r, alpha) => {
        const gradient = ctx.createRadialGradient(x, y, 0, x, y, r);
        gradient.addColorStop(0, 'rgba(255,255,255,' + alpha + ')');
        gradient.addColorStop(0.6, 'rgba(255,255,255,' + (alpha * 0.45) + ')');
        gradient.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, size, size);
    };
    blob(size / 2, size / 2, size * 0.46, 0.8);
    for (let i = 0; i < 7; i++) {
        blob(
            size * (0.25 + Math.random() * 0.5),
            size * (0.3 + Math.random() * 0.4),
            size * (0.12 + Math.random() * 0.18),
            0.3 + Math.random() * 0.35
        );
    }
    return new THREE.CanvasTexture(puffCanvas);
}
const cloudTextures = [makePuffTexture(), makePuffTexture(), makePuffTexture()];

function makeCloud() {
    const cloud = new THREE.Group();
    const material = new THREE.SpriteMaterial({
        map: cloudTextures[Math.floor(Math.random() * cloudTextures.length)],
        transparent: true,
        opacity: 0,
        depthWrite: false,
        rotation: (Math.random() - 0.5) * 0.6,
    });
    cloud.userData.baseShade = 0.94 + Math.random() * 0.06; // leichte Helligkeitsvariation
    // Grundfarbe pro Wolke leicht abgedunkelt merken; Blitz-Aufleuchten addiert darauf.
    cloud.userData.baseColor = new THREE.Color(cloudConfig.color)
        .multiplyScalar(cloud.userData.baseShade);
    material.color.copy(cloud.userData.baseColor);
    cloud.userData.material = material;
    const puffs = 5 + Math.floor(Math.random() * 4);
    for (let i = 0; i < puffs; i++) {
        const sprite = new THREE.Sprite(material);
        sprite.position.set(
            (Math.random() - 0.5) * 10,
            (Math.random() - 0.5) * 2.2,
            (Math.random() - 0.5) * 4.5
        );
        const s = 6 + Math.random() * 7;
        sprite.scale.set(s, s * 0.62, 1);
        cloud.add(sprite);
    }
    for (let i = 0; i < 3; i++) {
        const proxy = new THREE.Mesh(cloudGeometry, cloudShadowMaterial);
        proxy.position.set(
            (Math.random() - 0.5) * 8,
            (Math.random() - 0.5) * 1.5,
            (Math.random() - 0.5) * 3.5
        );
        const s = 2 + Math.random() * 2.2;
        proxy.userData.baseScale = new THREE.Vector3(s, s * 0.55, s * 0.8);
        proxy.userData.isShadowProxy = true;
        proxy.scale.copy(proxy.userData.baseScale);
        proxy.castShadow = true;
        cloud.add(proxy);
    }
    return cloud;
}

// Regen unter einer Wolke: kurze, fallende Linien in Weltkoordinaten; über den
// drawRange wird nur der der Regenstärke entsprechende Anteil gezeichnet
function makeRain() {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(RAIN_MAX_DROPS * 6), 3));
    geometry.setDrawRange(0, 0);
    const material = new THREE.LineBasicMaterial({
        color: 0xa9c2d8,
        transparent: true,
        opacity: 0,
        depthWrite: false,
    });
    const rain = new THREE.LineSegments(geometry, material);
    rain.frustumCulled = false; // Positionen ändern sich pro Frame
    const spread = 7 * (cloudConfig.size / 100);
    const drops = [];
    for (let i = 0; i < RAIN_MAX_DROPS; i++) {
        drops.push({
            x: (Math.random() - 0.5) * 2 * spread,
            z: (Math.random() - 0.5) * spread,
            y: Math.random() * CLOUD_BASE_Y,
            speed: 0.75 + Math.random() * 0.5,
        });
    }
    rain.userData.drops = drops;
    return rain;
}

function rebuildClouds() {
    endLightning(); // Quellwolke eines aktiven Blitzes verschwindet gleich
    for (const cloud of cloudGroup.children) {
        if (cloud.userData.material) cloud.userData.material.dispose();
    }
    cloudGroup.clear();
    for (const rain of rainGroup.children) {
        rain.geometry.dispose();
        rain.material.dispose();
    }
    rainGroup.clear();
    for (let i = 0; i < cloudConfig.count; i++) {
        const cloud = makeCloud();
        cloud.userData.speedFactor = 0.7 + Math.random() * 0.6;
        cloud.userData.heightOffset = Math.random() * 14;
        cloud.userData.spawnFade = 0;
        cloud.scale.setScalar(cloudConfig.size / 100);
        cloud.position.set(
            (Math.random() * 2 - 1) * CLOUD_LIMIT,
            CLOUD_BASE_Y + cloud.userData.heightOffset,
            (Math.random() - 0.5) * CLOUD_DEPTH * 0.9
        );
        cloudGroup.add(cloud);
        const rain = makeRain();
        cloud.userData.rain = rain;
        rainGroup.add(rain);
    }
}

// Tropfen unter einer Wolke fallen lassen; Dichte gemäss Regenstärke
function animateRain(cloud, fade, delta) {
    const rain = cloud.userData.rain;
    if (!rain) return;
    const intensity = cloudConfig.rain;
    rain.visible = intensity > 0 && fade > 0.02;
    if (!rain.visible) return;

    rain.position.x = cloud.position.x;
    rain.position.z = cloud.position.z;
    const top = cloud.position.y - 2; // knapp unter der Wolkenbasis starten
    const drops = rain.userData.drops;
    const active = Math.max(1, Math.round(drops.length * (intensity / 100)));
    rain.geometry.setDrawRange(0, active * 2);

    const positions = rain.geometry.attributes.position;
    for (let i = 0; i < active; i++) {
        const drop = drops[i];
        drop.y -= RAIN_FALL_SPEED * drop.speed * delta;
        if (drop.y < RAIN_FLOOR_Y || drop.y > top) drop.y = top * (0.85 + Math.random() * 0.15);
        const j = i * 6;
        positions.array[j] = drop.x;
        positions.array[j + 1] = Math.min(top, drop.y + RAIN_DROP_LENGTH);
        positions.array[j + 2] = drop.z;
        positions.array[j + 3] = drop.x;
        positions.array[j + 4] = drop.y;
        positions.array[j + 5] = drop.z;
    }
    positions.needsUpdate = true;
    rain.material.opacity = 0.5 * fade;
}

// --- Blitze: Zickzack-Kanal mit Ästen, Flacker-Hüllkurve, Szenen-Flash ---
function lightningEnvelope(t) {
    const p1 = Math.exp(-t * 20);
    const p2 = t > 0.1 ? Math.exp(-(t - 0.1) * 24) * 0.8 : 0;
    return Math.min(1, p1 + p2);
}

function buildBolt(start, endY) {
    const pos = boltGeometry.attributes.position.array;
    let seg = 0;
    const put = (a, b) => {
        if (seg >= LIGHTNING_MAX_SEGMENTS) return;
        const o = seg * 6;
        pos[o] = a.x;
        pos[o + 1] = a.y;
        pos[o + 2] = a.z;
        pos[o + 3] = b.x;
        pos[o + 4] = b.y;
        pos[o + 5] = b.z;
        seg++;
    };
    const end = new THREE.Vector3(
        start.x + (Math.random() - 0.5) * 12,
        endY,
        start.z + (Math.random() - 0.5) * 12
    );
    const steps = 14;
    let prev = start.clone();
    for (let i = 1; i <= steps; i++) {
        const q = new THREE.Vector3().lerpVectors(start, end, i / steps);
        if (i < steps) {
            const jitter = 1 + (1 - i / steps) * 3;
            q.x += (Math.random() - 0.5) * jitter;
            q.z += (Math.random() - 0.5) * jitter;
        }
        put(prev, q);
        if (i >= 3 && i <= steps - 3 && Math.random() < 0.35) {
            let bp = q.clone();
            const dir = new THREE.Vector3((Math.random() - 0.5) * 2, -1, (Math.random() - 0.5) * 2).normalize();
            const branchSteps = 2 + Math.floor(Math.random() * 3);
            for (let k = 0; k < branchSteps; k++) {
                const nb = bp.clone().addScaledVector(dir, 1.5 + Math.random() * 2);
                nb.x += (Math.random() - 0.5) * 1.5;
                nb.z += (Math.random() - 0.5) * 1.5;
                put(bp, nb);
                bp = nb;
            }
        }
        prev = q;
    }
    boltGeometry.setDrawRange(0, seg * 2);
    boltGeometry.attributes.position.needsUpdate = true;
}

function strikeLightning() {
    const clouds = cloudGroup.children;
    const visible = clouds.filter((c) => c.userData.material.opacity > 0.15);
    const pool = visible.length ? visible : clouds;
    const cloud = pool[Math.floor(Math.random() * pool.length)];
    const start = cloud.position.clone();
    start.y -= 2;
    buildBolt(start, RAIN_FLOOR_Y);
    boltMesh.visible = true;
    boltActive = true;
    boltTime = 0;
    flashCloud = cloud;
    lightningLight.position.set(start.x, (start.y + RAIN_FLOOR_Y) / 2, start.z);
}

function endLightning() {
    if (!boltActive) return;
    boltActive = false;
    boltMesh.visible = false;
    boltMesh.material.opacity = 0;
    lightningLight.intensity = 0;
    if (flashCloud && flashCloud.userData.material && flashCloud.userData.baseColor) {
        flashCloud.userData.material.color.copy(flashCloud.userData.baseColor);
    }
    flashCloud = null;
}

function animateLightning(delta) {
    const intensity = cloudConfig.lightning;
    if (intensity <= 0 || !cloudGroup.children.length) {
        endLightning();
        return;
    }
    if (boltActive) {
        boltTime += delta;
        if (boltTime >= LIGHTNING_DURATION) {
            endLightning();
            return;
        }
        const envelope = lightningEnvelope(boltTime);
        boltMesh.material.opacity = envelope;
        lightningLight.intensity = envelope * 12000;
        if (flashCloud && flashCloud.userData.material && flashCloud.userData.baseColor) {
            flashCloud.userData.material.color.copy(flashCloud.userData.baseColor).addScalar(envelope * 1.4);
        }
    } else {
        lightningCooldown -= delta;
        if (lightningCooldown <= 0) {
            strikeLightning();
            const mean = 12 - 11.2 * (intensity / 100);
            lightningCooldown = mean * (0.4 + Math.random() * 1.2);
        }
    }
}

function animateClouds(delta) {
    const speed = (cloudConfig.speed / 100) * 12;
    for (const cloud of cloudGroup.children) {
        cloud.position.x += speed * cloud.userData.speedFactor * delta;
        if (cloud.position.x > CLOUD_LIMIT) {
            cloud.position.x = -CLOUD_LIMIT;
            cloud.position.z = (Math.random() - 0.5) * CLOUD_DEPTH * 0.9;
            cloud.userData.heightOffset = Math.random() * 14;
            cloud.position.y = CLOUD_BASE_Y + cloud.userData.heightOffset;
        }
        cloud.userData.spawnFade = Math.min(1, cloud.userData.spawnFade + delta / 2);
        const positionFade = Math.max(0, Math.min(
            1,
            (cloud.position.x + CLOUD_LIMIT) / CLOUD_FADE_DIST,
            (CLOUD_LIMIT - cloud.position.x) / CLOUD_FADE_DIST
        ));
        const fade = positionFade * cloud.userData.spawnFade;
        cloud.userData.material.opacity = (cloudConfig.opacity / 100) * fade;
        for (const child of cloud.children) {
            if (child.userData.isShadowProxy) {
                child.scale.copy(child.userData.baseScale)
                    .multiplyScalar(Math.max(0.001, fade));
            }
        }
        animateRain(cloud, fade, delta);
    }
}
rebuildClouds();

// Sehr weiche, in die Breite gezogene Schwaden-Textur (elliptische Verläufe)
function makeFogTexture() {
    const fogCanvas = document.createElement('canvas');
    fogCanvas.width = 256;
    fogCanvas.height = 64;
    const ctx = fogCanvas.getContext('2d');
    const streak = (x, y, rx, ry, alpha) => {
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(rx / ry, 1);
        const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, ry);
        gradient.addColorStop(0, 'rgba(255,255,255,' + alpha + ')');
        gradient.addColorStop(0.55, 'rgba(255,255,255,' + (alpha * 0.4) + ')');
        gradient.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = gradient;
        ctx.fillRect(-ry, -ry, ry * 2, ry * 2);
        ctx.restore();
    };
    streak(128, 34, 116, 22, 0.5);
    for (let i = 0; i < 6; i++) {
        streak(
            70 + Math.random() * 116,
            22 + Math.random() * 20,
            20 + Math.random() * 36,
            7 + Math.random() * 9,
            0.15 + Math.random() * 0.25
        );
    }
    return new THREE.CanvasTexture(fogCanvas);
}
const fogTextures = [makeFogTexture(), makeFogTexture()];
let fogTime = 0;

function makeFogWisp() {
    const wisp = new THREE.Group();
    const material = new THREE.SpriteMaterial({
        map: fogTextures[Math.floor(Math.random() * fogTextures.length)],
        transparent: true,
        opacity: 0, // animateFog() blendet ein
        depthWrite: false,
    });
    material.color.setScalar(0.9 + Math.random() * 0.1);
    wisp.userData.material = material;
    const parts = 3 + Math.floor(Math.random() * 3);
    for (let i = 0; i < parts; i++) {
        const sprite = new THREE.Sprite(material);
        sprite.position.set(
            (Math.random() - 0.5) * 16,
            (Math.random() - 0.5) * 1.6,
            (Math.random() - 0.5) * 6
        );
        const w = 14 + Math.random() * 12;
        sprite.scale.set(w, w * (0.14 + Math.random() * 0.08), 1);
        wisp.add(sprite);
    }
    return wisp;
}

// Fester Schwaden-Vorrat; wie viele sichtbar sind, steuert die Dichte pro Frame
for (let i = 0; i < FOG_MAX_WISPS; i++) {
    const wisp = makeFogWisp();
    wisp.userData.speedFactor = 0.5 + Math.random() * 0.7;
    wisp.userData.phase = Math.random() * Math.PI * 2;
    wisp.userData.fade = 0;
    wisp.scale.setScalar(fogSizeFactor());
    wisp.position.y = FOG_BASE_Y;
    fogRespawn(wisp, false);
    fogGroup.add(wisp);
}

// Schwaden driften langsam von West nach Ost, schmiegen sich an die
// Geländeoberfläche und wabern dabei leicht in Höhe und Deckkraft
function animateFog(delta) {
    const wisps = fogGroup.children;
    const density = Math.min(100, Math.max(0, fogConfig.density));
    const active = Math.ceil(wisps.length * (density / 100));
    fogTime += delta;
    const sizeFactor = fogSizeFactor();
    const xLimit = fogXLimit();
    const zHalf = fogZHalf();
    const fadeDist = Math.min(FOG_FADE_DIST, xLimit);
    const maxOpacity = 0.4 * Math.sqrt(density / 100);
    for (let i = 0; i < wisps.length; i++) {
        const wisp = wisps[i];
        const data = wisp.userData;
        data.fade = Math.min(1, Math.max(0, data.fade + (i < active ? delta : -delta) / 2.5));
        if (data.fade <= 0) {
            wisp.visible = false;
            continue;
        }
        wisp.visible = true;
        wisp.position.x += FOG_DRIFT_SPEED * data.speedFactor * delta;
        // Grössenänderung verkleinert den Bewegungsraum — zurückführen
        wisp.position.z = Math.max(-zHalf, Math.min(zHalf, wisp.position.z));
        if (wisp.position.x > xLimit || !fogInsideShape(wisp.position.x, wisp.position.z)) {
            fogRespawn(wisp, true);
        }
        // Über der Geländeoberfläche schweben; ohne Höhenfeld (alte Exporte)
        // gilt das bisherige Höhenband über der Sockeloberkante
        wisp.position.y = (FOG_FIELD
            ? fogGroundY(wisp.position.x, wisp.position.z) + (1.5 + data.heightFraction * 3) * sizeFactor
            : FOG_BASE_Y + data.heightFraction * FOG_BAND_HEIGHT)
            + Math.sin(fogTime * 0.25 + data.phase) * 0.7;
        // Abstand zur Austrittskante in Driftrichtung (Kreis/Sechseck: sondieren)
        let distToExit = Math.min(fadeDist, xLimit - wisp.position.x);
        for (let d = 3; d < distToExit; d += 3) {
            if (!fogInsideShape(wisp.position.x + d, wisp.position.z)) {
                distToExit = d;
                break;
            }
        }
        const positionFade = Math.max(0, Math.min(
            1,
            (wisp.position.x - data.entryX) / fadeDist,
            distToExit / fadeDist
        ));
        const pulse = 0.75 + 0.25 * Math.sin(fogTime * 0.4 + data.phase * 1.7);
        data.material.opacity = maxOpacity * data.fade * positionFade * pulse;
    }
}

// --- Schnee: szenenweit taumelnde Flocken (Points), nicht an Wolken gebunden ---
// Leitet aus der Helligkeit einer Farbtextur eine kachelbare Tangent-Space-
// Normal-Map ab (Sobel-Gradient). Gleiche Logik wie makeNormalMap im Editor,
// damit der exportierte Sockel dieselbe Struktur zeigt.
function makeNormalMap(sourceCanvas, strength) {
    strength = strength || 2.0;
    const w = sourceCanvas.width;
    const h = sourceCanvas.height;
    const src = sourceCanvas.getContext('2d').getImageData(0, 0, w, h).data;
    const height = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
        height[i] = (0.299 * src[i * 4] + 0.587 * src[i * 4 + 1] + 0.114 * src[i * 4 + 2]) / 255;
    }
    const at = (x, y) => height[((y + h) % h) * w + ((x + w) % w)];
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const dst = out.getContext('2d').createImageData(w, h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const dx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1))
                - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
            const dy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1))
                - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
            let nx = -dx * strength;
            let ny = -dy * strength;
            const nz = 1;
            const len = Math.hypot(nx, ny, nz) || 1;
            nx /= len;
            ny /= len;
            const o = (y * w + x) * 4;
            dst.data[o] = (nx * 0.5 + 0.5) * 255;
            dst.data[o + 1] = (ny * 0.5 + 0.5) * 255;
            dst.data[o + 2] = (nz / len * 0.5 + 0.5) * 255;
            dst.data[o + 3] = 255;
        }
    }
    out.getContext('2d').putImageData(dst, 0, 0);
    return out;
}
const SKIRT_NORMAL_SCALE = 0.6;

function makeSnowTexture() {
    const size = 32;
    const snowCanvas = document.createElement('canvas');
    snowCanvas.width = size;
    snowCanvas.height = size;
    const ctx = snowCanvas.getContext('2d');
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.5, 'rgba(255,255,255,0.85)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    return new THREE.CanvasTexture(snowCanvas);
}
const SNOW_TOP_Y = CLOUD_BASE_Y + 8;
const snowMaterial = new THREE.PointsMaterial({
    map: makeSnowTexture(),
    color: 0xffffff,
    size: SNOW_BASE_SIZE * Math.max(0.1, snowConfig.size / 100),
    sizeAttenuation: true,
    transparent: true,
    opacity: 1,
    depthWrite: false,
    toneMapped: false,
});
// Per-Vertex-Alpha: das Attribut aOpacity moduliert die Deckkraft jeder Flocke
// einzeln, damit sie beim Erscheinen individuell einfaden kann
snowMaterial.onBeforeCompile = (shader) => {
    shader.vertexShader = 'attribute float aOpacity;\\nvarying float vOpacity;\\n'
        + shader.vertexShader.replace('#include <begin_vertex>',
            '#include <begin_vertex>\\n    vOpacity = aOpacity;');
    shader.fragmentShader = 'varying float vOpacity;\\n'
        + shader.fragmentShader.replace('#include <opaque_fragment>',
            'diffuseColor.a *= vOpacity;\\n#include <opaque_fragment>');
};
const snowGeometry = new THREE.BufferGeometry();
snowGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SNOW_MAX_FLAKES * 3), 3));
snowGeometry.setAttribute('aOpacity', new THREE.BufferAttribute(new Float32Array(SNOW_MAX_FLAKES), 1));
snowGeometry.setDrawRange(0, 0);
const snowPoints = new THREE.Points(snowGeometry, snowMaterial);
snowPoints.frustumCulled = false;
snowPoints.visible = false;
scene.add(snowPoints);
let snowTime = 0;

// Schnee fällt nur innerhalb der Grundform (nicht über den Rand) — dieselbe
// Formlogik wie beim Nebel (FOG_SHAPE), zusätzlich um SNOW_EDGE_INSET einwärts
// geschrumpft, damit die Flocken einen Sicherheitsabstand zum Kartenrand halten
function snowInsideShape(x, z) {
    const k = 1 - SNOW_EDGE_INSET;
    const ux = (x / WORLD_HALF_WIDTH) / k;
    const uy = (-z / (CLOUD_DEPTH / 2)) / k;
    if (FOG_SHAPE === 'circle') return ux * ux + uy * uy <= 1.0001;
    if (FOG_SHAPE === 'hexagon') {
        const hy = (uy * Math.sqrt(3)) / 2;
        const r = Math.hypot(ux, hy);
        const sectorAngle = Math.PI / 3;
        const theta = Math.atan2(hy, ux);
        const phi = ((theta % sectorAngle) + sectorAngle) % sectorAngle;
        return r <= Math.cos(Math.PI / 6) / Math.cos(phi - Math.PI / 6) + 1e-4;
    }
    return Math.abs(ux) <= 1 && Math.abs(uy) <= 1;
}
function snowRandomXZ() {
    const halfW = WORLD_HALF_WIDTH;
    const halfD = CLOUD_DEPTH / 2;
    for (let attempt = 0; attempt < 30; attempt++) {
        const x = (Math.random() * 2 - 1) * halfW;
        const z = (Math.random() * 2 - 1) * halfD;
        if (snowInsideShape(x, z)) return { x, z };
    }
    return { x: 0, z: 0 };
}
const snowFlakes = [];
for (let i = 0; i < SNOW_MAX_FLAKES; i++) {
    const { x, z } = snowRandomXZ();
    snowFlakes.push({
        baseX: x,
        baseZ: z,
        y: RAIN_FLOOR_Y + Math.random() * (SNOW_TOP_Y - RAIN_FLOOR_Y),
        speed: 0.6 + Math.random() * 0.8,
        phase: Math.random() * Math.PI * 2,
        drift: 0.4 + Math.random() * 0.6,
        // Startfortschritt zufällig verteilt, leichte Deckkraftvariation
        fade: Math.random(),
        maxOpacity: 0.7 + Math.random() * 0.3,
    });
}
// Ziel-Deckkraft einer voll eingeblendeten Flocke (steigt leicht mit der Stärke)
function snowMaxOpacity() {
    return 0.55 + 0.4 * Math.min(1, snowConfig.snow / 100);
}

// Jede Flocke faded einzeln ein (fade wächst nach dem Spawn) und kurz vor dem
// Aufsetzen wieder aus; die Deckkraft geht pro Flocke über aOpacity in den Shader
function animateSnow(delta) {
    const intensity = Math.min(100, Math.max(0, snowConfig.snow));
    if (intensity <= 0) {
        snowPoints.visible = false;
        return;
    }
    snowPoints.visible = true;
    snowTime += delta;
    const span = Math.max(1, SNOW_TOP_Y - RAIN_FLOOR_Y);
    const maxOpacity = snowMaxOpacity();
    const fadeStep = delta / SNOW_FADE_TIME;
    const active = Math.max(1, Math.round(snowFlakes.length * (intensity / 100)));
    snowGeometry.setDrawRange(0, active);
    const positions = snowGeometry.attributes.position.array;
    const opacities = snowGeometry.attributes.aOpacity.array;
    for (let i = 0; i < active; i++) {
        const flake = snowFlakes[i];
        flake.y -= SNOW_FALL_SPEED * flake.speed * delta;
        if (flake.y < RAIN_FLOOR_Y) {
            flake.y = SNOW_TOP_Y;
            flake.fade = 0;
            const spawn = snowRandomXZ();
            flake.baseX = spawn.x;
            flake.baseZ = spawn.z;
        }
        flake.fade = Math.min(1, flake.fade + fadeStep);
        const fallen = 1 - (flake.y - RAIN_FLOOR_Y) / span;
        const landFade = fallen > 0.85 ? Math.max(0, (1 - fallen) / 0.15) : 1;
        // seitliches Taumeln, am Formrand abgeklemmt, damit keine Flocke über
        // die Grundform hinausdriftet
        let dx = Math.sin(snowTime * flake.drift + flake.phase) * SNOW_DRIFT;
        let dz = Math.cos(snowTime * flake.drift * 0.7 + flake.phase) * SNOW_DRIFT;
        if (!snowInsideShape(flake.baseX + dx, flake.baseZ + dz)) {
            dx = 0;
            dz = 0;
        }
        const o = i * 3;
        positions[o] = flake.baseX + dx;
        positions[o + 1] = flake.y;
        positions[o + 2] = flake.baseZ + dz;
        opacities[i] = maxOpacity * flake.maxOpacity * flake.fade * landFade;
    }
    snowGeometry.attributes.position.needsUpdate = true;
    snowGeometry.attributes.aOpacity.needsUpdate = true;
}

// Schnittstelle: Marker/Wege ein-/ausblenden, Wolken steuern
const overlayObjects = new Map();
const terrainViewer = {
    list: () => [...overlayObjects.keys()],
    setVisible(name, visible) {
        const object = overlayObjects.get(name);
        if (object) object.visible = !!visible;
        return !!object;
    },
    toggle(name) {
        const object = overlayObjects.get(name);
        if (object) object.visible = !object.visible;
        return !!object;
    },
    getVisible(name) {
        const object = overlayObjects.get(name);
        return object ? object.visible : null;
    },
    getView() {
        return {
            polar: controls.getPolarAngle(),
            azimuth: controls.getAzimuthalAngle(),
            distance: camera.position.distanceTo(controls.target),
            zoom: camera.zoom,
        };
    },
    setClouds(options = {}) {
        const previousCount = cloudConfig.count;
        for (const key of ['count', 'speed', 'size', 'opacity', 'rain', 'lightning']) {
            if (typeof options[key] === 'number' && Number.isFinite(options[key])) {
                cloudConfig[key] = Math.max(0, options[key]);
            }
        }
        if (typeof options.color === 'string') {
            cloudConfig.color = options.color;
        }
        if (cloudConfig.count !== previousCount) rebuildClouds();
        if (typeof options.size === 'number') {
            for (const cloud of cloudGroup.children) {
                cloud.scale.setScalar(cloudConfig.size / 100);
            }
        }
        if (typeof options.color === 'string') {
            for (const cloud of cloudGroup.children) {
                cloud.userData.baseColor = new THREE.Color(cloudConfig.color)
                    .multiplyScalar(cloud.userData.baseShade);
                cloud.userData.material?.color.copy(cloud.userData.baseColor);
            }
        }
        return { ...cloudConfig };
    },
    getClouds: () => ({ ...cloudConfig }),
    setFog(options = {}) {
        if (typeof options.density === 'number' && Number.isFinite(options.density)) {
            fogConfig.density = Math.min(100, Math.max(0, options.density));
        }
        if (typeof options.size === 'number' && Number.isFinite(options.size)) {
            fogConfig.size = Math.min(400, Math.max(10, options.size));
            for (const wisp of fogGroup.children) wisp.scale.setScalar(fogSizeFactor());
        }
        return { ...fogConfig };
    },
    getFog: () => ({ ...fogConfig }),
    setSnow(options = {}) {
        const value = typeof options === 'number' ? options : options.snow;
        if (typeof value === 'number' && Number.isFinite(value)) {
            snowConfig.snow = Math.min(100, Math.max(0, value));
            // Deckkraft folgt über den Fade in animateSnow — hier nichts setzen
        }
        const size = typeof options === 'object' && options !== null ? options.size : undefined;
        if (typeof size === 'number' && Number.isFinite(size)) {
            snowConfig.size = Math.min(400, Math.max(10, size));
            snowMaterial.size = SNOW_BASE_SIZE * (snowConfig.size / 100);
        }
        return { ...snowConfig };
    },
    getSnow: () => ({ ...snowConfig }),
};
window.terrainViewer = terrainViewer;

// Ortstafeln: Stab zum Boden + kamerazugewandtes Textschild (weiss/schwarz)
const LABELS = CONFIG.labels || [];
function makeLabelCanvas(text) {
    const font = '600 26px system-ui, sans-serif';
    const probe = document.createElement('canvas').getContext('2d');
    probe.font = font;
    const textWidth = Math.max(20, Math.ceil(probe.measureText(text).width));
    const w = textWidth + 28;
    const h = 46;
    const labelCanvas = document.createElement('canvas');
    labelCanvas.width = w * 2;
    labelCanvas.height = h * 2;
    const ctx = labelCanvas.getContext('2d');
    ctx.scale(2, 2);
    ctx.beginPath();
    ctx.roundRect(1.5, 1.5, w - 3, h - 3, 6);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#000000';
    ctx.stroke();
    ctx.font = font;
    ctx.fillStyle = '#000000';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, w / 2, h / 2 + 1);
    return labelCanvas;
}
{
    const stickGeometry = new THREE.CylinderGeometry(0.12, 0.12, 1, 6);
    // ohne Tone Mapping: immer rein weiss
    const stickMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    for (const label of LABELS) {
        const group = new THREE.Group();
        group.name = label.name;
        const stick = new THREE.Mesh(stickGeometry, stickMaterial);
        stick.position.set(label.position[0], label.position[1] + 4, label.position[2]);
        stick.scale.set(1, 8, 1);
        stick.castShadow = true;
        const labelCanvas = makeLabelCanvas(label.text);
        const texture = new THREE.CanvasTexture(labelCanvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        const plate = new THREE.Sprite(new THREE.SpriteMaterial({
            map: texture,
            transparent: true,
            depthWrite: false,
            toneMapped: false, // Schild bleibt rein weiss/schwarz
        }));
        const plateHeight = 3.4;
        plate.scale.set(plateHeight * (labelCanvas.width / labelCanvas.height), plateHeight, 1);
        plate.position.set(label.position[0], label.position[1] + 8 + plateHeight / 2 - 0.2, label.position[2]);
        group.add(stick, plate);
        scene.add(group);
        overlayObjects.set(label.name, group);
    }
}

// Kontaktschatten: ausfadende Kreise unter Markern und Tafeln, aus den
// allgemeinen Schatten-Einstellungen abgeleitet (Härte, Stärke, Farbe)
{
    const shadows = CONFIG.contactShadows || [];
    if (shadows.length) {
        const size = 128;
        const blobCanvas = document.createElement('canvas');
        blobCanvas.width = size;
        blobCanvas.height = size;
        const ctx = blobCanvas.getContext('2d');
        const hardness = Math.min(100, Math.max(0, CONFIG.contactShadowHardness ?? 60));
        const inner = 0.1 + 0.75 * (hardness / 100);
        const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2 - 2);
        gradient.addColorStop(0, 'rgba(255,255,255,1)');
        gradient.addColorStop(inner, 'rgba(255,255,255,1)');
        gradient.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, size, size);

        const blobMaterial = new THREE.MeshBasicMaterial({
            map: new THREE.CanvasTexture(blobCanvas),
            transparent: true,
            depthWrite: false,
            color: CONFIG.shadowColor,
            opacity: (CONFIG.shadowIntensity || 0.6) * 0.9,
        });
        const blobGeometry = new THREE.PlaneGeometry(3.6, 3.6);
        for (const shadow of shadows) {
            const blob = new THREE.Mesh(blobGeometry, blobMaterial);
            const normal = new THREE.Vector3().fromArray(shadow.normal || [0, 1, 0]);
            blob.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
            blob.position.fromArray(shadow.position);
            scene.add(blob);
        }
    }
}

window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'overlay-visibility') {
        terrainViewer.setVisible(data.name, data.visible);
    } else if (data.type === 'overlay-toggle') {
        terrainViewer.toggle(data.name);
    } else if (data.type === 'overlay-list' && event.source) {
        event.source.postMessage({ type: 'overlay-list', names: terrainViewer.list() }, '*');
    } else if (data.type === 'clouds') {
        terrainViewer.setClouds(data);
    } else if (data.type === 'fog') {
        terrainViewer.setFog(data);
    } else if (data.type === 'snow') {
        terrainViewer.setSnow(data);
    }
});

// Der Loader bekommt den Meshopt-Decoder gesetzt, damit mit
// EXT_meshopt_compression exportierte GLBs geladen werden können. Für
// unkomprimierte GLBs bleibt er wirkungslos (rückwärtskompatibel).
const gltfLoader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
gltfLoader.load(GLB_FILE, (gltf) => {
    scene.add(gltf.scene);
    gltf.scene.traverse((object) => {
        if (/^(marker|weg)-/.test(object.name)) overlayObjects.set(object.name, object);
        if (object.isMesh) {
            object.castShadow = true;
            object.receiveShadow = true; // Selbstschatten des Geländes
        }
    });

    // Marker- und Wegfarben aus projekt.json anwenden (statt der im Modell
    // eingebetteten Farben) — so lassen sie sich nachträglich per JSON ändern.
    // Materialien werden geklont, da der GLB-Export identische Materialien
    // zwischen Objekten teilen kann.
    const recolor = (name, color) => {
        if (!color) return;
        const object = gltf.scene.getObjectByName(name);
        if (!object) return;
        object.traverse((child) => {
            if (child.isMesh && child.material && child.material.color) {
                child.material = child.material.clone();
                child.material.color.set(color);
            }
        });
    };
    for (const m of PROJEKT.markers || []) recolor('marker-' + m.id, m.color);
    for (const p of PROJEKT.paths || []) recolor('weg-' + p.id, p.color);

    // Texturen aus separaten Dateien anhängen (Gelände + Sockel)
    const textureLoader = new THREE.TextureLoader();
    const attachTexture = (meshName, file, repeatWrap, withNormalMap) => {
        if (!file) return;
        const mesh = gltf.scene.getObjectByName(meshName);
        if (!mesh) {
            ladeFertig();
            return;
        }
        textureLoader.load(file, (texture) => {
            // Der GLTFExporter schreibt UVs unverändert (three.js-Konvention,
            // v nach oben) und flippt sonst das EINGEBETTETE Bild. Unsere
            // Texturen kommen ungeflippt aus separaten Dateien → flipY = true.
            texture.flipY = true;
            texture.colorSpace = THREE.SRGBColorSpace;
            texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
            if (repeatWrap) {
                texture.wrapS = THREE.RepeatWrapping;
                texture.wrapT = THREE.RepeatWrapping;
            }
            mesh.material.map = texture;
            // Normal-Map wie im Editor prozedural aus der Sockel-Textur ableiten
            if (withNormalMap && texture.image) {
                const src = document.createElement('canvas');
                src.width = texture.image.width;
                src.height = texture.image.height;
                src.getContext('2d').drawImage(texture.image, 0, 0);
                const normalMap = new THREE.CanvasTexture(makeNormalMap(src));
                normalMap.flipY = true;
                normalMap.wrapS = THREE.RepeatWrapping;
                normalMap.wrapT = THREE.RepeatWrapping;
                normalMap.anisotropy = renderer.capabilities.getMaxAnisotropy();
                mesh.material.normalMap = normalMap;
                mesh.material.normalScale = new THREE.Vector2(SKIRT_NORMAL_SCALE, SKIRT_NORMAL_SCALE);
                if (mesh.material.roughness >= 1) mesh.material.roughness = 0.85;
            }
            mesh.material.needsUpdate = true;
            ladeFertig();
        }, undefined, ladeFertig);
    };
    attachTexture('gelaende', TERRAIN_TEXTURE, false, false);
    attachTexture('sockel', SOCKEL_TEXTURE, true, true);
    const box = new THREE.Box3().setFromObject(gltf.scene);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const extent = Math.max(size.x, size.z, size.y) * 0.8 + 30;
    const shadowCam = sun.shadow.camera;
    shadowCam.left = -extent;
    shadowCam.right = extent;
    shadowCam.top = extent;
    shadowCam.bottom = -extent;
    shadowCam.near = 1;
    shadowCam.far = 1200;
    shadowCam.updateProjectionMatrix();
    const dist = Math.max(size.x, size.z, size.y * 1.6);
    if (camera.isOrthographicCamera) {
        orthoFit = Math.max(size.x, size.z, size.y * 2) * 1.15;
        applyOrthoFrustum();
    }
    if (CONFIG.startCamera) {
        // im Editor gespeicherte Startposition
        camera.position.fromArray(CONFIG.startCamera.position);
        controls.target.fromArray(CONFIG.startCamera.target);
        if (camera.isOrthographicCamera) {
            camera.zoom = CONFIG.startCamera.zoom || 1;
            camera.updateProjectionMatrix();
        }
    } else if (camera.isOrthographicCamera) {
        // isometrische Standardansicht: klassischer 45°-Winkel
        const elevation = Math.atan(1 / Math.sqrt(2));
        const azimuth = Math.PI / 4;
        const d = 250;
        camera.position.set(
            center.x + Math.cos(azimuth) * Math.cos(elevation) * d,
            center.y + Math.sin(elevation) * d,
            center.z + Math.sin(azimuth) * Math.cos(elevation) * d
        );
        controls.target.copy(center);
    } else {
        camera.position.set(center.x, box.max.y + dist * 0.45, center.z + dist * 1.15);
        controls.target.copy(center);
    }

    // Sichtbegrenzungen aus der Konfiguration: Neigung nur ±tiltLimit um die
    // Startansicht, Zoom nur hinein (bis zoomInLimit Prozent), nie hinaus
    const startOffset = camera.position.clone().sub(controls.target);
    const startPolar = Math.acos(Math.min(1, Math.max(-1, startOffset.y / (startOffset.length() || 1))));
    const tiltLimit = ((CONFIG.tiltLimit ?? 90) * Math.PI) / 180;
    controls.minPolarAngle = Math.max(0, startPolar - tiltLimit);
    tiltMaxPolar = Math.min(Math.PI, startPolar + tiltLimit);
    const zoomInFactor = 1 - Math.min(0.95, Math.max(0, (CONFIG.zoomInLimit ?? 50) / 100));
    if (camera.isOrthographicCamera) {
        controls.minZoom = camera.zoom;
        controls.maxZoom = camera.zoom / zoomInFactor;
    } else {
        const startDistance = startOffset.length();
        controls.maxDistance = startDistance;
        controls.minDistance = startDistance * zoomInFactor;
    }

    ladeFertig(); // Modell geladen
}, undefined, () => laderFehler('Fehler: 3D-Modell konnte nicht geladen werden.'));

function resize() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    if (camera.isOrthographicCamera) {
        applyOrthoFrustum();
    } else {
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
    }
    updateBackgroundCover();
}
new ResizeObserver(resize).observe(canvas);
resize();
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
    const delta = clock.getDelta();
    animateClouds(delta);
    animateLightning(delta);
    animateFog(delta);
    animateSnow(delta);
    // Kamera nie unter die 0-Ebene (Modellboden), egal welches Neigungslimit
    // gilt: camera.y = target.y + r*cos(phi) >= 0, abhängig von Ziel und Zoom
    const r = camera.position.distanceTo(controls.target) || 1;
    const groundPolar = Math.acos(Math.min(1, Math.max(-1, -controls.target.y / r)));
    controls.maxPolarAngle = Math.min(tiltMaxPolar, groundPolar);
    controls.update();
    renderer.render(scene, camera);
});
</${'script'}>
</body>
</html>
`;
}

export function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
}
