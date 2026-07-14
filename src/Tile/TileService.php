<?php

declare(strict_types=1);

namespace Berglick\MapGenerator\Tile;

use Berglick\MapGenerator\Geo\BoundingBox;

/**
 * Lädt Slippy-Map-Kacheln (Höhendaten / Luftbild / OSM), fügt sie zu einem
 * Gesamtbild zusammen und schneidet es exakt auf die angefragte Bounding-Box zu.
 * Kacheln werden auf Disk gecached.
 */
final class TileService {
	private const int TILE_SIZE = 256;
	private const int MAX_TILES_PER_REQUEST = 150;
	private const int CONCURRENT_DOWNLOADS = 8;
	private const string USER_AGENT = 'berglick-map-generator/1.0 (private local 3d map generator)';

	private const array SOURCES = [
		'elevation' => [
			'url' => 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
			'ext' => 'png',
			'maxZoom' => 14,
			// Terrarium-Kodierung: Höhe 0 m entspricht RGB(128, 0, 0)
			'fill' => [128, 0, 0],
		],
		'satellite' => [
			'url' => 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
			'ext' => 'jpg',
			'maxZoom' => 17,
			'fill' => [40, 40, 40],
		],
		'osm' => [
			'url' => 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
			'ext' => 'png',
			'maxZoom' => 17,
			'fill' => [220, 220, 220],
		],
	];

	public function __construct (private readonly string $cacheDir) {
	}

	/**
	 * @param int $targetSize gewünschte Kantenlänge (längere Seite) in Pixeln
	 * @param bool $rescale true: Ergebnis exakt auf targetSize skalieren (Texturen),
	 *                      false: native Kachelauflösung behalten (Höhendaten, verlustfrei)
	 * @return array{image: \GdImage, bbox: BoundingBox, zoom: int}
	 */
	public function stitch (string $source, BoundingBox $bbox, int $targetSize, bool $rescale): array {
		if (!isset(self::SOURCES[$source]))
			throw new \InvalidArgumentException("Unbekannte Quelle: $source");

		$cfg = self::SOURCES[$source];
		$west = $bbox->west;
		$south = $bbox->south;
		$east = $bbox->east;
		$north = $bbox->north;

		$zoom = $this->pickZoom ($west, $south, $east, $north, $targetSize, $cfg['maxZoom'], $rescale);

		// Pixelkoordinaten der Bbox in der Weltkarte beim gewählten Zoom
		$pxWest = $this->lonToX ($west, $zoom) * self::TILE_SIZE;
		$pxEast = $this->lonToX ($east, $zoom) * self::TILE_SIZE;
		$pxNorth = $this->latToY ($north, $zoom) * self::TILE_SIZE;
		$pxSouth = $this->latToY ($south, $zoom) * self::TILE_SIZE;

		$cropX = (int)round ($pxWest);
		$cropY = (int)round ($pxNorth);
		$cropW = max (2, (int)round ($pxEast) - $cropX);
		$cropH = max (2, (int)round ($pxSouth) - $cropY);

		$tileMinX = intdiv ($cropX, self::TILE_SIZE);
		$tileMaxX = intdiv ($cropX + $cropW - 1, self::TILE_SIZE);
		$tileMinY = intdiv ($cropY, self::TILE_SIZE);
		$tileMaxY = intdiv ($cropY + $cropH - 1, self::TILE_SIZE);

		$canvas = imagecreatetruecolor ($cropW, $cropH);
		$fill = imagecolorallocate ($canvas, ...$cfg['fill']);
		imagefill ($canvas, 0, 0, $fill);

		$tiles = [];
		$maxIndex = (1 << $zoom) - 1;
		for ($ty = $tileMinY; $ty <= $tileMaxY; $ty++) {
			for ($tx = $tileMinX; $tx <= $tileMaxX; $tx++) {
				if ($tx < 0 || $ty < 0 || $tx > $maxIndex || $ty > $maxIndex) {
					continue;
				}
				$tiles[] = [$tx, $ty];
			}
		}

		foreach ($this->fetchTiles ($source, $cfg, $zoom, $tiles) as $key => $data) {
			[$tx, $ty] = $tiles[$key];
			$tileImg = @imagecreatefromstring ($data);
			if ($tileImg === false) {
				continue;
			}
			imagecopy (
				$canvas,
				$tileImg,
				$tx * self::TILE_SIZE - $cropX,
				$ty * self::TILE_SIZE - $cropY,
				0,
				0,
				self::TILE_SIZE,
				self::TILE_SIZE
			);
		}

		if ($rescale) {
			$scale = $targetSize / max ($cropW, $cropH);
			if ($scale < 1.0) {
				// IMG_BICUBIC schlägt in manchen GD-Builds fehl, daher Standard-Modus (bilinear)
				$scaled = imagescale ($canvas, max (2, (int)round ($cropW * $scale)), max (2, (int)round ($cropH * $scale)));

				if ($scaled !== false)
					$canvas = $scaled;
			}
		}

		// Exakte Geo-Grenzen des gerundeten Pixel-Ausschnitts zurückgeben
		$actualBbox = new BoundingBox(
			$this->xToLon ($cropX / self::TILE_SIZE, $zoom),
			$this->yToLat (($cropY + $cropH) / self::TILE_SIZE, $zoom),
			$this->xToLon (($cropX + $cropW) / self::TILE_SIZE, $zoom),
			$this->yToLat ($cropY / self::TILE_SIZE, $zoom),
        );

		return ['image' => $canvas, 'bbox' => $actualBbox, 'zoom' => $zoom];
	}

