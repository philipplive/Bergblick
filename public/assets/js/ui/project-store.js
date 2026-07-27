// ---------------------------------------------------------------------------
// Projektdatei: Auswahl, Einstellungen und alle Elemente speichern/laden
// ---------------------------------------------------------------------------

/**
 * Serialisiert den kompletten App-Zustand in eine Projektdatei (projekt.json)
 * und stellt ihn daraus wieder her. Kennt selbst keine UI-Details — es
 * delegiert an die beteiligten Bausteine (Einstellungen, Auswahl, Overlays,
 * Ansichten) und an den Viewer.
 */
export class ProjectSerializer {
    constructor({ settings, selection, overlays, views, viewer, mapView, getModel, generate }) {
        this.settings = settings;
        this.selection = selection;
        this.overlays = overlays;
        this.views = views;
        this.viewer = viewer;
        this.mapView = mapView;
        this.getModel = getModel;
        this.generate = generate;
    }

    collect() {
        return {
            format: 'mapgen-projekt',
            version: 1,
            isometric: this.views.isometric,
            startView: this.views.startView,
            selection: this.selection.serialize(),
            inputs: this.settings.collect(),
            ...this.overlays.serialize(),
        };
    }

    /** Viewer-Konfiguration für den Web-Export (Teil von projekt.json). */
    collectViewerConfig() {
        const viewer = this.viewer;
        const settings = this.settings;
        const startView = this.views.startView;
        return {
            glb: 'terrain.glb',
            terrainTexture: viewer.terrainMesh?.material.map?.image ? 'textur-gelaende.jpg' : null,
            skirtTexture: viewer.skirtMesh?.material.map?.image ? 'textur-sockel.png' : null,
            backgroundImage: viewer.backgroundTexture?.image ? 'hintergrund.jpg' : null,
            backdrop: settings.checked('opt-ground') ? settings.value('opt-ground-color') : '#141a26',
            groundVisible: settings.checked('opt-ground'),
            transparentBackground: settings.checked('opt-transparent'),
            shadowColor: settings.value('opt-shadow-color'),
            shadowExtent: viewer.shadowExtent,
            sunPosition: viewer.sun.position.toArray(),
            shadowRadius: viewer.sun.shadow.radius,
            shadowIntensity: viewer.sun.shadow.intensity,
            exposure: settings.number('opt-exposure') / 100,
            envIntensity: settings.number('opt-env') / 100,
            clouds: {
                count: settings.number('opt-clouds'),
                speed: settings.number('opt-cloud-speed'),
                size: settings.number('opt-cloud-size'),
                opacity: settings.number('opt-cloud-opacity'),
                color: settings.value('opt-cloud-color'),
                rain: settings.number('opt-cloud-rain'),
                lightning: settings.number('opt-lightning'),
            },
            cloudBaseY: viewer.cloudBaseY(),
            cloudDepth: viewer.worldDepth,
            rainFloorY: viewer.groundOffsetY(),
            fogDensity: settings.number('opt-fog'),
            fogSize: settings.number('opt-fog-size'),
            snow: settings.number('opt-snow'),
            snowSize: settings.number('opt-snow-size'),
            fogShape: this.getModel()?.shape ?? 'rect',
            fogHeightField: viewer.getFogHeightField(),
            fogBaseY: viewer.fogBaseY(),
            fogBandHeight: viewer.fogBandHeight(),
            labels: viewer.getLabelPlacements(),
            contactShadows: viewer.getContactShadowPlacements(),
            contactShadowHardness: settings.number('opt-shadow-hardness'),
            tiltLimit: settings.number('opt-tilt-limit'),
            zoomInLimit: settings.number('opt-zoom-limit'),
            // Die Startposition bestimmt die Anfangsansicht des Web-Viewers
            isometric: startView ? !!startView.isometric : this.views.isometric,
            startCamera: startView
                ? { position: startView.position, target: startView.target, zoom: startView.zoom }
                : null,
        };
    }

    apply(projekt) {
        if (!projekt || projekt.format !== 'mapgen-projekt') {
            throw new Error('keine gültige Projektdatei');
        }
        this.mapView.setMode(null);

        this.settings.apply(projekt.inputs ?? {});
        this.overlays.restore(projekt);
        if (projekt.selection?.bounds) this.selection.restore(projekt.selection);
        this.views.restore(projekt);

        // Direkt generieren, damit das importierte Projekt sofort sichtbar ist
        if (this.selection.selection) this.generate();
    }
}
