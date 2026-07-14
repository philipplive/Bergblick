<?php

declare(strict_types=1);

namespace Berglick\MapGenerator\Controller;

use Berglick\MapGenerator\Geo\BoundingBox;
use Berglick\MapGenerator\Tile\TileService;

/**
 * Liefert das Texturbild (Satellit oder OSM-Karte) für eine Bounding-Box als JPEG.
 *
 * GET-Parameter:
 *   bbox  = west,south,east,north (Grad, WGS84)
 *   style = satellite | osm (Default satellite)
 *   size  = Kantenlänge der längeren Seite in Pixeln (256–2048, Default 1024)
 */
final class TextureController extends ApiController {
	protected function respond (TileService $tiles, array $query): void {
		$bbox = BoundingBox::fromString ((string)($query['bbox'] ?? ''));
		$style = ($query['style'] ?? 'satellite') === 'osm' ? 'osm' : 'satellite';
		$size = max (256, min (2048, (int)($query['size'] ?? 1024)));

		$result = $tiles->stitch ($style, $bbox, $size, rescale: true);

		$this->sendImageHeaders ('image/jpeg', $result['bbox'], $result['zoom']);
		imagejpeg ($result['image'], null, 88);
	}

	protected function internalErrorMessage (): string {
		return 'Interner Fehler beim Laden der Textur';
	}
}
