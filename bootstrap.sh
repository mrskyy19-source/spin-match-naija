#!/bin/bash

echo "Checking MongoDB daemon..."
if pgrep -x "mongod" > /dev/null; then
    echo "🟢 MongoDB is already running."
else
    echo "Starting MongoDB daemon..."
    sudo mkdir -p /data/db
    sudo chown -R $USER /data/db
    sudo rm -f /data/db/mongod.lock
    mongod --fork --logpath /tmp/mongodb.log --dbpath /data/db
    sleep 2
fi

echo "Restarting Elite Spin Naija server..."
pkill -f "node server.js" 2>/dev/null || true
cd /var/www/casino
node server.js &
SERVER_PID=$!

sleep 2
echo "========================================"
echo "Testing server at http://localhost:3000"
echo "========================================"
curl -I http://localhost:3000
echo ""
echo "Server is running (PID: $SERVER_PID). Press Ctrl+C to stop."
wait $SERVER_PID
