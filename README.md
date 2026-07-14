# Berglick Map-Generator

Web-App zum Erzeugen von 3D-Geländemodellen aus einem frei wählbaren Kartenausschnitt.

![3D-Ansicht des Berglick Map-Generators](docs/images/screenshot-3d-ansicht.png)

## Starten

```bash
php -S localhost:8123 -t public
```

Danach im Browser öffnen: <http://localhost:8123>

## Funktionen

- **Kartenausschnitt wählen:** Der gewünschte Bereich wird direkt auf der Karte per Auswahlwerkzeug (Rechteck, Kreis oder Sechseck) festgelegt. Die Auswahl ist auf maximal 15 × 15 km begrenzt.
- **Export als STL:** Das erzeugte Geländemodell kann STL exportiert werden – direkt geeignet für den 3D-Druck.
- **Export als eigenständiges iframe:** Alternativ lässt sich das Modell als statischer, interaktiver Web-Viewer exportieren, der z. B. per `<iframe>` in eine eigene Website eingebettet werden kann.

### API des exportierten iframes

Der exportierte Web-Viewer lässt sich von der einbettenden Seite aus per JavaScript steuern. Die Namen der Overlays entsprechen den Nummern aus der App: `marker-<Nr>`, `weg-<Nr>`, `tafel-<Nr>`.

**Cross-origin per `postMessage`** (funktioniert auch, wenn iframe und Seite auf unterschiedlichen Domains liegen):

```html
<iframe id="karte" src="terrain-3d.html" width="800" height="600" style="border:0"></iframe>

<script>
const karte = document.getElementById('karte');

// Weg 1 ausblenden
karte.contentWindow.postMessage(
  { type: 'overlay-visibility', name: 'weg-1', visible: false },
  '*'
);

// Marker 2 umschalten
karte.contentWindow.postMessage({ type: 'overlay-toggle', name: 'marker-2' }, '*');

// Verfügbare Namen abfragen
window.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'overlay-list') console.log(e.data.names);
});
karte.contentWindow.postMessage({ type: 'overlay-list' }, '*');

// Wolken steuern (alle Felder optional)
karte.contentWindow.postMessage(
  { type: 'clouds', count: 10, speed: 80, size: 150, opacity: 60 },
  '*'
);
karte.contentWindow.postMessage({ type: 'clouds', count: 0 }, '*'); // Wolken aus
</script>
```

**Same-origin direkt über `contentWindow.terrainViewer`** (iframe und Seite auf derselben Domain):

```js
const karte = document.getElementById('karte');
const viewer = karte.contentWindow.terrainViewer;

viewer.setVisible('weg-1', false);
viewer.toggle('marker-2');
viewer.getVisible('weg-1');   // true | false | null
viewer.list();                // alle steuerbaren Namen

viewer.setClouds({ opacity: 50 });
viewer.getClouds();           // { count, speed, size, opacity }
```

Weitere Einstellungen (Hintergrundfarbe, Marker-/Wegfarben, Licht, Schatten) lassen sich direkt in der mitexportierten `projekt.json` anpassen, ohne erneut exportieren zu müssen.

## Datenquellen

- **Höhendaten:** [Terrain Tiles](https://registry.opendata.aws/terrain-tiles/)
  (Mapzen/AWS Open Data, Terrarium-Kodierung, frei nutzbar)
- **Karte:** © [OpenStreetMap](https://www.openstreetmap.org/copyright)-Mitwirkende
- **Satellitenbilder:** © Esri World Imagery

Voraussetzungen: PHP ≥ 8.1 mit den Extensions `gd` und `curl`.
