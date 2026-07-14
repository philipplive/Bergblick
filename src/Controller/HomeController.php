<?php

declare(strict_types=1);

namespace Berglick\MapGenerator\Controller;

use Berglick\MapGenerator\Application;
use Berglick\MapGenerator\View\Template;

/** Liefert die Editor-Oberfläche aus. */
final class HomeController {
	private readonly Template $template;

	public function __construct (?Template $template = null) {
		$this->template = $template ?? new Template(Application::templateDir ());
	}

	public function handle (): void {
		echo $this->template->render ('app', ['appName' => Application::NAME]);
	}
}
