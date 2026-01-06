# Docker Guide - Consonant Relayer v2

## Quick Start

```bash
# Build image
docker build -t consonant-relayer:2.0.0 .

# Run container
docker run -d \
  --name consonant-relayer \
  -e BACKEND_URL="http://localhost:3000" \
  -e CLUSTER_ID="my-cluster" \
  -e CLUSTER_NAME="Production" \
  -e CLUSTER_TOKEN="your-token" \
  -e KUBERNETES_NAMESPACE="default" \
  -p 8080:8080 \
  -p 4317:4317 \
  consonant-relayer:2.0.0

# View logs
docker logs -f consonant-relayer

# Stop container
docker stop consonant-relayer
docker rm consonant-relayer
```

## Multi-Stage Build

The Dockerfile uses a multi-stage build for optimal image size:

### Stage 1: Builder
- Base: `node:20-alpine`
- Installs build dependencies (Python, Make, g++)
- Installs ALL npm dependencies (dev + prod)
- Compiles TypeScript to JavaScript
- Prunes dev dependencies

### Stage 2: Runtime
- Base: `node:20-alpine`
- Copies only built files from builder
- Installs only runtime dependencies
- Runs as non-root user
- Minimal image size (~150MB)

## Image Sizes

```bash
# Check image size
docker images consonant-relayer

# Expected sizes:
# - consonant-relayer:2.0.0  ~150MB
# - node:20-alpine           ~120MB (base)
```

## Security Features

### 1. Non-Root User
```dockerfile
RUN adduser -u 1001 -G relayer -s /bin/sh -D relayer
USER relayer
```

The container runs as user `relayer` (UID 1001), not root.

### 2. Minimal Base Image
Using `node:20-alpine` instead of full `node:20`:
- Smaller attack surface
- Fewer vulnerabilities
- Faster downloads

### 3. Health Checks
```dockerfile
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://localhost:8080/health/liveness', ...)"
```

Docker automatically monitors container health.

### 4. Tini Init System
```dockerfile
ENTRYPOINT ["/sbin/tini", "--"]
```

Properly handles:
- Signal forwarding (SIGTERM → graceful shutdown)
- Zombie process reaping
- PID 1 responsibilities

## Environment Variables

### Required
- `BACKEND_URL` - Backend WebSocket URL
- `CLUSTER_ID` - Cluster identifier
- `CLUSTER_NAME` - Cluster name
- `CLUSTER_TOKEN` - Authentication token
- `KUBERNETES_NAMESPACE` - Namespace to watch

### Optional
- `NODE_ENV` - Environment (default: production)
- `LOG_LEVEL` - Log level (default: info)
- `LOG_PRETTY` - Pretty logs (default: false)
- `API_SERVER_PORT` - HTTP port (default: 8080)
- `OTEL_COLLECTOR_PORT` - OTLP port (default: 4317)

## Docker Compose

### Development Setup

```bash
# Copy environment template
cp .env.example .env

# Edit .env with your values
nano .env

# Start services
docker-compose up -d

# View logs
docker-compose logs -f

# Stop services
docker-compose down
```

### Services Included
- **relayer** - Consonant Relayer
- **cloudflared** - Cloudflare Tunnel sidecar

### Networks
All services run in `consonant-relayer-network` bridge network.

## Build Optimization

### Build Cache
Docker caches each layer. To maximize cache hits:

```dockerfile
# Copy package.json first (changes rarely)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source code last (changes frequently)
COPY . .
RUN npm run build
```

If source changes but dependencies don't, npm install is cached!

### .dockerignore
Exclude unnecessary files from build context:
```
node_modules
dist
.git
*.md
.env
```

This makes builds faster and images smaller.

### Build Arguments
```bash
# Build with custom Node version
docker build --build-arg NODE_VERSION=20.11.0 -t consonant-relayer:2.0.0 .

# Build for different platform
docker build --platform linux/amd64 -t consonant-relayer:2.0.0 .
```

## Running in Production

### Resource Limits
```bash
docker run -d \
  --name consonant-relayer \
  --memory="512m" \
  --cpus="1.0" \
  --restart=unless-stopped \
  -e BACKEND_URL="..." \
  consonant-relayer:2.0.0
```

