import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { makeSoilTexture, makeRockTexture, makeStrataTexture, makeNormalMap } from './textures.js';
import { insideShape, sampleHeight } from './mesh.js';

const WORLD_WIDTH = 100;   // Modellbreite in Szenen-Einheiten
const SUN_DISTANCE = 160;  // fester Abstand der Lichtquelle vom Mittelpunkt
// Environment-Map liefert die PBR-Materialien mit weicher indirekter Beleuchtung
// (statt nur Hemisphere-Licht). Standardmässig niedrig, damit Sonne und
// Schlagschatten die Lichtstimmung dominieren; über den Regler einstellbar
// (options.envIntensity in Prozent, 100 % = Faktor 1.0).
const ENV_INTENSITY_DEFAULT = 35;
// Stärke der prozeduralen Sockel-Normal-Map: dezent, damit die Struktur
// greifbar wird, ohne dass der Sockel "verbeult" wirkt.
const SKIRT_NORMAL_SCALE = 0.6;

/**
 * Ersatz für den PCF-Zweig im Shadow-Shader von Three.js: Poisson-Disk mit
 * zufälliger Rotation pro Pixel statt des 17-Tap-Rasterkernels. Der
 * Standardkernel erzeugt bei grossem shadow.radius sichtbare Stufen im
 * Halbschatten; die Zufallsrotation löst das Banding in feines Rauschen auf.
 * Wird auch in den Web-Export übernommen.
 */
export const PCF_POISSON_BRANCH = `#if defined( SHADOWMAP_TYPE_PCF )

            vec2 texelSize = vec2( 1.0 ) / shadowMapSize;
            vec2 spread = texelSize * shadowRadius;

            vec2 poissonDisk[ 32 ];
            poissonDisk[ 0 ] = vec2( 0.42728091, 0.26415186 );
            poissonDisk[ 1 ] = vec2( -0.92311000, -0.37826944 );
            poissonDisk[ 2 ] = vec2( 0.19956967, -0.96973308 );
            poissonDisk[ 3 ] = vec2( -0.65105173, 0.74941396 );
            poissonDisk[ 4 ] = vec2( 0.88890125, -0.45608048 );
            poissonDisk[ 5 ] = vec2( -0.16883807, -0.23656267 );
            poissonDisk[ 6 ] = vec2( 0.12699719, 0.98895632 );
            poissonDisk[ 7 ] = vec2( -0.47036682, -0.86789015 );
            poissonDisk[ 8 ] = vec2( -0.16244858, 0.40259296 );
            poissonDisk[ 9 ] = vec2( -0.90667031, 0.21125381 );
            poissonDisk[ 10 ] = vec2( 0.96942256, 0.14270868 );
            poissonDisk[ 11 ] = vec2( 0.36871545, -0.29837092 );
            poissonDisk[ 12 ] = vec2( 0.67435978, 0.73299741 );
            poissonDisk[ 13 ] = vec2( -0.48648958, 0.08194988 );
            poissonDisk[ 14 ] = vec2( 0.59400312, -0.79385041 );
            poissonDisk[ 15 ] = vec2( -0.09431953, -0.66590281 );
            poissonDisk[ 16 ] = vec2( -0.27829308, 0.93012527 );
            poissonDisk[ 17 ] = vec2( -0.51944696, -0.45554064 );
            poissonDisk[ 18 ] = vec2( 0.08066623, 0.07660021 );
            poissonDisk[ 19 ] = vec2( 0.19652416, 0.59775397 );
            poissonDisk[ 20 ] = vec2( 0.70246638, -0.11980137 );
            poissonDisk[ 21 ] = vec2( 0.25521838, -0.62673277 );
            poissonDisk[ 22 ] = vec2( -0.60182758, 0.41173964 );
            poissonDisk[ 23 ] = vec2( 0.73515790, 0.39033349 );
            poissonDisk[ 24 ] = vec2( -0.77826431, -0.08469927 );
            poissonDisk[ 25 ] = vec2( -0.71834785, -0.68825940 );
            poissonDisk[ 26 ] = vec2( -0.13646017, -0.97381242 );
            poissonDisk[ 27 ] = vec2( -0.35043597, 0.64063427 );
            poissonDisk[ 28 ] = vec2( 0.41710541, 0.90770521 );
            poissonDisk[ 29 ] = vec2( -0.04372319, 0.76136643 );
            poissonDisk[ 30 ] = vec2( 0.59183829, -0.49060638 );
            poissonDisk[ 31 ] = vec2( 0.08804962, -0.36545202 );

            float angle = fract( sin( dot( gl_FragCoord.xy, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 ) * 6.2831853;
            mat2 rotation = mat2( cos( angle ), sin( angle ), -sin( angle ), cos( angle ) );

            shadow = 0.0;
            for ( int i = 0; i < 32; i ++ ) {
                shadow += texture2DCompare( shadowMap, shadowCoord.xy + rotation * poissonDisk[ i ] * spread, shadowCoord.z );
            }
            shadow *= 0.03125;

        `;

/** Patcht den PCF-Zweig in Three.js' Shadow-Shader (vor dem ersten Rendern). */
export function patchShadowShader(shaderChunkLib) {
    const chunk = shaderChunkLib.shadowmap_pars_fragment;
    const start = chunk.indexOf('#if defined( SHADOWMAP_TYPE_PCF )');
    const end = chunk.indexOf('#elif defined( SHADOWMAP_TYPE_PCF_SOFT )');
    if (start === -1 || end === -1 || end < start) {
        console.warn('PCF-Shader-Patch übersprungen: Shader-Chunk hat unerwartetes Format');
        return;
    }
    shaderChunkLib.shadowmap_pars_fragment =
        chunk.slice(0, start) + PCF_POISSON_BRANCH + chunk.slice(end);
}

patchShadowShader(THREE.ShaderChunk);

/**
 * Klinkt Per-Vertex-Alpha in ein PointsMaterial: ein float-Attribut `aOpacity`
 * (0..1 pro Flocke) moduliert die finale Fragment-Deckkraft. So kann jede
 * Schneeflocke einzeln ein- und ausfaden, obwohl sich alle dasselbe Material
 * teilen. Wird auch im Web-Export verwendet.
 */
export function patchSnowMaterial(material) {
    material.onBeforeCompile = (shader) => {
        shader.vertexShader = 'attribute float aOpacity;\nvarying float vOpacity;\n'
            + shader.vertexShader.replace(
                '#include <begin_vertex>',
                '#include <begin_vertex>\n    vOpacity = aOpacity;'
            );
        shader.fragmentShader = 'varying float vOpacity;\n'
            + shader.fragmentShader.replace(
                '#include <opaque_fragment>',
                'diffuseColor.a *= vOpacity;\n#include <opaque_fragment>'
            );
    };
}

const CLOUD_LIMIT = WORLD_WIDTH * 0.6;  // Zugstrecke (±x): max. 10 % der Modellbreite über den Rand
const CLOUD_FADE_DIST = 20;             // Strecke für Ein-/Ausblenden am Rand
const RAIN_MAX_DROPS = 60;              // Tropfen pro Wolke bei 100 % Regen
const RAIN_FALL_SPEED = 42;             // Fallgeschwindigkeit (Einheiten pro Sekunde)
const RAIN_DROP_LENGTH = 1.4;           // Länge eines Tropfen-Strichs
const LIGHTNING_MAX_SEGMENTS = 90;      // Liniensegmente pro Blitz (Hauptkanal + Äste)
const LIGHTNING_DURATION = 0.3;         // Sichtbarkeitsdauer eines Blitzes in Sekunden
const FOG_MAX_WISPS = 16;               // Nebelschwaden bei 100 % Dichte
const FOG_EDGE_MARGIN = 14;             // Randabstand einer Schwade (bei 100 % Grösse)
const FOG_FADE_DIST = 20;               // Strecke für Ein-/Ausblenden am Rand
const FOG_DRIFT_SPEED = 1.6;            // maximale Driftgeschwindigkeit (Einheiten/s)
const SNOW_MAX_FLAKES = 1400;           // Flockenzahl bei 100 % Schneefall
const SNOW_FALL_SPEED = 3.5;            // Fallgeschwindigkeit (Einheiten pro Sekunde)
const SNOW_DRIFT = 2.2;                 // seitliches Taumeln der Flocken (Amplitude)
const SNOW_FADE_TIME = 2.5;             // Dauer für sanftes Ein-/Ausblenden (Sekunden)
const SNOW_EDGE_INSET = 0.02;           // Sicherheitsabstand zum Kartenrand (Anteil der halben Breite)
const SNOW_BASE_SIZE = 1.1;             // Flockengrösse in Welteinheiten bei 100 %

/** Weisses Textschild mit schwarzem Text und Rahmen für Ortstafeln. */
export function makeLabelCanvas(text) {
    const font = '600 26px system-ui, sans-serif';
    const probe = document.createElement('canvas').getContext('2d');
    probe.font = font;
    const textWidth = Math.max(20, Math.ceil(probe.measureText(text).width));
    const w = textWidth + 28;
    const h = 46;
    const canvas = document.createElement('canvas');
    canvas.width = w * 2;
    canvas.height = h * 2;
    const ctx = canvas.getContext('2d');
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
    return canvas;
}

const LABEL_STICK_HEIGHT = 8;   // Stablänge der Ortstafeln (Szenen-Einheiten)
const LABEL_PLATE_HEIGHT = 3.4; // Höhe des Textschilds
const CONTACT_SHADOW_SIZE = 3.6; // Durchmesser der Kontaktschatten-Kreise
const PATH_TUBE_RADIUS = 0.35;  // Dicke der Weg-Röhren
const PATH_DASH_LENGTH = 1.7;   // Strichlänge gestrichelter Wege
const PATH_DASH_GAP = 1.1;      // Lücke gestrichelter Wege
const PATH_DOT_SPACING = 1.6;   // Punktabstand gepunkteter Wege

/**
 * Ausfadender Kreis für Kontaktschatten unter Markern/Tafeln. Weiss gezeichnet,
 * die Farbe kommt über die Materialfarbe. Härte 100 = scharfe Kante, 0 = weich.
 */
export function makeContactShadowTexture(hardness) {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const inner = 0.1 + 0.75 * (Math.min(100, Math.max(0, hardness)) / 100);
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2 - 2);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(inner, 'rgba(255,255,255,1)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    return canvas;
}

/** Weiche, fleckige Wolkentextur (Radialverläufe auf Canvas). */
function makePuffTexture() {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const blob = (x, y, r, alpha) => {
        const gradient = ctx.createRadialGradient(x, y, 0, x, y, r);
        gradient.addColorStop(0, `rgba(255,255,255,${alpha})`);
        gradient.addColorStop(0.6, `rgba(255,255,255,${alpha * 0.45})`);
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
    return new THREE.CanvasTexture(canvas);
}

/** Sehr weiche, in die Breite gezogene Schwaden-Textur (elliptische Verläufe). */
function makeFogTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    const streak = (x, y, rx, ry, alpha) => {
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(rx / ry, 1);
        const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, ry);
        gradient.addColorStop(0, `rgba(255,255,255,${alpha})`);
        gradient.addColorStop(0.55, `rgba(255,255,255,${alpha * 0.4})`);
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
    return new THREE.CanvasTexture(canvas);
}

/** Runde, weiche Schneeflocke (radialer Verlauf) für die Flocken-Sprites. */
export function makeSnowTexture() {
    const size = 32;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.5, 'rgba(255,255,255,0.85)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    return canvas;
}

