import { TerrainViewer } from './terrain.js';
import { buildGridMesh, buildShapeMesh, insideShape, sampleHeight } from './mesh.js';
import { buildBinarySTL, buildWebViewerHTML, buildZip, downloadBlob, heightmapToPNG } from './exporter.js';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Leaflet-Karte
// ---------------------------------------------------------------------------

const map = L.map('map', { zoomControl: true }).setView([46.8, 8.2], 8);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-Mitwirkende',
}).addTo(map);

const SHAPE_STYLE = { color: '#4f8ef7', weight: 2, fillOpacity: 0.08, interactive: false };
const PATH_STYLE = { color: '#ff7733', weight: 3, interactive: false };
const SQRT3 = Math.sqrt(3);

let currentShape = 'rect'; // 'rect' | 'circle' | 'hexagon'
let selection = null;      // { type, bounds: L.LatLngBounds }
let selectionLayer = null;
let dragStart = null;

function metersPerDegree(latDeg) {
    const lat = (latDeg * Math.PI) / 180;
    return { lon: 111320 * Math.cos(lat), lat: 110574 };
}

/** Bbox (LatLngBounds) um einen Mittelpunkt, Halbachsen in Metern. */
function bboxAround(center, rxMeters, ryMeters) {
    const mpd = metersPerDegree(center.lat);
    return L.latLngBounds(
        [center.lat - ryMeters / mpd.lat, center.lng - rxMeters / mpd.lon],
        [center.lat + ryMeters / mpd.lat, center.lng + rxMeters / mpd.lon]
    );
}

/** Sechseck-Eckpunkte (Ecke bei 0° = Ost, passend zum 3D-Netz). */
function hexLatLngs(center, circumradiusMeters) {
    const mpd = metersPerDegree(center.lat);
    const points = [];
    for (let k = 0; k < 6; k++) {
        const theta = (k * Math.PI) / 3;
        points.push([
            center.lat + (circumradiusMeters * Math.sin(theta)) / mpd.lat,
            center.lng + (circumradiusMeters * Math.cos(theta)) / mpd.lon,
        ]);
    }
    return points;
}

function boundsSizeMeters(bounds) {
    const sw = bounds.getSouthWest();
    return {
        width: sw.distanceTo(L.latLng(bounds.getSouth(), bounds.getEast())),
        height: sw.distanceTo(L.latLng(bounds.getNorth(), bounds.getWest())),
    };
}

const MAX_SELECTION_METERS = 15000; // maximale Kantenlänge der Auswahl: 15 km

/** Begrenzt eine Bbox auf max. 15 × 15 km (Mittelpunkt bleibt erhalten). */
function clampBounds(bounds) {
    const { width, height } = boundsSizeMeters(bounds);
    if (width <= MAX_SELECTION_METERS && height <= MAX_SELECTION_METERS) return bounds;
    const center = bounds.getCenter();
    const halfLat = ((bounds.getNorth() - bounds.getSouth()) / 2) * Math.min(1, MAX_SELECTION_METERS / height);
    const halfLng = ((bounds.getEast() - bounds.getWest()) / 2) * Math.min(1, MAX_SELECTION_METERS / width);
    return L.latLngBounds(
        [center.lat - halfLat, center.lng - halfLng],
        [center.lat + halfLat, center.lng + halfLng]
    );
}

/** Begrenzt die Zielecke eines Rechteck-Zugs auf 15 km pro Achse (Startecke bleibt fix). */
function clampCorner(start, current) {
    const width = start.distanceTo(L.latLng(start.lat, current.lng));
    const height = start.distanceTo(L.latLng(current.lat, start.lng));
    return L.latLng(
        start.lat + (current.lat - start.lat) * Math.min(1, MAX_SELECTION_METERS / height),
        start.lng + (current.lng - start.lng) * Math.min(1, MAX_SELECTION_METERS / width)
    );
}

// ---------------------------------------------------------------------------
// Karten-Modi: Bereich aufziehen / Marker setzen / Weg zeichnen
// ---------------------------------------------------------------------------

let mapMode = null; // null | 'select' | 'marker' | 'path'

function setMapMode(mode) {
    if (mapMode === 'path' && mode !== 'path') finishPath();
    if (mapMode === 'select') dragStart = null;
    mapMode = mode;
    $('btn-select').classList.toggle('active', mode === 'select');
    $('btn-marker').classList.toggle('active', mode === 'marker');
    $('btn-path').classList.toggle('active', mode === 'path');
    $('btn-label').classList.toggle('active', mode === 'label');
    $('map').classList.toggle('selecting', mode !== null);
    if (mode === 'select') {
        map.dragging.disable();
    } else {
        map.dragging.enable();
    }
    if (mode === 'path') {
        map.doubleClickZoom.disable();
    } else {
        map.doubleClickZoom.enable();
    }
    if (mode !== null) showView('map');
    if (mode === 'select') {
        $('selection-info').textContent = currentShape === 'rect'
            ? 'Mit gedrückter Maustaste ein Rechteck aufziehen (max. 15 × 15 km).'
            : 'Mit gedrückter Maustaste vom Mittelpunkt nach aussen ziehen (max. Ø 15 km).';
    }
}

