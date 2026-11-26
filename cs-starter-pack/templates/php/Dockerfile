# PHP template (Laravel or plain PHP). Serves public/ on port 8080.
FROM php:8.3-cli
RUN apt-get update && apt-get install -y unzip git libpq-dev && docker-php-ext-install pdo pdo_mysql pdo_pgsql && rm -rf /var/lib/apt/lists/*
COPY --from=composer:2 /usr/bin/composer /usr/bin/composer
WORKDIR /app
COPY . .
RUN composer install --no-dev --no-interaction || true
EXPOSE 8080
# Laravel: CMD ["php", "artisan", "serve", "--host=0.0.0.0", "--port=8080"]
CMD ["php", "-S", "0.0.0.0:8080", "-t", "public"]
