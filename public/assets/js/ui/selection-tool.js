import { $ } from './dom.js';
import {
    MAX_SELECTION_METERS, SQRT3,
    bboxAround, boundsSizeMeters, clampBounds, clampCorner, hexLatLngs, metersPerDegree,
} from './geo.js';
import { makeHandle } from './map-view.js';

const SHAPE_STYLE = { color: '#4f8ef7', weight: 2, fillOpacity: 0.08, interactive: false };

// ---------------------------------------------------------------------------
// Bereichsauswahl (Rechteck / Kreis / Sechseck) mit Editier-Griffen
// ---------------------------------------------------------------------------

/**
 * Werkzeug zum Aufziehen und Anpassen der Bereichsauswahl. Nach jeder neuen
 * oder veränderten Auswahl wird onChange(selection) gerufen;
 * `selection` ist { type, bounds: L.LatLngBounds } oder null.
 */
export class SelectionTool {
    constructor(mapView, { onChange }) {
        this.mapView = mapView;
        this.map = mapView.map;
        this.onChange = onChange;

        this.shape = 'rect'; // 'rect' | 'circle' | 'hexagon'
        this.selection = null;
        this.layer = null;
        this.handles = L.layerGroup().addTo(this.map);
        this.dragStart = null;

        this.bindShapeButtons();
        this.bindMapEvents();
    }

    bindShapeButtons() {
        document.querySelectorAll('.btn.shape').forEach((btn) => {
            btn.addEventListener('click', () => {
                this.shape = btn.dataset.shape;
                document.querySelectorAll('.btn.shape').forEach((b) => b.classList.toggle('active', b === btn));
                if (this.selection) this.fromBounds(this.selection.bounds);
            });
        });
    }

    bindMapEvents() {
        this.mapView.onModeChange((mode, previous) => {
            if (previous === 'select') this.dragStart = null;
            if (mode === 'select') {
                $('selection-info').textContent = this.shape === 'rect'
                    ? 'Mit gedrückter Maustaste ein Rechteck aufziehen (max. 15 × 15 km).'
                    : 'Mit gedrückter Maustaste vom Mittelpunkt nach aussen ziehen (max. Ø 15 km).';
            }
        });

        this.map.on('mousedown', (e) => {
            if (this.mapView.mode !== 'select') return;
            this.dragStart = e.latlng;
            this.replaceLayer(null);
            this.handles.clearLayers();
        });

        this.map.on('mousemove', (e) => {
            if (this.mapView.mode !== 'select' || !this.dragStart) return;
            this.preview(this.dragStart, e.latlng);
        });

        this.map.on('mouseup', (e) => {
            if (this.mapView.mode !== 'select' || !this.dragStart) return;
            const start = this.dragStart;
            this.dragStart = null;
            this.mapView.setMode(null);

            if (this.shape === 'rect') {
                const bounds = L.latLngBounds(start, clampCorner(start, e.latlng));
                const { width, height } = boundsSizeMeters(bounds);
                if (width < 100 || height < 100) {
                    this.replaceLayer(null);
                    $('selection-info').textContent = 'Auswahl zu klein — bitte erneut aufziehen.';
                    return;
                }
                this.finalize('rect', bounds, L.rectangle(bounds, SHAPE_STYLE));
            } else {
                const radius = Math.min(start.distanceTo(e.latlng), MAX_SELECTION_METERS / 2);
                if (radius < 50) {
                    this.replaceLayer(null);
                    $('selection-info').textContent = 'Auswahl zu klein — bitte erneut aufziehen.';
                    return;
                }
                if (this.shape === 'circle') {
                    this.finalize('circle', bboxAround(start, radius, radius), L.circle(start, { radius, ...SHAPE_STYLE }));
                } else {
                    this.finalize(
                        'hexagon',
                        bboxAround(start, radius, (radius * SQRT3) / 2),
                        L.polygon(hexLatLngs(start, radius), SHAPE_STYLE)
                    );
                }
            }
            // Direkt auf den gewählten Bereich zoomen (nur beim Aufziehen — beim
            // Anpassen über die Griffe bleibt der Kartenausschnitt stehen)
            this.map.flyToBounds(this.selection.bounds.pad(0.4), { duration: 0.8 });
        });
    }

    replaceLayer(layer) {
        if (this.layer) this.map.removeLayer(this.layer);
        this.layer = layer;
        if (layer) layer.addTo(this.map);
    }

    /** Vorschau während des Aufziehens (Form folgt der Maus). */
    preview(start, current) {
        const radius = Math.min(start.distanceTo(current), MAX_SELECTION_METERS / 2);
        if (this.shape === 'circle') {
            if (this.layer instanceof L.Circle) {
                this.layer.setRadius(radius);
            } else {
                this.replaceLayer(L.circle(start, { radius, ...SHAPE_STYLE }));
            }
        } else if (this.shape === 'hexagon') {
            const points = hexLatLngs(start, radius);
            if (this.layer instanceof L.Polygon && !(this.layer instanceof L.Rectangle)) {
                this.layer.setLatLngs(points);
            } else {
                this.replaceLayer(L.polygon(points, SHAPE_STYLE));
            }
        } else {
            const bounds = L.latLngBounds(start, clampCorner(start, current));
            if (this.layer instanceof L.Rectangle) {
                this.layer.setBounds(bounds);
            } else {
                this.replaceLayer(L.rectangle(bounds, SHAPE_STYLE));
            }
        }
    }