// Farbrampe für den Stil "Höhenfarben" (t = 0..1 über den Höhenbereich)
export function hypsoColor(t, isWater) {
    if (isWater) return [0.24, 0.47, 0.66];
    const stops = [
        [0.0, [0.20, 0.52, 0.25]],
        [0.35, [0.65, 0.68, 0.35]],
        [0.65, [0.55, 0.42, 0.28]],
        [0.85, [0.62, 0.60, 0.58]],
        [1.0, [1.0, 1.0, 1.0]],
    ];
    for (let i = 1; i < stops.length; i++) {
        if (t <= stops[i][0]) {
            const [t0, c0] = stops[i - 1];
            const [t1, c1] = stops[i];
            const f = (t - t0) / (t1 - t0);
            return c0.map((v, k) => v + (c1[k] - v) * f);
        }
    }
    return [1, 1, 1];
}

/**
 * Radialer Alphaverlauf (weiss = deckend, schwarz = durchsichtig) für die
 * Bodenplatte: unter dem Modell voll deckend, gegen aussen weich auslaufend.
 */
function makeGroundFadeTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createRadialGradient(256, 256, 0, 256, 256, 256);
    gradient.addColorStop(0.0, '#ffffff');
    gradient.addColorStop(0.12, '#ffffff'); // bis ~240 Einheiten voll deckend
    gradient.addColorStop(0.42, '#000000'); // ab ~840 Einheiten unsichtbar
    gradient.addColorStop(1.0, '#000000');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 512, 512);
    return new THREE.CanvasTexture(canvas);
}

/** Deterministischer Pseudozufall in [0, 1) aus einem Ganzzahl-Index. */
function hash1(i) {
    const s = Math.sin(i * 127.1) * 43758.5453;
    return s - Math.floor(s);
}

/** Deterministisches Wert-Rauschen in ca. [-1, 1] aus Weltkoordinaten. */
function skirtNoise(x, y, z) {
    // Domain-Warp: verhindert, dass die Sinus-Summe als Gittermuster durchscheint
    const w = Math.sin(x * 0.53 + z * 0.71 + y * 0.37) * 1.7;
    return Math.sin(x * 1.7 + z * 2.3 + y * 0.6 + w) * 0.36
        + Math.sin(y * 2.9 + x * 0.8 - z * 1.1 - w) * 0.34
        + Math.sin(z * 3.7 - y * 1.9 + x * 2.9 + w * 0.5) * 0.30;
}

/**
 * Horizontale Auslenkung der Sockelwand (in Szenen-Einheiten) an einer
 * Weltposition — gibt jedem Sockel-Stil eine eigene 3D-Reliefstruktur.
 * Deterministisch, damit die Wand bei Rebuilds (Slider) nicht flackert.
 */
function skirtDisplacement(style, x, y, z) {
    if (style === 'soil') {
        // Erdreich: feinkörnig-buckelig, weich
        return skirtNoise(x * 0.9, y * 0.9, z * 0.9) * 0.35
            + skirtNoise(x * 1.6, y * 1.6, z * 1.6) * 0.16;
    }
    if (style === 'rock') {
        // Fels: grob und kantig — geriffeltes (ridged) Rauschen betont Grate
        const ridge = 1 - Math.abs(skirtNoise(x * 0.35, y * 0.45, z * 0.35));
        return (ridge * 2 - 1) * 0.8 + skirtNoise(x * 1.1, y * 1.1, z * 1.1) * 0.15;
    }
    if (style === 'strata') {
        // Gesteinsschichten: horizontale Bänder springen als Simse vor/zurück
        const wave = Math.sin(x * 0.16 + z * 0.13) * 0.7;
        const band = Math.floor((y + wave) / 2.4);
        return (hash1(band) - 0.5) * 1.8 + skirtNoise(x * 0.9, y * 0.9, z * 0.9) * 0.1;
    }
    return 0; // 'color': glatte Wand
}

export class TerrainViewer {
    constructor(container) {
        this.container = container;
        this.model = null;
        this.options = {
            exaggeration: 1.5,
            basePercent: 15,
            groundOffset: 0,    // Abstand des Modells zum Untergrund in % der Modellbreite
            aoStrength: 60,     // Stärke der gebackenen Umgebungsverdeckung in Prozent
            exposure: 100,      // Belichtung des Tone Mappings in Prozent
            baseColor: '#5c5148',
            baseStyle: 'color', // 'color' | 'soil' | 'rock' | 'strata'
            baseRelief: 100,    // Stärke des Sockel-Reliefs in Prozent (0 = flach)
            groundColor: '#262b36',
            shadowColor: '#000000',
            shadowHardness: 60,
            shadowStrength: 60, // Deckkraft des Schlagschattens in Prozent
            groundVisible: true,
            transparentBackground: false,
            lightRotation: 143, // Azimut in Grad um den Mittelpunkt
            lightElevation: 50, // Höhenwinkel in Grad über dem Horizont
            cloudCount: 6,
            cloudSpeed: 50,   // Prozent
            cloudSize: 100,   // Prozent
            cloudOpacity: 90,  // Deckkraft in Prozent
            cloudColor: '#ffffff', // Grundfarbe der Wolken
            cloudRain: 0,      // Regenstärke in Prozent (0 = kein Regen)
            cloudLightning: 0, // Blitz-Intensität in Prozent (0 = keine Blitze)
            fogDensity: 0,     // Dichte der Nebelschwaden in Prozent (0 = kein Nebel)
            fogSize: 100,      // Grösse der Nebelschwaden in Prozent
            snow: 0,           // Schneefall-Stärke in Prozent (0 = kein Schnee)
            snowSize: 100,     // Grösse der Schneeflocken in Prozent
            envIntensity: ENV_INTENSITY_DEFAULT, // Umgebungslicht (Environment-Map) in Prozent
        };

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x141a26);
        this.scene.fog = new THREE.Fog(0x141a26, 400, 900);

        // far deckt die gesamte Bodenplatte ab (sonst Clipping-Artefakte am Horizont)
        this.perspectiveCamera = new THREE.PerspectiveCamera(50, 1, 0.1, 6000);
        this.perspectiveCamera.position.set(0, 70, 120);
        this.orthoCamera = new THREE.OrthographicCamera(-100, 100, 100, -100, 1, 6000);
        this.camera = this.perspectiveCamera;