const toggleMode = (mode) => () => setMapMode(mapMode === mode ? null : mode);
$('btn-select').addEventListener('click', toggleMode('select'));
$('btn-marker').addEventListener('click', toggleMode('marker'));
$('btn-path').addEventListener('click', toggleMode('path'));
$('btn-label').addEventListener('click', toggleMode('label'));

// ---------------------------------------------------------------------------
// Bereichsauswahl (Rechteck / Kreis / Sechseck)
// ---------------------------------------------------------------------------

function replaceSelectionLayer(layer) {
    if (selectionLayer) map.removeLayer(selectionLayer);
    selectionLayer = layer;
    if (layer) layer.addTo(map);
}

// ---------------------------------------------------------------------------
// Editier-Griffe (Auswahl und Wege)
// ---------------------------------------------------------------------------

const selectionHandles = L.layerGroup().addTo(map);

function handleIcon(kind) {
    return L.divIcon({
        className: 'edit-handle-wrap',
        html: `<div class="edit-handle ${kind}"></div>`,
        iconSize: [14, 14],
        iconAnchor: [7, 7],
    });
}

function makeHandle(latlng, kind) {
    return L.marker(latlng, {
        icon: handleIcon(kind),
        draggable: kind !== 'insert',
        bubblingMouseEvents: false,
    });
}

/** Griffe zum Verschieben/Skalieren der aktuellen Auswahl. */
function renderSelectionHandles() {
    selectionHandles.clearLayers();
    if (!selection) return;
    const type = selection.type;
    const bounds = selection.bounds;
    const center = bounds.getCenter();
    const { width, height } = boundsSizeMeters(bounds);

    // Mittelpunkt-Griff: ganze Auswahl verschieben
    const move = makeHandle(center, 'move');
    move.on('drag', () => {
        const c = move.getLatLng();
        if (type === 'rect') {
            const dLat = c.lat - center.lat;
            const dLng = c.lng - center.lng;
            selectionLayer.setBounds(L.latLngBounds(
                [bounds.getSouth() + dLat, bounds.getWest() + dLng],
                [bounds.getNorth() + dLat, bounds.getEast() + dLng]
            ));
        } else if (type === 'circle') {
            selectionLayer.setLatLng(c);
        } else {
            selectionLayer.setLatLngs(hexLatLngs(c, width / 2));
        }
    });
    move.on('dragend', () => {
        const c = move.getLatLng();
        const dLat = c.lat - center.lat;
        const dLng = c.lng - center.lng;
        selectionFromBounds(L.latLngBounds(
            [bounds.getSouth() + dLat, bounds.getWest() + dLng],
            [bounds.getNorth() + dLat, bounds.getEast() + dLng]
        ), type);
    });
    selectionHandles.addLayer(move);

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
            h.on('drag', () => selectionLayer.setBounds(L.latLngBounds(anchor, clampCorner(anchor, h.getLatLng()))));
            h.on('dragend', () => selectionFromBounds(L.latLngBounds(anchor, clampCorner(anchor, h.getLatLng())), 'rect'));
            selectionHandles.addLayer(h);
        }
    } else {
        // Radius-Griff am Ostrand bzw. an der Ost-Ecke
        const radius = type === 'circle' ? width / 2 : width / 2;
        const mpd = metersPerDegree(center.lat);
        const h = makeHandle(L.latLng(center.lat, center.lng + radius / mpd.lon), 'point');
        h.on('drag', () => {
            const r = Math.min(MAX_SELECTION_METERS / 2, Math.max(50, center.distanceTo(h.getLatLng())));
            if (type === 'circle') {
                selectionLayer.setRadius(r);
            } else {
                selectionLayer.setLatLngs(hexLatLngs(center, r));
            }
        });
        h.on('dragend', () => {
            const r = Math.min(MAX_SELECTION_METERS / 2, Math.max(50, center.distanceTo(h.getLatLng())));
            const ry = type === 'circle' ? r : (r * SQRT3) / 2;
            selectionFromBounds(bboxAround(center, r, ry), type);
        });
        selectionHandles.addLayer(h);
    }
}

function describeSelection() {
    const { width, height } = boundsSizeMeters(selection.bounds);
    const km = (m) => (m / 1000).toFixed(1);
    switch (selection.type) {
        case 'circle':
            return `Auswahl: Kreis, Ø ${km(width)} km`;
        case 'hexagon':
            return `Auswahl: Sechseck, Ø ${km(width)} km (über Ecken)`;
        default:
            return `Auswahl: ${km(width)} × ${km(height)} km`;
    }
}

function finalizeSelection(type, bounds, layer) {
    selection = { type, bounds };
    replaceSelectionLayer(layer);
    renderSelectionHandles();
    $('selection-info').textContent = describeSelection();
    $('btn-generate').disabled = false;
}

