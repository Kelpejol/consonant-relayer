# ============================================================================
# Consonant Relayer v2 - Makefile
# ============================================================================
# Common commands for building, testing, and deploying the relayer
# 
# Usage:
#   make help              # Show available commands
#   make build             # Build Docker image
#   make dev               # Run in development mode
#   make test              # Run tests
#   make deploy            # Deploy to Kubernetes
# ============================================================================

.PHONY: help
.DEFAULT_GOAL := help

# Variables
IMAGE_NAME := consonant-relayer
IMAGE_TAG := 2.0.0
IMAGE_FULL := $(IMAGE_NAME):$(IMAGE_TAG)
REGISTRY := # Add your registry here (e.g., ghcr.io/org)
NAMESPACE := consonant-system

# Colors for output
COLOR_RESET := \033[0m
COLOR_BOLD := \033[1m
COLOR_GREEN := \033[32m
COLOR_YELLOW := \033[33m
COLOR_BLUE := \033[34m

# ============================================================================
# Help
# ============================================================================
help: ## Show this help message
	@echo "$(COLOR_BOLD)Consonant Relayer - Available Commands$(COLOR_RESET)"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  $(COLOR_BLUE)%-20s$(COLOR_RESET) %s\n", $$1, $$2}'
	@echo ""

# ============================================================================
# Development
# ============================================================================
install: ## Install dependencies
	@echo "$(COLOR_GREEN)Installing dependencies...$(COLOR_RESET)"
	npm ci

dev: ## Run in development mode (hot reload)
	@echo "$(COLOR_GREEN)Starting development server...$(COLOR_RESET)"
	npm run dev

clean: ## Clean build artifacts
	@echo "$(COLOR_YELLOW)Cleaning build artifacts...$(COLOR_RESET)"
	rm -rf dist
	rm -rf node_modules
	rm -rf coverage

# ============================================================================
# Building
# ============================================================================
build-local: ## Build TypeScript locally
	@echo "$(COLOR_GREEN)Building TypeScript...$(COLOR_RESET)"
	npm run build

build: ## Build Docker image
	@echo "$(COLOR_GREEN)Building Docker image: $(IMAGE_FULL)$(COLOR_RESET)"
	docker build -t $(IMAGE_FULL) .
	docker tag $(IMAGE_FULL) $(IMAGE_NAME):latest

build-no-cache: ## Build Docker image without cache
	@echo "$(COLOR_GREEN)Building Docker image (no cache): $(IMAGE_FULL)$(COLOR_RESET)"
	docker build --no-cache -t $(IMAGE_FULL) .
	docker tag $(IMAGE_FULL) $(IMAGE_NAME):latest

# ============================================================================
# Testing & Quality
# ============================================================================
lint: ## Run linting
	@echo "$(COLOR_GREEN)Running linter...$(COLOR_RESET)"
	npm run lint

lint-fix: ## Fix linting issues
	@echo "$(COLOR_GREEN)Fixing linting issues...$(COLOR_RESET)"
	npm run lint:fix

type-check: ## Run TypeScript type checking
	@echo "$(COLOR_GREEN)Type checking...$(COLOR_RESET)"
	npm run type-check

format: ## Format code with Prettier
	@echo "$(COLOR_GREEN)Formatting code...$(COLOR_RESET)"
	npm run format

format-check: ## Check code formatting
	@echo "$(COLOR_GREEN)Checking code formatting...$(COLOR_RESET)"
	npm run format:check

test: lint type-check ## Run all tests (lint + type-check)
	@echo "$(COLOR_GREEN)All checks passed!$(COLOR_RESET)"

# ============================================================================
# Docker Operations
# ============================================================================
up: ## Start services with docker-compose
	@echo "$(COLOR_GREEN)Starting services...$(COLOR_RESET)"
	docker-compose up -d

down: ## Stop services with docker-compose
	@echo "$(COLOR_YELLOW)Stopping services...$(COLOR_RESET)"
	docker-compose down

logs: ## View logs from docker-compose
	docker-compose logs -f

ps: ## Show running containers
	docker-compose ps

restart: down up ## Restart services

run: ## Run Docker container locally
	@echo "$(COLOR_GREEN)Running container: $(IMAGE_FULL)$(COLOR_RESET)"
	docker run -d \
		--name consonant-relayer \
		--env-file .env \
		-p 8080:8080 \
		-p 4317:4317 \
		$(IMAGE_FULL)

stop: ## Stop running container
	@echo "$(COLOR_YELLOW)Stopping container...$(COLOR_RESET)"
	docker stop consonant-relayer || true
	docker rm consonant-relayer || true

shell: ## Open shell in running container
	docker exec -it consonant-relayer sh

# ============================================================================
# Registry Operations
# ============================================================================
push: ## Push image to registry
	@if [ -z "$(REGISTRY)" ]; then \
		echo "$(COLOR_YELLOW)⚠️  REGISTRY not set. Set it in Makefile or run: make push REGISTRY=your-registry$(COLOR_RESET)"; \
		exit 1; \
	fi
	@echo "$(COLOR_GREEN)Pushing to registry: $(REGISTRY)/$(IMAGE_FULL)$(COLOR_RESET)"
	docker tag $(IMAGE_FULL) $(REGISTRY)/$(IMAGE_FULL)
	docker push $(REGISTRY)/$(IMAGE_FULL)

pull: ## Pull image from registry
	@if [ -z "$(REGISTRY)" ]; then \
		echo "$(COLOR_YELLOW)⚠️  REGISTRY not set$(COLOR_RESET)"; \
		exit 1; \
	fi
	@echo "$(COLOR_GREEN)Pulling from registry: $(REGISTRY)/$(IMAGE_FULL)$(COLOR_RESET)"
	docker pull $(REGISTRY)/$(IMAGE_FULL)

# ============================================================================
# Kubernetes Operations
# ============================================================================
k8s-namespace: ## Create Kubernetes namespace
	@echo "$(COLOR_GREEN)Creating namespace: $(NAMESPACE)$(COLOR_RESET)"
	kubectl create namespace $(NAMESPACE) --dry-run=client -o yaml | kubectl apply -f -

helm-install: ## Install with Helm
	@echo "$(COLOR_GREEN)Installing with Helm...$(COLOR_RESET)"
	helm install consonant-relayer ./helm \
		--namespace $(NAMESPACE) \
		--create-namespace \
		--values helm/values.yaml

helm-upgrade: ## Upgrade Helm release
	@echo "$(COLOR_GREEN)Upgrading Helm release...$(COLOR_RESET)"
	helm upgrade consonant-relayer ./helm \
		--namespace $(NAMESPACE) \
		--values helm/values.yaml

helm-uninstall: ## Uninstall Helm release
	@echo "$(COLOR_YELLOW)Uninstalling Helm release...$(COLOR_RESET)"
	helm uninstall consonant-relayer --namespace $(NAMESPACE)

k8s-logs: ## View Kubernetes logs
	kubectl logs -f -l app.kubernetes.io/name=consonant-relayer -n $(NAMESPACE)

k8s-status: ## Check Kubernetes status
	@echo "$(COLOR_BLUE)Pods:$(COLOR_RESET)"
	kubectl get pods -n $(NAMESPACE) -l app.kubernetes.io/name=consonant-relayer
	@echo ""
	@echo "$(COLOR_BLUE)Services:$(COLOR_RESET)"
	kubectl get svc -n $(NAMESPACE) -l app.kubernetes.io/name=consonant-relayer

k8s-delete: ## Delete Kubernetes resources
	@echo "$(COLOR_YELLOW)Deleting Kubernetes resources...$(COLOR_RESET)"
	kubectl delete all -l app.kubernetes.io/name=consonant-relayer -n $(NAMESPACE)

# ============================================================================
# Complete Workflows
# ============================================================================
ci: clean install test build ## Run full CI pipeline
	@echo "$(COLOR_GREEN)✓ CI pipeline complete!$(COLOR_RESET)"

deploy: build push helm-upgrade ## Build, push, and deploy
	@echo "$(COLOR_GREEN)✓ Deployment complete!$(COLOR_RESET)"

all: clean install test build ## Build everything from scratch
	@echo "$(COLOR_GREEN)✓ Build complete!$(COLOR_RESET)"

# ============================================================================
# Utility
# ============================================================================
version: ## Show current version
	@echo "$(COLOR_BOLD)Consonant Relayer v$(IMAGE_TAG)$(COLOR_RESET)"

image-size: ## Show Docker image size
	@docker images $(IMAGE_NAME) --format "table {{.Repository}}\t{{.Tag}}\t{{.Size}}"

prune: ## Clean up Docker system
	@echo "$(COLOR_YELLOW)Cleaning up Docker system...$(COLOR_RESET)"
	docker system prune -f
	docker volume prune -f

outdated: ## Check for outdated npm packages
	@echo "$(COLOR_BLUE)Checking for outdated packages...$(COLOR_RESET)"
	npm outdated

update: ## Update npm packages (use with caution)
	@echo "$(COLOR_YELLOW)⚠️  Updating packages... Review changes carefully!$(COLOR_RESET)"
	npm update
	@echo "$(COLOR_GREEN)Run 'npm audit' to check for vulnerabilities$(COLOR_RESET)"

audit: ## Run security audit
	@echo "$(COLOR_BLUE)Running security audit...$(COLOR_RESET)"
	npm audit

.PHONY: install dev clean build-local build build-no-cache \
        lint lint-fix type-check format format-check test \
        up down logs ps restart run stop shell \
        push pull \
        k8s-namespace helm-install helm-upgrade helm-uninstall k8s-logs k8s-status k8s-delete \
        ci deploy all \
        version image-size prune outdated update audit