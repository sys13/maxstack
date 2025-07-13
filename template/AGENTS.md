# AGENTS.MD

This AGENTS.md file provides comprehensive guidance for AI agents working with this codebase.

## Project Structure

- `/app`: Main application code
  - `/app/components`: Reusable UI and template components
  - `/app/routes`: Route handlers and page components
  - `/app/data`: Data sources and marketing content
  - `/app/hooks`: Custom React hooks
  - `/app/lib`: Utility functions
  - `/app/services`: Service logic and business rules
  - `/app/utils`: Database and helper utilities
- `/public`: Static assets (do not modify directly)
- `/database`: Database schema and relations
- `/drizzle`: Database migration files
- `/e2e`: End-to-end Playwright tests
- `/scripts`: Project scripts
- `/test-results`, `/coverage`: Test and coverage outputs

## Coding Conventions for OpenAI Codex

### General Conventions

- Use TypeScript for all new code
- Follow the existing code style in each file
- Use meaningful variable and function names
- Add comments for complex logic

### React Components Guidelines

- Keep components small and focused
- Use proper prop typing for all components
- Use `<Template />` if a template exists instead of creating new components from scratch
- Use shadcn/ui components that are in the /app/components/ui folder, can install more of them

### CSS/Styling Standards

- Use Tailwind CSS for styling
- Follow utility-first approach for styles
- Use custom CSS only when necessary

## Vitest Unit Tests

- Use [Vitest](https://vitest.dev/) for unit and integration tests
- Vitest test files should be named `*.test.ts`
- Run vitest tests with:

```bash
pnpm test:run
```

- Run a specific test file:

```bash
pnpm test:run -- app/services/task.test.ts
```

- Run tests with coverage:

```bash
pnpm test:run -- --coverage
```

## Playwright E2E Tests

- Use [Playwright](https://playwright.dev/) for end-to-end tests
- create tests in /e2e with the name \*.spec.ts
- Run playwright tests with `pnpm run test:e2e`

## Database

- we are using drizzle ORM with sqlite
- define schemas and relations in /database
- when querying data, prefer the db.query.tableName.find over the db.select syntax
- avoid use of raw SQL if possible
- avoid changing things in /drizzle

## Pull Request Guidelines

1. Includes a clear description of the changes
2. References any related issues
3. Ensures all tests pass
4. Includes screenshots for UI changes
5. Is focused on a single concern

## Programmatic Checks

Before submitting final changes, run:

```bash
pnpm run validate
```

All checks must pass
