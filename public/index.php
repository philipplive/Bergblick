<?php

declare(strict_types=1);

require dirname(__DIR__) . '/src/bootstrap.php';

use Berglick\MapGenerator\Controller\HomeController;

(new HomeController())->handle();
