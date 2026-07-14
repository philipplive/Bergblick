<?php

declare(strict_types=1);

namespace Berglick\MapGenerator\Geo;

/**
 * Bounding-Box in Grad (WGS84): west/south/east/north.
 *
 * Nutzereingaben laufen über fromString() und werden dort validiert;
 * der Konstruktor vertraut seinen Werten (für intern berechnete Boxen,
 * z. B. den auf Kachel-Pixel gerundeten Ausschnitt).
 */
final class BoundingBox {
	private const float MAX_EXTENT_DEGREES = 20.0;

	public function __construct (
		public readonly float $west,
		public readonly float $south,
		public readonly float $east,
		public readonly float $north,
	) {
	}

	/** Erwartet "west,south,east,north" in Grad; validiert Form und Wertebereich. */
	public static function fromString (string $csv): self {
		$parts = array_map (trim (...), explode (',', $csv));
		if (count ($parts) !== 4 || in_array ('', $parts, true))
			throw new \InvalidArgumentException('bbox muss 4 Werte enthalten: west,south,east,north');

		[$west, $south, $east, $north] = array_map (floatval (...), $parts);

		if ($west >= $east || $south >= $north)
			throw new \InvalidArgumentException('bbox ist leer oder verdreht (erwartet: west,south,east,north)');

		if ($west < -180 || $east > 180 || $south < -85.05 || $north > 85.05)
			throw new \InvalidArgumentException('bbox ausserhalb des gültigen Bereichs');

		if (($east - $west) > self::MAX_EXTENT_DEGREES || ($north - $south) > self::MAX_EXTENT_DEGREES)
			throw new \InvalidArgumentException('Der gewählte Bereich ist zu gross (max. 20° Kantenlänge)');

		return new self($west, $south, $east, $north);
	}

	/** "west,south,east,north" mit 8 Nachkommastellen (für den X-Bbox-Header). */
	public function toCsv (): string {
		return implode (',', array_map (
			static fn(float $v): string => sprintf ('%.8F', $v),
			[$this->west, $this->south, $this->east, $this->north]
		));
	}
}
