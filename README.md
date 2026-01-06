# Consonant Relayer v2

> Stateless relay service connecting Kubernetes clusters to Consonant backend via Cloudflare Tunnel

[![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)](https://github.com/consonant/relayer)
[![Node](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/typescript-5.7-blue.svg)](https://www.typescriptlang.org)

## 🎯 What is Consonant Relayer?

The Consonant Relayer is a production-ready service that bridges Kubernetes clusters with the Consonant backend. It handles:

- **Agent Management** - Discovery, registration, and invocation of Kagent agents
- **Telemetry Collection** - OTLP traces and logs via gRPC
- **Kubernetes Monitoring** - Agent CRDs, Pods, and Events
- **Secure Communication** - Cloudflare Tunnel (no inbound ports needed)

## ✨ Key Features

### 🔒 Security First
- **Zero inbound ports** - Cloudflare Tunnel provides outbound-only connection
- **HMAC authentication** - Cluster token-based authentication
- **Rate limiting** - 100 requests/minute per IP
- **Least privilege RBAC** - Namespace-scoped permissions

### 🚀 Production Ready
- **Type-safe configuration** - Zod validation for all settings
- **Graceful shutdown** - Proper cleanup of all resources
- **Circuit breakers** - Automatic failure protection
- **Retry logic** - Exponential backoff for resilience
- **Comprehensive metrics** - Prometheus format

### 📊 Observability
- **Structured logging** - JSON logs via Pino
- **Health checks** - Liveness and readiness probes
- **Prometheus metrics** - 20+ metrics tracked
- **Request tracing** - Full visibility into operations

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────┐
│                 Consonant Relayer Pod                    │
│  ┌───────────┐  ┌──────────┐  ┌───────────┐             │
│  │   Agent   │  │   HTTP   │  │   OTEL    │             │
│  │  Manager  │  │   API    │  │ Collector │             │
│  │           │  │  :8080   │  │   :4317   │             │
│  └─────┬─────┘  └────┬─────┘  └─────┬─────┘             │
│        │             │              │                     │
│        └─────────────┴──────────────┘                     │
│                      │                                    │
│              ┌───────▼────────┐                           │
│              │ Backend Client │                           │
│              │  (Socket.io)   │                           │
│              └───────┬────────┘                           │
│                      │                                    │
│              ┌───────▼────────┐                           │
│              │   Cloudflared  │                           │
│              │    Sidecar     │                           │
│              └───────┬────────┘                           │
└──────────────────────┼────────────────────────────────────┘
                       │
                       │ Outbound HTTPS Only
                       │ (Cloudflare Edge)
                       ▼
               ┌───────────────┐
               │    Backend    │
               └───────────────┘
```

## 📦 Installation

### Prerequisites

- **Node.js** ≥20.0.0
- **npm** ≥10.0.0
- **Kubernetes** cluster with access to create CRDs
- **Cloudflare Tunnel** token

### Quick Start

```bash
# Clone repository
git clone https://github.com/consonant/relayer.git
cd relayer

# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Edit .env with your values
# - BACKEND_URL
# - CLUSTER_ID
# - CLUSTER_NAME
# - CLUSTER_TOKEN
# - KUBERNETES_NAMESPACE

# Build
npm run build

# Run
npm start
```

### Docker

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
  consonant-relayer:2.0.0
```

### Kubernetes (Helm)

```bash
# Install with Helm
helm install consonant-relayer ./helm \
  --namespace consonant-system \
  --create-namespace \
  --set backendUrl="wss://backend.yourcompany.com" \
  --set clusterId="prod-cluster-1" \
  --set clusterName="Production Cluster" \
  --set clusterToken="your-secure-token" \
  --set cloudflare.tunnelToken="your-tunnel-token"
```

## ⚙️ Configuration

### Kubernetes Deployment (Production)

**Configuration via Helm values** (NOT environment variables):

```bash
helm install consonant-relayer ./helm \
  --set relayer.backend.clusterId="prod-cluster-1" \
  --set relayer.backend.clusterName="Production Cluster" \
  --set-string relayer.backend.clusterToken="your-token" \
  --set-string cloudflared.tunnelToken="your-tunnel-token"
```

**Required Helm Values:**
- `relayer.backend.clusterId` - Unique cluster identifier
- `relayer.backend.clusterName` - Human-readable name
- `relayer.backend.clusterToken` - Authentication token
- `cloudflared.tunnelToken` - Cloudflare tunnel token (if enabled)

**Optional Helm Values:**
- `relayer.logging.level` - Log level (default: "info")
- `relayer.kubernetes.namespace` - Namespace to watch (default: "default")
- `relayer.resources.limits` - CPU/memory limits
- See [helm/values.yaml](./helm/values.yaml) for all 50+ options

### Local Development Only

For local testing with `npm run dev` or `docker-compose`:

```bash
cp .env.example .env
nano .env  # Fill in your values
npm run dev
```

**Note:** `.env` files are NOT used in Kubernetes. See [CONFIGURATION.md](./CONFIGURATION.md) for details.

## 🔧 Development

```bash
# Install dependencies
npm install

# Run in development mode (with hot reload)
npm run dev

# Type checking
npm run type-check

# Linting
npm run lint
npm run lint:fix

# Formatting
npm run format
npm run format:check

# Build
npm run build

# Clean build output
npm run clean
```

## 📊 API Endpoints

### HTTP REST API (Port 8080)

- `POST /api/agents/register` - Agent self-registration
- `GET /health/liveness` - Liveness probe (always 200)
- `GET /health/readiness` - Readiness probe (503 if not ready)
- `GET /metrics` - Prometheus metrics
- `GET /` - API information

### Example: Agent Registration

```bash
curl -X POST http://localhost:8080/api/agents/register \
  -H "Content-Type: application/json" \
  -d '{
    "namespace": "default",
    "name": "my-agent",
    "card": {
      "name": "My Agent",
      "description": "Agent description",
      "url": "http://agent.example.com",
      "version": "1.0.0",
      "protocolVersion": "1.0",
      "capabilities": {
        "streaming": true,
        "pushNotifications": false,
        "stateTransitionHistory": false
      },
      "defaultInputModes": ["text"],
      "defaultOutputModes": ["text"],
      "skills": []
    }
  }'
```

## 📈 Metrics

The relayer exposes Prometheus metrics on `/metrics`:

```bash
# Scrape metrics
curl http://localhost:8080/metrics
```

### Key Metrics

- `agents_registered_total` - Total agents registered
- `agents_discovered_total` - Total agents discovered
- `agents_active` - Current active agents
- `invocations_total` - Total agent invocations
- `invocations_duration_ms` - Invocation latency histogram
- `telemetry_events_received_total` - Total telemetry events
- `backend_connected` - Backend connection status (0 or 1)
- `http_requests_total` - Total HTTP requests
- `http_request_duration_ms` - HTTP request latency

## 🔍 Troubleshooting

### Check Logs

```bash
# Docker
docker logs -f consonant-relayer

# Kubernetes
kubectl logs -f -l app.kubernetes.io/name=consonant-relayer -n consonant-system
```

### Common Issues

**Backend connection fails**
- Verify `BACKEND_URL` is correct
- Check Cloudflare Tunnel is running
- Verify `CLUSTER_TOKEN` is correct

**Agent discovery not working**
- Ensure Agent CRD exists in cluster
- Check Kagent controller is running
- Verify relayer has RBAC permissions

**Telemetry not received**
- Confirm OTLP port 4317 is accessible
- Verify Kagent agents are configured to send to relayer
- Check OTEL collector logs

## 🤝 Contributing

This is a private repository. For internal contributions:

1. Create a feature branch
2. Make your changes
3. Ensure all tests pass: `npm run lint && npm run type-check`
4. Create a pull request

## 📄 License

UNLICENSED - Private proprietary software

## 🔗 Related Projects

- [Consonant Backend](https://github.com/consonant/backend) - Self-hosted Backend

## 📞 Support

For support, please contact the Consonant team.

---

**Built with ❤️ by Consonant Engineering**