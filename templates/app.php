<?php

declare(strict_types=1);

/**
 * Editor-Oberfläche
 *
 * @var string $appName
 */
?>
<!DOCTYPE html>
<html lang="de">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title><?= htmlspecialchars($appName) ?></title>
    <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='80' font-size='80'>🏔️</text></svg>">
    <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
          integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=" crossorigin="">
    <link rel="stylesheet" href="assets/css/app.css">
    <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
            integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossorigin=""></script>
    <script type="importmap">
    {
        "imports": {
            "three": "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js",
            "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/"
        }
    }
    </script>
</head>
<body>
<div id="layout">
    <aside id="sidebar">
        <header id="app-header">
            <h1><?= htmlspecialchars($appName) ?></h1>
            <div id="app-menu">
                <button id="btn-menu" class="btn" title="Menü">☰</button>
                <div id="app-menu-dropdown" hidden>
                    <button id="btn-import" class="menu-item">Projekt importieren</button>
                    <input type="file" id="opt-import-file" accept="application/json,.json" hidden>
                </div>
            </div>
        </header>

        <section class="panel">
            <h2>1. Bereich wählen</h2>
            <div class="shape-group">
                <button class="btn shape active" data-shape="rect" title="Rechteck">▭ Rechteck</button>
                <button class="btn shape" data-shape="circle" title="Kreis">◯ Kreis</button>
                <button class="btn shape" data-shape="hexagon" title="Sechseck">⬡ Sechseck</button>
            </div>
            <button id="btn-select" class="btn primary">Bereich aufziehen</button>
            <p id="selection-info" class="muted">Noch kein Bereich gewählt (max. 15 × 15 km).</p>
        </section>

        <section class="panel">
            <h2>2. Marker &amp; Wege</h2>
            <div class="btn-row">
                <button id="btn-marker" class="btn">📍 Marker</button>
                <button id="btn-path" class="btn">✏️ Weg</button>
                <button id="btn-label" class="btn">🏷️ Tafel</button>
                <button id="btn-clear-overlays" class="btn">Alle löschen</button>
            </div>
            <ul id="overlay-list" class="overlay-list" hidden></ul>
            <p class="muted">Marker: Klick setzt, Ziehen verschiebt. Weg: Klicks setzen Punkte,
                Doppelklick beendet; danach Punkte ziehen, „+"-Punkte einfügen, Rechtsklick
                löscht einen Punkt. Tafel: Klick setzt eine Ortstafel, Ziehen verschiebt sie.
                Farbe und Text lassen sich nach dem Setzen in der Liste anpassen; gelöscht
                wird ebenfalls dort.</p>
        </section>

        <section class="panel">
            <h2>3. Einstellungen</h2>
            <label class="field">
                <span>Oberfläche</span>
                <select id="opt-style">
                    <option value="satellite">Satellitenbild</option>
                    <option value="osm">Strassenkarte (OSM)</option>
                    <option value="hypso">Höhenfarben</option>
                </select>
            </label>
            <label class="field">
                <span>Auflösung</span>
                <select id="opt-resolution">
                    <option value="128">Niedrig (schnell)</option>
                    <option value="256" selected>Mittel</option>
                    <option value="512">Hoch</option>
                </select>
            </label>
            <label class="field">
                <span>Textur-Auflösung</span>
                <select id="opt-texture-size">
                    <option value="1024">1024 px (schnell)</option>
                    <option value="2048" selected>2048 px</option>
                    <option value="4096">4096 px (langsam)</option>
                </select>
            </label>
            <label class="field">
                <span>Überhöhung <output id="out-exaggeration">1.5×</output></span>
                <input type="range" id="opt-exaggeration" min="0.5" max="5" step="0.1" value="1.5">
            </label>
            <label class="field">
                <span>Schattierung (AO) <output id="out-ao">60 %</output></span>
                <input type="range" id="opt-ao" min="0" max="100" step="1" value="60">
            </label>
            <label class="field">
                <span>Sockelhöhe <output id="out-base">15 %</output></span>
                <input type="range" id="opt-base" min="0" max="60" step="1" value="15">
            </label>
            <label class="field">
                <span>Abstand zum Boden <output id="out-ground-offset">0 %</output></span>
                <input type="range" id="opt-ground-offset" min="0" max="50" step="1" value="0">
            </label>
            <label class="field">
                <span>Sockel-Stil</span>
                <select id="opt-base-style">
                    <option value="color">Einfarbig</option>
                    <option value="soil">Erdreich</option>
                    <option value="rock">Fels</option>
                    <option value="strata">Gesteinsschichten</option>
                </select>
            </label>
            <label class="field">
                <span>Sockel-Relief <output id="out-base-relief">100 %</output></span>
                <input type="range" id="opt-base-relief" min="0" max="200" step="5" value="100">
            </label>
            <div class="color-row">
                <label class="color-field">
                    <span>Sockel</span>
                    <input type="color" id="opt-base-color" value="#5c5148">
                </label>
                <label class="color-field">
                    <span>Untergrund</span>
                    <input type="color" id="opt-ground-color" value="#262b36">
                </label>
                <label class="color-field">
                    <span>Schatten</span>
                    <input type="color" id="opt-shadow-color" value="#000000">
                </label>
            </div>
            <label class="field">
                <span>Schattenhärte <output id="out-shadow">60 %</output></span>
                <input type="range" id="opt-shadow-hardness" min="0" max="100" step="1" value="60">
            </label>
            <label class="field">
                <span>Schattenstärke <output id="out-shadow-strength">60 %</output></span>
                <input type="range" id="opt-shadow-strength" min="0" max="100" step="1" value="60">
            </label>
            <label class="field">
                <span>Licht-Rotation <output id="out-light-rot">143°</output></span>
                <input type="range" id="opt-light-rot" min="0" max="360" step="1" value="143">
            </label>
            <label class="field">
                <span>Licht-Höhenwinkel <output id="out-light-elev">50°</output></span>
                <input type="range" id="opt-light-elev" min="10" max="85" step="1" value="50">
            </label>
            <label class="field">
                <span>Belichtung <output id="out-exposure">100 %</output></span>
                <input type="range" id="opt-exposure" min="50" max="200" step="5" value="100">
            </label>
            <label class="field check">
                <input type="checkbox" id="opt-ground" checked>
                <span>Untergrund anzeigen</span>
            </label>
            <label class="field check">
                <input type="checkbox" id="opt-transparent">
                <span>Transparenter Hintergrund</span>
            </label>
            <label class="field">
                <span>Hintergrundbild</span>
                <span class="file-row">
                    <input type="file" id="opt-bg-image" accept="image/*">
                    <button type="button" id="btn-bg-clear" class="btn" title="Hintergrundbild entfernen">✕</button>
                </span>
            </label>
            <label class="field">
                <span>Wolken <output id="out-clouds">6</output></span>
                <input type="range" id="opt-clouds" min="0" max="20" step="1" value="6">
            </label>
            <label class="field">
                <span>Wolken-Geschwindigkeit <output id="out-cloud-speed">50 %</output></span>
                <input type="range" id="opt-cloud-speed" min="0" max="100" step="1" value="50">
            </label>
            <label class="field">
                <span>Wolken-Grösse <output id="out-cloud-size">100 %</output></span>
                <input type="range" id="opt-cloud-size" min="50" max="200" step="5" value="100">
            </label>
            <label class="field">
                <span>Wolken-Deckkraft <output id="out-cloud-opacity">90 %</output></span>
                <input type="range" id="opt-cloud-opacity" min="10" max="100" step="1" value="90">
            </label>
            <label class="field">
                <span>Regen <output id="out-cloud-rain">0 %</output></span>
                <input type="range" id="opt-cloud-rain" min="0" max="100" step="1" value="0">
            </label>
            <label class="field">
                <span>Blitze <output id="out-lightning">0 %</output></span>
                <input type="range" id="opt-lightning" min="0" max="100" step="1" value="0">
            </label>
            <label class="field">
                <span>Nebelschwaden <output id="out-fog">0 %</output></span>
                <input type="range" id="opt-fog" min="0" max="100" step="1" value="0">
            </label>
            <label class="field">
                <span>Export: Neigung max. ± <output id="out-tilt-limit">90°</output></span>
                <input type="range" id="opt-tilt-limit" min="0" max="90" step="5" value="90">
            </label>
            <label class="field">
                <span>Export: Zoom hinein max. <output id="out-zoom-limit">50 %</output></span>
                <input type="range" id="opt-zoom-limit" min="0" max="80" step="5" value="50">
            </label>
        </section>

        <section class="panel">
            <h2>4. Generieren</h2>
            <button id="btn-generate" class="btn primary big" disabled>3D-Karte generieren</button>
            <p id="status" class="muted"></p>
        </section>

        <section class="panel" id="export-panel" hidden>
            <h2>5. Export</h2>
            <label class="field">
                <span>Modellbreite (3D-Druck)</span>
                <select id="opt-model-width">
                    <option value="100">100 mm</option>
                    <option value="150" selected>150 mm</option>
                    <option value="200">200 mm</option>
                </select>
            </label>
            <div class="btn-row">
                <button id="btn-export-stl" class="btn">STL (3D-Druck)</button>
                <button id="btn-export-png" class="btn">Screenshot</button>
                <button id="btn-export-heightmap" class="btn">Heightmap</button>
                <button id="btn-export-web" class="btn">Web (HTML)</button>
                <button id="btn-export-test" class="btn">Web testen</button>
                <button id="btn-export-project" class="btn">Projekt (JSON)</button>
            </div>
            <p class="muted">Web-Export: ZIP mit Viewer-HTML, 3D-Modell und Texturen als separate
                Dateien — entpacken, alles zusammen hochladen und per
                <code>&lt;iframe&gt;</code> einbinden. „Web testen“ legt denselben Export
                direkt unter <code>/test/</code> ab und öffnet ihn im neuen Tab.</p>
        </section>

        <footer>
            Höhendaten: <a href="https://registry.opendata.aws/terrain-tiles/" target="_blank" rel="noopener">Terrain Tiles (Mapzen/AWS)</a> ·
            Karte: © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>-Mitwirkende ·
            Satellit: © Esri
        </footer>
    </aside>

    <main id="main">
        <nav id="view-tabs">
            <button id="tab-map" class="tab active">Karte</button>
            <button id="tab-3d" class="tab" disabled>3D-Ansicht</button>
            <button id="btn-save-view" class="tab" disabled title="Aktuelle Kameraposition als Startposition speichern">📷 Kamera Start setzen</button>
            <button id="btn-goto-view" class="tab" disabled title="Zur gespeicherten Startposition springen">🎯 Zum Kamera Start</button>
            <button id="btn-iso" class="tab" disabled title="Zwischen isometrischer und perspektivischer Ansicht wechseln">◇ Isometrisch</button>
        </nav>
        <div id="map" class="view active"></div>
        <div id="viewer" class="view"></div>
    </main>
</div>
<script type="module" src="assets/js/app.js"></script>
</body>
</html>
