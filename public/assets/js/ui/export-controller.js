import { $ } from './dom.js';
import { buildBinarySTL, buildWebViewerHTML, buildZip, downloadBlob } from '../exporter.js';

// ---------------------------------------------------------------------------
// Export: Projektdatei, STL, Web-Export (ZIP) und Test-Export auf den Server
// ---------------------------------------------------------------------------

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

/**
 * Prüft einmalig, ob der Browser WebP über canvas.toBlob kodieren kann.
 * (Manche Umgebungen liefern bei nicht unterstütztem Typ still ein PNG.)
 */
let webpSupport = null;
function canEncodeWebP() {
    if (webpSupport === null) {
        const probe = document.createElement('canvas');
        probe.width = probe.height = 1;
        // toDataURL gibt bei Unterstützung einen "data:image/webp"-Prefix zurück
        webpSupport = probe.toDataURL('image/webp').startsWith('data:image/webp');
    }
    return webpSupport;
}

/**
 * Kodiert einen Canvas als WebP (falls möglich) oder fällt auf ein
 * verlustbehaftetes Ausgangsformat (JPG) zurück. Gibt sowohl die Bytes als
 * auch die passende Dateiendung zurück, damit Dateiname und Inhalt
 * zusammenpassen. `basename` ist der Name ohne Endung (z. B. "textur-gelaende").
 */
async function encodeTexture(canvas, basename, quality) {
    if (canEncodeWebP()) {
        return { name: `${basename}.webp`, data: await canvasToBytes(canvas, 'image/webp', quality) };
    }
    return { name: `${basename}.jpg`, data: await canvasToBytes(canvas, 'image/jpeg', quality) };
}

/**
 * Komprimiert ein GLB (aus dem GLTFExporter) mit EXT_meshopt_compression.
 * three.js r170 bringt nur den Decoder mit; für den Encoder nutzen wir
 * @gltf-transform + meshoptimizer. Beide liegen lokal unter assets/vendor/
 * (gebündelt bzw. mit eingebettetem WASM), werden also ohne Internetzugang und
 * ohne Drittanbieter-CDN geladen. Der Viewer liest das Ergebnis über den in
 * exporter.js gesetzten MeshoptDecoder.
 *
 * Level 'medium' quantisiert schonender als 'high' — wichtig, weil COLOR_0 die
 * gebackene AO-Verschattung trägt und die Höhen fein sind.
 *
 * Schlägt die Kompression fehl, wird das unkomprimierte GLB zurückgegeben,
 * statt den Export scheitern zu lassen.
 */
async function compressGLB(glbArrayBuffer) {
    try {
        const [{ WebIO, meshopt, EXTMeshoptCompression }, { MeshoptEncoder }] = await Promise.all([
            import('../../vendor/gltf-transform.js'),
            import('../../vendor/meshopt_encoder.js'),
        ]);
        await MeshoptEncoder.ready;
        const io = new WebIO()
            .registerExtensions([EXTMeshoptCompression])
            .registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
        const doc = await io.readBinary(new Uint8Array(glbArrayBuffer));
        await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
        const out = await io.writeBinary(doc);
        return { data: out, compressed: true };
    } catch (err) {
        console.warn('Meshopt-Kompression übersprungen (Fallback: unkomprimiertes GLB):', err);
        return { data: new Uint8Array(glbArrayBuffer), compressed: false };
    }
}

/** Kurzer Grössen-Hinweis fürs Export-Statusfeld (GLB komprimiert/roh). */
function glbExportInfo(info) {
    if (!info) return '';
    if (info.compressed) {
        return ` (GLB ${info.outKB} KB, komprimiert aus ${info.rawKB} KB)`;
    }
    return ` (GLB ${info.outKB} KB, unkomprimiert — Meshopt nicht verfügbar)`;
}

/**
 * Verdrahtet die Export-Buttons und bündelt alle Export-Abläufe:
 * Projektdatei, STL, Web-Export als ZIP und Test-Export auf den Server.
 */
export class ExportController {
    constructor({ viewer, settings, project, getModel, onStatus }) {
        this.viewer = viewer;
        this.settings = settings;
        this.project = project;
        this.getModel = getModel;
        this.onStatus = onStatus;

        $('btn-export-project').addEventListener('click', () => this.exportProject());
        $('btn-export-stl').addEventListener('click', () => this.exportSTL());
        $('btn-export-web').addEventListener('click', () => this.exportWeb());
        $('btn-export-test').addEventListener('click', () => this.exportTest());
    }

    exportProject() {
        const projekt = this.project.collect();
        if (this.getModel()) projekt.viewer = this.project.collectViewerConfig();
        downloadBlob(
            new Blob([JSON.stringify(projekt, null, 2)], { type: 'application/json' }),
            'projekt.json'
        );
        this.onStatus('Projektdatei gespeichert — über "Projekt importieren" wieder ladbar.');
    }

