# Contributing to moqrtc-ts

Thank you for your interest in contributing to moqrtc-ts! This document provides guidelines and instructions for contributing to the project.

## Code of Conduct

By participating in this project, you agree to maintain a respectful and inclusive environment for all contributors.

## How to Contribute

### Reporting Bugs

If you find a bug, please create an issue on GitHub with:

- A clear, descriptive title
- Steps to reproduce the issue
- Expected behavior
- Actual behavior
- Your environment (Deno version, OS, etc.)
- Any relevant code samples or error messages

### Suggesting Enhancements

Enhancement suggestions are welcome! Please create an issue with:

- A clear, descriptive title
- Detailed description of the proposed enhancement
- Rationale for why this enhancement would be useful
- Any relevant examples or mockups

### Pull Requests

1. **Fork the repository** and create your branch from `main`
2. **Install Deno**: Follow instructions at [deno.land](https://deno.land/)
3. **Make your changes**: Ensure your code follows the project style
4. **Add tests**: If you're adding functionality, add corresponding tests
5. **Run tests**: Ensure all tests pass with `deno task test`
6. **Run linter**: Fix any linting issues with `deno task lint`
7. **Format code**: Run `deno task fmt` to ensure consistent formatting
8. **Type check**: Run `deno task check` to verify TypeScript correctness
9. **Update documentation**: Update README.md or other docs if needed
10. **Commit your changes**: Use clear, descriptive commit messages
11. **Push to your fork** and submit a pull request

### Commit Message Guidelines

- Use the present tense ("Add feature" not "Added feature")
- Use the imperative mood ("Move cursor to..." not "Moves cursor to...")
- Limit the first line to 72 characters or less
- Reference issues and pull requests when relevant

Example:
```
Add support for X feature

- Implement core functionality
- Add tests for edge cases
- Update documentation

Fixes #123
```

## Development Setup

### Prerequisites

- Deno >= 1.40.0 (install from [deno.land](https://deno.land/))

### Development Workflow

```bash
# Type check all files
deno task check

# Run tests
deno task test

# Run tests in watch mode
deno task test:watch

# Run tests with coverage
deno task coverage

# Generate HTML coverage report
deno task coverage:html

# Lint code
deno task lint

# Format code
deno task fmt

# Check formatting without changing files
deno task fmt:check
```

## Coding Standards

### TypeScript

- Use TypeScript strict mode
- Provide type annotations for public APIs
- Avoid `any` types where possible
- Use meaningful variable and function names

### Style Guide

- Follow the existing code style
- Use Deno's built-in formatter (`deno fmt`)
- Follow Deno's linting rules (`deno lint`)
- Write clear, concise comments for complex logic
- Use explicit `.ts` extensions in relative imports

### Testing

- Write unit tests for new functionality using `Deno.test()`
- Use test steps (`t.step()`) for nested test organization
- Maintain or improve code coverage
- Test edge cases and error conditions
- Use descriptive test names
- Place test files next to source files with `_test.ts` suffix

## Project Structure

```
moqrtc-js/
├── src/                  # Source files
│   ├── **/*_test.ts     # Test files (co-located with source)
│   └── index.ts         # Main entry point
├── example/             # Example application
├── .github/             # GitHub workflows and templates
├── .vscode/             # VSCode settings for Deno
├── deno.json            # Deno configuration
├── MIGRATION_NOTES.md   # Migration documentation
└── README.md            # Project documentation
```

## Getting Help

If you need help or have questions:

- Check existing issues and discussions
- Create a new issue with your question
- Tag it appropriately

## License

By contributing to moqrtc-ts, you agree that your contributions will be licensed under the MIT License.
