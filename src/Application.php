<?php

declare(strict_types=1);

namespace Berglick\MapGenerator;

/** Zentrale Konstanten und Pfade der App. */
final class Application {
	public const string NAME = 'Berglick Map-Generator';

	public static function rootDir (): string {
		return dirname (__DIR__);
	}

	public static function cacheDir (): string {
		return self::rootDir ().'/cache';
	}

	public static function publicDir (): string {
		return self::rootDir ().'/public';
	}

	public static function templateDir (): string {
		return self::rootDir ().'/templates';
	}
}
