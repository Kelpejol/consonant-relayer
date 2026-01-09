# ============================================================================
# Consonant Relayer v2 - Production Dockerfile
# ============================================================================
# Multi-stage build for minimal production image size
# 
# Features:
# - Multi-stage build (builder + runtime)
# - Non-root user
# - Minimal base image (Alpine)
# - Health checks
# - Security hardening
# - Small image size (~150MB)
# 
# Build: docker build -t consonant-relayer:2.0.0 .
# Run:   docker run -d consonant-relayer:2.0.0
# ============================================================================

# ============================================================================
# Stage 1: Builder
# ============================================================================
FROM node:20-alpine AS builder

# Install build dependencies
RUN apk add --no-cache \
    python3a \
    make \
    g++ \
    git

# Set working directory
WORKDIR /build

# Copy package files
COPY package.json package-lock.json ./

# Install ALL dependencies (including dev)
RUN npm ci --include=dev

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Remove dev dependencies (keep only production)
RUN npm prune --production

# ============================================================================
# Stage 2: Runtime
# ============================================================================
FROM node:20-alpine AS runtime

# Install runtime dependencies
RUN apk add --no-cache \
    ca-certificates \
    tini

# Create non-root user
RUN addgroup -g 1001 relayer && \
    adduser -u 1001 -G relayer -s /bin/sh -D relayer

# Set working directory
WORKDIR /app

# Copy built application from builder
COPY --from=builder --chown=relayer:relayer /build/dist ./dist
COPY --from=builder --chown=relayer:relayer /build/node_modules ./node_modules
COPY --from=builder --chown=relayer:relayer /build/package.json ./

# Create proto directory (for OTLP proto files)
RUN mkdir -p proto && chown relayer:relayer proto

# Switch to non-root user
USER relayer

# Expose ports
# 8080 - HTTP API
# 4317 - OTLP gRPC
EXPOSE 8080 4317

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://localhost:8080/health/liveness', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

# Environment defaults
ENV NODE_ENV=production \
    LOG_LEVEL=info \
    LOG_PRETTY=false

# Use tini as init system (proper signal handling)
ENTRYPOINT ["/sbin/tini", "--"]

# Start application
CMD ["node", "dist/index.js"]

# ============================================================================
# Metadata
# ============================================================================
LABEL maintainer="Consonant Engineering" \
      version="2.0.0" \
      description="Consonant Relayer - Kubernetes to Backend Bridge" \
      org.opencontainers.image.source="https://github.com/consonant/relayer" \
      org.opencontainers.image.title="Consonant Relayer" \
      org.opencontainers.image.version="2.0.0"