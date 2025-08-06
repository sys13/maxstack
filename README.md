<div align="center">

# 🚀 MAXSTACK

## The AI-First Full-Stack Framework

Build web-apps faster with built-in templates and guardrails so your AI can code faster.

[![npm version](https://img.shields.io/npm/v/maxstack?color=21bb42&label=%F0%9F%93%A6%20npm)](http://npmjs.com/package/maxstack)
[![TypeScript](https://img.shields.io/badge/%F0%9F%92%AA_typescript-strict-21bb42.svg)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/%F0%9F%93%9D_license-MIT-21bb42.svg)](https://github.com/sys13/maxstack/blob/main/LICENSE.md)

[Getting Started](#-getting-started) • [Features](#-features) • [Tech Stack](#-tech-stack) • [Documentation](#-documentation)

</div>

---

## 🎯 What is MAXSTACK?

MAXSTACK is a modern CLI tool that scaffolds full-stack React applications with AI-powered development workflows.
It provides a carefully curated tech stack, pre-built templates, and intelligent code generation to help you ship faster.

**Create a production-ready app in 3 commands:**

```bash
npx maxstack init my-app # 🎨 Interactive project setup
cd my-app && npm install # 📦 Install dependencies
npm run dev              # 🚀 Start developing
```

## ✨ Features

### 🤖 **AI-Powered Development**

- Generate components, routes, and schemas with `maxstack gen`
- AI-assisted code scaffolding and template creation
- Intelligent project structure and best practices

### 🎨 **Built-in Design System**

- Beautiful, accessible templates for common pages
- Blog, marketing, auth, and SaaS templates included
- Responsive design with Tailwind CSS and shadcn/ui components

### ⚡ **Production-Ready Stack**

- Full-stack TypeScript with React Router v7
- Database with Drizzle ORM and SQLite
- Authentication with Better Auth
- Email system with React Email
- End-to-end testing with Playwright

### 🚀 **Deploy Anywhere**

- One-click deployment to Fly.io
- Docker containerization included
- Automatic database migrations
- GitHub Actions CI/CD ready

## 🛠 Tech Stack

MAXSTACK includes everything you need for modern web development:

| Category         | Technology                 | Purpose                                       |
| ---------------- | -------------------------- | --------------------------------------------- |
| **Frontend**     | React 19 + React Router v7 | Modern full-stack React with routing          |
| **Styling**      | Tailwind CSS + Radix UI    | Utility-first CSS with accessible components  |
| **Backend**      | Node.js + TypeScript       | Type-safe server-side development             |
| **Database**     | Drizzle ORM + SQLite       | Type-safe database queries and migrations     |
| **Auth**         | Better Auth                | Modern authentication with multiple providers |
| **Email**        | React Email + Resend       | Templated emails with React components        |
| **Testing**      | Vitest + Playwright        | Unit, integration, and E2E testing            |
| **Code Quality** | Biome + TypeScript         | Fast linting, formatting, and type checking   |
| **Deployment**   | Fly.io + Docker            | Production deployment with containers         |

## 🚀 Getting Started

### Prerequisites

- Node.js 20.19.0 or higher
- npm, pnpm, or yarn

### Create Your First App

```bash
# Create a new MAXSTACK project
npx maxstack init my-awesome-app

# Navigate to your project
cd my-awesome-app

# Install dependencies
npm install

# Start the development server
npm run dev
```

Your app will be running at `http://localhost:5173` with:

- ✅ Authentication system ready
- ✅ Database configured
- ✅ UI components available
- ✅ Testing setup complete

### Generate a project with scaffolding

```bash
# Generate new components and features with AI
npx maxstack gen

# Examples of what you can generate:
# - Blog system with posts and categories
# - User dashboard with analytics
# - E-commerce product catalog
# - Contact forms and landing pages
```

## 📋 Available Scripts

Every MAXSTACK project comes with these development commands:

```bash
npm run dev       # Start development server
npm run build     # Build for production
npm run start     # Start production server
npm run test      # Run unit tests with Vitest
npm run test:e2e  # Run E2E tests with Playwright
npm run lint      # Lint and format code with Biome
npm run typecheck # Type check with TypeScript
npm run validate  # Run all checks (lint + test + typecheck)
npm run db:push   # Push database schema changes
npm run db:studio # Open database admin interface
```

## 🎯 Project Structure

MAXSTACK creates a well-organized project structure:

```text
my-app/
├── app/                    # Application code
│   ├── components/         # Reusable UI components
│   │   ├── templates/      # Page templates (blog, landing, etc.)
│   │   └── ui/            # Basic UI components (buttons, forms, etc.)
│   ├── routes/            # File-based routing with React Router
│   ├── services/          # Business logic and API calls
│   ├── hooks/             # Custom React hooks
│   └── utils/             # Utility functions
├── database/              # Database schema definitions
├── drizzle/               # Database migrations
├── e2e/                   # End-to-end tests
├── public/                # Static assets
├── scripts/               # Build and deployment scripts
└── maxstack.tsx           # Project configuration
```

## 🎨 Standard Features

MAXSTACK includes production-ready templates for common use cases:

### 📝 **Blog System**

```bash
# Generate a complete blog with posts, categories, and admin
npx maxstack init my-blog
# Select "Blog" when prompted for features
```

- SEO-optimized blog posts
- Category and tag management
- Markdown content support
- Admin interface included

### 💼 **SaaS Marketing Site**

```bash
# Create a modern SaaS landing page
npx maxstack init my-saas
# Select "SaaS Marketing" when prompted
```

- Landing page with hero section
- Pricing tables and feature grids
- Newsletter sign-up forms
- Customer testimonials

## 🔧 AI-Ready

AI can know what to do when there are clear conventions, and included `Agents.md` file, and validation scripts.

Start with adding pages into `maxstack.tsx`, run `npx maxstack gen`, and you will have your pages, components, and tests stubbed out, ready for your AI assistant to fill things out.

## 📚 Documentation

- **[Getting Started Guide](https://maxstack.dev/docs/getting-started)** - Comprehensive tutorial
- **[API Reference](https://maxstack.dev/docs/api)** - Complete API documentation
- **[Template Gallery](https://maxstack.dev/templates)** - Browse all available templates
- **[Deployment Guide](https://maxstack.dev/docs/deployment)** - Production deployment options

## 🚀 Deployment

### Fly.io (Recommended)

Deploy to Fly.io with one command:

```bash
npm run deploy
```

This automatically:

- ✅ Builds your application
- ✅ Runs database migrations
- ✅ Deploys with zero downtime
- ✅ Sets up monitoring and health checks

### Digital Ocean

Fill in the env variables requested in `scripts/deploy-digitalocean.sh`, and run it with `pnpm run deploy:digitalocean`

### Other Platforms

MAXSTACK works with any Node.js hosting platform and comes with an included Dockerfile:

- **Vercel**: `npm run build && vercel deploy`
- **Railway**: Connect your GitHub repo
- **AWS/GCP**: Deploy with standard Node.js configuration

## 🤝 Community & Support

- **[Discord Community](https://discord.gg/mR4jax5BCC)** - Get help and share projects
- **[GitHub Discussions](https://github.com/sys13/maxstack/discussions)** - Feature requests and Q&A

## 🗺️ Roadmap

### Coming Soon

### In Development

- [ ] More AI model integrations (Claude, Gemini)
- [ ] Advanced deployment options (Kubernetes, AWS)
- [ ] More Standard Features
- [ ] Advanced analytics dashboard
- [ ] Multi-tenant SaaS features

## 💎 Pro Features

- **Advanced AI Models**: Access to GPT-4, Claude 3, and specialized code models
- **Premium Templates**: E-commerce, CRM, and enterprise applications
- **Priority Support**: Direct access to the MAXSTACK team
- **Custom Integrations**: Tailored solutions for your specific needs

## 🧪 Try It Now

**Quick Demo**: Create a todo app in 2 minutes

```bash
npx maxstack init todo-demo
cd todo-demo && npm install && npm run dev
```

---

## 📄 License & Contributing

MAXSTACK is MIT licensed.
See [LICENSE.md](LICENSE.md) for details.

**Contributing**: We welcome contributions!
See our [Contributing Guide](.github/CONTRIBUTING.md) and [Development Setup](.github/DEVELOPMENT.md).

---

<div align="center">

⭐ Star this repo if MAXSTACK helps you build faster!

Built with ❤️ by the MAXSTACK team

</div>

## Contributors

<!-- spellchecker: disable -->
<!-- ALL-CONTRIBUTORS-LIST:START - Do not remove or modify this section -->
<!-- prettier-ignore-start -->
<!-- markdownlint-disable -->
<table>
  <tbody>
    <tr>
      <td align="center"><a href="brainbuildai.com"><img src="https://avatars.githubusercontent.com/u/1377089?v=4?s=100" width="100px;" alt="Daniel Arrizza"/><br /><sub><b>Daniel Arrizza</b></sub></a><br /><a href="https://github.com/sys13/maxstack/commits?author=sys13" title="Code">💻</a> <a href="#content-sys13" title="Content">🖋</a> <a href="https://github.com/sys13/maxstack/commits?author=sys13" title="Documentation">📖</a> <a href="#ideas-sys13" title="Ideas, Planning, & Feedback">🤔</a> <a href="#infra-sys13" title="Infrastructure (Hosting, Build-Tools, etc)">🚇</a> <a href="#maintenance-sys13" title="Maintenance">🚧</a> <a href="#projectManagement-sys13" title="Project Management">📆</a> <a href="#tool-sys13" title="Tools">🔧</a></td>
    </tr>
  </tbody>
</table>

<!-- markdownlint-restore -->
<!-- prettier-ignore-end -->

<!-- ALL-CONTRIBUTORS-LIST:END -->
<!-- spellchecker: enable -->

<p align="center">
	<!-- prettier-ignore-start -->
	<!-- ALL-CONTRIBUTORS-BADGE:START - Do not remove or modify this section -->
	<a href="#contributors" target="_blank"><img alt="👪 All Contributors: 1" src="https://img.shields.io/badge/%F0%9F%91%AA_all_contributors-1-21bb42.svg" /></a>
<!-- ALL-CONTRIBUTORS-BADGE:END -->
	<!-- prettier-ignore-end -->
	<a href="https://github.com/sys13/maxstack/blob/main/.github/CODE_OF_CONDUCT.md" target="_blank"><img alt="🤝 Code of Conduct: Kept" src="https://img.shields.io/badge/%F0%9F%A4%9D_code_of_conduct-kept-21bb42" /></a>
	<a href="https://codecov.io/gh/sys13/maxstack" target="_blank"><img alt="🧪 Coverage" src="https://img.shields.io/codecov/c/github/sys13/maxstack?label=%F0%9F%A7%AA%20coverage" /></a>
	<a href="https://github.com/sys13/maxstack/blob/main/LICENSE.md" target="_blank"><img alt="📝 License: MIT" src="https://img.shields.io/badge/%F0%9F%93%9D_license-MIT-21bb42.svg" /></a>
	<a href="http://npmjs.com/package/maxstack" target="_blank"><img alt="📦 npm version" src="https://img.shields.io/npm/v/maxstack?color=21bb42&label=%F0%9F%93%A6%20npm" /></a>
	<img alt="💪 TypeScript: Strict" src="https://img.shields.io/badge/%F0%9F%92%AA_typescript-strict-21bb42.svg" />
</p>