/** Erzeugt die Auswahl in der gewünschten Form, eingeschrieben in die Bbox. */
function selectionFromBounds(bounds, shape = currentShape) {
    bounds = clampBounds(bounds);
    const center = bounds.getCenter();
    const { width, height } = boundsSizeMeters(bounds);
    if (shape === 'circle') {
        const r = Math.min(width, height) / 2;
        finalizeSelection('circle', bboxAround(center, r, r), L.circle(center, { radius: r, ...SHAPE_STYLE }));
    } else if (shape === 'hexagon') {
        const rc = Math.min(width / 2, height / SQRT3);
        finalizeSelection(
            'hexagon',
            bboxAround(center, rc, (rc * SQRT3) / 2),
            L.polygon(hexLatLngs(center, rc), SHAPE_STYLE)
        );
    } else {
        finalizeSelection('rect', bounds, L.rectangle(bounds, SHAPE_STYLE));
    }
}

document.querySelectorAll('.btn.shape').forEach((btn) => {
    btn.addEventListener('click', () => {
        currentShape = btn.dataset.shape;
        document.querySelectorAll('.btn.shape').forEach((b) => b.classList.toggle('active', b === btn));
        if (selection) selectionFromBounds(selection.bounds);
    });
});

function previewShape(start, current) {
    const radius = Math.min(start.distanceTo(current), MAX_SELECTION_METERS / 2);
    if (currentShape === 'circle') {
        if (selectionLayer instanceof L.Circle) {
            selectionLayer.setRadius(radius);
        } else {
            replaceSelectionLayer(L.circle(start, { radius, ...SHAPE_STYLE }));
        }
    } else if (currentShape === 'hexagon') {
        const points = hexLatLngs(start, radius);
        if (selectionLayer instanceof L.Polygon && !(selectionLayer instanceof L.Rectangle)) {
            selectionLayer.setLatLngs(points);
        } else {
            replaceSelectionLayer(L.polygon(points, SHAPE_STYLE));
        }
    } else {
        const bounds = L.latLngBounds(start, clampCorner(start, current));
        if (selectionLayer instanceof L.Rectangle) {
            selectionLayer.setBounds(bounds);
        } else {
            replaceSelectionLayer(L.rectangle(bounds, SHAPE_STYLE));
        }
    }
}

map.on('mousedown', (e) => {
    if (mapMode !== 'select') return;
    dragStart = e.latlng;
    replaceSelectionLayer(null);
    selectionHandles.clearLayers();
});

map.on('mousemove', (e) => {
    if (mapMode !== 'select' || !dragStart) return;
    previewShape(dragStart, e.latlng);
});

map.on('mouseup', (e) => {
    if (mapMode !== 'select' || !dragStart) return;
    const start = dragStart;
    dragStart = null;
    setMapMode(null);

    if (currentShape === 'rect') {
        const bounds = L.latLngBounds(start, clampCorner(start, e.latlng));
        const { width, height } = boundsSizeMeters(bounds);
        if (width < 100 || height < 100) {
            replaceSelectionLayer(null);
            $('selection-info').textContent = 'Auswahl zu klein — bitte erneut aufziehen.';
            return;
        }
        finalizeSelection('rect', bounds, L.rectangle(bounds, SHAPE_STYLE));
    } else {
        const radius = Math.min(start.distanceTo(e.latlng), MAX_SELECTION_METERS / 2);
        if (radius < 50) {
            replaceSelectionLayer(null);
            $('selection-info').textContent = 'Auswahl zu klein — bitte erneut aufziehen.';
            return;
        }
        if (currentShape === 'circle') {
            finalizeSelection('circle', bboxAround(start, radius, radius), L.circle(start, { radius, ...SHAPE_STYLE }));
        } else {
            finalizeSelection(
                'hexagon',
                bboxAround(start, radius, (radius * SQRT3) / 2),
                L.polygon(hexLatLngs(start, radius), SHAPE_STYLE)
            );
        }
    }
});

// ---------------------------------------------------------------------------
// Marker und Wege
// ---------------------------------------------------------------------------

const markers = []; // { id, latlng, color, layer }
const paths = [];   // { id, latlngs: [L.LatLng, …], color, layer }
const labels = [];  // { id, latlng, text, layer }
let markerSeq = 0;
let pathSeq = 0;
let labelSeq = 0;
let draftPath = null;

