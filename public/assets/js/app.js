import { TerrainViewer } from './terrain.js';
import { computeAmbientOcclusion } from './mesh.js';
import { $ } from './ui/dom.js';
import { MapView } from './ui/map-view.js';
import { SelectionTool } from './ui/selection-tool.js';
import { OverlayManager } from './ui/overlay-manager.js';
import { ViewController } from './ui/view-controller.js';
import { SettingsPanel } from './ui/settings-panel.js';
import { TerrainService } from './ui/terrain-service.js';
import { ProjectSerializer } from './ui/project-store.js';
import { ExportController } from './ui/export-controller.js';
import { AppMenu } from './ui/app-menu.js';
import { loadIcons } from './ui/icons.js';

// ---------------------------------------------------------------------------
// Kompositionswurzel: erzeugt alle Bausteine und verdrahtet sie untereinander
// ---------------------------------------------------------------------------

class App {
    constructor() {
        this.model = null; // { mesh, rawGrid, bbox, shape } — Ergebnis von "Generieren"

        this.viewer = new TerrainViewer($('viewer'));
        this.mapView = new MapView();

        this.views = new ViewController(this.mapView, this.viewer, {
            hasModel: () => this.model !== null,
            onStatus: (text) => this.setStatus(text),
        });

        this.selection = new SelectionTool(this.mapView, {
            onChange: () => { $('btn-generate').disabled = false; },
        });

        this.overlays = new OverlayManager(this.mapView, {
            onChange: () => this.updateOverlays3D(),
        });

        this.settings = new SettingsPanel(this.viewer, {
            onStatus: (text) => this.setStatus(text),
        });

        this.terrain = new TerrainService();

        this.project = new ProjectSerializer({
            settings: this.settings,
            selection: this.selection,
            overlays: this.overlays,
            views: this.views,
            viewer: this.viewer,
            mapView: this.mapView,
            getModel: () => this.model,
            generate: () => this.generate(),
        });

        this.exports = new ExportController({
            viewer: this.viewer,
            settings: this.settings,
            project: this.project,
            getModel: () => this.model,
            onStatus: (text) => this.setStatus(text),
        });

        this.menu = new AppMenu({
            onImport: (file) => this.importProject(file),
        });

        $('btn-generate').addEventListener('click', () => this.generate());
    }

    setStatus(text) {
        $('status').textContent = text;
    }

    /** Projiziert die Kartenelemente auf das aktuelle Modell in der 3D-Ansicht. */
    updateOverlays3D() {
        if (!this.model) return;
        this.viewer.setOverlays(this.overlays.project(this.model));
    }

    /** Generieren: Höhendaten + Textur laden und das 3D-Modell aufbauen. */
    async generate() {
        if (!this.selection.selection) return;
        const btn = $('btn-generate');
        btn.disabled = true;

        try {
            const { model, textureImage } = await this.terrain.generate(
                this.selection.selection,
                {
                    style: this.settings.value('opt-style'),
                    resolution: this.settings.value('opt-resolution'),
                    textureSize: this.settings.value('opt-texture-size'),
                },
                (text) => this.setStatus(text)
            );
            this.model = model;

            this.viewer.build(model.mesh, {
                texture: textureImage,
                exaggeration: this.settings.number('opt-exaggeration'),
                basePercent: this.settings.number('opt-base'),
                groundOffset: this.settings.number('opt-ground-offset'),
                // fürs Gelände-Folgen und Beschneiden der Nebelschwaden
                heightGrid: model.rawGrid,
                shape: model.shape,
                // AO wird einmalig beim Generieren mit der aktuellen Überhöhung
                // gebacken; der Überhöhungs-Regler ändert sie danach nicht mehr
                aoGrid: {
                    data: computeAmbientOcclusion(model.rawGrid, this.settings.number('opt-exaggeration')),
                    gridW: model.rawGrid.gridW,
                    gridH: model.rawGrid.gridH,
                },
            });
            this.updateOverlays3D();

            this.views.unlock();
            $('export-panel').hidden = false;
            this.views.showView('3d');
            if (this.views.startView) this.views.gotoStartView(); // gespeicherte Startansicht anwenden
            this.setStatus(`Fertig — ${model.mesh.heights.length.toLocaleString('de-CH')} Punkte.`);
        } catch (err) {
            console.error(err);
            this.setStatus(`Fehler: ${err.message}`);
        } finally {
            btn.disabled = false;
        }
    }

    /** Projekt aus einer JSON-Datei importieren (über das Burger-Menü). */
    async importProject(file) {
        try {
            this.project.apply(JSON.parse(await file.text()));
            this.setStatus('Projekt importiert.');
        } catch (err) {
            console.error(err);
            this.setStatus(`Fehler beim Import: ${err.message}`);
        }
    }
}

// Icons für die Highlights einmalig laden — danach ist das Zeichnen synchron
// (nötig für Leaflet-divIcons und die Three-Texturen)
await loadIcons();
new App();
