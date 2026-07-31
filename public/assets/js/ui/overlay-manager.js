import { $, escapeHTML } from './dom.js';
import { makeHandle } from './map-view.js';
import { insideShape, sampleHeight } from '../mesh.js';
import { DEFAULT_HIGHLIGHT_ICON, HIGHLIGHT_ICONS, iconById, iconSVG } from './icons.js';

// ---------------------------------------------------------------------------
// Marker, Wege, Ortstafeln und Highlights auf der Karte (inkl. Liste im Panel)
// ---------------------------------------------------------------------------

// Linientypen für Wege: dash = Leaflet-dashArray (null = durchgezogen)
const PATH_LINE_TYPES = {
    solid: { label: 'Strich', dash: null },
    dotted: { label: 'Gepunktet', dash: '0.1 8' },
    dashed: { label: 'Gestrichelt', dash: '8 8' },
};

const PATH_STYLE = { color: '#ff7733', weight: 3, interactive: false };

// Startwerte neuer Elemente — angepasst wird danach direkt in der Liste
const DEFAULT_MARKER_COLOR = '#e5484d';
const DEFAULT_PATH_COLOR = '#ff7733';
const DEFAULT_PATH_LINE_TYPE = 'solid';
const DEFAULT_LABEL_TEXT = 'Gipfel';
const DEFAULT_HIGHLIGHT_COLOR = '#3b82f6';

/**
 * Verwaltet alle Kartenelemente (Marker, Wege, Tafeln, Highlights): Anlegen per
 * Klick im jeweiligen Modus, Bearbeiten über Griffe und die Liste im
 * Seitenpanel, Projektion in Modellkoordinaten für die 3D-Ansicht. Nach jeder
 * Änderung wird onChange() gerufen (aktualisiert die 3D-Overlays).
 */
export class OverlayManager {
    constructor(mapView, { onChange }) {
        this.mapView = mapView;
        this.map = mapView.map;
        this.onChange = onChange;

        this.markers = [];    // { id, latlng, color, layer }
        this.paths = [];      // { id, latlngs: [L.LatLng, …], color, lineType, layer, handles }
        this.labels = [];     // { id, latlng, text, layer }
        this.highlights = []; // { id, latlng, color, icon, layer }

        this.markerSeq = 0;
        this.pathSeq = 0;
        this.labelSeq = 0;
        this.highlightSeq = 0;
        this.draftPath = null;

        this.bindEvents();
    }

    bindEvents() {
        this.map.on('click', (e) => {
            if (this.mapView.mode === 'marker') this.addMarker(e.latlng);
            else if (this.mapView.mode === 'path') this.addPathPoint(e.latlng);
            else if (this.mapView.mode === 'label') this.addLabel(e.latlng);
            else if (this.mapView.mode === 'highlight') this.addHighlight(e.latlng);
        });

        this.map.on('dblclick', () => {
            if (this.mapView.mode === 'path') this.finishPath();
        });

        // Beim Verlassen des Weg-Modus wird der angefangene Weg abgeschlossen
        this.mapView.onModeChange((mode, previous) => {
            if (previous === 'path' && mode !== 'path') this.finishPath();
        });

        $('btn-clear-overlays').addEventListener('click', () => this.clear());
    }

    // --- Marker -------------------------------------------------------------

