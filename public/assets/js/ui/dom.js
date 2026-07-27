// ---------------------------------------------------------------------------
// Kleine DOM-Helfer, die von allen UI-Bausteinen genutzt werden
// ---------------------------------------------------------------------------

/** Kurzform für document.getElementById. */
export const $ = (id) => document.getElementById(id);

/** Ersetzt HTML-Sonderzeichen, damit Nutzertext sicher in Markup landet. */
export const escapeHTML = (s) => s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
