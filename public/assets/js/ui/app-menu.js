import { $ } from './dom.js';

// ---------------------------------------------------------------------------
// Burger-Menü neben dem Titel
// ---------------------------------------------------------------------------

/**
 * Öffnet das Dropdown neben dem Titel; Klick daneben oder Escape schliesst es
 * wieder. Der Menüpunkt "Projekt importieren" reicht die gewählte Datei an
 * onImport(file) weiter.
 */
export class AppMenu {
    constructor({ onImport }) {
        this.dropdown = $('app-menu-dropdown');

        $('btn-menu').addEventListener('click', (e) => {
            e.stopPropagation();
            this.dropdown.hidden = !this.dropdown.hidden;
        });

        document.addEventListener('click', (e) => {
            if (!this.dropdown.hidden && !this.dropdown.contains(e.target)) this.close();
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') this.close();
        });

        $('btn-import').addEventListener('click', () => {
            this.close();
            $('opt-import-file').click();
        });

        $('opt-import-file').addEventListener('change', (e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file) return;
            onImport(file);
        });
    }

    close() {
        this.dropdown.hidden = true;
    }
}
