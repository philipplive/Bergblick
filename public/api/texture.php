<?php

declare(strict_types=1);

require dirname(__DIR__, 2) . '/src/bootstrap.php';

use Berglick\MapGenerator\Controller\TextureController;

(new TextureController())->handle($_GET);
