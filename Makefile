.DEFAULT_GOAL := help

.PHONY: help build up start rebuild down stop restart logs ps status

help: ## Show this help
	@awk 'BEGIN {FS = ":.*##"; printf "Usage: make [target]\n\n"} /^[a-zA-Z_-]+:.*?##/ { printf "  %-10s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

build: ## Build the bot image
	docker compose build

up: ## Start the bot in background
	docker compose up -d

start: up ## Alias for up

rebuild: ## Build and start
	docker compose up -d --build

down: ## Stop and remove the container
	docker compose down

stop: down ## Alias for down

restart: ## Restart the running container
	docker compose restart

logs: ## Follow container logs
	docker compose logs -f

ps: ## Show container status
	docker compose ps

status: ps ## Alias for ps
