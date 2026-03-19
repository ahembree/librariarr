# Contributing to Librariarr

Thanks for your interest in contributing! This guide will help you get started.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose
- [Node.js](https://nodejs.org/) 22+
- npm

## Development Setup

1. Clone the repository:

   ```bash
   git clone https://github.com/ahembree/librariarr.git
   cd librariarr
   ```

2. Copy the example environment file:

   ```bash
   cp .env.example .env
   ```

3. Start the development environment:

   ```bash
   npm run docker:dev
   ```

   This starts the Next.js dev server with hot reload and a PostgreSQL database.

4. Open [http://localhost:3000](http://localhost:3000) in your browser.

See the [README](README.md) for the full list of development commands.

## Testing

The project uses [Vitest](https://vitest.dev/) with a real PostgreSQL test database.

```bash
npm run test:unit           # Unit tests (no DB needed)
npm run test:integration    # Integration tests (requires Docker DB running)
npm test                    # Full test suite
```

- **Unit tests** (`tests/unit/`) test pure logic with no database dependency.
- **Integration tests** (`tests/integration/`) test API route handlers against a real PostgreSQL database. The test DB is created automatically by the global setup.

## Code Style

- **Linting:** ESLint is configured and runs automatically via a Husky pre-commit hook.
- **Commit messages:** Follow [Conventional Commits](https://www.conventionalcommits.org/) — enforced by commitlint.
  - Format: `type(scope): description` (e.g., `feat: add stream manager`, `fix(auth): handle expired tokens`)
- **Styling:** Tailwind CSS v4 with OKLCH color model. Dark mode only.

## Pull Requests

1. Create a branch from `main`.
2. Make your changes and add tests where appropriate.
3. Ensure everything passes locally:

   ```bash
   npm run lint
   npx tsc --noEmit
   npm test
   ```

4. Push your branch and open a pull request against `main`.
5. Fill out the PR template — describe what changed and how you tested it.

## Reporting Issues

Use [GitHub Issues](https://github.com/ahembree/librariarr/issues) to report bugs or request features. Please use the provided issue templates.

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.