### Logging
```bash
# JSON logs to stdout/stderr (default)
docker run -d \
  --log-driver json-file \
  --log-opt max-size=10m \
  --log-opt max-file=3 \
  consonant-relayer:2.0.0
```

### Health Monitoring
```bash
# Check health status
docker inspect --format='{{.State.Health.Status}}' consonant-relayer

# View health check logs
docker inspect --format='{{json .State.Health}}' consonant-relayer | jq
```

## Registry Operations

### Tag and Push
```bash
# Tag for registry
docker tag consonant-relayer:2.0.0 ghcr.io/consonant/relayer:2.0.0
docker tag consonant-relayer:2.0.0 ghcr.io/consonant/relayer:latest

# Login to registry
docker login ghcr.io -u username

# Push
docker push ghcr.io/consonant/relayer:2.0.0
docker push ghcr.io/consonant/relayer:latest
```

### Pull and Run
```bash
# Pull from registry
docker pull ghcr.io/consonant/relayer:2.0.0

# Run
docker run -d ghcr.io/consonant/relayer:2.0.0
```

## Kubernetes with Docker Images

### Build for Kubernetes
```bash
# Build multi-arch image
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t ghcr.io/consonant/relayer:2.0.0 \
  --push \
  .
```

### Use in Kubernetes
```yaml
# deployment.yaml
spec:
  containers:
  - name: relayer
    image: ghcr.io/consonant/relayer:2.0.0
    imagePullPolicy: IfNotPresent
```

## Troubleshooting

### Container Won't Start
```bash
# Check logs
docker logs consonant-relayer

# Check for configuration errors
docker run --rm -e BACKEND_URL="..." consonant-relayer:2.0.0

# Run with shell access
docker run -it --entrypoint sh consonant-relayer:2.0.0
```

### High Memory Usage
```bash
# Check memory stats
docker stats consonant-relayer

# Set memory limit
docker update --memory="256m" consonant-relayer
```

### Network Issues
```bash
# Check network configuration
docker network inspect consonant-relayer-network

# Test connectivity
docker exec consonant-relayer wget -O- http://backend:3000/health
```

### Build Failures
```bash
# Build with verbose output
docker build --progress=plain --no-cache -t consonant-relayer:2.0.0 .

# Check disk space
docker system df

# Clean up
docker system prune -a
```

## Best Practices

### 1. Always Use Tags
❌ `docker pull consonant-relayer`
✅ `docker pull consonant-relayer:2.0.0`

### 2. Use Health Checks
Define health checks in Dockerfile for automatic monitoring.

### 3. Run as Non-Root
Never run containers as root in production.

### 4. Set Resource Limits
Always set memory and CPU limits in production.

### 5. Use Multi-Stage Builds
Keeps production images small and secure.

### 6. Pin Base Image Versions
❌ `FROM node:20`
✅ `FROM node:20-alpine`

### 7. Scan for Vulnerabilities
```bash
# Scan image
docker scan consonant-relayer:2.0.0

# Use Trivy
trivy image consonant-relayer:2.0.0
```

## Performance Tuning

### Node.js in Containers
```bash
# Adjust heap size if needed
docker run -d \
  -e NODE_OPTIONS="--max-old-space-size=256" \
  consonant-relayer:2.0.0
```

### Build Performance
```bash
# Use BuildKit for faster builds
DOCKER_BUILDKIT=1 docker build -t consonant-relayer:2.0.0 .

# Use build cache from registry
docker build \
  --cache-from ghcr.io/consonant/relayer:latest \
  -t consonant-relayer:2.0.0 \
  .
```

## Size Comparison

| Image | Size | Notes |
|-------|------|-------|
| node:20 | ~900MB | Full Debian base |
| node:20-slim | ~220MB | Slim Debian base |
| node:20-alpine | ~120MB | Alpine base (our choice) |
| consonant-relayer:2.0.0 | ~150MB | Alpine + app |

Alpine gives us 6x size reduction vs. full Node image!
