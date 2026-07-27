import { $ } from './dom.js';

// ---------------------------------------------------------------------------
// Einstellungs-Panel: verdrahtet die Regler mit dem 3D-Viewer
// ---------------------------------------------------------------------------

/** Alle Eingabefelder, die in der Projektdatei gespeichert werden (ohne Checkboxen). */
export const SETTING_IDS = [
    'opt-style', 'opt-resolution', 'opt-texture-size', 'opt-exaggeration', 'opt-ao',
    'opt-base', 'opt-ground-offset',
    'opt-base-style', 'opt-base-relief', 'opt-base-color', 'opt-ground-color', 'opt-shadow-color',
    'opt-shadow-hardness', 'opt-shadow-strength', 'opt-light-rot', 'opt-light-elev', 'opt-exposure', 'opt-env',
    'opt-clouds', 'opt-cloud-speed', 'opt-cloud-size', 'opt-cloud-opacity', 'opt-cloud-color', 'opt-cloud-rain',
    'opt-lightning', 'opt-fog', 'opt-fog-size', 'opt-snow', 'opt-snow-size',
    'opt-model-width',
    'opt-tilt-limit', 'opt-zoom-limit',
];

const percent = (v) => `${v} %`;
const degrees = (v) => `${v}°`;

/**
 * Bindet alle Regler, Farbwähler und Schalter deklarativ an den Viewer:
 * `out` ist das zugehörige Ausgabefeld, `format` dessen Textformat und
 * `apply` der Viewer-Setter (null = wirkt nur im exportierten Viewer).
 * Die Regler wirken live auf das bestehende Modell.
 */
export class SettingsPanel {
    constructor(viewer, { onStatus }) {
        this.viewer = viewer;
        this.onStatus = onStatus;

        this.bindSliders();
        this.bindColorsAndSwitches();
        this.bindBackgroundImage();
    }

    bindSliders() {
        const viewer = this.viewer;
        const sliders = [
            { id: 'opt-exaggeration', out: 'out-exaggeration', format: (v) => `${Number(v).toFixed(1)}×`, apply: (v) => viewer.setExaggeration(Number(v)) },
            { id: 'opt-base', out: 'out-base', format: percent, apply: (v) => viewer.setBasePercent(Number(v)) },
            { id: 'opt-ground-offset', out: 'out-ground-offset', format: percent, apply: (v) => viewer.setGroundOffset(Number(v)) },
            { id: 'opt-ao', out: 'out-ao', format: percent, apply: (v) => viewer.setAOStrength(Number(v)) },
            { id: 'opt-exposure', out: 'out-exposure', format: percent, apply: (v) => viewer.setExposure(Number(v)) },
            { id: 'opt-env', out: 'out-env', format: percent, apply: (v) => viewer.setEnvIntensity(Number(v)) },
            { id: 'opt-base-relief', out: 'out-base-relief', format: percent, apply: (v) => viewer.setBaseRelief(Number(v)) },
            { id: 'opt-shadow-hardness', out: 'out-shadow', format: percent, apply: (v) => viewer.setShadowHardness(Number(v)) },
            { id: 'opt-shadow-strength', out: 'out-shadow-strength', format: percent, apply: (v) => viewer.setShadowStrength(Number(v)) },
            { id: 'opt-light-rot', out: 'out-light-rot', format: degrees, apply: (v) => viewer.setLightRotation(Number(v)) },
            { id: 'opt-light-elev', out: 'out-light-elev', format: degrees, apply: (v) => viewer.setLightElevation(Number(v)) },
            { id: 'opt-clouds', out: 'out-clouds', format: (v) => v, apply: (v) => viewer.setCloudCount(Number(v)) },
            { id: 'opt-cloud-speed', out: 'out-cloud-speed', format: percent, apply: (v) => viewer.setCloudSpeed(Number(v)) },
            { id: 'opt-cloud-size', out: 'out-cloud-size', format: percent, apply: (v) => viewer.setCloudSize(Number(v)) },
            { id: 'opt-cloud-opacity', out: 'out-cloud-opacity', format: percent, apply: (v) => viewer.setCloudOpacity(Number(v)) },
            { id: 'opt-cloud-rain', out: 'out-cloud-rain', format: percent, apply: (v) => viewer.setCloudRain(Number(v)) },
            { id: 'opt-lightning', out: 'out-lightning', format: percent, apply: (v) => viewer.setCloudLightning(Number(v)) },
            { id: 'opt-fog', out: 'out-fog', format: percent, apply: (v) => viewer.setFogDensity(Number(v)) },
            { id: 'opt-fog-size', out: 'out-fog-size', format: percent, apply: (v) => viewer.setFogSize(Number(v)) },
            { id: 'opt-snow', out: 'out-snow', format: percent, apply: (v) => viewer.setSnow(Number(v)) },
            { id: 'opt-snow-size', out: 'out-snow-size', format: percent, apply: (v) => viewer.setSnowSize(Number(v)) },
            // Export-Sichtbegrenzungen (wirken nur im exportierten Viewer)
            { id: 'opt-tilt-limit', out: 'out-tilt-limit', format: degrees, apply: null },
            { id: 'opt-zoom-limit', out: 'out-zoom-limit', format: percent, apply: null },
        ];
        for (const { id, out, format, apply } of sliders) {
            $(id).addEventListener('input', (e) => {
                $(out).textContent = format(e.target.value);
                if (apply) apply(e.target.value);
            });
        }
    }

    bindColorsAndSwitches() {
        const viewer = this.viewer;
        const inputs = [
            { id: 'opt-base-color', event: 'input', apply: (v) => viewer.setBaseColor(v) },
            { id: 'opt-base-style', event: 'change', apply: (v) => viewer.setBaseStyle(v) },
            { id: 'opt-ground-color', event: 'input', apply: (v) => viewer.setGroundColor(v) },
            { id: 'opt-shadow-color', event: 'input', apply: (v) => viewer.setShadowColor(v) },
            { id: 'opt-cloud-color', event: 'input', apply: (v) => viewer.setCloudColor(v) },
        ];
        for (const { id, event, apply } of inputs) {
            $(id).addEventListener(event, (e) => apply(e.target.value));
        }

        $('opt-ground').addEventListener('change', (e) => viewer.setGroundVisible(e.target.checked));
        $('opt-transparent').addEventListener('change', (e) => viewer.setTransparentBackground(e.target.checked));
    }

    bindBackgroundImage() {
        $('opt-bg-image').addEventListener('change', async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            try {
                this.viewer.setBackgroundImage(await createImageBitmap(file));
            } catch (err) {
                console.error(err);
                this.onStatus('Hintergrundbild konnte nicht geladen werden.');
            }
        });

        $('btn-bg-clear').addEventListener('click', () => {
            $('opt-bg-image').value = '';
            this.viewer.setBackgroundImage(null);
        });
    }

    // --- Zugriff auf aktuelle Werte -------------------------------------------

    value(id) {
        return $(id).value;
    }

    number(id) {
        return Number($(id).value);
    }

    checked(id) {
        return $(id).checked;
    }

    // --- Projektdatei -----------------------------------------------------------

    /** Alle Einstellungen für die Projektdatei. */
    collect() {
        const inputs = {};
        for (const id of SETTING_IDS) inputs[id] = $(id).value;
        inputs['opt-ground'] = $('opt-ground').checked;
        inputs['opt-transparent'] = $('opt-transparent').checked;
        return inputs;
    }

    /** Übernimmt Einstellungen (Whitelist; Events feuern die bestehende Verdrahtung). */
    apply(inputs) {
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
    }
}
