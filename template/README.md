# MAXSTACK

## Quick Start

### Prerequisites

- Node.js (LTS version recommended)
- npm or pnpm package manager

### Available Scripts

- `npm run dev` - Start development server
- `npm run build` - Build for production
- `npm run start` - Start production server
- `npm run test` - Run unit tests
- `npm run test:e2e` - Run E2E tests
- `npm run lint` - Lint and format code
- `npm run typecheck` - Run TypeScript type checking
- `npm run validate` - Run all checks (lint, typecheck, test)

## Development

### Code Quality

This project maintains high code quality standards through:

- **TypeScript**: Static type checking for better reliability
- **Biome**: Fast linting and formatting
- **Vitest**: Lightning-fast unit and integration testing
- **Playwright**: Reliable end-to-end testing
- **React Router v7**: Modern routing with type safety

### Project Structure

```sh
app/
├── components/ # Reusable UI components
├── hooks/      # Custom React hooks
├── lib/        # Utility libraries
├── routes/     # Application routes
├── services/   # Business logic and API calls
└── utils/      # Pure utility functions
```

### Contributing

Please read our [Contributing Guide](./docs/CONTRIBUTING.md) for detailed information about our development process, coding standards, and how to submit contributions.

## Testing

We follow a comprehensive testing strategy:

- **Unit Tests**: Individual functions and components
- **Integration Tests**: Component interactions and workflows
- **E2E Tests**: Complete user journeys

Run all tests:

```bash
npm run validate
```

## Deployment

Build for production:

```bash
npm run build
npm run start
```

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Development Tools Setup

### VSCode Biome Extension

For the best development experience, install the Biome VSCode extension:

1. Open Command Palette (Ctrl/⌘+⇧+P)
2. Select "Extensions: Install Extensions"
3. Search for "Biome" and install
4. Set as default formatter:
   - Open Command Palette
   - Select "Format Document With..."
   - Select "Configure Default Formatter"
   - Choose "Biome"
