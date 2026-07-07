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

## Releasing

This repo publishes two independent packages to [JSR](https://jsr.io) —
`@okdaichi/av-nodes` (`packages/av_nodes`) and `@okdaichi/media-log`
(`packages/media_log`). Releases are **per-package**, driven by **tags**, and
published automatically from GitHub Actions via OIDC (no tokens or secrets
required). The root `@okdaichi/moqrtc-js` package is not currently released.

> Prerequisite: each JSR package must be linked to this repo
> (`okdaichi/moqrtc-js`) in its JSR settings so OIDC auth works. Both packages
> are already linked.

To cut a release of one package:

1. **Bump the version** in `packages/<package>/deno.json` (`version` field).
   Follow SemVer: patch for bug fixes, minor for added functionality, major for
   breaking changes (this is a 0.x project, so most releases are patch/minor).
2. **Update `CHANGELOG.md`**: add a `## [X.Y.Z] - YYYY-MM-DD` entry at the top of
   the versioned section (above the previous release), summarize the changes,
   reference the relevant PRs (`[#NN]`), and add the PR + version-compare link
   references at the bottom (e.g.
   `[0.10.4]: .../compare/av-nodes/v0.10.3...av-nodes/v0.10.4`).
3. **Commit**, e.g. `release(av-nodes): bump version to 0.10.4`.
4. **Tag and push** the release tag — the tag name determines which package
   publishes:

   ```bash
   git tag av-nodes/v0.10.4   # or: media-log/v0.1.0
   git push origin av-nodes/v0.10.4
   ```

   Pushing a tag matching `av-nodes/v*` or `media-log/v*` triggers the
   `Publish` workflow (`.github/workflows/publish.yml`), which checks out the
   tagged commit, runs that package's tests as a gate, then runs `deno publish`.
   The package is published at exactly the tagged version.

To publish a package without a fresh tag (e.g. a tag was pushed before the
workflow existed, or to recover from a failed publish), use the **Run workflow**
button on the Publish workflow in GitHub Actions — it dispatches from `main`
and is restricted to the `main` branch.

CI (`ci.yml`) runs `deno fmt --check`, `deno lint`, type-checks, and the root
`src/` tests on every push/PR to `main`, and also runs each package's
`deno task check` + `deno task test`. Don't publish a package whose CI is red.

## Getting Help

If you need help or have questions:

- Check existing issues and discussions
- Create a new issue with your question
- Tag it appropriately

## License

By contributing to moqrtc-ts, you agree that your contributions will be licensed under the MIT License.
