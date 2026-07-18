/**
 * Baut aus dem rechteckigen Höhenraster ein Geländenetz in der gewünschten
 * Grundform. Alle Netze teilen dieselbe Struktur:
 *
 *   positionsXY  Float32Array (n*2) — Meter relativ zur Bbox-Mitte, x = Ost, y = Nord
 *   heights      Float32Array (n)  — Höhe in Metern
 *   uvs          Float32Array (n*2) — Texturkoordinaten (v = 1 am Nordrand)
 *   indices      Uint32Array — Dreiecke, gegen den Uhrzeigersinn von oben
 *   boundary     Uint32Array — Randumlauf gegen den Uhrzeigersinn von oben
 */

/** Rechteck: übernimmt das Höhenraster 1:1 als regelmässiges Gitter. */
export function buildGridMesh(grid) {
    const { heights, gridW, gridH, widthMeters, depthMeters } = grid;
    const n = gridW * gridH;
    const positionsXY = new Float32Array(n * 2);
    const uvs = new Float32Array(n * 2);

    for (let row = 0; row < gridH; row++) {
        for (let col = 0; col < gridW; col++) {
            const i = row * gridW + col;
            const u = col / (gridW - 1);
            const v = 1 - row / (gridH - 1); // Bildzeile 0 = Norden
            positionsXY[i * 2] = (u - 0.5) * widthMeters;
            positionsXY[i * 2 + 1] = (v - 0.5) * depthMeters;
            uvs[i * 2] = u;
            uvs[i * 2 + 1] = v;
        }
    }

    const indices = new Uint32Array((gridW - 1) * (gridH - 1) * 6);
    let o = 0;
    for (let row = 0; row < gridH - 1; row++) {
        for (let col = 0; col < gridW - 1; col++) {
            const a = row * gridW + col;
            const b = a + 1;
            const c = a + gridW;
            const d = c + 1;
            indices[o++] = a; indices[o++] = d; indices[o++] = b;
            indices[o++] = a; indices[o++] = c; indices[o++] = d;
        }
    }

    // Randumlauf: Süd → Ost → Nord → West (jede Ecke genau einmal)
    const boundary = [];
    for (let c = 0; c < gridW - 1; c++) boundary.push((gridH - 1) * gridW + c);
    for (let r = gridH - 1; r > 0; r--) boundary.push(r * gridW + gridW - 1);
    for (let c = gridW - 1; c > 0; c--) boundary.push(c);
    for (let r = 0; r < gridH - 1; r++) boundary.push(r * gridW);

    return {
        positionsXY,
        heights: Float32Array.from(heights),
        uvs,
        indices,
        boundary: Uint32Array.from(boundary),
        widthMeters,
        depthMeters,
    };
}

/**
 * Kreis oder Sechseck: radiales Netz (Ringe × Sektoren), in die Bbox
 * eingeschrieben. Höhen werden bilinear aus dem Raster abgetastet,
 * dadurch bleibt der Rand glatt statt treppenförmig.
 */
export function buildShapeMesh(grid, shape) {
    const { gridW, gridH, widthMeters, depthMeters } = grid;

    const rings = Math.max(24, Math.min(160, Math.round(Math.min(gridW, gridH) / 2)));
    let sectors = Math.max(96, Math.min(720, rings * 6));
    sectors = 6 * Math.ceil(sectors / 6); // Vielfaches von 6 → exakte Sechseck-Ecken

    // Einheitsform mit Ausdehnung [-1, 1] in beiden Achsen, Ecke bei θ = 0 (Ost)
    const unitPoint = (theta) => {
        if (shape === 'hexagon') {
            const sectorAngle = Math.PI / 3;
            const phi = ((theta % sectorAngle) + sectorAngle) % sectorAngle;
            const r = Math.cos(Math.PI / 6) / Math.cos(phi - Math.PI / 6);
            return [r * Math.cos(theta), (r * Math.sin(theta)) / (Math.sqrt(3) / 2)];
        }
        return [Math.cos(theta), Math.sin(theta)];
    };

    const n = 1 + rings * sectors;
    const positionsXY = new Float32Array(n * 2);
    const heights = new Float32Array(n);
    const uvs = new Float32Array(n * 2);

    const setVertex = (i, ux, uy) => {
        const u = ux / 2 + 0.5;
        const v = uy / 2 + 0.5;
        positionsXY[i * 2] = ux * (widthMeters / 2);
        positionsXY[i * 2 + 1] = uy * (depthMeters / 2);
        uvs[i * 2] = u;
        uvs[i * 2 + 1] = v;
        heights[i] = sampleHeight(grid, u, v);
    };

    setVertex(0, 0, 0);
    const idx = (ring, s) => 1 + (ring - 1) * sectors + (s % sectors);
    for (let ring = 1; ring <= rings; ring++) {
        const t = ring / rings;
        for (let s = 0; s < sectors; s++) {
            const [ux, uy] = unitPoint((s / sectors) * 2 * Math.PI);
            setVertex(idx(ring, s), ux * t, uy * t);
        }
    }

    const indices = new Uint32Array(sectors * (2 * rings - 1) * 3);
    let o = 0;
    for (let s = 0; s < sectors; s++) {
        indices[o++] = 0;
        indices[o++] = idx(1, s);
        indices[o++] = idx(1, s + 1);
    }
    for (let ring = 1; ring < rings; ring++) {
        for (let s = 0; s < sectors; s++) {
            const a = idx(ring, s);
            const b = idx(ring, s + 1);
            const c = idx(ring + 1, s);
            const d = idx(ring + 1, s + 1);
            indices[o++] = a; indices[o++] = c; indices[o++] = d;
            indices[o++] = a; indices[o++] = d; indices[o++] = b;
        }
    }

    const boundary = new Uint32Array(sectors);
    for (let s = 0; s < sectors; s++) boundary[s] = idx(rings, s);

    return { positionsXY, heights, uvs, indices, boundary, widthMeters, depthMeters };
}

