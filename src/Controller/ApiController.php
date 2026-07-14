<?php

declare(strict_types=1);

namespace Berglick\MapGenerator\Controller;

use Berglick\MapGenerator\Application;
use Berglick\MapGenerator\Geo\BoundingBox;
use Berglick\MapGenerator\Tile\TileService;

/**
 * Basis der Bild-Endpoints: CORS, Fehlerbehandlung (400 bei ungültigen
 * Parametern, 500 sonst) und die gemeinsamen Antwort-Header.
 */
abstract class ApiController {
	final public function handle (array $query): void {
		// Binär-Endpoint: Notices/Warnings gehören ins Log, nie in die Bilddaten
		ini_set ('display_errors', '0');

		header ('Access-Control-Allow-Origin: *');

		try {
			$this->respond (new TileService(Application::cacheDir ()), $query);
		} catch (\InvalidArgumentException $e) {
			$this->jsonError (400, $e->getMessage ());
		} catch (\Throwable) {
			$this->jsonError (500, $this->internalErrorMessage ());
		}
	}

	/** Verarbeitet die validierte Anfrage und schreibt das Bild in die Ausgabe. */
	abstract protected function respond (TileService $tiles, array $query): void;

	/** Meldung für unerwartete Fehler (ohne interne Details). */
	abstract protected function internalErrorMessage (): string;

	final protected function sendImageHeaders (string $contentType, BoundingBox $bbox, int $zoom): void {
		header ('Content-Type: '.$contentType);
		header ('Cache-Control: private, max-age=3600');
		header ('X-Bbox: '.$bbox->toCsv ());
		header ('X-Zoom: '.$zoom);
		header ('Access-Control-Expose-Headers: X-Bbox, X-Zoom');
	}

	private function jsonError (int $status, string $message): void {
		http_response_code ($status);
		header ('Content-Type: application/json');
		echo json_encode (['error' => $message]);
	}
}
