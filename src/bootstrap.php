<?php

declare(strict_types=1);

/**
 * Gemeinsamer Einstiegspunkt aller public/-Skripte:
 * registriert den Autoloader für Berglick\MapGenerator.
 */

require_once __DIR__ . '/Autoloader.php';

(new \Berglick\MapGenerator\Autoloader('Berglick\\MapGenerator\\', __DIR__))->register();
