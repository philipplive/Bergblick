<?php

declare(strict_types=1);

namespace Berglick\MapGenerator\View;

/**
 * Minimaler PHP-Template-Renderer: rendert templates/<name>.php,
 * die übergebenen Variablen sind im Template als lokale Variablen sichtbar.
 */
final class Template
{
    public function __construct(private readonly string $templateDir)
    {
    }

    /** @param array<string, mixed> $vars */
    public function render(string $name, array $vars = []): string
    {
        $file = $this->templateDir . '/' . $name . '.php';
        if (!is_file($file))
            throw new \InvalidArgumentException("Template nicht gefunden: $name");

        extract($vars, EXTR_SKIP);
        ob_start();
        try {
            require $file;
            return (string)ob_get_clean();
        } catch (\Throwable $e) {
            ob_end_clean();
            throw $e;
        }
    }
}