    /** Karten-Pin als eingefärbtes SVG (unabhängig von Leaflet-Bilddateien). */
    markerIcon(color) {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="36" viewBox="0 0 26 36">
            <path d="M13 0C5.8 0 0 5.8 0 13c0 9.8 13 23 13 23s13-13.2 13-23C26 5.8 20.2 0 13 0z"
                  fill="${color}" stroke="#fff" stroke-width="1.5"/>
            <circle cx="13" cy="13" r="4.5" fill="#fff"/>
        </svg>`;
        return L.divIcon({ className: 'pin-icon', html: svg, iconSize: [26, 36], iconAnchor: [13, 36] });
    }

    createMarker(latlng, color, id) {
        const layer = L.marker(latlng, { icon: this.markerIcon(color), bubblingMouseEvents: false, draggable: true });
        const entry = { id, latlng, color, layer };
        layer.on('click', () => {
            if (this.mapView.mode === 'marker') this.removeMarker(entry);
        });
        layer.on('dragend', () => {
            entry.latlng = layer.getLatLng();
            this.onChange();
        });
        layer.addTo(this.map);
        this.markers.push(entry);
    }

    addMarker(latlng) {
        this.createMarker(latlng, DEFAULT_MARKER_COLOR, ++this.markerSeq);
        this.renderList();
        this.onChange();
    }

    removeMarker(entry) {
        this.map.removeLayer(entry.layer);
        this.markers.splice(this.markers.indexOf(entry), 1);
        this.renderList();
        this.onChange();
    }

    // --- Ortstafeln ----------------------------------------------------------

    /** Ortstafel auf der Karte: weisses Schild mit Strich nach unten. */
    labelIcon(text) {
        const html = `<div class="map-label"><span>${escapeHTML(text)}</span><i></i></div>`;
        return L.divIcon({ className: 'label-icon', html, iconSize: null });
    }

    createLabel(latlng, text, id) {
        const layer = L.marker(latlng, { icon: this.labelIcon(text), bubblingMouseEvents: false, draggable: true });
        const entry = { id, latlng, text, layer };
        layer.on('click', () => {
            if (this.mapView.mode === 'label') this.removeLabel(entry);
        });
        layer.on('dragend', () => {
            entry.latlng = layer.getLatLng();
            this.onChange();
        });
        layer.addTo(this.map);
        this.labels.push(entry);
    }

    addLabel(latlng) {
        this.createLabel(latlng, DEFAULT_LABEL_TEXT, ++this.labelSeq);
        this.renderList();
        this.onChange();
    }

    removeLabel(entry) {
        this.map.removeLayer(entry.layer);
        this.labels.splice(this.labels.indexOf(entry), 1);
        this.renderList();
        this.onChange();
    }

    // --- Highlights -----------------------------------------------------------

    /** Runde Scheibe in Wunschfarbe mit weissem Icon — wie in der 3D-Ansicht. */
    highlightIcon(iconId, color) {
        const html = `<div class="map-highlight" style="background:${color}">
            ${iconSVG(iconId, '#ffffff', 17)}</div>`;
        return L.divIcon({ className: 'highlight-icon', html, iconSize: [28, 28], iconAnchor: [14, 14] });
    }

    createHighlight(latlng, color, iconId, id) {
        // Farbe und Icon normalisieren: fremde Projektdateien können beides
        // weglassen, das Farbfeld und die Canvas-Scheibe brauchen gültige Werte
        const icon = iconById(iconId).id;
        const fill = /^#[0-9a-f]{6}$/i.test(color ?? '') ? color : DEFAULT_HIGHLIGHT_COLOR;
        const layer = L.marker(latlng, {
            icon: this.highlightIcon(icon, fill), bubblingMouseEvents: false, draggable: true,
        });
        const entry = { id, latlng, color: fill, icon, layer };
        layer.on('click', () => {
            if (this.mapView.mode === 'highlight') this.removeHighlight(entry);
        });
        layer.on('dragend', () => {
            entry.latlng = layer.getLatLng();
            this.onChange();
        });
        layer.addTo(this.map);
        this.highlights.push(entry);
    }

    addHighlight(latlng) {
        this.createHighlight(latlng, DEFAULT_HIGHLIGHT_COLOR, DEFAULT_HIGHLIGHT_ICON, ++this.highlightSeq);
        this.renderList();
        this.onChange();
    }

    removeHighlight(entry) {
        this.map.removeLayer(entry.layer);
        this.highlights.splice(this.highlights.indexOf(entry), 1);
        this.renderList();
        this.onChange();
    }

    // --- Wege ----------------------------------------------------------------

    /** Punkt-Griffe eines Wegs: ziehen = verschieben, "+" = einfügen, Rechtsklick = löschen. */
    renderPathHandles(path) {
        for (const h of path.handles ?? []) this.map.removeLayer(h);
        path.handles = [];

        path.latlngs.forEach((ll, i) => {
            const h = makeHandle(ll, 'point');
            h.on('drag', () => {
                path.latlngs[i] = h.getLatLng();
                path.layer.setLatLngs(path.latlngs);
            });
            h.on('dragend', () => {
                path.latlngs[i] = h.getLatLng();
                this.renderPathHandles(path);
                this.onChange();
            });
            h.on('contextmenu', (e) => {
                e.originalEvent.preventDefault();
                if (path.latlngs.length <= 2) return;
                path.latlngs.splice(i, 1);
                path.layer.setLatLngs(path.latlngs);
                this.renderPathHandles(path);
                this.onChange();
            });
            h.addTo(this.map);
            path.handles.push(h);
        });

        // Einfüge-Griffe auf den Segmentmitten
        for (let i = 0; i < path.latlngs.length - 1; i++) {
            const a = path.latlngs[i];
            const b = path.latlngs[i + 1];
            const mid = L.latLng((a.lat + b.lat) / 2, (a.lng + b.lng) / 2);
            const m = makeHandle(mid, 'insert');
            m.on('click', () => {
                path.latlngs.splice(i + 1, 0, mid);
                path.layer.setLatLngs(path.latlngs);
                this.renderPathHandles(path);
                this.onChange();
            });
            m.addTo(this.map);
            path.handles.push(m);
        }
    }

    /** Fertiger Weg (z. B. aus einem Projekt-Import). */
    createPath(latlngs, color, id, lineType = DEFAULT_PATH_LINE_TYPE) {
        if (!PATH_LINE_TYPES[lineType]) lineType = DEFAULT_PATH_LINE_TYPE;
        const layer = L.polyline(latlngs, {
            ...PATH_STYLE, color, dashArray: PATH_LINE_TYPES[lineType].dash,
        }).addTo(this.map);
        const entry = { id, latlngs, color, lineType, layer };
        this.paths.push(entry);
        this.renderPathHandles(entry);
    }

    addPathPoint(latlng) {
        if (!this.draftPath) {
            const color = DEFAULT_PATH_COLOR;
            this.draftPath = {
                latlngs: [],
                color,
                lineType: DEFAULT_PATH_LINE_TYPE,
                layer: L.polyline([], { ...PATH_STYLE, color, dashArray: '6 6' }).addTo(this.map),
            };
        }
        const last = this.draftPath.latlngs.at(-1);
        if (last && last.equals(latlng)) return; // Doppelklick erzeugt doppelte Klicks
        this.draftPath.latlngs.push(latlng);
        this.draftPath.layer.setLatLngs(this.draftPath.latlngs);
    }

    finishPath() {
        if (!this.draftPath) return;
        if (this.draftPath.latlngs.length >= 2) {
            this.draftPath.layer.setStyle({ dashArray: PATH_LINE_TYPES[this.draftPath.lineType].dash });
            const entry = { id: ++this.pathSeq, ...this.draftPath };
            this.paths.push(entry);
            this.renderPathHandles(entry);
        } else {
            this.map.removeLayer(this.draftPath.layer);
        }
        this.draftPath = null;
        this.renderList();
        this.onChange();
    }

    removePath(entry) {
        this.map.removeLayer(entry.layer);
        for (const h of entry.handles ?? []) this.map.removeLayer(h);
        this.paths.splice(this.paths.indexOf(entry), 1);
        this.renderList();
        this.onChange();
    }

    // --- Liste im Seitenpanel --------------------------------------------------

    /**
     * Liste im Seitenpanel: Farbe (Marker/Weg) und Text (Tafel) jedes Elements
     * werden direkt in der Zeile bearbeitet; die Karte folgt live, das 3D-Modell
     * beim Abschliessen der Eingabe (change).
     */
    renderList() {
        const list = $('overlay-list');
        list.innerHTML = '';

        const addRow = (label, onDelete, ...controls) => {
            const li = document.createElement('li');
            const del = document.createElement('button');
            del.className = 'del';
            del.title = `${label} löschen`;
            del.textContent = '✕';
            del.addEventListener('click', onDelete);
            li.append(...controls, del);
            list.appendChild(li);
        };
        const colorInput = (value, title, onInput) => {
            const input = document.createElement('input');
            input.type = 'color';
            input.className = 'dot';
            input.value = value;
            input.title = title;
            input.addEventListener('input', () => onInput(input.value));
            input.addEventListener('change', () => this.onChange());
            return input;
        };
        const nameSpan = (text) => {
            const span = document.createElement('span');
            span.className = 'name';
            span.textContent = text;
            return span;
        };

        for (const m of this.markers) {
            const color = colorInput(m.color, 'Markerfarbe ändern', (v) => {
                m.color = v;
                m.layer.setIcon(this.markerIcon(v));
            });
            addRow(`Marker ${m.id}`, () => this.removeMarker(m), color, nameSpan(`Marker ${m.id}`));
        }

        for (const p of this.paths) {
            const color = colorInput(p.color, 'Wegfarbe ändern', (v) => {
                p.color = v;
                p.layer.setStyle({ color: v });
            });
            const lineType = document.createElement('select');
            lineType.className = 'line-type';
            lineType.title = 'Linientyp ändern';
            for (const [value, def] of Object.entries(PATH_LINE_TYPES)) {
                const option = document.createElement('option');
                option.value = value;
                option.textContent = def.label;
                lineType.appendChild(option);
            }
            lineType.value = p.lineType;
            lineType.addEventListener('change', () => {
                p.lineType = lineType.value;
                p.layer.setStyle({ dashArray: PATH_LINE_TYPES[p.lineType].dash });
                this.onChange();
            });
            addRow(`Weg ${p.id}`, () => this.removePath(p), color, nameSpan(`Weg ${p.id}`), lineType);
        }

        for (const l of this.labels) {
            const dot = document.createElement('span');
            dot.className = 'dot';
            dot.style.background = '#ffffff';
            const text = document.createElement('input');
            text.type = 'text';
            text.className = 'name name-input';
            text.maxLength = 40;
            text.value = l.text;
            text.title = 'Tafel-Text ändern';
            text.addEventListener('input', () => {
                l.text = text.value;
                l.layer.setIcon(this.labelIcon(l.text));
            });
            text.addEventListener('change', () => {
                if (!text.value.trim()) {
                    l.text = DEFAULT_LABEL_TEXT;
                    text.value = l.text;
                    l.layer.setIcon(this.labelIcon(l.text));
                }
                this.onChange();
            });
            addRow(`Tafel ${l.id}`, () => this.removeLabel(l), dot, text);
        }

        for (const h of this.highlights) {
            const color = colorInput(h.color, 'Highlight-Farbe ändern', (v) => {
                h.color = v;
                h.layer.setIcon(this.highlightIcon(h.icon, v));
            });
            const icon = document.createElement('select');
            icon.className = 'line-type';
            icon.title = 'Icon ändern';
            for (const def of HIGHLIGHT_ICONS) {
                const option = document.createElement('option');
                option.value = def.id;
                option.textContent = def.label;
                icon.appendChild(option);
            }
            icon.value = h.icon;
            icon.addEventListener('change', () => {
                h.icon = icon.value;
                h.layer.setIcon(this.highlightIcon(h.icon, h.color));
                this.onChange();
            });
            addRow(`Highlight ${h.id}`, () => this.removeHighlight(h), color,
                nameSpan(`Highlight ${h.id}`), icon);
        }

        list.hidden = list.children.length === 0;
    }

    // --- Gesamtzustand ----------------------------------------------------------

    clear() {
        for (const m of this.markers) this.map.removeLayer(m.layer);
        for (const p of this.paths) {
            this.map.removeLayer(p.layer);
            for (const h of p.handles ?? []) this.map.removeLayer(h);
        }
        for (const l of this.labels) this.map.removeLayer(l.layer);
        for (const h of this.highlights) this.map.removeLayer(h.layer);
        if (this.draftPath) this.map.removeLayer(this.draftPath.layer);
        this.markers.length = 0;
        this.paths.length = 0;
        this.labels.length = 0;
        this.highlights.length = 0;
        this.draftPath = null;
        this.renderList();
        this.onChange();
    }

    /** Alle Elemente für die Projektdatei (reine Daten, keine Leaflet-Layer). */
    serialize() {
        return {
            markers: this.markers.map((m) => ({ id: m.id, lat: m.latlng.lat, lng: m.latlng.lng, color: m.color })),
            paths: this.paths.map((p) => ({
                id: p.id,
                color: p.color,
                lineType: p.lineType,
                points: p.latlngs.map((ll) => [ll.lat, ll.lng]),
            })),
            labels: this.labels.map((l) => ({ id: l.id, lat: l.latlng.lat, lng: l.latlng.lng, text: l.text })),
            highlights: this.highlights.map((h) => ({
                id: h.id, lat: h.latlng.lat, lng: h.latlng.lng, color: h.color, icon: h.icon,
            })),
        };
    }

    /** Stellt alle Elemente aus einer Projektdatei wieder her. */
    restore(projekt) {
        this.clear();
        for (const m of projekt.markers ?? []) {
            this.createMarker(L.latLng(m.lat, m.lng), m.color, Number(m.id));
        }
        for (const p of projekt.paths ?? []) {
            this.createPath(p.points.map(([lat, lng]) => L.latLng(lat, lng)), p.color, Number(p.id), p.lineType);
        }
        for (const l of projekt.labels ?? []) {
            this.createLabel(L.latLng(l.lat, l.lng), String(l.text ?? ''), Number(l.id));
        }
        for (const h of projekt.highlights ?? []) {
            this.createHighlight(L.latLng(h.lat, h.lng), h.color, h.icon, Number(h.id));
        }
        this.markerSeq = Math.max(0, ...this.markers.map((m) => m.id));
        this.pathSeq = Math.max(0, ...this.paths.map((p) => p.id));
        this.labelSeq = Math.max(0, ...this.labels.map((l) => l.id));
        this.highlightSeq = Math.max(0, ...this.highlights.map((h) => h.id));
        this.renderList();
    }

    // --- Projektion in Modellkoordinaten ------------------------------------------

    /**
     * Projiziert Marker und Wege in Bbox-Koordinaten (u, v ∈ 0..1) mit Höhen aus
     * dem Raster. Wege werden fein unterteilt, damit sie dem Gelände folgen, und
     * an der Grundform (Kreis/Sechseck) beschnitten.
     */
    project(model) {
        const { rawGrid, bbox, shape } = model;
        const [w, s, e, n] = bbox;
        const toUV = (ll) => [(ll.lng - w) / (e - w), (ll.lat - s) / (n - s)];
        const inside = (u, v) =>
            u >= 0 && u <= 1 && v >= 0 && v <= 1 && insideShape(u * 2 - 1, v * 2 - 1, shape);

        // Geländeneigung (m/m, Ost- und Nordrichtung) für die Kontaktschatten
        const slopeAt = (u, v) => {
            const du = 1 / rawGrid.gridW;
            const dv = 1 / rawGrid.gridH;
            const dhdx = (sampleHeight(rawGrid, Math.min(1, u + du), v)
                - sampleHeight(rawGrid, Math.max(0, u - du), v)) / (2 * du * rawGrid.widthMeters);
            const dhdy = (sampleHeight(rawGrid, u, Math.min(1, v + dv))
                - sampleHeight(rawGrid, u, Math.max(0, v - dv))) / (2 * dv * rawGrid.depthMeters);
            return [dhdx, dhdy];
        };

        const projectedMarkers = [];
        for (const m of this.markers) {
            const [u, v] = toUV(m.latlng);
            if (inside(u, v)) {
                projectedMarkers.push({
                    id: m.id, color: m.color, u, v,
                    h: sampleHeight(rawGrid, u, v),
                    slope: slopeAt(u, v),
                });
            }
        }

        const projectedPaths = [];
        for (const path of this.paths) {
            const runs = [];
            let run = [];
            const pts = path.latlngs;
            for (let i = 0; i < pts.length - 1; i++) {
                const [u0, v0] = toUV(pts[i]);
                const [u1, v1] = toUV(pts[i + 1]);
                const steps = Math.max(1, Math.min(300,
                    Math.ceil(Math.max(Math.abs(u1 - u0), Math.abs(v1 - v0)) * 200)));
                for (let k = i === 0 ? 0 : 1; k <= steps; k++) {
                    const t = k / steps;
                    const u = u0 + (u1 - u0) * t;
                    const v = v0 + (v1 - v0) * t;
                    if (inside(u, v)) {
                        run.push({ u, v, h: sampleHeight(rawGrid, u, v) });
                    } else if (run.length) {
                        if (run.length >= 2) runs.push(run);
                        run = [];
                    }
                }
            }
            if (run.length >= 2) runs.push(run);
            if (runs.length) {
                projectedPaths.push({ id: path.id, color: path.color, lineType: path.lineType, runs });
            }
        }

        const projectedLabels = [];
        for (const l of this.labels) {
            const [u, v] = toUV(l.latlng);
            if (inside(u, v)) {
                projectedLabels.push({
                    id: l.id, text: l.text, u, v,
                    h: sampleHeight(rawGrid, u, v),
                    slope: slopeAt(u, v),
                });
            }
        }

        const projectedHighlights = [];
        for (const h of this.highlights) {
            const [u, v] = toUV(h.latlng);
            if (inside(u, v)) {
                projectedHighlights.push({
                    id: h.id, color: h.color, icon: h.icon, u, v,
                    h: sampleHeight(rawGrid, u, v),
                    slope: slopeAt(u, v),
                });
            }
        }

        return {
            markers: projectedMarkers,
            paths: projectedPaths,
            labels: projectedLabels,
            highlights: projectedHighlights,
        };
    }
}
