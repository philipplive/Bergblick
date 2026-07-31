<?php

declare(strict_types=1);

namespace Berglick\MapGenerator\Controller;

use Berglick\MapGenerator\Application;

/**
 * Nimmt die Dateien des Web-Exports entgegen und legt sie unter public/test/
 * ab, damit der Export direkt im Browser geprüft werden kann.
 *
 * POST api/test-export.php?action=clear  → leert den Test-Ordner
 * POST api/test-export.php?name=<datei>  → schreibt den Request-Body als Datei
 */
final class TestExportController {
	private const array ALLOWED_EXTENSIONS = ['html', 'json', 'glb', 'jpg', 'jpeg', 'png', 'webp', 'md'];

	public function handle (array $query): void {
		// JSON-Endpoint: Notices/Warnings gehören ins Log, nie in die Antwort
		ini_set ('display_errors', '0');
		header ('Content-Type: application/json');

		try {
			if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
				$this->error (405, 'Nur POST erlaubt');
				return;
			}

			$dir = Application::publicDir ().'/test';

			if (($query['action'] ?? '') === 'clear') {
				$this->clearDirectory ($dir);
				echo json_encode (['ok' => true]);
				return;
			}

			$name = (string)($query['name'] ?? '');
			if (!$this->isValidFilename ($name)) {
				$this->error (400, 'Ungültiger Dateiname');
				return;
			}

			if (!is_dir ($dir) && !mkdir ($dir, 0775, true)) {
				throw new \RuntimeException ('Test-Ordner konnte nicht erstellt werden');
			}

			$data = file_get_contents ('php://input');
			if ($data === false || file_put_contents ($dir.'/'.$name, $data) === false) {
				throw new \RuntimeException ('Datei konnte nicht geschrieben werden');
			}

			echo json_encode (['ok' => true, 'name' => $name]);
		} catch (\Throwable) {
			$this->error (500, 'Interner Fehler beim Test-Export');
		}
	}

	/** Nur einfache Dateinamen mit bekannter Endung — keine Pfade, keine Dotfiles. */
	private function isValidFilename (string $name): bool {
		if (preg_match ('/^[a-z0-9][a-z0-9._-]{0,127}$/i', $name) !== 1) {
			return false;
		}
		$extension = strtolower (pathinfo ($name, PATHINFO_EXTENSION));
		return in_array ($extension, self::ALLOWED_EXTENSIONS, true);
	}

	private function clearDirectory (string $dir): void {
		if (!is_dir ($dir)) {
			return;
		}
		foreach (glob ($dir.'/*') ?: [] as $file) {
			if (is_file ($file)) {
				unlink ($file);
			}
		}
	}

	private function error (int $status, string $message): void {
		http_response_code ($status);
		echo json_encode (['ok' => false, 'error' => $message]);
	}
}
