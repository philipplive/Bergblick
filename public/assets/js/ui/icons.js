// ---------------------------------------------------------------------------
// Icon-Bibliothek für Highlights (SVGs aus assets/icons/)
// ---------------------------------------------------------------------------

/**
 * Auswählbare Icons. `file` ist der Dateiname in assets/icons/, `label` der
 * Name in der Auswahlliste. Neue Icons hier eintragen — die SVGs müssen
 * einfarbig sein (die Farbe wird beim Zeichnen ersetzt).
 */
export const HIGHLIGHT_ICONS = [
    { id: 'linear-note', label: 'Notiz', file: 'linear-note.svg' },
    { id: 'linear-doc', label: 'Dokument', file: 'linear-doc.svg' },
    { id: 'linear-clip', label: 'Büroklammer', file: 'linear-clip.svg' },
    { id: 'linear-like', label: 'Gefällt mir', file: 'linear-like.svg' },
    { id: 'linear-shop', label: 'Geschäft', file: 'linear-shop.svg' },
    { id: 'linear-tool', label: 'Werkzeug', file: 'linear-tool.svg' },
];

export const DEFAULT_HIGHLIGHT_ICON = HIGHLIGHT_ICONS[0].id;

const ICON_BASE_PATH = 'assets/icons/';

/** Icon-Definition zu einer id; fällt auf das Standard-Icon zurück. */
export function iconById(id) {
    return HIGHLIGHT_ICONS.find((icon) => icon.id === id)
        ?? HIGHLIGHT_ICONS.find((icon) => icon.id === DEFAULT_HIGHLIGHT_ICON);
}

// Geladene SVG-Quelltexte (id → { paths: [d, …], viewBox: [x, y, w, h] })
const iconCache = new Map();

/**
 * Zerlegt ein SVG in seine Pfad-Daten und die viewBox. Wir nutzen nur
 * <path d="…">, weil alle mitgelieferten Icons einfarbige Single-Path-Icons
 * sind — das reicht, um sie über Path2D in beliebiger Farbe zu zeichnen.
 */
function parseSVG(source) {
    const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
    const svg = doc.querySelector('svg');
    const viewBox = (svg?.getAttribute('viewBox') ?? '0 0 32 32')
        .split(/[\s,]+/)
        .map(Number);
    const paths = [...doc.querySelectorAll('path')]
        .map((path) => path.getAttribute('d'))
        .filter(Boolean);
    return { paths, viewBox: viewBox.length === 4 ? viewBox : [0, 0, 32, 32] };
}

/**
 * Lädt alle Icons einmalig in den Cache. Muss vor dem ersten Zeichnen
 * aufgerufen werden (die App tut das beim Start); danach ist das Zeichnen
 * synchron und damit für Leaflet-divIcons und Three-Texturen nutzbar.
 */
export async function loadIcons() {
    await Promise.all(HIGHLIGHT_ICONS.map(async (icon) => {
        if (iconCache.has(icon.id)) return;
        try {
            const response = await fetch(ICON_BASE_PATH + icon.file);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            iconCache.set(icon.id, parseSVG(await response.text()));
        } catch (err) {
            console.warn(`Icon "${icon.file}" konnte nicht geladen werden:`, err);
            iconCache.set(icon.id, { paths: [], viewBox: [0, 0, 32, 32] });
        }
    }));
}

/**
 * Zeichnet ein Icon zentriert in ein Quadrat der Kantenlänge `size` an der
 * Position (x, y) — gleichmässig skaliert, damit nicht-quadratische viewBoxes
 * nicht verzerren.
 */
function drawIcon(ctx, id, x, y, size, color) {
    const icon = iconCache.get(id) ?? iconCache.get(DEFAULT_HIGHLIGHT_ICON);
    if (!icon || !icon.paths.length) return;
    const [vx, vy, vw, vh] = icon.viewBox;
    const scale = size / Math.max(vw, vh);
    ctx.save();
    ctx.translate(x + (size - vw * scale) / 2, y + (size - vh * scale) / 2);
    ctx.scale(scale, scale);
    ctx.translate(-vx, -vy);
    ctx.fillStyle = color;
    for (const d of icon.paths) ctx.fill(new Path2D(d), 'evenodd');
    ctx.restore();
}

/**
 * Pfaddaten der verwendeten Icons für den Web-Export. Der exportierte Viewer
 * hat keinen Zugriff auf assets/icons/, darum wandern die Konturen als reine
 * Daten in die projekt.json.
 */
export function iconPathData(ids) {
    const data = {};
    for (const id of new Set(ids)) {
        const icon = iconCache.get(id) ?? iconCache.get(DEFAULT_HIGHLIGHT_ICON);
        if (icon) data[id] = { paths: icon.paths, viewBox: icon.viewBox };
    }
    return data;
}

/** Icon als eingefärbtes SVG-Markup — für die Leaflet-Karte und die Liste. */
export function iconSVG(id, color, size) {
    const icon = iconCache.get(id) ?? iconCache.get(DEFAULT_HIGHLIGHT_ICON);
    if (!icon) return '';
    const [vx, vy, vw, vh] = icon.viewBox;
    const paths = icon.paths
        .map((d) => `<path d="${d}" fill="${color}"/>`)
        .join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"
        viewBox="${vx} ${vy} ${vw} ${vh}">${paths}</svg>`;
}

// Grössen der 3D-Scheibe in Canvas-Pixeln (2× für scharfe Darstellung)
const DISC_SIZE = 128;
const DISC_ICON_RATIO = 0.52; // Anteil des Icons am Scheibendurchmesser

/**
 * Runde Scheibe in Wunschfarbe mit weissem Icon — Textur für das
 * Highlight-Schild in der 3D-Ansicht (und im Web-Export).
 */
export function makeHighlightCanvas(iconId, color) {
    const canvas = document.createElement('canvas');
    canvas.width = DISC_SIZE;
    canvas.height = DISC_SIZE;
    const ctx = canvas.getContext('2d');
    const center = DISC_SIZE / 2;

    // Scheibe mit weissem Rand — hebt sich vor jedem Gelände ab
    ctx.beginPath();
    ctx.arc(center, center, center - 5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 6;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();

    const iconSize = DISC_SIZE * DISC_ICON_RATIO;
    drawIcon(ctx, iconId, center - iconSize / 2, center - iconSize / 2, iconSize, '#ffffff');
    return canvas;
}