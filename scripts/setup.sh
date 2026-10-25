#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v node >/dev/null 2>&1; then
  echo "❌ Node.js is not installed. Please install Node 20+ and retry."
  exit 1
fi

echo "📦 Installing dependencies..."
npm install

echo "📁 Creating local log directories..."
mkdir -p logs/calls

if [ ! -f .env ]; then
  cp .env.example .env
  echo "📝 Created .env from .env.example"
else
  echo "ℹ️ .env already exists, leaving it unchanged"
fi

echo "✅ Setup complete"
echo "Next steps:"
echo "1) Fill .env with Twilio credentials and URLs"
echo "2) Run: npm start"
