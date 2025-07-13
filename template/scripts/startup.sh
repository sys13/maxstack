#!/bin/sh

# startup.sh - Script to initialize the application environment and start the server - used in deployment

set -e # Exit on any error

# Ensure the /data directory exists and has proper permissions
mkdir -p /data
chmod 755 /data

# Set the database file name environment variable if not already set
export DB_FILE_NAME="${DB_FILE_NAME:-file:/data/local.db}"

echo "Database file path: $DB_FILE_NAME"

# Check if database file exists, if not create it
if [ ! -f /data/local.db ]; then
	echo "Database file does not exist, creating and running migrations..."
	touch /data/local.db
	chmod 644 /data/local.db
	echo "Running database migrations..."
	pnpm run db:migrate
	echo "Migrations completed successfully"
else
	echo "Database file exists, running migrations to ensure it's up to date..."
	pnpm run db:migrate
	echo "Migrations completed successfully"
fi

# Verify database file is accessible
if [ ! -r /data/local.db ]; then
	echo "Error: Database file is not readable"
	exit 1
fi

# Start the application
echo "Starting the application..."
exec pnpm run start
