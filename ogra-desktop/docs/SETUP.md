# Ogra Desktop — Local Setup

## Prerequisites

- Node.js 20+
- npm 10+
- (Optional) Ollama for local model inference
- (Optional) OpenAI API key for cloud model access

## Quick Start

```bash
# Clone and install
cd ogra-desktop
npm install

# Run in development mode (requires display)
npm run dev

# Run tests
npm test
```

## Configuration

Ogra stores all data in `~/.ogra/` (macOS/Linux) or `%APPDATA%/Ogra/` (Windows):

```
~/.ogra/
  ogra.db          # Main SQLite database
  secrets/         # Encrypted API keys
    secrets.enc.json
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama endpoint |
| `OLLAMA_DEFAULT_MODEL` | `qwen2.5` | Default Ollama model |

## Running Tests

```bash
# All tests
npm test

# Specific test file
npx vitest run tests/unit/policy-audit.test.ts

# With coverage
npm run coverage

# Watch mode
npm run test:watch
```

## Alpha Demo Path

The Alpha E2E demo verifies the core loop:

```
Import sensitive folder → mark Confidential → local RAG retrieval
→ policy decides local-only → local model answers
→ show 0 Ogra-managed cloud calls → show route decision + local audit trail
```

To run the smoke test:

```bash
npx vitest run tests/e2e/
```

## Database Migrations

Migrations run automatically on first start. The schema version is tracked in the `_migrations` table.

To reset local data:
```bash
rm -rf ~/.ogra
```

## Provider Setup

### Ollama (Local)

```bash
# Install Ollama
curl -fsSL https://ollama.com/install.sh | sh

# Pull a model
ollama pull qwen2.5
```

### OpenAI-Compatible (Cloud)

Add an API key through the Ogra UI Settings → Providers → Add OpenAI-compatible.

## Security Assumptions

1. SQLite database is stored on local disk only — no cloud sync in Alpha.
2. API keys are encrypted at rest via AES-256-CBC in `~/.ogra/secrets/`.
3. No telemetry or crash reporting is enabled by default.
4. The renderer process cannot access Node.js APIs, SQLite, or secret values.
5. All cloud model calls go through Ogra-controlled adapters after policy evaluation.
