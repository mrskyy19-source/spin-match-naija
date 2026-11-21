#!/bin/bash

cd /var/www/casino

echo "=== CASINO PROJECT (/VAR/WWW/CASINO) ==="

# 1. FIX EMPTY PACKAGE.JSON
if [ ! -s package.json ]; then
    echo "❌ package.json is empty! Rebuilding it based on server.js requires..."
    cat << 'EOF' > package.json
{
  "name": "casino-server",
  "version": "1.0.0",
  "description": "Crypto Casino Backend",
  "main": "server.js",
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "axios": "^1.6.2",
    "bcryptjs": "^2.4.3",
    "cors": "^2.8.5",
    "dotenv": "^16.3.1",
    "express": "^4.18.2",
    "helmet": "^7.1.0",
    "jsonwebtoken": "^9.0.2",
    "mongoose": "^8.0.3"
  }
}
EOF
    echo "✅ package.json created. Installing dependencies..."
    npm install
else
    echo "✅ package.json exists and is populated."
fi

# 2. MONGODB CONNECTION TEST USING .ENV
echo "\n=== TESTING MONGODB CONNECTION ==="

if [ ! -f .env ]; then
    echo "❌ Error: .env file not found!"
    exit 1
fi

# Export .env variables into the shell environment safely
export $(grep -v '^#' .env | xargs)

# Check if MONGO_URI exists in .env
if [ -z "$MONGO_URI" ]; then
    echo "❌ Error: MONGO_URI is not defined in your .env file."
    exit 1
fi

echo "Connecting to MongoDB using MONGO_URI from .env..."

# Use mongosh (modern mongo shell) or mongo (legacy) depending on what is installed
if command -v mongosh &> /dev/null; then
    MONGO_CMD="mongosh"
elif command -v mongo &> /dev/null; then
    MONGO_CMD="mongo"
else
    echo "❌ Error: Neither 'mongosh' nor 'mongo' command is installed."
    exit 1
fi

# Run the connection test
$MONGO_CMD "$MONGO_URI" --eval "db.runCommand({ ping: 1 })" --quiet

if [ $? -eq 0 ]; then
    echo "✅ Casino MongoDB: OK"
else
    echo "❌ Casino MongoDB: FAILED (ECONNREFUSED - Check if mongod is running and MONGO_URI is correct)"
fi

echo "\n=== SETUP COMPLETE ==="
echo "You can now start your server with: npm start"
