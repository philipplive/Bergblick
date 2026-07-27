import { $ } from './dom.js';

// ---------------------------------------------------------------------------
// Ansichten (Karte / 3D), Isometrie-Umschalter und Start-Kameraposition
// ---------------------------------------------------------------------------

/**
 * Schaltet zwischen Karten- und 3D-Ansicht um und verwaltet die gespeicherte
 * Start-Kameraposition (inkl. Isometrie-Zustand des Viewers).
 */
export class ViewController {
    constructor(mapView, viewer, { hasModel, onStatus }) {
        this.mapView = mapView;
        this.viewer = viewer;
        this.hasModel = hasModel;
        this.onStatus = onStatus;

        this.startView = null; // { isometric, position, target, zoom }

        $('tab-map').addEventListener('click', () => this.showView('map'));
        $('tab-3d').addEventListener('click', () => this.showView('3d'));

        $('btn-iso').addEventListener('click', () => {
            const active = $('btn-iso').classList.toggle('active');
            this.viewer.setIsometric(active);
            this.showView('3d');
        });

        $('btn-save-view').addEventListener('click', () => this.saveStartView());
        $('btn-goto-view').addEventListener('click', () => this.gotoStartView());

        // Ein aktives Kartenwerkzeug holt immer die Kartenansicht in den Vordergrund
        mapView.onModeChange((mode) => {
            if (mode !== null) this.showView('map');
        });
    }

    /** Ist die isometrische Ansicht gerade aktiv? */
    get isometric() {
        return $('btn-iso').classList.contains('active');
    }

    showView(name) {
        $('map').classList.toggle('active', name === 'map');
        $('viewer').classList.toggle('active', name === '3d');
        $('tab-map').classList.toggle('active', name === 'map');
        $('tab-3d').classList.toggle('active', name === '3d');
        if (name === 'map') {
            this.mapView.map.invalidateSize();
        } else {
            this.viewer.resize();
        }
    }

    saveStartView() {
        if (!this.hasModel()) return;
        this.startView = {
            isometric: this.isometric,
            ...this.viewer.getCameraView(),
        };
        this.updateGotoButton();
        this.onStatus('Startposition gespeichert.');
    }

    gotoStartView() {
        if (!this.startView) return;
        $('btn-iso').classList.toggle('active', !!this.startView.isometric);
        this.viewer.setIsometric(!!this.startView.isometric);
        this.viewer.setCameraView(this.startView);
        this.showView('3d');
    }

    updateGotoButton() {
        $('btn-goto-view').disabled = !this.startView;
    }

    /** Gibt die 3D-Bedienelemente frei (nach dem ersten erfolgreichen Generieren). */
    unlock() {
        $('tab-3d').disabled = false;
        $('btn-iso').disabled = false;
        $('btn-save-view').disabled = false;
    }

    /** Stellt Ansichtsmodus und Startposition aus einer Projektdatei wieder her. */
    restore(projekt) {
        const iso = projekt.isometric === true;
        $('btn-iso').classList.toggle('active', iso);
        this.viewer.setIsometric(iso);
        this.startView = projekt.startView?.position && projekt.startView?.target ? projekt.startView : null;
        this.updateGotoButton();
    }
}
