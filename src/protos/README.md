# OpenTelemetry Proto Files

This directory should contain the official OpenTelemetry Protocol Buffer definitions.

## Setup Instructions

### Option 1: Download Official Proto Files

```bash
# Clone the official OpenTelemetry proto repository
git clone https://github.com/open-telemetry/opentelemetry-proto.git

# Copy proto files to this directory
cp -r opentelemetry-proto/opentelemetry ./proto/
```

### Option 2: Install via npm (Recommended)

```bash
# Install the official proto package
npm install @opentelemetry/otlp-proto-exporter-base

# The proto files will be available in node_modules
```

## Required Files

The OTEL Collector needs these proto files:

```
proto/
└── opentelemetry/
    └── proto/
        ├── collector/
        │   ├── trace/
        │   │   └── v1/
        │   │       └── trace_service.proto
        │   └── logs/
        │       └── v1/
        │           └── logs_service.proto
        ├── trace/
        │   └── v1/
        │       └── trace.proto
        ├── logs/
        │   └── v1/
        │       └── logs.proto
        ├── common/
        │   └── v1/
        │       └── common.proto
        └── resource/
            └── v1/
                └── resource.proto
```

## Development Mode

If proto files are not available, the OTEL Collector will use inline service definitions as a fallback. This is suitable for development but **NOT recommended for production**.

## Verification

To verify proto files are correctly placed:

```bash
ls -R proto/opentelemetry/proto/
```

You should see all the required directories and .proto files.

## License

The OpenTelemetry proto files are licensed under Apache License 2.0.
See: https://github.com/open-telemetry/opentelemetry-proto/blob/main/LICENSE