    exportSTL() {
        const model = this.getModel();
        if (!model) return;
        this.onStatus('Erzeuge STL …');
        const stl = buildBinarySTL(model.mesh, {
            exaggeration: this.settings.number('opt-exaggeration'),
            basePercent: this.settings.number('opt-base'),
            modelWidthMM: this.settings.number('opt-model-width'),
        });
        downloadBlob(new Blob([stl], { type: 'model/stl' }), 'terrain.stl');
        this.onStatus('STL exportiert.');
    }

    /**
     * Sammelt alle Dateien des Web-Exports (Viewer-HTML, Modell, projekt.json,
     * Texturen) — gemeinsame Basis für den ZIP-Download und den Test-Export.
     * Gibt { files, glbInfo } zurück; glbInfo enthält die GLB-Grössen für die
     * Statusmeldung.
     */
    async collectWebExportFiles() {
        const glb = await this.viewer.exportGLB();
        const compressedGlb = await compressGLB(glb);
        const viewerConfig = this.project.collectViewerConfig();
        const encoder = new TextEncoder();

        const files = [
            { name: 'terrain-3d.html', data: encoder.encode(buildWebViewerHTML()) },
            { name: 'terrain.glb', data: compressedGlb.data },
        ];

        // Texturen als separate Dateien (werden vom Viewer zur Laufzeit geladen).
        // WebP, wo möglich (deutlich kleiner), sonst JPG-Fallback. Der Sockel
        // braucht Transparenz → WebP verlustlos bzw. PNG-Fallback. Die tatsächliche
        // Endung überschreibt die Vorgabe in viewerConfig, damit projekt.json auf
        // die geschriebenen Dateien zeigt.
        if (viewerConfig.terrainTexture) {
            const tex = await encodeTexture(this.viewer.terrainMesh.material.map.image, 'textur-gelaende', 0.9);
            viewerConfig.terrainTexture = tex.name;
            files.push(tex);
        }
        if (viewerConfig.skirtTexture) {
            const canvas = this.viewer.skirtMesh.material.map.image;
            const skirt = canEncodeWebP()
                // WebP verlustlos (quality 1) erhält die Transparenz und schlägt PNG in der Grösse
                ? { name: 'textur-sockel.webp', data: await canvasToBytes(canvas, 'image/webp', 1) }
                : { name: 'textur-sockel.png', data: await canvasToBytes(canvas, 'image/png') };
            viewerConfig.skirtTexture = skirt.name;
            files.push(skirt);
        }
        if (viewerConfig.backgroundImage) {
            const bg = await encodeTexture(this.viewer.backgroundTexture.image, 'hintergrund', 0.88);
            viewerConfig.backgroundImage = bg.name;
            files.push(bg);
        }

        // Projektdatei zuletzt: nach den Texturen, damit die endgültigen
        // Dateinamen (Endung je nach WebP-Unterstützung) in viewerConfig stehen.
        const projekt = this.project.collect();
        projekt.viewer = viewerConfig;
        files.push({ name: 'projekt.json', data: encoder.encode(JSON.stringify(projekt, null, 2)) });

        const glbInfo = {
            compressed: compressedGlb.compressed,
            rawKB: Math.round(glb.byteLength / 1024),
            outKB: Math.round(compressedGlb.data.byteLength / 1024),
        };
        return { files, glbInfo };
    }

    async exportWeb() {
        if (!this.getModel()) return;
        this.onStatus('Erzeuge Web-Export …');
        try {
            const { files, glbInfo } = await this.collectWebExportFiles();
            downloadBlob(new Blob([buildZip(files)], { type: 'application/zip' }), 'terrain-3d.zip');
            this.onStatus(`Web-Export (ZIP) erstellt${glbExportInfo(glbInfo)} — entpacken, komplett hochladen, per <iframe> einbinden.`);
        } catch (err) {
            console.error(err);
            this.onStatus(`Fehler beim Web-Export: ${err.message}`);
        }
    }

    async exportTest() {
        if (!this.getModel()) return;
        // Tab sofort im Klick-Handler öffnen, sonst greift der Popup-Blocker
        const testWindow = window.open('', '_blank');
        this.onStatus('Erzeuge Test-Export …');
        try {
            const upload = async (url, body) => {
                const response = await fetch(url, { method: 'POST', body });
                const result = await response.json().catch(() => ({}));
                if (!response.ok || !result.ok) {
                    throw new Error(result.error || `Server antwortete mit ${response.status}`);
                }
            };
            const { files, glbInfo } = await this.collectWebExportFiles();
            await upload('api/test-export.php?action=clear');
            for (const file of files) {
                await upload(`api/test-export.php?name=${encodeURIComponent(file.name)}`, file.data);
            }
            const testUrl = `test/terrain-3d.html?v=${Date.now()}`;
            if (testWindow) testWindow.location = testUrl;
            else window.open(testUrl, '_blank');
            this.onStatus(`Test-Export unter /test/ abgelegt und im neuen Tab geöffnet${glbExportInfo(glbInfo)}.`);
        } catch (err) {
            console.error(err);
            if (testWindow) testWindow.close();
            this.onStatus(`Fehler beim Test-Export: ${err.message}`);
        }
    }
}
