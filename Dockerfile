FROM php:8.3-cli

# gd muss im offiziellen Image selbst kompiliert werden (curl ist bereits enthalten).
# Die *-dev-Pakete werden nur zum Build gebraucht und danach wieder entfernt.
RUN set -eux; \
	apt-get update; \
	apt-get install -y --no-install-recommends \
		libpng-dev \
		libjpeg62-turbo-dev \
		libwebp-dev \
		libfreetype6-dev; \
	docker-php-ext-configure gd --with-jpeg --with-webp --with-freetype; \
	docker-php-ext-install -j"$(nproc)" gd; \
	apt-get purge -y --auto-remove libpng-dev libjpeg62-turbo-dev libwebp-dev libfreetype6-dev; \
	# Die Runtime-Libraries, gegen die gd gelinkt ist, müssen bleiben —
	# --auto-remove nimmt sie zusammen mit den *-dev-Paketen mit.
	apt-get install -y --no-install-recommends \
		libpng16-16 \
		libjpeg62-turbo \
		libwebp7 \
		libwebpmux3 \
		libwebpdemux2 \
		libfreetype6; \
	rm -rf /var/lib/apt/lists/*

COPY docker/php.ini /usr/local/etc/php/conf.d/99-map-gen.ini

WORKDIR /app

EXPOSE 8123

# Entwicklungsserver — der Code kommt per Bind-Mount aus docker-compose.yml.
CMD ["php", "-S", "0.0.0.0:8123", "-t", "public"]
