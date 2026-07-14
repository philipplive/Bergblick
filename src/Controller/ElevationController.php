<?php

declare(strict_types=1);

namespace Berglick\MapGenerator\Controller;

use Berglick\MapGenerator\Geo\BoundingBox;
use Berglick\MapGenerator\Tile\TileService;

/**
 * Liefert die Höhendaten für eine Bounding-Box als Terrarium-kodiertes PNG.
 * Dekodierung im Client: hoehe_m = (R * 256 + G + B / 256) - 32768
 *
 * GET-Parameter:
 *   bbox = west,south,east,north (Grad, WGS84)
 *   size = gewünschte Rasterauflösung der längeren Seite (64–1024, Default 256)
 */
final class ElevationController extends ApiController {
	protected function respond (TileService $tiles, array $query): void {
		$bbox = BoundingBox::fromString ((string)($query['bbox'] ?? ''));
		$size = max (64, min (1024, (int)($query['size'] ?? 256)));

		$result = $tiles->stitch ('elevation', $bbox, $size, rescale: false);

		$this->sendImageHeaders ('image/png', $result['bbox'], $result['zoom']);
		imagepng ($result['image'], null, 6);
	}

	protected function internalErrorMessage (): string {
		return 'Interner Fehler beim Laden der Höhendaten';
	}
}
