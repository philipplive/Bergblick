/**
 * Prozedurale, kachelbare Sockel-Texturen. Alle Texturen sind in hellen,
 * neutralen Tönen gehalten und werden über die Materialfarbe (Sockelfarbe)
 * eingefärbt. Rückgabe ist jeweils ein Canvas (256×256).
 */

const SIZE = 256;

function createContext(baseColor) {
    const canvas = document.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = baseColor;
    ctx.fillRect(0, 0, SIZE, SIZE);
    return ctx;
}

/** Zeichnet eine Form auch an den umgebrochenen Rändern → kachelbar. */
function wrapped(ctx, x, y, draw) {
    for (const dx of [-SIZE, 0, SIZE]) {
        for (const dy of [-SIZE, 0, SIZE]) {
            draw(x + dx, y + dy);
        }
    }
}

function speckle(ctx, count, radiusMin, radiusMax, alphaMin, alphaMax) {
    for (let i = 0; i < count; i++) {
        const x = Math.random() * SIZE;
        const y = Math.random() * SIZE;
        const r = radiusMin + Math.random() * (radiusMax - radiusMin);
        const alpha = alphaMin + Math.random() * (alphaMax - alphaMin);
        const rotation = Math.random() * Math.PI;
        const squash = 0.6 + Math.random() * 0.4;
        const dark = Math.random() < 0.55;
        ctx.fillStyle = dark ? `rgba(40,30,20,${alpha})` : `rgba(255,250,240,${alpha})`;
        wrapped(ctx, x, y, (px, py) => {
            ctx.beginPath();
            ctx.ellipse(px, py, r, r * squash, rotation, 0, 2 * Math.PI);
            ctx.fill();
        });
    }
}

/** Erdreich: feinkörnig gesprenkelt, dazu kleine helle Steinchen. */
export function makeSoilTexture() {
    const ctx = createContext('#b3a68f');
    speckle(ctx, 500, 0.8, 2.5, 0.1, 0.3);
    speckle(ctx, 60, 3, 7, 0.06, 0.16);
    for (let i = 0; i < 26; i++) {
        const x = Math.random() * SIZE;
        const y = Math.random() * SIZE;
        const r = 1.5 + Math.random() * 3.5;
        const rotation = Math.random() * Math.PI;
        ctx.fillStyle = 'rgba(228,222,206,0.75)';
        wrapped(ctx, x, y, (px, py) => {
            ctx.beginPath();
            ctx.ellipse(px, py, r, r * 0.7, rotation, 0, 2 * Math.PI);
            ctx.fill();
        });
    }
    return ctx.canvas;
}

/** Fels: grossflächige Flecken und feine diagonale Risse. */
export function makeRockTexture() {
    const ctx = createContext('#a8a29a');
    speckle(ctx, 70, 8, 30, 0.04, 0.1);
    speckle(ctx, 250, 1, 4, 0.05, 0.15);
    ctx.lineWidth = 1;
    for (let i = 0; i < 26; i++) {
        const x = Math.random() * SIZE;
        const y = Math.random() * SIZE;
        const length = 20 + Math.random() * 60;
        const angle = Math.PI * (0.15 + Math.random() * 0.25) * (Math.random() < 0.5 ? 1 : -1);
        ctx.strokeStyle = `rgba(30,25,20,${0.08 + Math.random() * 0.12})`;
        wrapped(ctx, x, y, (px, py) => {
            ctx.beginPath();
            ctx.moveTo(px, py);
            ctx.lineTo(px + Math.cos(angle) * length, py + Math.sin(angle) * length);
            ctx.stroke();
        });
    }
    return ctx.canvas;
}

/** Gesteinsschichten: horizontale Bänder wie Sedimentschichten. */
export function makeStrataTexture() {
    const ctx = createContext('#ada395');
    let y = 0;
    while (y < SIZE) {
        const height = 10 + Math.random() * 26;
        const lightness = 150 + Math.floor(Math.random() * 70);
        const warmth = Math.floor(Math.random() * 14);
        ctx.fillStyle = `rgb(${lightness + warmth},${lightness},${lightness - warmth})`;
        ctx.fillRect(0, y, SIZE, height);
        // dunkle Trennfuge zwischen den Schichten
        ctx.fillStyle = 'rgba(45,35,25,0.25)';
        ctx.fillRect(0, y + height - 1.5, SIZE, 1.5);
        y += height;
    }
    speckle(ctx, 350, 0.8, 2.2, 0.04, 0.1);
    return ctx.canvas;
}