        this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: true });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        // PCF statt VSM: bei VSM mischen sich die Tiefen verschiedener
        // Schattenwerfer (Wolken vs. Gelände) und erzeugen helle Säume, wo
        // sich Schatten überlappen. PCF vereinigt Schatten korrekt; weiche
        // Kanten kommen weiterhin über shadow.radius.
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFShadowMap;
        // AgX Tone Mapping: natürlichere Farbwiedergabe als ACES (weniger
        // Sättigungsverschiebung in Grüntönen), saubere Highlights bei Himmel
        // und Schnee ohne hartes Clipping
        this.renderer.toneMapping = THREE.AgXToneMapping;
        this.renderer.toneMappingExposure = this.options.exposure / 100;
        container.appendChild(this.renderer.domElement);

        // Vorberechnete Environment-Map: gibt allen MeshStandardMaterial-Objekten
        // (Gelände, Sockel, Marker, Wege) indirekte Beleuchtung. Einmalig erzeugt,
        // danach ist der PMREMGenerator entbehrlich.
        const pmrem = new THREE.PMREMGenerator(this.renderer);
        this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
        this.scene.environmentIntensity = this.options.envIntensity / 100;
        pmrem.dispose();

        this.attachControls(this.camera);

        this.scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x54492e, 1.1));
        const sun = new THREE.DirectionalLight(0xffffff, 1.6);
        sun.castShadow = true;
        sun.shadow.mapSize.set(4096, 4096);
        sun.shadow.bias = -0.0002;
        sun.shadow.normalBias = 0.5; // gegen Schatten-Akne auf den Hängen (PCF)
        this.sun = sun;
        this.scene.add(sun);
        this.updateSun();

        // Untergrund: einfarbige Bodenplatte plus transparenter "Schattenfänger"
        // darüber (ShadowMaterial färbt nur die beschatteten Bereiche ein).
        // Gross genug, dass alle Kanten hinter der Nebel-Distanz verschwinden.
        const groundGeometry = new THREE.PlaneGeometry(4000, 4000).rotateX(-Math.PI / 2);
        this.groundMesh = new THREE.Mesh(
            groundGeometry,
            new THREE.MeshBasicMaterial({
                color: this.options.groundColor,
                alphaMap: makeGroundFadeTexture(), // fadet gegen aussen aus
                transparent: true,
                depthWrite: false,
            })
        );
        this.groundMesh.position.y = -0.6;
        // Immer als Erstes unter den transparenten Objekten zeichnen: three.js
        // sortiert Transparentes nach Objektursprung, wodurch die riesige Platte
        // je nach Blickwinkel sonst ÜBER die Tafel-Sprites gemalt würde
        this.groundMesh.renderOrder = -2;
        this.scene.add(this.groundMesh);

        // Deckkraft fest auf 1 — die Schattenstärke wird über sun.shadow.intensity
        // geregelt und wirkt damit auch auf den Selbstschatten des Geländes
        this.shadowMesh = new THREE.Mesh(
            groundGeometry,
            new THREE.ShadowMaterial({ color: this.options.shadowColor, opacity: 1 })
        );
        this.shadowMesh.position.y = -0.3;
        this.shadowMesh.receiveShadow = true;
        this.shadowMesh.renderOrder = -1; // wie groundMesh: nie über Sprites malen
        this.scene.add(this.shadowMesh);

        this.setShadowHardness(this.options.shadowHardness);
        this.setShadowStrength(this.options.shadowStrength);
        this.applyEnvironment();

        // Alles, was zum Modell gehört (Gelände, Sockel, Marker, Wege) —
        // diese Gruppe wird auch für den GLB-/Web-Export verwendet
        this.modelGroup = new THREE.Group();
        this.scene.add(this.modelGroup);
        this.overlayGroup = new THREE.Group();
        this.modelGroup.add(this.overlayGroup);

        // { markers: [{id, color, u, v, h}], paths: [{id, color, lineType, runs}], labels: [{id, text, u, v, h}] }
        this.overlays = null;
        this.overlayGeometries = [];
        this.overlayMaterials = [];
        this.overlayTextures = [];
        this.pinConeGeometry = new THREE.ConeGeometry(1.0, 3.4, 20);
        this.pinHeadGeometry = new THREE.SphereGeometry(1.15, 20, 14);
        this.pathDotGeometry = new THREE.SphereGeometry(PATH_TUBE_RADIUS * 1.3, 12, 10);
        this.stickGeometry = new THREE.CylinderGeometry(0.12, 0.12, 1, 6);
        // unbeleuchtet und ohne Tone Mapping: aus jedem Winkel rein weiss
        this.stickMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });

        // Ortstafeln separat: Sprites lassen sich nicht ins GLB exportieren,
        // der Web-Export baut sie zur Laufzeit aus Konfigurationsdaten nach
        this.labelGroup = new THREE.Group();
        this.scene.add(this.labelGroup);

        // Kontaktschatten (ausfadende Kreise) unter Markern und Tafeln —
        // ebenfalls ausserhalb des GLB, der Web-Export baut sie zur Laufzeit
        this.blobGroup = new THREE.Group();
        this.scene.add(this.blobGroup);
        this.blobGeometry = new THREE.PlaneGeometry(CONTACT_SHADOW_SIZE, CONTACT_SHADOW_SIZE);
        this.blobMaterial = new THREE.MeshBasicMaterial({
            transparent: true,
            depthWrite: false,
        });
        this.contactShadowPlacements = [];
        this.updateContactShadowStyle();

        this.backgroundTexture = null;

        // Wolken: weiche Sprite-"Puffs" fürs Aussehen, dazu unsichtbare
        // Kugel-Proxies als Schattenwerfer (Sprites werfen keine Schatten)
        this.cloudGroup = new THREE.Group();
        this.scene.add(this.cloudGroup);
        this.cloudTextures = [makePuffTexture(), makePuffTexture(), makePuffTexture()];
        this.cloudGeometry = new THREE.SphereGeometry(1, 14, 10);
        this.cloudShadowMaterial = new THREE.MeshBasicMaterial({
            colorWrite: false, // im Farbbild unsichtbar, im Schattenpass vorhanden
            depthWrite: false,
        });

        // Regen: pro Wolke ein Bündel fallender Tropfen-Striche (LineSegments in
        // Weltkoordinaten, folgt der Wolke) — Dichte steuert der Regen-Regler
        this.rainGroup = new THREE.Group();
        this.scene.add(this.rainGroup);

        // Nebelschwaden: flache, sehr weiche Sprite-Bänder, die langsam über
        // die unteren Hanglagen driften — Dichte steuert der Nebel-Regler
        this.fogGroup = new THREE.Group();
        this.scene.add(this.fogGroup);
        this.fogTextures = [makeFogTexture(), makeFogTexture()];
        this.fogTime = 0;

        // Blitze: ein wiederverwendeter Zickzack aus Liniensegmenten plus ein
        // gepulstes Punktlicht als Szenen-Flash; Häufigkeit gemäss Blitz-Regler
        this.boltGeometry = new THREE.BufferGeometry();
        this.boltGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(LIGHTNING_MAX_SEGMENTS * 6), 3));
        this.boltGeometry.setDrawRange(0, 0);
        this.boltMesh = new THREE.LineSegments(this.boltGeometry, new THREE.LineBasicMaterial({
            color: 0xeaf2ff,
            transparent: true,
            opacity: 0,
            toneMapped: false, // Blitz bleibt grell, unabhängig vom Tone Mapping
            depthWrite: false,
        }));
        this.boltMesh.visible = false;
        this.boltMesh.frustumCulled = false; // Geometrie ändert sich pro Schlag
        this.scene.add(this.boltMesh);
        this.lightningLight = new THREE.PointLight(0xcfe0ff, 0, 0, 2);
        this.scene.add(this.lightningLight);
        this.boltActive = false;
        this.boltTime = 0;
        this.lightningCooldown = 0;
        this.flashCloud = null;

        // Schnee: szenenweit taumelnde Flocken (Points) über der Modellgrundfläche.
        // Nicht an Wolken gebunden — Schnee fällt auch bei klarem Himmel. Jede
        // Flocke hat ihre eigene Deckkraft (Per-Vertex-Alpha über das Attribut
        // aOpacity, siehe patchSnowMaterial), damit sie beim Erscheinen einzeln
        // einfaden kann statt schlagartig aufzupoppen.
        this.snowMaterial = new THREE.PointsMaterial({
            map: new THREE.CanvasTexture(makeSnowTexture()),
            color: 0xffffff,
            size: SNOW_BASE_SIZE * (this.options.snowSize / 100),
            sizeAttenuation: true,
            transparent: true,
            opacity: 1,
            depthWrite: false,
            toneMapped: false,
        });
        patchSnowMaterial(this.snowMaterial);
        this.snowGeometry = new THREE.BufferGeometry();
        this.snowGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SNOW_MAX_FLAKES * 3), 3));
        this.snowGeometry.setAttribute('aOpacity', new THREE.BufferAttribute(new Float32Array(SNOW_MAX_FLAKES), 1));
        this.snowGeometry.setDrawRange(0, 0);
        this.snowPoints = new THREE.Points(this.snowGeometry, this.snowMaterial);
        this.snowPoints.frustumCulled = false; // Positionen ändern sich pro Frame
        this.snowPoints.visible = false;
        this.scene.add(this.snowPoints);
        this.snowFlakes = []; // { baseX, baseZ, y, speed, phase, drift, fade, maxOpacity }
        this.snowTime = 0;

        this.terrainMesh = null;
        this.skirtMesh = null;

        new ResizeObserver(() => this.resize()).observe(container);
        this.resize();

        this.clock = new THREE.Clock();
        this.renderer.setAnimationLoop(() => {
            const delta = this.clock.getDelta();
            this.animateClouds(delta);
            this.animateLightning(delta);
            this.animateFog(delta);
            this.animateSnow(delta);
            this.clampOrbitAboveGround();
            this.controls.update();
            this.renderer.render(this.scene, this.camera);
        });
    }

    /**
     * Begrenzt die Orbit-Neigung so, dass die Kamera nie unter die 0-Ebene
     * (Modellboden) gerät. Der zulässige Polarwinkel hängt von Zielhöhe und
     * Abstand ab (camera.y = target.y + r·cos φ ≥ 0) und wird deshalb pro
     * Frame neu berechnet — er ändert sich mit Zoom und Verschieben.
     */
    clampOrbitAboveGround() {
        const target = this.controls.target;
        const r = this.camera.position.distanceTo(target) || 1;
        this.controls.maxPolarAngle = Math.acos(Math.min(1, Math.max(-1, -target.y / r)));
    }

    /** OrbitControls an die aktive Kamera binden (Ziel bleibt erhalten). */
    attachControls(camera) {
        const target = this.controls?.target.clone();
        this.controls?.dispose();
        this.controls = new OrbitControls(camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.enablePan = false; // kein Verschieben (Maus + Zwei-Finger) — das Modell bleibt zentriert
        if (camera.isOrthographicCamera) {
            this.controls.minZoom = 0.3;
            this.controls.maxZoom = 10;
        } else {
            this.controls.maxDistance = 600;
        }
        if (target) this.controls.target.copy(target);
    }

    resize() {
        const w = this.container.clientWidth;
        const h = this.container.clientHeight;
        if (w === 0 || h === 0) return;
        this.perspectiveCamera.aspect = w / h;
        this.perspectiveCamera.updateProjectionMatrix();
        this.updateOrthoFrustum();
        this.renderer.setSize(w, h);
        this.updateBackgroundCover();
    }

    /** Sichtfeld der Iso-Kamera an Modellgrösse und Fensterformat anpassen. */
    updateOrthoFrustum() {
        const w = this.container.clientWidth;
        const h = Math.max(1, this.container.clientHeight);
        const aspect = w / h;
        const peak = this.model ? this.currentPeakY() : 50;
        const fit = Math.max(WORLD_WIDTH, this.worldDepth || WORLD_WIDTH, peak * 2) * 1.15;
        this.orthoCamera.top = fit / 2;
        this.orthoCamera.bottom = -fit / 2;
        this.orthoCamera.left = (-fit * aspect) / 2;
        this.orthoCamera.right = (fit * aspect) / 2;
        this.orthoCamera.updateProjectionMatrix();
    }

    /** Aktuelle Kameraansicht (Position, Ziel, Zoom) auslesen. */
    getCameraView() {
        return {
            position: this.camera.position.toArray(),
            target: this.controls.target.toArray(),
            zoom: this.camera.zoom,
        };
    }

    /** Gespeicherte Kameraansicht auf die aktive Kamera anwenden. */
    setCameraView(view) {
        if (!view?.position || !view?.target) return;
        this.camera.position.fromArray(view.position);
        this.controls.target.fromArray(view.target);
        if (this.camera.isOrthographicCamera) {
            this.camera.zoom = view.zoom || 1;
            this.camera.updateProjectionMatrix();
        }
        this.controls.update();
    }

    /**
     * Zwischen isometrischer (orthografischer) und perspektivischer Ansicht
     * wechseln. Die Perspektiv-Kamera behält ihre Position, sodass "zurück"
     * exakt zur vorherigen Ansicht führt.
     */
    setIsometric(enabled) {
        this.options.isometric = enabled;
        if (enabled) {
            this.updateOrthoFrustum();
            const target = this.controls.target;
            const distance = 250; // nah genug, damit der Nebel das Modell nicht erfasst
            const elevation = Math.atan(1 / Math.sqrt(2)); // klassischer Iso-Winkel (~35.26°)
            const azimuth = Math.PI / 4;
            this.orthoCamera.position.set(
                target.x + Math.cos(azimuth) * Math.cos(elevation) * distance,
                target.y + Math.sin(elevation) * distance,
                target.z + Math.sin(azimuth) * Math.cos(elevation) * distance
            );
            this.orthoCamera.zoom = 1;
            this.orthoCamera.updateProjectionMatrix();
            this.camera = this.orthoCamera;
        } else {
            this.camera = this.perspectiveCamera;
        }
        this.attachControls(this.camera);
    }

    /**
     * Hintergrundbild wie CSS "cover" einpassen: füllt die Fläche, wird
     * beschnitten statt gestreckt oder gestaucht.
     */
    updateBackgroundCover() {
        const texture = this.backgroundTexture;
        if (!texture?.image) return;
        const canvasAspect = this.container.clientWidth / Math.max(1, this.container.clientHeight);
        const imageAspect = texture.image.width / texture.image.height;
        if (imageAspect > canvasAspect) {
            const repeat = canvasAspect / imageAspect;
            texture.repeat.set(repeat, 1);
            texture.offset.set((1 - repeat) / 2, 0);
        } else {
            const repeat = imageAspect / canvasAspect;
            texture.repeat.set(1, repeat);
            texture.offset.set(0, (1 - repeat) / 2);
        }
    }

    /**
     * @param mesh    Geländenetz aus mesh.js (positionsXY, heights, uvs, indices, boundary)
     * @param options { texture: ImageBitmap|null, exaggeration, basePercent,
     *                  aoGrid: { data, gridW, gridH } | undefined }
     */
    build(mesh, options) {
        this.dispose();
        this.model = mesh;
        this.options = { ...this.options, ...options };

        const { positionsXY, heights, uvs, indices, widthMeters, depthMeters } = mesh;
        this.worldScale = WORLD_WIDTH / widthMeters;
        this.worldDepth = depthMeters * this.worldScale;

        let min = Infinity;
        let max = -Infinity;
        for (const h of heights) {
            if (h < min) min = h;
            if (h > max) max = h;
        }
        this.minHeight = min;
        this.maxHeight = max;

        // Szenenkoordinaten: x = Ost, y = Höhe, z = Süd (Norden zeigt nach -z)
        const positions = new Float32Array(heights.length * 3);
        for (let i = 0; i < heights.length; i++) {
            positions[i * 3] = positionsXY[i * 2] * this.worldScale;
            positions[i * 3 + 2] = -positionsXY[i * 2 + 1] * this.worldScale;
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('uv', new THREE.BufferAttribute(Float32Array.from(uvs), 2));
        geometry.setIndex(new THREE.BufferAttribute(Uint32Array.from(indices), 1));

        // Gebackene Umgebungsverdeckung: Sichtbarkeit pro Vertex, bilinear aus
        // dem AO-Raster abgetastet (Rasterzeile 0 = Norden, wie sampleHeight)
        this.vertexAO = null;
        this.baseVertexColors = null;
        if (this.options.aoGrid) {
            const { data, gridW, gridH } = this.options.aoGrid;
            const ao = new Float32Array(heights.length);
            for (let i = 0; i < heights.length; i++) {
                const fx = Math.min(Math.max(uvs[i * 2], 0), 1) * (gridW - 1);
                const fy = (1 - Math.min(Math.max(uvs[i * 2 + 1], 0), 1)) * (gridH - 1);
                const x0 = Math.min(Math.floor(fx), gridW - 2);
                const y0 = Math.min(Math.floor(fy), gridH - 2);
                const tx = fx - x0;
                const ty = fy - y0;
                ao[i] = (data[y0 * gridW + x0] * (1 - tx) + data[y0 * gridW + x0 + 1] * tx) * (1 - ty)
                    + (data[(y0 + 1) * gridW + x0] * (1 - tx) + data[(y0 + 1) * gridW + x0 + 1] * tx) * ty;
            }
            this.vertexAO = ao;
        }

        let material;
        if (this.options.texture) {
            // ImageBitmap-Uploads ignorieren texture.flipY (WebGL-Spezifikation),
            // die Textur stünde sonst Nord-Süd gespiegelt auf dem Gelände.
            // Über ein 2D-Canvas geht der Upload den Pfad, bei dem flipY greift.
            const img = this.options.texture;
            const cnv = document.createElement('canvas');
            cnv.width = img.width;
            cnv.height = img.height;
            cnv.getContext('2d').drawImage(img, 0, 0);
            const tex = new THREE.CanvasTexture(cnv);
            tex.colorSpace = THREE.SRGBColorSpace;
            tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
            material = new THREE.MeshStandardMaterial({
                map: tex,
                vertexColors: true, // trägt die AO-Abdunklung
                roughness: 0.95,
                metalness: 0,
            });
        } else {
            const colors = new Float32Array(heights.length * 3);
            const range = Math.max(1, max - min);
            for (let i = 0; i < heights.length; i++) {
                const [r, g, b] = hypsoColor((heights[i] - min) / range, heights[i] <= 0);
                colors[i * 3] = r;
                colors[i * 3 + 1] = g;
                colors[i * 3 + 2] = b;
            }
            this.baseVertexColors = colors;
            material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
        }

        // Vertexfarben = (Hypso-Farbe ×) AO — applyAOColors() füllt die Werte.
        // Sie wandern als COLOR_0 mit ins GLB und damit in den Web-Export.
        geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(heights.length * 3), 3));

        this.terrainMesh = new THREE.Mesh(geometry, material);
        this.terrainMesh.name = 'gelaende'; // Name bleibt im GLB-Export erhalten
        this.terrainMesh.castShadow = true;
        this.terrainMesh.receiveShadow = true; // Selbstschatten: Gipfel werfen Schatten ins Tal
        this.modelGroup.add(this.terrainMesh);
        this.applyAOColors();

        const baseMaps = this.baseMaps(this.options.baseStyle);
        this.skirtMesh = new THREE.Mesh(
            new THREE.BufferGeometry(),
            new THREE.MeshStandardMaterial({
                color: this.options.baseColor,
                map: baseMaps.map,
                normalMap: baseMaps.normalMap,
                normalScale: new THREE.Vector2(SKIRT_NORMAL_SCALE, SKIRT_NORMAL_SCALE),
                // leicht unter 1: die Normal-Map soll Struktur zeigen können,
                // statt in vollständig mattem Grau zu verschwinden
                roughness: 0.85,
                side: THREE.DoubleSide,
            })
        );
        this.skirtMesh.name = 'sockel';
        this.skirtMesh.castShadow = true;
        this.skirtMesh.receiveShadow = true;
        this.modelGroup.add(this.skirtMesh);

        this.updateHeights();
        this.applyGroundOffset();
        this.updateShadowFit();

        const peakY = this.currentPeakY();

        const dist = Math.max(WORLD_WIDTH, this.worldDepth, peakY * 1.6);
        this.perspectiveCamera.position.set(0, Math.max(dist * 0.65, peakY * 1.3), dist * 1.1);
        this.controls.target.set(0, peakY * 0.35, 0);
        if (this.options.isometric) this.setIsometric(true); // Iso-Kamera neu einpassen

        this.rebuildClouds();
        this.rebuildFog();
        this.rebuildSnow();
    }

    baseThickness() {
        return (this.options.basePercent / 100) * 0.25 * WORLD_WIDTH;
    }

    /** Abstand des Modells zum Untergrund in Szenen-Einheiten. */
    groundOffsetY() {
        return ((this.options.groundOffset ?? 0) / 100) * WORLD_WIDTH;
    }

    /** Hebt das gesamte Modell (samt Tafeln und Kontaktschatten) über den Boden. */
    applyGroundOffset() {
        const y = this.groundOffsetY();
        this.modelGroup.position.y = y;
        this.labelGroup.position.y = y;
        this.blobGroup.position.y = y;
    }

    setGroundOffset(percent) {
        const previousY = this.groundOffsetY();
        this.options.groundOffset = percent;
        const delta = this.groundOffsetY() - previousY;
        this.applyGroundOffset();
        // Kamera und Orbit-Ziel im gleichen Mass mitheben: das Modell bleibt
        // an derselben Stelle im Bild, nur Untergrund und Abstand ändern sich
        this.controls.target.y += delta;
        this.perspectiveCamera.position.y += delta;
        this.orthoCamera.position.y += delta;
        this.updateCloudAltitude();
        this.updateShadowFit();
        this.updateOrthoFrustum();
    }

    /** Schatten-Kamera und Schattenfänger auf die Modellausdehnung einpassen. */
    updateShadowFit() {
        if (!this.model) return;
        const extent = Math.max(WORLD_WIDTH, this.worldDepth, this.currentPeakY()) * 0.8 + 30;
        const shadowCam = this.sun.shadow.camera;
        shadowCam.left = -extent;
        shadowCam.right = extent;
        shadowCam.top = extent;
        shadowCam.bottom = -extent;
        shadowCam.near = 1;
        shadowCam.far = 1200; // deckt auch flache Lichtwinkel mit langen Schatten ab
        shadowCam.updateProjectionMatrix();

        this.shadowExtent = extent;
        this.updateShadowCatcher();
    }

    /** Überträgt Höhen (inkl. Überhöhung und Sockel) auf die Geometrie. */
    updateHeights() {
        if (!this.terrainMesh) return;
        const { heights } = this.model;
        const scale = this.worldScale * this.options.exaggeration;
        const base = this.baseThickness();
        const pos = this.terrainMesh.geometry.attributes.position;
        for (let i = 0; i < heights.length; i++) {
            pos.setY(i, (heights[i] - this.minHeight) * scale + base);
        }
        pos.needsUpdate = true;
        this.terrainMesh.geometry.computeVertexNormals();
        this.rebuildSkirt();
        this.rebuildOverlays();
        this.updateCloudAltitude();
    }

    /** Höhe des höchsten Geländepunkts in Szenen-Einheiten (inkl. Sockel und Bodenabstand). */
    currentPeakY() {
        return (this.maxHeight - this.minHeight) * this.worldScale * this.options.exaggeration
            + this.baseThickness() + this.groundOffsetY();
    }

    /** Marker und Wege setzen; Punkte als { u, v, h } relativ zur Bbox. */
    setOverlays(overlays) {
        this.overlays = overlays;
        this.rebuildOverlays();
    }

    /**
     * Baut Marker-Pins und Weg-Röhren auf der aktuellen Geländeoberfläche.
     * Jedes Element bekommt eine benannte Gruppe (marker-<id> / weg-<id>) —
     * die Namen bleiben im GLB-/Web-Export erhalten und dienen dort als
     * Schnittstelle zum Ein-/Ausblenden.
     */
    rebuildOverlays() {
        for (const geometry of this.overlayGeometries) geometry.dispose();
        for (const material of this.overlayMaterials) material.dispose();
        for (const texture of this.overlayTextures) texture.dispose();
        this.overlayGeometries = [];
        this.overlayMaterials = [];
        this.overlayTextures = [];
        this.overlayGroup.clear();
        this.labelGroup.clear();
        this.blobGroup.clear();
        this.contactShadowPlacements = [];
        if (!this.model || !this.overlays) return;

        const scale = this.worldScale * this.options.exaggeration;
        const base = this.baseThickness();
        const worldPoint = (p) => new THREE.Vector3(
            (p.u - 0.5) * WORLD_WIDTH,
            (p.h - this.minHeight) * scale + base,
            -((p.v - 0.5) * this.worldDepth)
        );

        // Kontaktschatten: an die Hangneigung angepasster, ausfadender Kreis
        // exakt am Fusspunkt. Neigung analytisch aus dem Höhenraster (slope).
        const addContactShadow = (point) => {
            const pos = worldPoint(point);
            const [dhdx, dhdy] = point.slope ?? [0, 0];
            const normal = new THREE.Vector3(
                -dhdx * this.options.exaggeration,
                1,
                dhdy * this.options.exaggeration
            ).normalize();
            const blob = new THREE.Mesh(this.blobGeometry, this.blobMaterial);
            blob.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
            blob.position.copy(pos).addScaledVector(normal, 0.12);
            this.blobGroup.add(blob);
            this.contactShadowPlacements.push({
                position: blob.position.toArray(),
                normal: normal.toArray(),
            });
        };

        for (const marker of this.overlays.markers) {
            const material = new THREE.MeshStandardMaterial({ color: marker.color, roughness: 0.5 });
            this.overlayMaterials.push(material);
            const group = new THREE.Group();
            group.name = `marker-${marker.id}`;
            const pos = worldPoint(marker);
            const cone = new THREE.Mesh(this.pinConeGeometry, material);
            cone.rotation.x = Math.PI; // Spitze nach unten auf die Oberfläche
            cone.position.set(pos.x, pos.y + 1.7, pos.z);
            cone.castShadow = true;
            const head = new THREE.Mesh(this.pinHeadGeometry, material);
            head.position.set(pos.x, pos.y + 3.6, pos.z);
            head.castShadow = true;
            group.add(cone, head);
            this.overlayGroup.add(group);
            addContactShadow(marker);
        }

        for (const label of this.overlays.labels ?? []) {
            const group = new THREE.Group();
            group.name = `tafel-${label.id}`;
            const pos = worldPoint(label);

            const stick = new THREE.Mesh(this.stickGeometry, this.stickMaterial);
            stick.position.set(pos.x, pos.y + LABEL_STICK_HEIGHT / 2, pos.z);
            stick.scale.set(1, LABEL_STICK_HEIGHT, 1);
            stick.castShadow = true;

            const canvas = makeLabelCanvas(label.text);
            const texture = new THREE.CanvasTexture(canvas);
            texture.colorSpace = THREE.SRGBColorSpace;
            this.overlayTextures.push(texture);
            const material = new THREE.SpriteMaterial({
                map: texture,
                transparent: true,
                depthWrite: false,
                toneMapped: false, // Schild bleibt rein weiss/schwarz
            });
            this.overlayMaterials.push(material);
            const plate = new THREE.Sprite(material);
            plate.scale.set(LABEL_PLATE_HEIGHT * (canvas.width / canvas.height), LABEL_PLATE_HEIGHT, 1);
            plate.position.set(pos.x, pos.y + LABEL_STICK_HEIGHT + LABEL_PLATE_HEIGHT / 2 - 0.2, pos.z);

            group.add(stick, plate);
            this.labelGroup.add(group);
            addContactShadow(label);
        }

        for (const path of this.overlays.paths) {
            const material = new THREE.MeshStandardMaterial({ color: path.color, roughness: 0.6 });
            this.overlayMaterials.push(material);
            const group = new THREE.Group();
            group.name = `weg-${path.id}`;
            const addTube = (curve, segments) => {
                const geometry = new THREE.TubeGeometry(curve, segments, PATH_TUBE_RADIUS, 8, false);
                this.overlayGeometries.push(geometry);
                const tube = new THREE.Mesh(geometry, material);
                tube.castShadow = true;
                group.add(tube);
            };
            for (const run of path.runs) {
                if (run.length < 2) continue;
                const points = run.map((p) => {
                    const v = worldPoint(p);
                    v.y += 0.4; // leicht über der Oberfläche, verhindert Z-Fighting
                    return v;
                });
                const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
                if (path.lineType === 'dotted') {
                    // Kugeln in gleichmässigen Abständen entlang der Bogenlänge
                    const count = Math.max(1, Math.round(curve.getLength() / PATH_DOT_SPACING));
                    for (let i = 0; i <= count; i++) {
                        const dot = new THREE.Mesh(this.pathDotGeometry, material);
                        dot.position.copy(curve.getPointAt(i / count));
                        dot.castShadow = true;
                        group.add(dot);
                    }
                } else if (path.lineType === 'dashed') {
                    // Teilung so runden, dass der Weg mit einem Strich beginnt und endet
                    const length = curve.getLength();
                    const n = Math.max(1, Math.round(
                        (length + PATH_DASH_GAP) / (PATH_DASH_LENGTH + PATH_DASH_GAP)));
                    const dash = (length - (n - 1) * PATH_DASH_GAP) / n;
                    for (let i = 0; i < n; i++) {
                        const t0 = (i * (dash + PATH_DASH_GAP)) / length;
                        const t1 = Math.min(1, t0 + dash / length);
                        const steps = Math.max(2, Math.ceil(dash * 2));
                        const seg = [];
                        for (let k = 0; k <= steps; k++) {
                            seg.push(curve.getPointAt(t0 + ((t1 - t0) * k) / steps));
                        }
                        addTube(new THREE.CatmullRomCurve3(seg, false, 'centripetal'), steps);
                    }
                } else {
                    addTube(curve, Math.max(16, points.length * 2));
                }
            }
            this.overlayGroup.add(group);
        }
    }

    /** Basis-Flughöhe der Wolken, knapp über dem höchsten Gipfel. */
    cloudBaseY() {
        return this.currentPeakY() + 10;
    }

    /** Untere Nebelgrenze: knapp über der Sockeloberkante. */
    fogBaseY() {
        return this.groundOffsetY() + this.baseThickness() + 1;
    }

    /** Höhe des Bandes, in dem die Nebelschwaden treiben (untere Hanglagen). */
    fogBandHeight() {
        return Math.max(4, (this.currentPeakY() - this.fogBaseY()) * 0.35);
    }

    fogSizeFactor() {
        return Math.max(0.1, this.options.fogSize / 100);
    }

    /**
     * Bewegungsraum der Schwaden: Modellgrundfläche minus Randabstand, damit
     * auch grosse Schwaden vollständig über dem Gelände bleiben und nicht
     * über die Kante hinausragen.
     */
    fogXLimit() {
        return Math.max(6, WORLD_WIDTH / 2 - FOG_EDGE_MARGIN * this.fogSizeFactor());
    }

    fogZHalf() {
        return Math.max(2, this.worldDepth / 2 - FOG_EDGE_MARGIN * this.fogSizeFactor());
    }

    /** Liegt (x, z) innerhalb der um den Randabstand geschrumpften Grundform? */
    fogInsideShape(x, z) {
        const halfW = WORLD_WIDTH / 2;
        const halfD = this.worldDepth / 2;
        const margin = FOG_EDGE_MARGIN * this.fogSizeFactor();
        const kx = Math.max(0.1, 1 - margin / halfW);
        const kz = Math.max(0.1, 1 - margin / halfD);
        return insideShape((x / halfW) / kx, (-z / halfD) / kz, this.options.shape ?? 'rect');
    }

    /** Geländeoberfläche (Szenen-Y) an der Position (x, z); Basis für die Schwadenhöhe. */
    fogGroundY(x, z) {
        const grid = this.options.heightGrid;
        if (!grid) return this.fogBaseY();
        const u = x / WORLD_WIDTH + 0.5;
        const v = 0.5 - z / this.worldDepth;
        const h = sampleHeight(grid, u, v);
        return (h - this.minHeight) * this.worldScale * this.options.exaggeration
            + this.baseThickness() + this.groundOffsetY();
    }

    /**
     * Kompaktes Höhenfeld der Geländeoberfläche (Szenen-Y) über der ganzen
     * Grundfläche — der Web-Export nutzt es, um die Schwaden dem Gelände
     * folgen zu lassen (das GLB selbst hat kein Höhenraster).
     */
    getFogHeightField() {
        if (!this.options.heightGrid) return null;
        const gridW = 48;
        const gridH = 48;
        const data = new Array(gridW * gridH);
        for (let r = 0; r < gridH; r++) {
            for (let c = 0; c < gridW; c++) {
                const x = (c / (gridW - 1) - 0.5) * WORLD_WIDTH;
                const z = (r / (gridH - 1) - 0.5) * this.worldDepth;
                data[r * gridW + c] = Math.round(this.fogGroundY(x, z) * 10) / 10;
            }
        }
        return { gridW, gridH, data };
    }

    /**
     * Setzt eine Schwade an eine gültige Position innerhalb der Grundform.
     * atEntry: an die westliche Eintrittskante (Drift geht nach Osten) —
     * dort blendet sie über die Driftstrecke ein statt aufzupoppen.
     */
    fogRespawn(wisp, atEntry) {
        const xLimit = this.fogXLimit();
        const zHalf = this.fogZHalf();
        const data = wisp.userData;
        data.heightFraction = Math.random();
        for (let attempt = 0; attempt < 30; attempt++) {
            const z = (Math.random() * 2 - 1) * zHalf;
            let x = atEntry ? -xLimit : (Math.random() * 2 - 1) * xLimit;
            // Bei Kreis/Sechseck liegt die Eintrittskante je nach z weiter innen
            while (atEntry && x < xLimit && !this.fogInsideShape(x, z)) x += 3;
            if (this.fogInsideShape(x, z)) {
                wisp.position.x = x;
                wisp.position.z = z;
                // Einblenden ab Eintrittskante; bei freier Platzierung sofort voll da
                data.entryX = atEntry ? x : x - FOG_FADE_DIST;
                return;
            }
        }
        wisp.position.set(0, this.fogBaseY(), 0); // Rückfall: Mitte ist immer gültig
        data.entryX = -FOG_FADE_DIST;
    }

    /**
     * Eine Wolke: mehrere weiche, texturierte Sprite-"Puffs" (Aussehen) plus
     * unsichtbare Kugel-Proxies, die den Wolkenschatten werfen.
     */
    makeCloud() {
        const cloud = new THREE.Group();

        const material = new THREE.SpriteMaterial({
            map: this.cloudTextures[Math.floor(Math.random() * this.cloudTextures.length)],
            transparent: true,
            opacity: 0, // startet ausgeblendet, animateClouds() blendet ein
            depthWrite: false,
            rotation: (Math.random() - 0.5) * 0.6,
        });
        cloud.userData.baseShade = 0.94 + Math.random() * 0.06; // leichte Helligkeitsvariation
        // Grundfarbe pro Wolke leicht abgedunkelt merken; animateClouds/-Lightning
        // setzen die Materialfarbe daraus (Blitz-Aufleuchten addiert darauf).
        cloud.userData.baseColor = new THREE.Color(this.options.cloudColor)
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
            const proxy = new THREE.Mesh(this.cloudGeometry, this.cloudShadowMaterial);
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

    /**
     * Regen unter einer Wolke: kurze, fallende Linien in Weltkoordinaten.
     * Die Tropfen aktualisiert animateRain() pro Frame; über den drawRange
     * wird nur der der Regenstärke entsprechende Anteil gezeichnet.
     */
    makeRain() {
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
        const spread = 7 * (this.options.cloudSize / 100);
        rain.userData.drops = Array.from({ length: RAIN_MAX_DROPS }, () => ({
            x: (Math.random() - 0.5) * 2 * spread,
            z: (Math.random() - 0.5) * spread,
            y: Math.random() * this.cloudBaseY(),
            speed: 0.75 + Math.random() * 0.5,
        }));
        return rain;
    }

    /** Baut die Wolkendecke (samt Regen) gemäss Anzahl/Grösse neu auf. */
    rebuildClouds() {
        this.endLightning(); // Quellwolke eines aktiven Blitzes verschwindet gleich
        for (const cloud of this.cloudGroup.children) {
            cloud.userData.material?.dispose();
        }
        this.cloudGroup.clear();
        for (const rain of this.rainGroup.children) {
            rain.geometry.dispose();
            rain.material.dispose();
        }
        this.rainGroup.clear();
        if (!this.model || this.options.cloudCount <= 0) return;

        for (let i = 0; i < this.options.cloudCount; i++) {
            const cloud = this.makeCloud();
            cloud.userData.speedFactor = 0.7 + Math.random() * 0.6;
            cloud.userData.heightOffset = Math.random() * 14;
            cloud.userData.spawnFade = 0; // sanftes Erscheinen nach (Neu-)Aufbau
            cloud.scale.setScalar(this.options.cloudSize / 100);
            cloud.position.set(
                (Math.random() * 2 - 1) * CLOUD_LIMIT,
                this.cloudBaseY() + cloud.userData.heightOffset,
                (Math.random() - 0.5) * this.worldDepth * 0.9
            );
            this.cloudGroup.add(cloud);
            const rain = this.makeRain();
            cloud.userData.rain = rain;
            this.rainGroup.add(rain);
        }
    }

    /**
     * Eine Nebelschwade: wenige breite, sehr weiche Sprites, die zusammen ein
     * flaches Band ergeben. Wirft keinen Schatten und ist nicht Teil des GLB
     * (der Web-Viewer baut die Schwaden zur Laufzeit nach).
     */
    makeFogWisp() {
        const wisp = new THREE.Group();
        const material = new THREE.SpriteMaterial({
            map: this.fogTextures[Math.floor(Math.random() * this.fogTextures.length)],
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

    /**
     * Baut den Schwaden-Vorrat neu auf. Es entstehen immer FOG_MAX_WISPS
     * Schwaden; wie viele davon sichtbar sind, steuert der Dichte-Regler
     * pro Frame in animateFog() — so flackert beim Schieben nichts.
     */
    rebuildFog() {
        for (const wisp of this.fogGroup.children) {
            wisp.userData.material?.dispose();
        }
        this.fogGroup.clear();
        if (!this.model) return;
        for (let i = 0; i < FOG_MAX_WISPS; i++) {
            const wisp = this.makeFogWisp();
            wisp.userData.speedFactor = 0.5 + Math.random() * 0.7;
            wisp.userData.phase = Math.random() * Math.PI * 2;
            wisp.userData.fade = 0;
            wisp.scale.setScalar(this.fogSizeFactor());
            wisp.position.y = this.fogBaseY();
            this.fogRespawn(wisp, false);
            this.fogGroup.add(wisp);
        }
    }

    /**
     * Schwaden driften langsam von West nach Ost, schmiegen sich an die
     * Geländeoberfläche und wabern dabei leicht in Höhe und Deckkraft.
     * Höhe wird pro Frame berechnet und folgt damit auch Überhöhungs-,
     * Sockel- und Bodenabstands-Änderungen automatisch.
     */
    animateFog(delta) {
        const wisps = this.fogGroup.children;
        if (!wisps.length) return;
        const density = Math.min(100, Math.max(0, this.options.fogDensity));
        const active = Math.ceil(wisps.length * (density / 100));
        this.fogTime += delta;
        const sizeFactor = this.fogSizeFactor();
        const xLimit = this.fogXLimit();
        const zHalf = this.fogZHalf();
        const fadeDist = Math.min(FOG_FADE_DIST, xLimit);
        const maxOpacity = 0.4 * Math.sqrt(density / 100);
        for (let i = 0; i < wisps.length; i++) {
            const wisp = wisps[i];
            const data = wisp.userData;
            // sanftes Ein-/Ausblenden, wenn der Regler die Anzahl ändert
            data.fade = Math.min(1, Math.max(0, data.fade + (i < active ? delta : -delta) / 2.5));
            if (data.fade <= 0) {
                wisp.visible = false;
                continue;
            }
            wisp.visible = true;
            wisp.position.x += FOG_DRIFT_SPEED * data.speedFactor * delta;
            // Grössenänderung verkleinert den Bewegungsraum — zurückführen
            wisp.position.z = Math.max(-zHalf, Math.min(zHalf, wisp.position.z));
            if (wisp.position.x > xLimit || !this.fogInsideShape(wisp.position.x, wisp.position.z)) {
                this.fogRespawn(wisp, true);
            }
            // Über der Geländeoberfläche schweben (leicht wabernd)
            wisp.position.y = this.fogGroundY(wisp.position.x, wisp.position.z)
                + (1.5 + data.heightFraction * 3) * sizeFactor
                + Math.sin(this.fogTime * 0.25 + data.phase) * 0.7;
            // Abstand zur Austrittskante in Driftrichtung (Kreis/Sechseck: sondieren)
            let distToExit = Math.min(fadeDist, xLimit - wisp.position.x);
            for (let d = 3; d < distToExit; d += 3) {
                if (!this.fogInsideShape(wisp.position.x + d, wisp.position.z)) {
                    distToExit = d;
                    break;
                }
            }
            const positionFade = Math.max(0, Math.min(
                1,
                (wisp.position.x - data.entryX) / fadeDist,
                distToExit / fadeDist
            ));
            // leichtes An- und Abschwellen, damit die Schwaden lebendig wirken
            const pulse = 0.75 + 0.25 * Math.sin(this.fogTime * 0.4 + data.phase * 1.7);
            data.material.opacity = maxOpacity * data.fade * positionFade * pulse;
        }
    }

    /**
     * Obere Grenze des Schneefalls (Flocken starten knapp über dem Gipfel bzw.
     * über der Wolkenbasis, damit Schnee auch aus den Wolken zu kommen scheint).
     */
    snowTopY() {
        return this.cloudBaseY() + 8;
    }

    /**
     * Liegt (x, z) innerhalb der Modell-Grundform (Rechteck/Kreis/Sechseck)?
     * Die Form wird um SNOW_EDGE_INSET einwärts geschrumpft (Division der
     * normierten Koordinaten), damit die Flocken einen Sicherheitsabstand zum
     * Kartenrand halten und keine über die Kante hinausragt.
     */
    snowInsideShape(x, z) {
        const k = 1 - SNOW_EDGE_INSET;
        return insideShape(
            (x / (WORLD_WIDTH / 2)) / k,
            (-z / (this.worldDepth / 2)) / k,
            this.options.shape ?? 'rect'
        );
    }

    /** Zufällige (x, z)-Position innerhalb der Grundform (für Spawn/Respawn). */
    snowRandomXZ() {
        const halfW = WORLD_WIDTH / 2;
        const halfD = this.worldDepth / 2;
        for (let attempt = 0; attempt < 30; attempt++) {
            const x = (Math.random() * 2 - 1) * halfW;
            const z = (Math.random() * 2 - 1) * halfD;
            if (this.snowInsideShape(x, z)) return { x, z };
        }
        return { x: 0, z: 0 }; // Rückfall: Mitte liegt immer innerhalb
    }

    /**
     * Baut den Flocken-Vorrat für die aktuelle Modellgrösse neu auf. Es gibt
     * immer SNOW_MAX_FLAKES Flocken; wie viele gezeichnet werden, steuert der
     * Regler pro Frame über den drawRange — so flackert beim Schieben nichts.
     * Die Flocken fallen nur innerhalb der Grundform (nicht über den Rand): die
     * seitliche Taumel-Amplitude (SNOW_DRIFT) wird beim Innen-Test einbezogen,
     * damit auch die ausgelenkte Position drinnen bleibt.
     */
    rebuildSnow() {
        if (!this.model) return;
        const top = this.snowTopY();
        const floor = this.groundOffsetY();
        this.snowFlakes = Array.from({ length: SNOW_MAX_FLAKES }, () => {
            const { x, z } = this.snowRandomXZ();
            return {
                baseX: x,
                baseZ: z,
                y: floor + Math.random() * (top - floor),
                speed: 0.6 + Math.random() * 0.8,
                phase: Math.random() * Math.PI * 2,
                drift: 0.4 + Math.random() * 0.6,
                // Startfortschritt zufällig, damit die Flocken nicht gemeinsam
                // von 0 einfaden, sondern schon verteilt sichtbar sind
                fade: Math.random(),
                // leichte Helligkeits-/Deckkraftvariation pro Flocke
                maxOpacity: 0.7 + Math.random() * 0.3,
            };
        });
    }

    /** Ziel-Deckkraft einer voll eingeblendeten Flocke (steigt leicht mit der Stärke). */
    snowMaxOpacity() {
        return 0.55 + 0.4 * Math.min(1, this.options.snow / 100);
    }

    /**
     * Flocken fallen langsam und taumeln dabei seitlich; unten angekommen setzen
     * sie oben an einer neuen, formintern zufälligen Stelle wieder auf. Der
     * aktive Anteil (drawRange) folgt der Schnee-Stärke.
     *
     * Jede Flocke faded EINZELN ein: nach dem Spawn/Respawn wächst ihr fade-Wert
     * über SNOW_FADE_TIME von 0 auf 1, kurz vor dem Aufsetzen faded sie wieder
     * aus. Die Deckkraft wird pro Flocke über das aOpacity-Attribut in den
     * Shader gegeben (patchSnowMaterial), damit die Flocken nicht gemeinsam,
     * sondern individuell erscheinen und verschwinden.
     */
    animateSnow(delta) {
        const flakes = this.snowFlakes;
        const intensity = Math.min(100, Math.max(0, this.options.snow));
        if (!flakes.length || intensity <= 0) {
            this.snowPoints.visible = false;
            return;
        }
        this.snowPoints.visible = true;
        this.snowTime += delta;
        const top = this.snowTopY();
        const floor = this.groundOffsetY();
        const span = Math.max(1, top - floor);
        const maxOpacity = this.snowMaxOpacity();
        const fadeStep = delta / SNOW_FADE_TIME;
        const active = Math.max(1, Math.round(flakes.length * (intensity / 100)));
        this.snowGeometry.setDrawRange(0, active);
        const positions = this.snowGeometry.attributes.position.array;
        const opacities = this.snowGeometry.attributes.aOpacity.array;
        for (let i = 0; i < active; i++) {
            const flake = flakes[i];
            flake.y -= SNOW_FALL_SPEED * flake.speed * delta;
            if (flake.y < floor) {
                // Aufgesetzt: oben neu spawnen und wieder von 0 einfaden
                flake.y = top;
                flake.fade = 0;
                const { x, z } = this.snowRandomXZ();
                flake.baseX = x;
                flake.baseZ = z;
            }
            // einzelnes Einfaden nach dem Spawn
            flake.fade = Math.min(1, flake.fade + fadeStep);
            // Anteil des Fallwegs, den die Flocke schon zurückgelegt hat (0 oben, 1 unten)
            const fallen = 1 - (flake.y - floor) / span;
            // kurz vor dem Aufsetzen (letzte 15 %) wieder ausfaden
            const landFade = fallen > 0.85 ? Math.max(0, (1 - fallen) / 0.15) : 1;
            // seitliches Taumeln, aber am Formrand abgeklemmt, damit keine
            // Flocke über die Grundform hinausdriftet
            let dx = Math.sin(this.snowTime * flake.drift + flake.phase) * SNOW_DRIFT;
            let dz = Math.cos(this.snowTime * flake.drift * 0.7 + flake.phase) * SNOW_DRIFT;
            if (!this.snowInsideShape(flake.baseX + dx, flake.baseZ + dz)) {
                dx = 0;
                dz = 0;
            }
            const o = i * 3;
            positions[o] = flake.baseX + dx;
            positions[o + 1] = flake.y;
            positions[o + 2] = flake.baseZ + dz;
            opacities[i] = maxOpacity * flake.maxOpacity * flake.fade * landFade;
        }
        this.snowGeometry.attributes.position.needsUpdate = true;
        this.snowGeometry.attributes.aOpacity.needsUpdate = true;
    }

    setSnow(percent) {
        this.options.snow = percent;
        // Deckkraft wird pro Flocke in animateSnow gesetzt (aOpacity); hier nichts tun
    }

    setSnowSize(percent) {
        this.options.snowSize = percent;
        this.snowMaterial.size = SNOW_BASE_SIZE * Math.max(0.1, percent / 100);
    }

    /** Wolken folgen der Geländehöhe (z. B. bei Überhöhungs-Änderung). */
    updateCloudAltitude() {
        for (const cloud of this.cloudGroup.children) {
            cloud.position.y = this.cloudBaseY() + cloud.userData.heightOffset;
        }
    }

    /**
     * Wolkenzug von West nach Ost. Am Streckenanfang blenden die Wolken ein,
     * am Ende aus (positionsabhängig); die Schatten-Proxies wachsen/schrumpfen
     * mit, damit auch der Wolkenschatten sanft erscheint und verschwindet.
     */
    animateClouds(delta) {
        if (!this.cloudGroup.children.length) return;
        const speed = (this.options.cloudSpeed / 100) * 12; // Einheiten pro Sekunde
        for (const cloud of this.cloudGroup.children) {
            cloud.position.x += speed * cloud.userData.speedFactor * delta;
            if (cloud.position.x > CLOUD_LIMIT) {
                cloud.position.x = -CLOUD_LIMIT;
                cloud.position.z = (Math.random() - 0.5) * this.worldDepth * 0.9;
                cloud.userData.heightOffset = Math.random() * 14;
                cloud.position.y = this.cloudBaseY() + cloud.userData.heightOffset;
            }

            cloud.userData.spawnFade = Math.min(1, cloud.userData.spawnFade + delta / 2);
            const positionFade = Math.max(0, Math.min(
                1,
                (cloud.position.x + CLOUD_LIMIT) / CLOUD_FADE_DIST,
                (CLOUD_LIMIT - cloud.position.x) / CLOUD_FADE_DIST
            ));
            const fade = positionFade * cloud.userData.spawnFade;

            cloud.userData.material.opacity = (this.options.cloudOpacity / 100) * fade;
            for (const child of cloud.children) {
                if (child.userData.isShadowProxy) {
                    child.scale.copy(child.userData.baseScale)
                        .multiplyScalar(Math.max(0.001, fade));
                }
            }
            this.animateRain(cloud, fade, delta);
        }
    }

    /** Tropfen unter einer Wolke fallen lassen; Dichte gemäss Regenstärke. */
    animateRain(cloud, fade, delta) {
        const rain = cloud.userData.rain;
        if (!rain) return;
        const intensity = this.options.cloudRain;
        rain.visible = intensity > 0 && fade > 0.02;
        if (!rain.visible) return;

        rain.position.x = cloud.position.x;
        rain.position.z = cloud.position.z;
        const top = cloud.position.y - 2; // knapp unter der Wolkenbasis starten
        const floor = this.groundOffsetY(); // Regen endet an der Modellunterkante
        const drops = rain.userData.drops;
        const active = Math.max(1, Math.round(drops.length * (intensity / 100)));
        rain.geometry.setDrawRange(0, active * 2);

        const positions = rain.geometry.attributes.position;
        for (let i = 0; i < active; i++) {
            const drop = drops[i];
            drop.y -= RAIN_FALL_SPEED * drop.speed * delta;
            if (drop.y < floor || drop.y > top) drop.y = top * (0.85 + Math.random() * 0.15);
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

    setCloudCount(count) {
        this.options.cloudCount = count;
        this.rebuildClouds();
    }

    setCloudSpeed(percent) {
        this.options.cloudSpeed = percent;
    }

    setCloudSize(percent) {
        this.options.cloudSize = percent;
        for (const cloud of this.cloudGroup.children) {
            cloud.scale.setScalar(percent / 100);
        }
    }

    setCloudOpacity(percent) {
        this.options.cloudOpacity = percent; // greift im nächsten Animationsframe
    }

    setCloudColor(hex) {
        this.options.cloudColor = hex;
        for (const cloud of this.cloudGroup.children) {
            cloud.userData.baseColor = new THREE.Color(hex)
                .multiplyScalar(cloud.userData.baseShade);
            cloud.userData.material?.color.copy(cloud.userData.baseColor);
        }
    }

    setCloudRain(percent) {
        this.options.cloudRain = percent; // greift im nächsten Animationsframe
    }

    setCloudLightning(percent) {
        this.options.cloudLightning = percent; // greift im nächsten Animationsframe
    }

    setFogDensity(percent) {
        this.options.fogDensity = percent; // greift im nächsten Animationsframe
    }

    setFogSize(percent) {
        this.options.fogSize = percent;
        for (const wisp of this.fogGroup.children) {
            wisp.scale.setScalar(this.fogSizeFactor());
        }
    }

    /** Flacker-Hüllkurve eines Blitzes: zwei schnell abklingende Pulse. */
    lightningEnvelope(t) {
        const p1 = Math.exp(-t * 20);
        const p2 = t > 0.1 ? Math.exp(-(t - 0.1) * 24) * 0.8 : 0;
        return Math.min(1, p1 + p2);
    }

    /**
     * Schreibt einen Zickzack-Blitz (Hauptkanal + zufällige Äste) von start
     * bis auf die Höhe endY in den vorallozierten Segment-Buffer.
     */
    buildBolt(start, endY) {
        const pos = this.boltGeometry.attributes.position.array;
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
                const jitter = 1 + (1 - i / steps) * 3; // oben stärker ausgelenkt
                q.x += (Math.random() - 0.5) * jitter;
                q.z += (Math.random() - 0.5) * jitter;
            }
            put(prev, q);
            // gelegentliche Verästelung schräg nach unten
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
        this.boltGeometry.setDrawRange(0, seg * 2);
        this.boltGeometry.attributes.position.needsUpdate = true;
    }

    /** Löst einen Blitz an einer zufälligen, möglichst sichtbaren Wolke aus. */
    strikeLightning() {
        const clouds = this.cloudGroup.children;
        const visible = clouds.filter((c) => c.userData.material.opacity > 0.15);
        const pool = visible.length ? visible : clouds;
        const cloud = pool[Math.floor(Math.random() * pool.length)];
        const start = cloud.position.clone();
        start.y -= 2;
        this.buildBolt(start, this.groundOffsetY());
        this.boltMesh.visible = true;
        this.boltActive = true;
        this.boltTime = 0;
        this.flashCloud = cloud;
        // Flash-Licht mittig am Kanal: erhellt Wolke und Gelände darunter
        this.lightningLight.position.set(start.x, (start.y + this.groundOffsetY()) / 2, start.z);
    }

    /** Aktiven Blitz beenden und die Quellwolke zurücksetzen. */
    endLightning() {
        if (!this.boltActive) return;
        this.boltActive = false;
        this.boltMesh.visible = false;
        this.boltMesh.material.opacity = 0;
        this.lightningLight.intensity = 0;
        if (this.flashCloud?.userData.baseColor) {
            this.flashCloud.userData.material?.color.copy(this.flashCloud.userData.baseColor);
        }
        this.flashCloud = null;
    }

    /** Blitz-Logik pro Frame: Zufalls-Cooldown, Flackern, Ausblenden. */
    animateLightning(delta) {
        const intensity = this.options.cloudLightning;
        if (intensity <= 0 || !this.cloudGroup.children.length) {
            this.endLightning();
            return;
        }
        if (this.boltActive) {
            this.boltTime += delta;
            if (this.boltTime >= LIGHTNING_DURATION) {
                this.endLightning();
                return;
            }
            const envelope = this.lightningEnvelope(this.boltTime);
            this.boltMesh.material.opacity = envelope;
            this.lightningLight.intensity = envelope * 12000;
            if (this.flashCloud?.userData.baseColor) {
                this.flashCloud.userData.material?.color
                    .copy(this.flashCloud.userData.baseColor)
                    .addScalar(envelope * 1.4);
            }
        } else {
            this.lightningCooldown -= delta;
            if (this.lightningCooldown <= 0) {
                this.strikeLightning();
                // mittlere Pause: ~12 s bei 1 % bis ~0.8 s bei 100 %
                const mean = 12 - 11.2 * (intensity / 100);
                this.lightningCooldown = mean * (0.4 + Math.random() * 1.2);
            }
        }
    }

    /**
     * Exportiert das Modell (Gelände, Sockel, Marker, Wege) als GLB.
     * Texturen werden dabei bewusst NICHT eingebettet — sie liegen im
     * Web-Export als separate Dateien und werden zur Laufzeit angehängt.
     */
    exportGLB() {
        // Farb- und Normal-Map werden separat exportiert bzw. im Web-Viewer
        // prozedural neu erzeugt; sie werden hier temporär entfernt, damit der
        // GLTFExporter sie nicht als (grosse) Bilder ins GLB einbettet.
        const stripped = [];
        for (const mesh of [this.terrainMesh, this.skirtMesh]) {
            if (mesh?.material.map || mesh?.material.normalMap) {
                stripped.push([mesh.material, mesh.material.map, mesh.material.normalMap]);
                mesh.material.map = null;
                mesh.material.normalMap = null;
                mesh.material.needsUpdate = true;
            }
        }
        const restore = () => {
            for (const [material, map, normalMap] of stripped) {
                material.map = map;
                material.normalMap = normalMap;
                material.needsUpdate = true;
            }
        };
        return new Promise((resolve, reject) => {
            new GLTFExporter().parse(this.modelGroup, resolve, reject, { binary: true });
        }).finally(restore);
    }

    /** Prozedurale Sockel-Textur (gecached); null bei Stil "Einfarbig". */
    /**
     * Baut die Sockel-Texturen eines Stils (Farb- und Normal-Map) und legt sie
     * im Cache ab. Die Normal-Map wird prozedural aus der Farbtextur abgeleitet
     * (siehe makeNormalMap), sodass die Struktur mit Licht spielt, ohne dass
     * zusätzliche Geometrie oder Assets nötig sind.
     */
    baseMaps(style) {
        if (style === 'color') return { map: null, normalMap: null };
        this.baseTextureCache = this.baseTextureCache ?? {};
        if (!this.baseTextureCache[style]) {
            const makers = { soil: makeSoilTexture, rock: makeRockTexture, strata: makeStrataTexture };
            if (!makers[style]) return { map: null, normalMap: null };
            const colorCanvas = makers[style]();
            const map = new THREE.CanvasTexture(colorCanvas);
            const normalMap = new THREE.CanvasTexture(makeNormalMap(colorCanvas));
            for (const tex of [map, normalMap]) {
                tex.wrapS = THREE.RepeatWrapping;
                tex.wrapT = THREE.RepeatWrapping;
            }
            map.colorSpace = THREE.SRGBColorSpace;
            // Normal-Maps sind lineare Daten, nicht sRGB
            this.baseTextureCache[style] = { map, normalMap };
        }
        return this.baseTextureCache[style];
    }

    baseTexture(style) {
        return this.baseMaps(style).map;
    }

    /**
     * Seitenwände und Boden entlang des Geländerands. UVs in Weltmassstab
     * (eine Texturkachel pro 25 Einheiten), damit Sockel-Texturen gleichmässig
     * und ohne Verzerrung liegen. Ausser bei Stil "Einfarbig" werden die Wände
     * vertikal unterteilt und stilabhängig nach aussen ausgelenkt (Relief);
     * die Auslenkung läuft an Geländekante und Bodenplatte auf 0 aus, damit
     * keine Spalten zu Gelände und Boden entstehen. Die Normalen werden über
     * die Relieffläche gemittelt (weich gerundet statt facettiert); nur an
     * scharfen Randknicken (Rechteck-/Sechseck-Ecken) bleibt die Kante hart.
     */
    rebuildSkirt() {
        const TEX = 25; // Weltbreite einer Texturkachel
        const loop = this.model.boundary;
        const pos = this.terrainMesh.geometry.attributes.position;
        const n = loop.length;
        const style = this.options.baseStyle;

        // Umfangslängen für die u-Koordinate der Wände
        const cumulative = new Float32Array(n + 1);
        let maxTop = 0;
        for (let i = 0; i < n; i++) {
            const a = loop[i];
            const b = loop[(i + 1) % n];
            const dx = pos.getX(b) - pos.getX(a);
            const dz = pos.getZ(b) - pos.getZ(a);
            cumulative[i + 1] = cumulative[i] + Math.hypot(dx, dz);
            maxTop = Math.max(maxTop, pos.getY(a));
        }

        // Vertikale Unterteilung nur, wenn der Stil ein Relief hat
        const relief = (this.options.baseRelief ?? 100) / 100;
        const rows = style === 'color' || relief === 0
            ? 1
            : Math.min(40, Math.max(8, Math.ceil(maxTop / 0.8)));
        const smooth = (t) => {
            const c = Math.min(1, Math.max(0, t));
            return c * c * (3 - 2 * c);
        };

        // Wandpunkte pro Randvertex, vom Boden (j = 0) bis zur Geländekante
        // (j = rows), ausgelenkt entlang der XZ-Auswärtsnormale des Rands
        const columns = new Array(n);
        for (let i = 0; i < n; i++) {
            const v = loop[i];
            const x = pos.getX(v), top = pos.getY(v), z = pos.getZ(v);
            const column = new Float32Array((rows + 1) * 3);
            let nx = 0, nz = 0;
            if (rows > 1) {
                const p = loop[(i - 1 + n) % n];
                const q = loop[(i + 1) % n];
                nx = -(pos.getZ(q) - pos.getZ(p));
                nz = pos.getX(q) - pos.getX(p);
                // nach aussen orientieren (Modell ist um den Ursprung zentriert)
                if (nx * x + nz * z < 0) {
                    nx = -nx;
                    nz = -nz;
                }
                const len = Math.hypot(nx, nz) || 1;
                nx /= len;
                nz /= len;
            }
            for (let j = 0; j <= rows; j++) {
                const t = j / rows;
                // Dämpfung: 0 an Kante und Boden; flache Sockel bleiben fast glatt
                const fade = smooth(t / 0.18) * smooth((1 - t) / 0.18) * Math.min(1, top / 8);
                const d = fade > 0 ? skirtDisplacement(style, x, top * t, z) * fade * relief : 0;
                column[j * 3] = x + nx * d;
                column[j * 3 + 1] = top * t;
                column[j * 3 + 2] = z + nz * d;
            }
            columns[i] = column;
        }

        // Scharfe Randknicke (z. B. Rechteck-Ecken) erkennen — dort wird die
        // Umfangs-Tangente einseitig gebildet, die Kante bleibt sichtbar hart
        const sharp = new Uint8Array(n);
        for (let i = 0; i < n; i++) {
            const p = loop[(i - 1 + n) % n];
            const v = loop[i];
            const q = loop[(i + 1) % n];
            const d1x = pos.getX(v) - pos.getX(p);
            const d1z = pos.getZ(v) - pos.getZ(p);
            const d2x = pos.getX(q) - pos.getX(v);
            const d2z = pos.getZ(q) - pos.getZ(v);
            const len = (Math.hypot(d1x, d1z) || 1) * (Math.hypot(d2x, d2z) || 1);
            sharp[i] = (d1x * d2x + d1z * d2z) / len < 0.85 ? 1 : 0; // Knick über ~30°
        }

        // Über die Fläche gemittelte Normalen (Kreuzprodukt der Tangenten
        // entlang Umfang und Höhe): das Relief wirkt weich gerundet statt
        // facettiert, wie es computeVertexNormals() auf der unindizierten
        // Dreiecksliste ergäbe
        const normalsFor = (prev, cur, next) => {
            const out = new Float32Array((rows + 1) * 3);
            for (let j = 0; j <= rows; j++) {
                const j0 = j * 3;
                const ju = Math.min(rows, j + 1) * 3;
                const jd = Math.max(0, j - 1) * 3;
                const tx = next[j0] - prev[j0];
                const ty = next[j0 + 1] - prev[j0 + 1];
                const tz = next[j0 + 2] - prev[j0 + 2];
                const vx = cur[ju] - cur[jd];
                const vy = cur[ju + 1] - cur[jd + 1];
                const vz = cur[ju + 2] - cur[jd + 2];
                // Tangente-Umfang × Tangente-Höhe zeigt bei diesem Umlaufsinn nach aussen
                const nx = ty * vz - tz * vy;
                const ny = tz * vx - tx * vz;
                const nz = tx * vy - ty * vx;
                const norm = Math.hypot(nx, ny, nz) || 1;
                out[j0] = nx / norm;
                out[j0 + 1] = ny / norm;
                out[j0 + 2] = nz / norm;
            }
            return out;
        };
        const smoothNormals = new Array(n);
        for (let i = 0; i < n; i++) {
            smoothNormals[i] = sharp[i]
                ? null // an Knicken pro Segment einseitig gebildet
                : normalsFor(columns[(i - 1 + n) % n], columns[i], columns[(i + 1) % n]);
        }

        const wallVerts = n * rows * 6;
        const verts = new Float32Array((wallVerts + n * 3) * 3);
        const norms = new Float32Array((wallVerts + n * 3) * 3);
        const uvs = new Float32Array((wallVerts + n * 3) * 2);
        let vi = 0;
        let ui = 0;
        const push = (P, N, j, u) => {
            const j3 = j * 3;
            norms[vi] = N[j3];
            verts[vi++] = P[j3];
            norms[vi] = N[j3 + 1];
            verts[vi++] = P[j3 + 1];
            norms[vi] = N[j3 + 2];
            verts[vi++] = P[j3 + 2];
            uvs[ui++] = u;
            uvs[ui++] = P[j3 + 1] / TEX;
        };

        for (let i = 0; i < n; i++) {
            const A = columns[i];
            const B = columns[(i + 1) % n];
            const NA = smoothNormals[i] ?? normalsFor(A, A, B);
            const NB = smoothNormals[(i + 1) % n] ?? normalsFor(A, B, B);
            const ua = cumulative[i] / TEX;
            const ub = cumulative[i + 1] / TEX;
            // Wandstreifen von der Geländekante bis zum Boden (y = 0)
            for (let j = 0; j < rows; j++) {
                push(A, NA, j + 1, ua);
                push(A, NA, j, ua);
                push(B, NB, j, ub);
                push(A, NA, j + 1, ua);
                push(B, NB, j, ub);
                push(B, NB, j + 1, ub);
            }
        }

        // Boden als Fächer um den Mittelpunkt (Normale zeigt nach unten)
        const pushFloor = (x, z) => {
            norms[vi] = 0;
            verts[vi++] = x;
            norms[vi] = -1;
            verts[vi++] = 0;
            norms[vi] = 0;
            verts[vi++] = z;
            uvs[ui++] = x / TEX;
            uvs[ui++] = z / TEX;
        };
        for (let i = 0; i < n; i++) {
            const a = loop[i];
            const b = loop[(i + 1) % n];
            pushFloor(0, 0);
            pushFloor(pos.getX(b), pos.getZ(b));
            pushFloor(pos.getX(a), pos.getZ(a));
        }

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
        geo.setAttribute('normal', new THREE.BufferAttribute(norms, 3));
        geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
        this.skirtMesh.geometry.dispose();
        this.skirtMesh.geometry = geo;
    }

    /**
     * Schreibt die Vertexfarben des Geländes: gebackene AO-Abdunklung gemäss
     * aoStrength, im Hypso-Modus multipliziert mit der Höhenfarbe.
     */
    applyAOColors() {
        const attr = this.terrainMesh?.geometry.getAttribute('color');
        if (!attr) return;
        const strength = (this.options.aoStrength ?? 0) / 100;
        const base = this.baseVertexColors;
        for (let i = 0; i < attr.count; i++) {
            const shade = this.vertexAO ? 1 - strength * (1 - this.vertexAO[i]) : 1;
            if (base) {
                attr.setXYZ(i, base[i * 3] * shade, base[i * 3 + 1] * shade, base[i * 3 + 2] * shade);
            } else {
                attr.setXYZ(i, shade, shade, shade);
            }
        }
        attr.needsUpdate = true;
    }

    setAOStrength(value) {
        this.options.aoStrength = value;
        this.applyAOColors();
    }

    setExposure(percent) {
        this.options.exposure = percent;
        this.renderer.toneMappingExposure = percent / 100;
    }

    setEnvIntensity(percent) {
        this.options.envIntensity = percent;
        this.scene.environmentIntensity = percent / 100;
    }

    setExaggeration(value) {
        this.options.exaggeration = value;
        this.updateHeights();
    }

    setBasePercent(value) {
        this.options.basePercent = value;
        this.updateHeights();
    }

    setBaseColor(color) {
        this.options.baseColor = color;
        if (this.skirtMesh) this.skirtMesh.material.color.set(color);
    }

    setBaseStyle(style) {
        this.options.baseStyle = style;
        if (this.skirtMesh) {
            const maps = this.baseMaps(style);
            this.skirtMesh.material.map = maps.map;
            this.skirtMesh.material.normalMap = maps.normalMap;
            this.skirtMesh.material.needsUpdate = true;
            this.rebuildSkirt(); // Stil bestimmt auch die Reliefstruktur der Wände
        }
    }

    setBaseRelief(value) {
        this.options.baseRelief = value;
        if (this.skirtMesh) this.rebuildSkirt();
    }

    setGroundColor(color) {
        this.options.groundColor = color;
        this.groundMesh.material.color.set(color);
        this.applyEnvironment();
    }

    setGroundVisible(visible) {
        this.options.groundVisible = visible;
        this.groundMesh.visible = visible;
        this.shadowMesh.visible = visible;
        this.applyEnvironment();
    }

    /**
     * Studio-Look: Hintergrund und Nebel übernehmen die Untergrundfarbe,
     * damit die Bodenplatte nahtlos in den Horizont übergeht. Ist ein
     * Hintergrundbild gesetzt, hat es Vorrang vor der Farbe.
     */
    applyEnvironment() {
        const backdrop = this.options.groundVisible ? this.options.groundColor : '#141a26';
        if (this.options.transparentBackground) {
            this.scene.background = null;
            this.renderer.setClearAlpha(0);
        } else {
            this.scene.background = this.backgroundTexture ?? new THREE.Color(backdrop);
            this.renderer.setClearAlpha(1);
        }
        this.scene.fog.color.set(backdrop);
        // Schachbrett im Editor macht die Transparenz sichtbar
        this.container.classList.toggle('transparent-bg', this.options.transparentBackground);
    }

    setTransparentBackground(enabled) {
        this.options.transparentBackground = enabled;
        this.applyEnvironment();
    }

    /** Hintergrundbild setzen (ImageBitmap) oder mit null entfernen. */
    setBackgroundImage(image) {
        if (this.backgroundTexture) {
            this.backgroundTexture.dispose();
            this.backgroundTexture = null;
        }
        if (image) {
            const canvas = document.createElement('canvas');
            canvas.width = image.width;
            canvas.height = image.height;
            canvas.getContext('2d').drawImage(image, 0, 0);
            this.backgroundTexture = new THREE.CanvasTexture(canvas);
            this.backgroundTexture.colorSpace = THREE.SRGBColorSpace;
            this.updateBackgroundCover();
        }
        this.applyEnvironment();
    }

    /** Kontaktschatten-Positionen (mit Flächennormalen) für den Web-Export. */
    getContactShadowPlacements() {
        // Die gespeicherten Positionen sind gruppenlokal — der Bodenabstand
        // steckt in der Gruppen-Transformation und wird hier eingerechnet
        const offset = this.groundOffsetY();
        return this.contactShadowPlacements.map((p) => ({
            position: [p.position[0], p.position[1] + offset, p.position[2]],
            normal: p.normal,
        }));
    }

    /** Ortstafel-Daten (Name, Text, Weltposition) für den Web-Export. */
    getLabelPlacements() {
        if (!this.model || !this.overlays?.labels) return [];
        const scale = this.worldScale * this.options.exaggeration;
        const base = this.baseThickness() + this.groundOffsetY();
        return this.overlays.labels.map((label) => ({
            name: `tafel-${label.id}`,
            text: label.text,
            position: [
                (label.u - 0.5) * WORLD_WIDTH,
                (label.h - this.minHeight) * scale + base,
                -((label.v - 0.5) * this.worldDepth),
            ],
        }));
    }

    setShadowColor(color) {
        this.options.shadowColor = color;
        this.shadowMesh.material.color.set(color);
        this.updateContactShadowStyle();
    }

    /** 100 = harte Kante, 0 = maximal weich. */
    setShadowHardness(value) {
        this.options.shadowHardness = value;
        // Radius ist in Shadow-Map-Texeln: bei 4096er-Map doppelt so gross
        // wie früher bei 2048, damit die Weichheit in Weltmassen gleich bleibt
        this.sun.shadow.radius = 1 + (1 - value / 100) * 50;
        this.updateContactShadowStyle();
    }

    /**
     * Schattenstärke (0–100 %): skaliert die Schattenwirkung der Sonne für
     * alle Empfänger — Schlagschatten auf dem Untergrund UND Selbstschatten
     * des Geländes.
     */
    setShadowStrength(value) {
        this.options.shadowStrength = value;
        this.sun.shadow.intensity = value / 100;
        this.updateContactShadowStyle();
    }

    /** Kontaktschatten-Optik aus den allgemeinen Schatten-Einstellungen ableiten. */
    updateContactShadowStyle() {
        if (!this.blobMaterial) return; // Konstruktor: Material existiert noch nicht
        const oldMap = this.blobMaterial.map;
        this.blobMaterial.map = new THREE.CanvasTexture(
            makeContactShadowTexture(this.options.shadowHardness)
        );
        this.blobMaterial.color.set(this.options.shadowColor);
        this.blobMaterial.opacity = (this.options.shadowStrength / 100) * 0.9;
        this.blobMaterial.needsUpdate = true;
        oldMap?.dispose();
    }

    /** Positioniert die Lichtquelle aus Azimut (Rotation) und Höhenwinkel. */
    updateSun() {
        const azimuth = THREE.MathUtils.degToRad(this.options.lightRotation);
        const elevation = THREE.MathUtils.degToRad(this.options.lightElevation);
        this.sun.position.set(
            Math.cos(azimuth) * Math.cos(elevation) * SUN_DISTANCE,
            Math.sin(elevation) * SUN_DISTANCE,
            Math.sin(azimuth) * Math.cos(elevation) * SUN_DISTANCE
        );
        this.updateShadowCatcher();
    }

    setLightRotation(degrees) {
        this.options.lightRotation = degrees;
        this.updateSun();
    }

    setLightElevation(degrees) {
        this.options.lightElevation = degrees;
        this.updateSun();
    }

    /**
     * Richtet den Schattenfänger an der Lichtrichtung aus: in Schattenrichtung
     * verlängert (flaches Licht = lange Schatten), quer dazu schmaler als der
     * Schatten-Kamera-Bereich — dessen gekippte Frustum-Grenze zeichnet sich
     * sonst als feiner Saum auf dem Boden ab.
     */
    updateShadowCatcher() {
        if (!this.shadowExtent) return;
        const extent = this.shadowExtent;
        const azimuth = THREE.MathUtils.degToRad(this.options.lightRotation);
        const elevation = THREE.MathUtils.degToRad(this.options.lightElevation);
        const along = (extent / Math.sin(elevation)) * 0.9;
        const across = extent * 0.75;
        this.shadowMesh.rotation.y = -azimuth;
        this.shadowMesh.scale.set(along / 2000, 1, across / 2000);
    }

    screenshot() {
        if (!this.terrainMesh) return null;
        this.renderer.render(this.scene, this.camera);
        return this.renderer.domElement.toDataURL('image/png');
    }

    dispose() {
        for (const mesh of [this.terrainMesh, this.skirtMesh]) {
            if (!mesh) continue;
            mesh.removeFromParent();
            mesh.geometry.dispose();
            if (mesh.material.map) mesh.material.map.dispose();
            mesh.material.dispose();
        }
        this.terrainMesh = null;
        this.skirtMesh = null;
    }
}
