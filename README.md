# moqrtc-ts

TypeScript implementation of a real-time communication protocol over Media over QUIC (MOQ)

## Overview

This project provides a TypeScript implementation for real-time communication using the Media over QUIC (MOQ) protocol. It is designed to enable efficient, low-latency media streaming over QUIC transport.

## Features

- **TypeScript**: Fully typed for better developer experience
- **ESM Support**: Modern ES modules for compatibility
- **Lightweight**: Minimal dependencies
- **Standards-compliant**: Following MOQ protocol specifications

## Installation

### For Deno projects
```typescript
import { Room, BroadcastPublisher } from "jsr:@okudai/moqrtc-js";
```

### For Node.js projects (via npm)
```bash
npm install moqrtc-ts
```

## Usage

Documentation and usage examples will be provided as the project develops.

## Development

### Prerequisites

- [Deno](https://deno.land/) >= 1.40.0

### Setup

```bash
# Clone the repository
git clone https://github.com/OkutaniDaichi0106/moqrtc-js.git
cd moqrtc-js

# Run tests
deno task test

# Run tests with coverage
deno task coverage

# Check code formatting
deno task fmt:check

# Format code
deno task fmt

# Run linter
deno task lint

# Type check
deno task check
```

### Available Deno Tasks

- `deno task test` - Run all tests
- `deno task test:watch` - Run tests in watch mode
- `deno task coverage` - Generate test coverage report
- `deno task coverage:html` - Generate HTML coverage report
- `deno task coverage:lcov` - Generate LCOV coverage report
- `deno task fmt` - Format code
- `deno task fmt:check` - Check code formatting
- `deno task lint` - Lint code
- `deno task check` - Type check all TypeScript files

## Contributing

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for details on how to contribute to this project.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for a history of changes to this project.

## Links

- [GitHub Repository](https://github.com/OkutaniDaichi0106/moqrtc-js)
- [Issue Tracker](https://github.com/OkutaniDaichi0106/moqrtc-js/issues)
