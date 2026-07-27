import { metersPerDegree } from './geo.js';
import { buildGridMesh, buildShapeMesh } from '../mesh.js';

// ---------------------------------------------------------------------------
// Generieren: Höhendaten + Textur laden, dekodieren, 3D-Netz bauen
// ---------------------------------------------------------------------------

/**
 * Lädt Höhendaten und Textur von der Server-API und baut daraus das
 * Höhenraster und das 3D-Netz. Hält selbst keinen Zustand.
 */
export class TerrainService {
    /** Lädt ein Bild von der API; Fehlermeldungen kommen aus der JSON-Antwort. */
    async fetchImage(url) {
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

    /** Dekodiert Terrarium-kodierte Höhen (RGB) in Meter. */
    decodeTerrarium(image) {
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

    /**
     * Kompletter Generier-Ablauf für eine Auswahl. Meldet Zwischenschritte über
     * onStatus und gibt { model: { mesh, rawGrid, bbox, shape }, textureImage }
     * zurück.
     */
    async generate(selection, { style, resolution, textureSize }, onStatus = () => {}) {
        const b = selection.bounds;
        const bboxParam = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]
            .map((v) => v.toFixed(6)).join(',');

        onStatus('Lade Höhendaten und Textur …');
        const [elevation, texture] = await Promise.all([
            this.fetchImage(`api/elevation.php?bbox=${bboxParam}&size=${resolution}`),
            style === 'hypso'
                ? Promise.resolve(null)
                : this.fetchImage(`api/texture.php?bbox=${bboxParam}&style=${style}&size=${textureSize}`),
        ]);

        onStatus('Erzeuge 3D-Modell …');
        const heights = this.decodeTerrarium(elevation.image);
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

        return {
            model: { mesh, rawGrid, bbox, shape: selection.type },
            textureImage: texture?.image ?? null,
        };
    }
}
