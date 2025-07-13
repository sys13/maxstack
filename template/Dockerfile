FROM node:22-alpine AS development-dependencies-env
RUN corepack enable pnpm
COPY package.json pnpm-lock.yaml /app/
WORKDIR /app
RUN pnpm install --frozen-lockfile
COPY . /app

FROM node:22-alpine AS production-dependencies-env
RUN corepack enable pnpm
COPY package.json pnpm-lock.yaml /app/
WORKDIR /app
RUN pnpm install --frozen-lockfile --prod
# Install additional packages needed for migrations
RUN pnpm add drizzle-kit@1.0.0-beta.1-c0277c0 @dotenvx/dotenvx

FROM node:22-alpine AS build-env
RUN corepack enable pnpm
COPY package.json pnpm-lock.yaml /app/
COPY --from=development-dependencies-env /app/node_modules /app/node_modules
COPY . /app/
WORKDIR /app
RUN pnpm run build

FROM node:22-alpine
RUN corepack enable pnpm
COPY package.json pnpm-lock.yaml .env.example /app/
COPY --from=production-dependencies-env /app/node_modules /app/node_modules
COPY --from=build-env /app/build /app/build
COPY ./scripts /app/scripts
COPY ./drizzle /app/drizzle
COPY ./drizzle.config.ts /app/drizzle.config.ts
COPY ./database /app/database
RUN mv /app/.env.example /app/.env
RUN chmod +x /app/scripts/startup.sh
WORKDIR /app
CMD ["/app/scripts/startup.sh"]
