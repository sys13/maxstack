<div align="center">

# 🚀 MAXSTACK

## The AI-First Full-Stack Framework

Build production-ready web applications faster with AI-powered development, built-in templates, and modern tooling

[![npm version](https://img.shields.io/npm/v/maxstack?color=21bb42&label=%F0%9F%93%A6%20npm)](http://npmjs.com/package/maxstack)
[![TypeScript](https://img.shields.io/badge/%F0%9F%92%AA_typescript-strict-21bb42.svg)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/%F0%9F%93%9D_license-MIT-21bb42.svg)](https://github.com/sys13/maxstack/blob/main/LICENSE.md)

[Getting Started](#-getting-started) • [Features](#-features) • [Tech Stack](#-tech-stack) • [Documentation](#-documentation) • [Templates](#-templates--examples)

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

- 40+ pre-built UI components using Radix UI
- Beautiful, accessible templates for common pages
- Blog, marketing, auth, and SaaS templates included
- Responsive design with Tailwind CSS

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
| **Frontend**     | React 19 + React Router v7 | Modern React with file-based routing          |
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

### Generate AI-Powered Features

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

## 🎨 Templates & Examples

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

### 🏪 **E-commerce Ready**

- Product catalogs and shopping carts
- Payment integration templates
- Order management system
- Customer dashboards

## 🔧 AI-Powered Generation

The `maxstack gen` command uses AI to understand your project and generate contextual code:

```bash
# Generate new features based on your existing codebase
npx maxstack gen

# Example AI generations:
# "Add a user profile page with avatar upload"
# "Create a dashboard with analytics charts"
# "Build a contact form with email notifications"
# "Add a product review system"
```

The AI analyzes your current project structure, database schema, and existing components to generate code that fits seamlessly into your application.

## 📚 Documentation

- **[Getting Started Guide](https://maxstack.dev/docs/getting-started)** - Comprehensive tutorial
- **[API Reference](https://maxstack.dev/docs/api)** - Complete API documentation
- **[Template Gallery](https://maxstack.dev/templates)** - Browse all available templates
- **[Migration Guide](https://maxstack.dev/docs/migration)** - Upgrading from other stacks
- **[Deployment Guide](https://maxstack.dev/docs/deployment)** - Production deployment options

## 🌟 Why Choose MAXSTACK?

### **vs. Create React App**

- ✅ Full-stack solution (not just frontend)
- ✅ Database and auth included
- ✅ Production deployment ready
- ✅ Modern React Router v7

### **vs. Next.js**

- ✅ Simpler architecture (no server components complexity)
- ✅ AI-powered code generation
- ✅ Built-in design system
- ✅ Opinionated best practices

### **vs. T3 Stack**

- ✅ More comprehensive (includes UI components)
- ✅ AI integration built-in
- ✅ Better DX with templates
- ✅ Deployment automation

### **vs. Building from Scratch**

- ✅ Saves weeks of setup time
- ✅ Battle-tested configuration
- ✅ Regular updates and security patches
- ✅ Community support

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

### Other Platforms

MAXSTACK works with any Node.js hosting platform:

- **Vercel**: `npm run build && vercel deploy`
- **Railway**: Connect your GitHub repo
- **DigitalOcean**: Use the included Dockerfile
- **AWS/GCP**: Deploy with standard Node.js configuration

## 🤝 Community & Support

- **[Discord Community](https://discord.gg/maxstack)** - Get help and share projects
- **[GitHub Discussions](https://github.com/sys13/maxstack/discussions)** - Feature requests and Q&A
- **[Twitter](https://twitter.com/maxstackdev)** - Updates and announcements
- **[YouTube](https://youtube.com/@maxstack)** - Video tutorials and demos

## 🗺️ Roadmap

### Coming Soon

- [ ] Visual UI builder with drag-and-drop
- [ ] More AI model integrations (Claude, Gemini)
- [ ] Real-time collaboration features
- [ ] Advanced deployment options (Kubernetes, AWS)
- [ ] Mobile app templates (React Native)

### In Development

- [ ] GraphQL API generation
- [ ] Advanced analytics dashboard
- [ ] Multi-tenant SaaS features
- [ ] Internationalization support

## 💎 Pro Features (Coming Soon)

- **Advanced AI Models**: Access to GPT-4, Claude 3, and specialized code models
- **Premium Templates**: E-commerce, CRM, and enterprise applications
- **Priority Support**: Direct access to the MAXSTACK team
- **Custom Integrations**: Tailored solutions for your specific needs

## 🎯 Examples in Production

See MAXSTACK in action:

- **[TaskFlow](https://taskflow.app)** - Project management SaaS built in 2 weeks
- **[BlogCraft](https://blogcraft.io)** - AI-powered blog platform
- **[ShopStack](https://shopstack.com)** - E-commerce solution for small businesses

_Want your project featured? [Submit it here](https://github.com/sys13/maxstack/discussions/new?category=showcase)_

## 🧪 Try It Now

**Quick Demo**: Create a todo app in 2 minutes

```bash
npx maxstack init todo-demo
cd todo-demo && npm install && npm run dev
```

**Live Playground**: Try MAXSTACK in your browser  
👉 **[StackBlitz demo](https://stackblitz.com/github/sys13/maxstack/tree/main/template)**

---

## 📄 License & Contributing

MAXSTACK is MIT licensed.
See [LICENSE.md](LICENSE.md) for details.

**Contributing**: We welcome contributions!
See our [Contributing Guide](.github/CONTRIBUTING.md) and [Development Setup](.github/DEVELOPMENT.md).

### How to Contribute

1. 🍴 Fork the repository
2. 🌿 Create a feature branch
3. ✨ Make your changes
4. ✅ Add tests
5. 📝 Update documentation
6. 🔀 Submit a pull request

**Good First Issues**: Check out issues labeled [`good first issue`](https://github.com/sys13/maxstack/labels/good%20first%20issue)

---

<div align="center">

⭐ Star this repo if MAXSTACK helped you build faster!

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