/**
 * Liegt der normalisierte Punkt (ux, uy ∈ [-1, 1], Bbox-Mitte = 0) innerhalb
 * der Grundform? Wird zum Beschneiden von Markern und Wegen verwendet.
 */
export function insideShape(ux, uy, shape) {
    if (shape === 'circle') {
        return ux * ux + uy * uy <= 1.0001;
    }
    if (shape === 'hexagon') {
        // Normierung des Netzes rückgängig machen (y war durch √3/2 geteilt)
        const hy = (uy * Math.sqrt(3)) / 2;
        const r = Math.hypot(ux, hy);
        const sectorAngle = Math.PI / 3;
        const theta = Math.atan2(hy, ux);
        const phi = ((theta % sectorAngle) + sectorAngle) % sectorAngle;
        return r <= Math.cos(Math.PI / 6) / Math.cos(phi - Math.PI / 6) + 1e-4;
    }
    return Math.abs(ux) <= 1 && Math.abs(uy) <= 1;
}

/**
 * Gebackene Umgebungsverdeckung (Ambient Occlusion) aus dem Höhenraster:
 * pro Rasterpunkt wird in 8 Richtungen der Horizontwinkel gesucht (HBAO-
 * Prinzip) — Täler und Mulden erhalten weniger Himmelslicht als Grate und
 * wirken dadurch plastischer. Die Überhöhung geht in die Winkel ein, damit
 * die Verdeckung zur dargestellten (überhöhten) Geometrie passt.
 *
 * @returns Float32Array (gridW × gridH) Sichtbarkeit 0..1 (1 = unverdeckt)
 */
export function computeAmbientOcclusion(grid, exaggeration) {
    const { heights, gridW, gridH, widthMeters, depthMeters } = grid;
    const stepX = widthMeters / (gridW - 1);
    const stepY = depthMeters / (gridH - 1);
    const dirs = [
        [1, 0], [-1, 0], [0, 1], [0, -1],
        [1, 1], [1, -1], [-1, 1], [-1, -1],
    ];
    // Abtastdistanzen in Zellen: nah dicht, fern grob (geometrisch wachsend)
    const steps = [];
    const maxDist = Math.min(64, Math.floor(Math.max(gridW, gridH) / 4));
    for (let d = 1; d <= maxDist; d = Math.ceil(d * 1.5)) steps.push(d);

    const ao = new Float32Array(gridW * gridH);
    for (let y = 0; y < gridH; y++) {
        for (let x = 0; x < gridW; x++) {
            const h0 = heights[y * gridW + x];
            let visibility = 0;
            for (const [dx, dy] of dirs) {
                const stepLen = Math.hypot(dx * stepX, dy * stepY);
                let maxTan = 0;
                for (const d of steps) {
                    const nx = x + dx * d;
                    const ny = y + dy * d;
                    if (nx < 0 || ny < 0 || nx >= gridW || ny >= gridH) break;
                    const tan = ((heights[ny * gridW + nx] - h0) * exaggeration) / (d * stepLen);
                    if (tan > maxTan) maxTan = tan;
                }
                // Sichtbarer Himmelsanteil dieser Richtung: 1 − sin(Horizontwinkel)
                visibility += 1 - maxTan / Math.sqrt(1 + maxTan * maxTan);
            }
            ao[y * gridW + x] = visibility / dirs.length;
        }
    }
    return ao;
}

/** Bilineare Höhenabtastung; u = 0..1 (West → Ost), v = 0..1 (Süd → Nord). */
export function sampleHeight(grid, u, v) {
    const { heights, gridW, gridH } = grid;
    const fx = Math.min(Math.max(u, 0), 1) * (gridW - 1);
    const fy = (1 - Math.min(Math.max(v, 0), 1)) * (gridH - 1);
    const x0 = Math.min(Math.floor(fx), gridW - 2);
    const y0 = Math.min(Math.floor(fy), gridH - 2);
    const tx = fx - x0;
    const ty = fy - y0;
    const h00 = heights[y0 * gridW + x0];
    const h10 = heights[y0 * gridW + x0 + 1];
    const h01 = heights[(y0 + 1) * gridW + x0];
    const h11 = heights[(y0 + 1) * gridW + x0 + 1];
    return (h00 * (1 - tx) + h10 * tx) * (1 - ty) + (h01 * (1 - tx) + h11 * tx) * ty;
}
