fly apps create taskly
fly volume create data -r yyz -n 1
fly scale count 1
fly secrets set BETTER_AUTH_URL="https://taskly.fly.dev" DB_FILE_NAME="file:/data/local.db" BETTER_AUTH_SECRET=$(openssl rand -hex 32)
fly deploy --strategy immediate --wait-timeout 60
