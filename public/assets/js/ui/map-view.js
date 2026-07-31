import { $ } from './dom.js';

// ---------------------------------------------------------------------------
// Leaflet-Karte samt Bearbeitungsmodus
// ---------------------------------------------------------------------------

/** Icon für einen Editier-Griff (Punkt, Einfügen, Verschieben). */
export function handleIcon(kind) {
    return L.divIcon({
        className: 'edit-handle-wrap',
        html: `<div class="edit-handle ${kind}"></div>`,
        iconSize: [14, 14],
        iconAnchor: [7, 7],
    });
}

/** Editier-Griff als Leaflet-Marker (Auswahl- und Weg-Werkzeug). */
export function makeHandle(latlng, kind) {
    return L.marker(latlng, {
        icon: handleIcon(kind),
        draggable: kind !== 'insert',
        bubblingMouseEvents: false,
    });
}

/**
 * Kapselt die Leaflet-Karte und den aktiven Bearbeitungsmodus
 * (null | 'select' | 'marker' | 'path' | 'label' | 'highlight'). Die Werkzeuge
 * hängen sich über onModeChange und die Maus-Ereignisse von `map` an.
 */
export class MapView {
    constructor() {
        this.map = L.map('map', { zoomControl: true }).setView([46.8, 8.2], 8);
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-Mitwirkende',
        }).addTo(this.map);

        this.mode = null;
        this.modeListeners = [];

        // Werkzeug-Buttons: erneuter Klick schaltet den Modus wieder aus
        for (const [id, mode] of [
            ['btn-select', 'select'],
            ['btn-marker', 'marker'],
            ['btn-path', 'path'],
            ['btn-label', 'label'],
            ['btn-highlight', 'highlight'],
        ]) {
            $(id).addEventListener('click', () => this.toggleMode(mode));
        }
    }

    /** Registriert einen Beobachter: listener(neuerModus, vorherigerModus). */
    onModeChange(listener) {
        this.modeListeners.push(listener);
    }

    toggleMode(mode) {
        this.setMode(this.mode === mode ? null : mode);
    }

    setMode(mode) {
        const previous = this.mode;
        this.mode = mode;
        $('btn-select').classList.toggle('active', mode === 'select');
        $('btn-marker').classList.toggle('active', mode === 'marker');
        $('btn-path').classList.toggle('active', mode === 'path');
        $('btn-label').classList.toggle('active', mode === 'label');
        $('btn-highlight').classList.toggle('active', mode === 'highlight');
        $('map').classList.toggle('selecting', mode !== null);
        if (mode === 'select') {
            this.map.dragging.disable();
        } else {
            this.map.dragging.enable();
        }
        if (mode === 'path') {
            this.map.doubleClickZoom.disable();
        } else {
            this.map.doubleClickZoom.enable();
        }
        for (const listener of this.modeListeners) listener(mode, previous);
    }
}
