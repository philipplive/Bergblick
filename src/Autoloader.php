<?php

declare(strict_types=1);

namespace Berglick\MapGenerator;

/**
 * PSR-4-Autoloader für den Namespace Berglick\MapGenerator
 * Klassenname relativ zum Präfix = Dateipfad relativ zum Basisverzeichnis.
 */
final class Autoloader {
	public function __construct (
		private readonly string $prefix,
		private readonly string $baseDir,
	) {
	}

	public function register (): void {
		spl_autoload_register ($this->load (...));
	}

	private function load (string $class): void {
		if (!str_starts_with ($class, $this->prefix))
			return;

		$relative = substr ($class, strlen ($this->prefix));
		$file = $this->baseDir.'/'.str_replace ('\\', '/', $relative).'.php';
		if (is_file ($file))
			require $file;
	}
}