const escapeHTML = (s) => s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/** Karten-Pin als eingefärbtes SVG (unabhängig von Leaflet-Bilddateien). */
function markerIcon(color) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="36" viewBox="0 0 26 36">
        <path d="M13 0C5.8 0 0 5.8 0 13c0 9.8 13 23 13 23s13-13.2 13-23C26 5.8 20.2 0 13 0z"
              fill="${color}" stroke="#fff" stroke-width="1.5"/>
        <circle cx="13" cy="13" r="4.5" fill="#fff"/>
    </svg>`;
    return L.divIcon({ className: 'pin-icon', html: svg, iconSize: [26, 36], iconAnchor: [13, 36] });
}

function removeMarker(entry) {
    map.removeLayer(entry.layer);
    markers.splice(markers.indexOf(entry), 1);
    renderOverlayList();
    updateOverlays3D();
}

function removePath(entry) {
    map.removeLayer(entry.layer);
    for (const h of entry.handles ?? []) map.removeLayer(h);
    paths.splice(paths.indexOf(entry), 1);
    renderOverlayList();
    updateOverlays3D();
}

function createMarker(latlng, color, id) {
    const layer = L.marker(latlng, { icon: markerIcon(color), bubblingMouseEvents: false, draggable: true });
    const entry = { id, latlng, color, layer };
    layer.on('click', () => {
        if (mapMode === 'marker') removeMarker(entry);
    });
    layer.on('dragend', () => {
        entry.latlng = layer.getLatLng();
        updateOverlays3D();
    });
    layer.addTo(map);
    markers.push(entry);
}

function addMarker(latlng) {
    createMarker(latlng, $('opt-marker-color').value, ++markerSeq);
    renderOverlayList();
    updateOverlays3D();
}

/** Ortstafel auf der Karte: weisses Schild mit Strich nach unten. */
function labelIcon(text) {
    const html = `<div class="map-label"><span>${escapeHTML(text)}</span><i></i></div>`;
    return L.divIcon({ className: 'label-icon', html, iconSize: null });
}

function removeLabel(entry) {
    map.removeLayer(entry.layer);
    labels.splice(labels.indexOf(entry), 1);
    renderOverlayList();
    updateOverlays3D();
}

function createLabel(latlng, text, id) {
    const layer = L.marker(latlng, { icon: labelIcon(text), bubblingMouseEvents: false, draggable: true });
    const entry = { id, latlng, text, layer };
    layer.on('click', () => {
        if (mapMode === 'label') removeLabel(entry);
    });
    layer.on('dragend', () => {
        entry.latlng = layer.getLatLng();
        updateOverlays3D();
    });
    layer.addTo(map);
    labels.push(entry);
}

function addLabel(latlng) {
    const text = ($('opt-label-text').value || '').trim() || 'Ortstafel';
    createLabel(latlng, text, ++labelSeq);
    renderOverlayList();
    updateOverlays3D();
}

/** Punkt-Griffe eines Wegs: ziehen = verschieben, "+" = einfügen, Rechtsklick = löschen. */
function renderPathHandles(path) {
    for (const h of path.handles ?? []) map.removeLayer(h);
    path.handles = [];

    path.latlngs.forEach((ll, i) => {
        const h = makeHandle(ll, 'point');
        h.on('drag', () => {
            path.latlngs[i] = h.getLatLng();
            path.layer.setLatLngs(path.latlngs);
        });
        h.on('dragend', () => {
            path.latlngs[i] = h.getLatLng();
            renderPathHandles(path);
            updateOverlays3D();
        });
        h.on('contextmenu', (e) => {
            e.originalEvent.preventDefault();
            if (path.latlngs.length <= 2) return;
            path.latlngs.splice(i, 1);
            path.layer.setLatLngs(path.latlngs);
            renderPathHandles(path);
            updateOverlays3D();
        });
        h.addTo(map);
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
            renderPathHandles(path);
            updateOverlays3D();
        });
        m.addTo(map);
        path.handles.push(m);
    }
}

/** Fertiger Weg (z. B. aus einem Projekt-Import). */
function createPath(latlngs, color, id) {
    const layer = L.polyline(latlngs, { ...PATH_STYLE, color }).addTo(map);
    const entry = { id, latlngs, color, layer };
    paths.push(entry);
    renderPathHandles(entry);
}

function addPathPoint(latlng) {
    if (!draftPath) {
        const color = $('opt-path-color').value;
        draftPath = {
            latlngs: [],
            color,
            layer: L.polyline([], { ...PATH_STYLE, color, dashArray: '6 6' }).addTo(map),
        };
    }
    const last = draftPath.latlngs.at(-1);
    if (last && last.equals(latlng)) return; // Doppelklick erzeugt doppelte Klicks
    draftPath.latlngs.push(latlng);
    draftPath.layer.setLatLngs(draftPath.latlngs);
}

function finishPath() {
    if (!draftPath) return;
    if (draftPath.latlngs.length >= 2) {
        draftPath.layer.setStyle({ dashArray: null });
        const entry = { id: ++pathSeq, ...draftPath };
        paths.push(entry);
        renderPathHandles(entry);
    } else {
        map.removeLayer(draftPath.layer);
    }
    draftPath = null;
    renderOverlayList();
    updateOverlays3D();
}

/** Liste im Seitenpanel: alle Marker/Wege mit Farbe und Einzel-Löschen. */
function renderOverlayList() {
    const list = $('overlay-list');
    list.innerHTML = '';
    const addRow = (label, color, onDelete) => {
        const li = document.createElement('li');
        const dot = document.createElement('span');
        dot.className = 'dot';
        dot.style.background = color;
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = label;
        const del = document.createElement('button');
        del.className = 'del';
        del.title = `${label} löschen`;
        del.textContent = '✕';
        del.addEventListener('click', onDelete);
        li.append(dot, name, del);
        list.appendChild(li);
    };
    for (const m of markers) addRow(`Marker ${m.id}`, m.color, () => removeMarker(m));
    for (const p of paths) addRow(`Weg ${p.id}`, p.color, () => removePath(p));
    for (const l of labels) addRow(`Tafel ${l.id} — ${l.text}`, '#ffffff', () => removeLabel(l));
    list.hidden = list.children.length === 0;
}

map.on('click', (e) => {
    if (mapMode === 'marker') addMarker(e.latlng);
    else if (mapMode === 'path') addPathPoint(e.latlng);
    else if (mapMode === 'label') addLabel(e.latlng);
});

map.on('dblclick', () => {
    if (mapMode === 'path') finishPath();
});

function clearOverlays() {
    for (const m of markers) map.removeLayer(m.layer);
    for (const p of paths) {
        map.removeLayer(p.layer);
        for (const h of p.handles ?? []) map.removeLayer(h);
    }
    for (const l of labels) map.removeLayer(l.layer);
    if (draftPath) map.removeLayer(draftPath.layer);
    markers.length = 0;
    paths.length = 0;
    labels.length = 0;
    draftPath = null;
    renderOverlayList();
    updateOverlays3D();
}

$('btn-clear-overlays').addEventListener('click', clearOverlays);

/**
 * Projiziert Marker und Wege in Bbox-Koordinaten (u, v ∈ 0..1) mit Höhen aus
 * dem Raster. Wege werden fein unterteilt, damit sie dem Gelände folgen, und
 * an der Grundform (Kreis/Sechseck) beschnitten.
 */
function projectOverlays() {
    const { rawGrid, bbox, shape } = currentModel;
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
    for (const m of markers) {
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
    for (const path of paths) {
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
        if (runs.length) projectedPaths.push({ id: path.id, color: path.color, runs });
    }

    const projectedLabels = [];
    for (const l of labels) {
        const [u, v] = toUV(l.latlng);
        if (inside(u, v)) {
            projectedLabels.push({
                id: l.id, text: l.text, u, v,
                h: sampleHeight(rawGrid, u, v),
                slope: slopeAt(u, v),
            });
        }
    }

    return { markers: projectedMarkers, paths: projectedPaths, labels: projectedLabels };
}

function updateOverlays3D() {
    if (!currentModel) return;
    viewer.setOverlays(projectOverlays());
}

// ---------------------------------------------------------------------------
// Ansichten umschalten
// ---------------------------------------------------------------------------

const viewer = new TerrainViewer($('viewer'));

function showView(name) {
    $('map').classList.toggle('active', name === 'map');
    $('viewer').classList.toggle('active', name === '3d');
    $('tab-map').classList.toggle('active', name === 'map');
    $('tab-3d').classList.toggle('active', name === '3d');
    if (name === 'map') {
        map.invalidateSize();
    } else {
        viewer.resize();
    }
}

$('tab-map').addEventListener('click', () => showView('map'));
$('tab-3d').addEventListener('click', () => showView('3d'));

$('btn-iso').addEventListener('click', () => {
    const active = $('btn-iso').classList.toggle('active');
    viewer.setIsometric(active);
    showView('3d');
});

// ---------------------------------------------------------------------------
// Start-Kameraposition: aktuelle Ansicht merken und anspringen
// ---------------------------------------------------------------------------

let startView = null; // { isometric, position, target, zoom }

function updateGotoButton() {
    $('btn-goto-view').disabled = !startView;
}

$('btn-save-view').addEventListener('click', () => {
    if (!currentModel) return;
    startView = {
        isometric: $('btn-iso').classList.contains('active'),
        ...viewer.getCameraView(),
    };
    updateGotoButton();
    setStatus('Startposition gespeichert.');
});

function gotoStartView() {
    if (!startView) return;
    $('btn-iso').classList.toggle('active', !!startView.isometric);
    viewer.setIsometric(!!startView.isometric);
    viewer.setCameraView(startView);
    showView('3d');
}

$('btn-goto-view').addEventListener('click', gotoStartView);

// ---------------------------------------------------------------------------
// Generieren: Höhendaten + Textur laden, dekodieren, 3D-Modell bauen
// ---------------------------------------------------------------------------

let currentModel = null; // { mesh, rawGrid, bbox, shape }

function setStatus(text) {
    $('status').textContent = text;
}

async function fetchImage(url) {
    const response = await fetch(url);
    if (!response.ok) {
        let message = `HTTP ${response.status}`;
        try {
            message = (await response.json()).error ?? message;
        } catch { /* Antwort war kein JSON */ }
        throw new Error(message);
    }
    const bboxHeader = response.headers.get('X-Bbox');
    const blob = await response.blob();
    const image = await createImageBitmap(blob);
    return { image, bbox: bboxHeader ? bboxHeader.split(',').map(Number) : null };
}

function decodeTerrarium(image) {
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0);
    const { data } = ctx.getImageData(0, 0, image.width, image.height);
    const heights = new Float32Array(image.width * image.height);
    for (let i = 0; i < heights.length; i++) {
        const o = i * 4;
        heights[i] = data[o] * 256 + data[o + 1] + data[o + 2] / 256 - 32768;
    }
    return heights;
}

$('btn-generate').addEventListener('click', async () => {
    if (!selection) return;
    const btn = $('btn-generate');
    btn.disabled = true;

    try {
        const b = selection.bounds;
        const bboxParam = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]
            .map((v) => v.toFixed(6)).join(',');

        const style = $('opt-style').value;
        const resolution = $('opt-resolution').value;

        setStatus('Lade Höhendaten und Textur …');
        const [elevation, texture] = await Promise.all([
            fetchImage(`api/elevation.php?bbox=${bboxParam}&size=${resolution}`),
            style === 'hypso'
                ? Promise.resolve(null)
                : fetchImage(`api/texture.php?bbox=${bboxParam}&style=${style}&size=1024`),
        ]);

        setStatus('Erzeuge 3D-Modell …');
        const heights = decodeTerrarium(elevation.image);
        const bbox = elevation.bbox ?? bboxParam.split(',').map(Number);
        const [w, s, e, n] = bbox;
        const mpd = metersPerDegree((s + n) / 2);

        const rawGrid = {
            heights,
            gridW: elevation.image.width,
            gridH: elevation.image.height,
            widthMeters: (e - w) * mpd.lon,
            depthMeters: (n - s) * mpd.lat,
        };
        const mesh = selection.type === 'rect'
            ? buildGridMesh(rawGrid)
            : buildShapeMesh(rawGrid, selection.type);
        currentModel = { mesh, rawGrid, bbox, shape: selection.type };

        viewer.build(mesh, {
            texture: texture?.image ?? null,
            exaggeration: Number($('opt-exaggeration').value),
            basePercent: Number($('opt-base').value),
        });
        updateOverlays3D();

        $('tab-3d').disabled = false;
        $('btn-iso').disabled = false;
        $('btn-save-view').disabled = false;
        $('export-panel').hidden = false;
        showView('3d');
        if (startView) gotoStartView(); // gespeicherte Startansicht anwenden
        setStatus(`Fertig — ${mesh.heights.length.toLocaleString('de-CH')} Punkte.`);
    } catch (err) {
        console.error(err);
        setStatus(`Fehler: ${err.message}`);
    } finally {
        btn.disabled = false;
    }
});

// Regler wirken live auf das bestehende Modell
$('opt-exaggeration').addEventListener('input', (e) => {
    $('out-exaggeration').textContent = `${Number(e.target.value).toFixed(1)}×`;
    viewer.setExaggeration(Number(e.target.value));
});

$('opt-base').addEventListener('input', (e) => {
    $('out-base').textContent = `${e.target.value} %`;
    viewer.setBasePercent(Number(e.target.value));
});

$('opt-base-color').addEventListener('input', (e) => viewer.setBaseColor(e.target.value));
$('opt-base-style').addEventListener('change', (e) => viewer.setBaseStyle(e.target.value));
$('opt-ground-color').addEventListener('input', (e) => viewer.setGroundColor(e.target.value));
$('opt-shadow-color').addEventListener('input', (e) => viewer.setShadowColor(e.target.value));

$('opt-shadow-hardness').addEventListener('input', (e) => {
    $('out-shadow').textContent = `${e.target.value} %`;
    viewer.setShadowHardness(Number(e.target.value));
});

$('opt-shadow-strength').addEventListener('input', (e) => {
    $('out-shadow-strength').textContent = `${e.target.value} %`;
    viewer.setShadowStrength(Number(e.target.value));
});

$('opt-ground').addEventListener('change', (e) => viewer.setGroundVisible(e.target.checked));
$('opt-transparent').addEventListener('change', (e) => viewer.setTransparentBackground(e.target.checked));

$('opt-bg-image').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
        viewer.setBackgroundImage(await createImageBitmap(file));
    } catch (err) {
        console.error(err);
        setStatus('Hintergrundbild konnte nicht geladen werden.');
    }
});

$('btn-bg-clear').addEventListener('click', () => {
    $('opt-bg-image').value = '';
    viewer.setBackgroundImage(null);
});

$('opt-light-rot').addEventListener('input', (e) => {
    $('out-light-rot').textContent = `${e.target.value}°`;
    viewer.setLightRotation(Number(e.target.value));
});

$('opt-light-dist').addEventListener('input', (e) => {
    $('out-light-dist').textContent = e.target.value;
    viewer.setLightDistance(Number(e.target.value));
});

$('opt-clouds').addEventListener('input', (e) => {
    $('out-clouds').textContent = e.target.value;
    viewer.setCloudCount(Number(e.target.value));
});

$('opt-cloud-speed').addEventListener('input', (e) => {
    $('out-cloud-speed').textContent = `${e.target.value} %`;
    viewer.setCloudSpeed(Number(e.target.value));
});

$('opt-cloud-size').addEventListener('input', (e) => {
    $('out-cloud-size').textContent = `${e.target.value} %`;
    viewer.setCloudSize(Number(e.target.value));
});

$('opt-cloud-opacity').addEventListener('input', (e) => {
    $('out-cloud-opacity').textContent = `${e.target.value} %`;
    viewer.setCloudOpacity(Number(e.target.value));
});

// Export-Sichtbegrenzungen (wirken nur im exportierten Viewer)
$('opt-tilt-limit').addEventListener('input', (e) => {
    $('out-tilt-limit').textContent = `${e.target.value}°`;
});

$('opt-zoom-limit').addEventListener('input', (e) => {
    $('out-zoom-limit').textContent = `${e.target.value} %`;
});

// ---------------------------------------------------------------------------
// Projektdatei: Auswahl, Einstellungen und alle Elemente speichern/laden
// ---------------------------------------------------------------------------

const SETTING_IDS = [
    'opt-style', 'opt-resolution', 'opt-exaggeration', 'opt-base',
    'opt-base-style', 'opt-base-color', 'opt-ground-color', 'opt-shadow-color',
    'opt-shadow-hardness', 'opt-shadow-strength', 'opt-light-rot', 'opt-light-dist',
    'opt-clouds', 'opt-cloud-speed', 'opt-cloud-size', 'opt-cloud-opacity',
    'opt-marker-color', 'opt-path-color', 'opt-label-text', 'opt-model-width',
    'opt-tilt-limit', 'opt-zoom-limit',
];

function collectProject() {
    const inputs = {};
    for (const id of SETTING_IDS) inputs[id] = $(id).value;
    inputs['opt-ground'] = $('opt-ground').checked;
    inputs['opt-transparent'] = $('opt-transparent').checked;
    return {
        format: 'mapgen-projekt',
        version: 1,
        isometric: $('btn-iso').classList.contains('active'),
        startView,
        selection: selection ? {
            type: selection.type,
            bounds: [
                selection.bounds.getWest(), selection.bounds.getSouth(),
                selection.bounds.getEast(), selection.bounds.getNorth(),
            ],
        } : null,
        inputs,
        markers: markers.map((m) => ({ id: m.id, lat: m.latlng.lat, lng: m.latlng.lng, color: m.color })),
        paths: paths.map((p) => ({
            id: p.id,
            color: p.color,
            points: p.latlngs.map((ll) => [ll.lat, ll.lng]),
        })),
        labels: labels.map((l) => ({ id: l.id, lat: l.latlng.lat, lng: l.latlng.lng, text: l.text })),
    };
}

/** Viewer-Konfiguration für den Web-Export (Teil von projekt.json). */
function collectViewerConfig() {
    return {
        glb: 'terrain.glb',
        terrainTexture: viewer.terrainMesh?.material.map?.image ? 'textur-gelaende.jpg' : null,
        skirtTexture: viewer.skirtMesh?.material.map?.image ? 'textur-sockel.png' : null,
        backgroundImage: viewer.backgroundTexture?.image ? 'hintergrund.jpg' : null,
        backdrop: $('opt-ground').checked ? $('opt-ground-color').value : '#141a26',
        groundVisible: $('opt-ground').checked,
        transparentBackground: $('opt-transparent').checked,
        shadowColor: $('opt-shadow-color').value,
        shadowExtent: viewer.shadowExtent,
        sunPosition: viewer.sun.position.toArray(),
        shadowRadius: viewer.sun.shadow.radius,
        shadowIntensity: viewer.sun.shadow.intensity,
        clouds: {
            count: Number($('opt-clouds').value),
            speed: Number($('opt-cloud-speed').value),
            size: Number($('opt-cloud-size').value),
            opacity: Number($('opt-cloud-opacity').value),
        },
        cloudBaseY: viewer.cloudBaseY(),
        cloudDepth: viewer.worldDepth,
        labels: viewer.getLabelPlacements(),
        contactShadows: viewer.getContactShadowPlacements(),
        contactShadowHardness: Number($('opt-shadow-hardness').value),
        tiltLimit: Number($('opt-tilt-limit').value),
        zoomInLimit: Number($('opt-zoom-limit').value),
        // Die Startposition bestimmt die Anfangsansicht des Web-Viewers
        isometric: startView ? !!startView.isometric : $('btn-iso').classList.contains('active'),
        startCamera: startView
            ? { position: startView.position, target: startView.target, zoom: startView.zoom }
            : null,
    };
}

function applyProject(projekt) {
    if (!projekt || projekt.format !== 'mapgen-projekt') {
        throw new Error('keine gültige Projektdatei');
    }
    setMapMode(null);

    // Einstellungen übernehmen (Whitelist; Events feuern die bestehende Verdrahtung)
    const inputs = projekt.inputs ?? {};
    for (const id of SETTING_IDS) {
        if (inputs[id] === undefined) continue;
        const el = $(id);
        el.value = String(inputs[id]);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    for (const id of ['opt-ground', 'opt-transparent']) {
        if (typeof inputs[id] === 'boolean') {
            $(id).checked = inputs[id];
            $(id).dispatchEvent(new Event('change', { bubbles: true }));
        }
    }

    // Marker, Wege, Tafeln
    clearOverlays();
    for (const m of projekt.markers ?? []) {
        createMarker(L.latLng(m.lat, m.lng), m.color, Number(m.id));
    }
    for (const p of projekt.paths ?? []) {
        createPath(p.points.map(([lat, lng]) => L.latLng(lat, lng)), p.color, Number(p.id));
    }
    for (const l of projekt.labels ?? []) {
        createLabel(L.latLng(l.lat, l.lng), String(l.text ?? ''), Number(l.id));
    }
    markerSeq = Math.max(0, ...markers.map((m) => m.id));
    pathSeq = Math.max(0, ...paths.map((p) => p.id));
    labelSeq = Math.max(0, ...labels.map((l) => l.id));
    renderOverlayList();

    // Kartenausschnitt
    if (projekt.selection?.bounds) {
        const [w, s, e, n] = projekt.selection.bounds;
        currentShape = ['rect', 'circle', 'hexagon'].includes(projekt.selection.type)
            ? projekt.selection.type
            : 'rect';
        document.querySelectorAll('.btn.shape').forEach((b) => {
            b.classList.toggle('active', b.dataset.shape === currentShape);
        });
        const bounds = L.latLngBounds([s, w], [n, e]);
        selectionFromBounds(bounds);
        map.fitBounds(bounds.pad(0.4));
    }

    // Ansichtsmodus (isometrisch/perspektivisch) und Startposition wiederherstellen
    const iso = projekt.isometric === true;
    $('btn-iso').classList.toggle('active', iso);
    viewer.setIsometric(iso);
    startView = projekt.startView?.position && projekt.startView?.target ? projekt.startView : null;
    updateGotoButton();

    // Direkt generieren, damit das importierte Projekt sofort sichtbar ist
    if (selection) $('btn-generate').click();
}

$('btn-import').addEventListener('click', () => $('opt-import-file').click());

$('opt-import-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
        applyProject(JSON.parse(await file.text()));
        setStatus('Projekt importiert.');
    } catch (err) {
        console.error(err);
        setStatus(`Fehler beim Import: ${err.message}`);
    }
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

$('btn-export-project').addEventListener('click', () => {
    const projekt = collectProject();
    if (currentModel) projekt.viewer = collectViewerConfig();
    downloadBlob(
        new Blob([JSON.stringify(projekt, null, 2)], { type: 'application/json' }),
        'projekt.json'
    );
    setStatus('Projektdatei gespeichert — über "Projekt importieren" wieder ladbar.');
});

$('btn-export-stl').addEventListener('click', () => {
    if (!currentModel) return;
    setStatus('Erzeuge STL …');
    const stl = buildBinarySTL(currentModel.mesh, {
        exaggeration: Number($('opt-exaggeration').value),
        basePercent: Number($('opt-base').value),
        modelWidthMM: Number($('opt-model-width').value),
    });
    downloadBlob(new Blob([stl], { type: 'model/stl' }), 'terrain.stl');
    setStatus('STL exportiert.');
});

$('btn-export-png').addEventListener('click', () => {
    const dataUrl = viewer.screenshot();
    if (!dataUrl) return;
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = 'terrain.png';
    a.click();
});

$('btn-export-heightmap').addEventListener('click', () => {
    if (!currentModel) return;
    heightmapToPNG(currentModel.rawGrid).then((blob) => downloadBlob(blob, 'heightmap.png'));
});

/** Canvas als Bilddatei-Bytes (für die separaten Textur-Dateien im ZIP). */
function canvasToBytes(canvas, type, quality) {
    return new Promise((resolve, reject) => {
        canvas.toBlob(async (blob) => {
            if (!blob) {
                reject(new Error('Textur konnte nicht kodiert werden'));
                return;
            }
            resolve(new Uint8Array(await blob.arrayBuffer()));
        }, type, quality);
    });
}

$('btn-export-web').addEventListener('click', async () => {
    if (!currentModel) return;
    setStatus('Erzeuge Web-Export …');
    try {
        const glb = await viewer.exportGLB();
        const viewerConfig = collectViewerConfig();
        const encoder = new TextEncoder();

        const files = [
            { name: 'terrain-3d.html', data: encoder.encode(buildWebViewerHTML()) },
            { name: 'terrain.glb', data: new Uint8Array(glb) },
        ];

        // Projektdatei: steuert den Viewer und ist im Editor wieder importierbar
        const projekt = collectProject();
        projekt.viewer = viewerConfig;
        files.push({ name: 'projekt.json', data: encoder.encode(JSON.stringify(projekt, null, 2)) });

        // Texturen als separate Dateien (werden vom Viewer zur Laufzeit geladen)
        if (viewerConfig.terrainTexture) {
            files.push({
                name: viewerConfig.terrainTexture,
                data: await canvasToBytes(viewer.terrainMesh.material.map.image, 'image/jpeg', 0.9),
            });
        }
        if (viewerConfig.skirtTexture) {
            files.push({
                name: viewerConfig.skirtTexture,
                data: await canvasToBytes(viewer.skirtMesh.material.map.image, 'image/png'),
            });
        }
        if (viewerConfig.backgroundImage) {
            files.push({
                name: viewerConfig.backgroundImage,
                data: await canvasToBytes(viewer.backgroundTexture.image, 'image/jpeg', 0.88),
            });
        }

        downloadBlob(new Blob([buildZip(files)], { type: 'application/zip' }), 'terrain-3d.zip');
        setStatus('Web-Export (ZIP) erstellt — entpacken, komplett hochladen, per <iframe> einbinden.');
    } catch (err) {
        console.error(err);
        setStatus(`Fehler beim Web-Export: ${err.message}`);
    }
});