	private function pickZoom (float $west, float $south, float $east, float $north, int $targetSize, int $maxZoom, bool $rescale): int {
		// Pixelausdehnung der Bbox bei Zoom 0
		$w0 = ($this->lonToX ($east, 0) - $this->lonToX ($west, 0)) * self::TILE_SIZE;
		$h0 = ($this->latToY ($south, 0) - $this->latToY ($north, 0)) * self::TILE_SIZE;
		$extent0 = max ($w0, $h0, 1e-9);

		$exact = log ($targetSize / $extent0, 2);
		// Texturen: eine Stufe schärfer laden und herunterskalieren.
		// Höhendaten: nie über targetSize hinaus (Ausgabe bleibt unskaliert).
		$zoom = $rescale ? (int)ceil ($exact) : (int)floor ($exact);
		$zoom = max (1, min ($maxZoom, $zoom));

		while ($zoom > 1 && $this->countTiles ($west, $south, $east, $north, $zoom) > self::MAX_TILES_PER_REQUEST)
			$zoom--;

		return $zoom;
	}

	private function countTiles (float $west, float $south, float $east, float $north, int $zoom): int {
		$tx = (int)floor ($this->lonToX ($east, $zoom)) - (int)floor ($this->lonToX ($west, $zoom)) + 1;
		$ty = (int)floor ($this->latToY ($south, $zoom)) - (int)floor ($this->latToY ($north, $zoom)) + 1;
		return $tx * $ty;
	}

	/**
	 * Lädt Kacheln parallel (curl_multi) mit Disk-Cache.
	 *
	 * @param array<int, array{int, int}> $tiles [tileX, tileY]-Paare
	 * @return array<int, string> Kachel-Rohdaten, Schlüssel wie in $tiles
	 */
	private function fetchTiles (string $source, array $cfg, int $zoom, array $tiles): array {
		$results = [];
		$pending = [];

		foreach ($tiles as $key => [$tx, $ty]) {
			$cacheFile = sprintf ('%s/%s/%d/%d/%d.%s', $this->cacheDir, $source, $zoom, $tx, $ty, $cfg['ext']);
			$cached = @file_get_contents ($cacheFile);
			if ($cached !== false && $cached !== '')
				$results[$key] = $cached;
			else
				$pending[$key] = [$tx, $ty, $cacheFile];
		}

		foreach (array_chunk ($pending, self::CONCURRENT_DOWNLOADS, true) as $chunk) {
			$multi = curl_multi_init ();
			$handles = [];
			foreach ($chunk as $key => [$tx, $ty, $cacheFile]) {
				$url = strtr ($cfg['url'], ['{z}' => $zoom, '{x}' => $tx, '{y}' => $ty]);
				$ch = curl_init ($url);
				curl_setopt_array ($ch, [
					CURLOPT_RETURNTRANSFER => true,
					CURLOPT_FOLLOWLOCATION => true,
					CURLOPT_CONNECTTIMEOUT => 10,
					CURLOPT_TIMEOUT => 25,
					CURLOPT_USERAGENT => self::USER_AGENT,
				]);
				curl_multi_add_handle ($multi, $ch);
				$handles[$key] = [$ch, $cacheFile];
			}

			do {
				$status = curl_multi_exec ($multi, $running);
				if ($running > 0) {
					curl_multi_select ($multi, 1.0);
				}
			} while ($running > 0 && $status === CURLM_OK);

			foreach ($handles as $key => [$ch, $cacheFile]) {
				$httpCode = (int)curl_getinfo ($ch, CURLINFO_RESPONSE_CODE);
				$body = curl_multi_getcontent ($ch);
				if ($httpCode === 200 && is_string ($body) && $body !== '') {
					$results[$key] = $body;
					$dir = dirname ($cacheFile);
					if (is_dir ($dir) || @mkdir ($dir, 0775, true))
						@file_put_contents ($cacheFile, $body);
				}
				curl_multi_remove_handle ($multi, $ch);
			}
			curl_multi_close ($multi);
		}

		return $results;
	}

	private function lonToX (float $lon, int $zoom): float {
		return ($lon + 180.0) / 360.0 * (1 << $zoom);
	}

	private function latToY (float $lat, int $zoom): float {
		$latRad = deg2rad ($lat);
		return (1.0 - log (tan ($latRad) + 1.0 / cos ($latRad)) / M_PI) / 2.0 * (1 << $zoom);
	}

	private function xToLon (float $x, int $zoom): float {
		return $x / (1 << $zoom) * 360.0 - 180.0;
	}

	private function yToLat (float $y, int $zoom): float {
		$n = M_PI - 2.0 * M_PI * $y / (1 << $zoom);
		return rad2deg (atan (sinh ($n)));
	}
}
