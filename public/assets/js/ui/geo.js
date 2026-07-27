// ---------------------------------------------------------------------------
// Geo-Berechnungen rund um die Bereichsauswahl (reine Funktionen, Leaflet-Typen)
// ---------------------------------------------------------------------------

export const SQRT3 = Math.sqrt(3);

export const MAX_SELECTION_METERS = 15000; // maximale Kantenlänge der Auswahl: 15 km

export function metersPerDegree(latDeg) {
    const lat = (latDeg * Math.PI) / 180;
    return { lon: 111320 * Math.cos(lat), lat: 110574 };
}

/** Bbox (LatLngBounds) um einen Mittelpunkt, Halbachsen in Metern. */
export function bboxAround(center, rxMeters, ryMeters) {
    const mpd = metersPerDegree(center.lat);
    return L.latLngBounds(
        [center.lat - ryMeters / mpd.lat, center.lng - rxMeters / mpd.lon],
        [center.lat + ryMeters / mpd.lat, center.lng + rxMeters / mpd.lon]
    );
}

/** Sechseck-Eckpunkte (Ecke bei 0° = Ost, passend zum 3D-Netz). */
export function hexLatLngs(center, circumradiusMeters) {
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

export function boundsSizeMeters(bounds) {
    const sw = bounds.getSouthWest();
    return {
        width: sw.distanceTo(L.latLng(bounds.getSouth(), bounds.getEast())),
        height: sw.distanceTo(L.latLng(bounds.getNorth(), bounds.getWest())),
    };
}

/** Begrenzt eine Bbox auf max. 15 × 15 km (Mittelpunkt bleibt erhalten). */
export function clampBounds(bounds) {
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
export function clampCorner(start, current) {
    const width = start.distanceTo(L.latLng(start.lat, current.lng));
    const height = start.distanceTo(L.latLng(current.lat, start.lng));
    return L.latLng(
        start.lat + (current.lat - start.lat) * Math.min(1, MAX_SELECTION_METERS / height),
        start.lng + (current.lng - start.lng) * Math.min(1, MAX_SELECTION_METERS / width)
    );
}