    /** Griffe zum Verschieben/Skalieren der aktuellen Auswahl. */
    renderHandles() {
        this.handles.clearLayers();
        if (!this.selection) return;
        const type = this.selection.type;
        const bounds = this.selection.bounds;
        const center = bounds.getCenter();
        const { width } = boundsSizeMeters(bounds);

        // Mittelpunkt-Griff: ganze Auswahl verschieben
        const move = makeHandle(center, 'move');
        move.on('drag', () => {
            const c = move.getLatLng();
            if (type === 'rect') {
                const dLat = c.lat - center.lat;
                const dLng = c.lng - center.lng;
                this.layer.setBounds(L.latLngBounds(
                    [bounds.getSouth() + dLat, bounds.getWest() + dLng],
                    [bounds.getNorth() + dLat, bounds.getEast() + dLng]
                ));
            } else if (type === 'circle') {
                this.layer.setLatLng(c);
            } else {
                this.layer.setLatLngs(hexLatLngs(c, width / 2));
            }
        });
        move.on('dragend', () => {
            const c = move.getLatLng();
            const dLat = c.lat - center.lat;
            const dLng = c.lng - center.lng;
            this.fromBounds(L.latLngBounds(
                [bounds.getSouth() + dLat, bounds.getWest() + dLng],
                [bounds.getNorth() + dLat, bounds.getEast() + dLng]
            ), type);
        });
        this.handles.addLayer(move);

        if (type === 'rect') {
            // Eck-Griffe: gegenüberliegende Ecke bleibt fixiert
            const corners = [
                [bounds.getNorthWest(), bounds.getSouthEast()],
                [bounds.getNorthEast(), bounds.getSouthWest()],
                [bounds.getSouthEast(), bounds.getNorthWest()],
                [bounds.getSouthWest(), bounds.getNorthEast()],
            ];
            for (const [corner, anchor] of corners) {
                const h = makeHandle(corner, 'point');
                h.on('drag', () => this.layer.setBounds(L.latLngBounds(anchor, clampCorner(anchor, h.getLatLng()))));
                h.on('dragend', () => this.fromBounds(L.latLngBounds(anchor, clampCorner(anchor, h.getLatLng())), 'rect'));
                this.handles.addLayer(h);
            }
        } else {
            // Radius-Griff am Ostrand bzw. an der Ost-Ecke
            const radius = width / 2;
            const mpd = metersPerDegree(center.lat);
            const h = makeHandle(L.latLng(center.lat, center.lng + radius / mpd.lon), 'point');
            h.on('drag', () => {
                const r = Math.min(MAX_SELECTION_METERS / 2, Math.max(50, center.distanceTo(h.getLatLng())));
                if (type === 'circle') {
                    this.layer.setRadius(r);
                } else {
                    this.layer.setLatLngs(hexLatLngs(center, r));
                }
            });
            h.on('dragend', () => {
                const r = Math.min(MAX_SELECTION_METERS / 2, Math.max(50, center.distanceTo(h.getLatLng())));
                const ry = type === 'circle' ? r : (r * SQRT3) / 2;
                this.fromBounds(bboxAround(center, r, ry), type);
            });
            this.handles.addLayer(h);
        }
    }

    describe() {
        const { width, height } = boundsSizeMeters(this.selection.bounds);
        const km = (m) => (m / 1000).toFixed(1);
        switch (this.selection.type) {
            case 'circle':
                return `Auswahl: Kreis, Ø ${km(width)} km`;
            case 'hexagon':
                return `Auswahl: Sechseck, Ø ${km(width)} km (über Ecken)`;
            default:
                return `Auswahl: ${km(width)} × ${km(height)} km`;
        }
    }

    finalize(type, bounds, layer) {
        this.selection = { type, bounds };
        this.replaceLayer(layer);
        this.renderHandles();
        $('selection-info').textContent = this.describe();
        this.onChange(this.selection);
    }

    /** Erzeugt die Auswahl in der gewünschten Form, eingeschrieben in die Bbox. */
    fromBounds(bounds, shape = this.shape) {
        bounds = clampBounds(bounds);
        const center = bounds.getCenter();
        const { width, height } = boundsSizeMeters(bounds);
        if (shape === 'circle') {
            const r = Math.min(width, height) / 2;
            this.finalize('circle', bboxAround(center, r, r), L.circle(center, { radius: r, ...SHAPE_STYLE }));
        } else if (shape === 'hexagon') {
            const rc = Math.min(width / 2, height / SQRT3);
            this.finalize(
                'hexagon',
                bboxAround(center, rc, (rc * SQRT3) / 2),
                L.polygon(hexLatLngs(center, rc), SHAPE_STYLE)
            );
        } else {
            this.finalize('rect', bounds, L.rectangle(bounds, SHAPE_STYLE));
        }
    }

    /** Auswahl für die Projektdatei: { type, bounds: [w, s, e, n] } oder null. */
    serialize() {
        if (!this.selection) return null;
        return {
            type: this.selection.type,
            bounds: [
                this.selection.bounds.getWest(), this.selection.bounds.getSouth(),
                this.selection.bounds.getEast(), this.selection.bounds.getNorth(),
            ],
        };
    }

    /** Stellt die Auswahl aus einer Projektdatei wieder her (inkl. Kartenzoom). */
    restore({ type, bounds: [w, s, e, n] }) {
        this.shape = ['rect', 'circle', 'hexagon'].includes(type) ? type : 'rect';
        document.querySelectorAll('.btn.shape').forEach((b) => {
            b.classList.toggle('active', b.dataset.shape === this.shape);
        });
        const bounds = L.latLngBounds([s, w], [n, e]);
        this.fromBounds(bounds);
        this.map.fitBounds(bounds.pad(0.4));
    }
}
