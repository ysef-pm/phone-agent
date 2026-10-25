# Phone Agent

An autonomous AI phone agent that can make and receive calls, navigate IVR systems, and have natural conversations with humans — all while you sip your coffee and avoid scary receptionists.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Why This Exists

Because calling the GP (huisarts) in the Netherlands is terrifying, and their receptionists are even scarier. This bot handles it for you.

More seriously: this is a production-grade Twilio + OpenAI/ElevenLabs voice agent with smart IVR navigation, encrypted transcript storage, and safety rails for consequential decisions.

## Features

### 🤖 Dual Voice Providers
- **ElevenLabs Conversational AI** (production default)
- **OpenAI GPT-Live** with `gpt-4o-realtime-preview` (pilot mode)

### 🎯 Smart IVR Navigation
- Autonomous menu navigation with `press_digit` function calling
- Verified human detection before starting conversations
- Blocks consequential actions (cancellations, payments, appointments)
- Multi-hop IVR support with automatic TwiML rebuilding

### 🔒 Security First
- Encrypted call transcript storage with 7-day retention
- Authenticated REST API for transcript retrieval
- Twilio webhook signature validation
- Bearer token authentication for outbound calls
- No prompts or transcripts in process logs

### 📞 Call Features
- Outbound calling with allowlist protection
- Pre-dial digit injection for IVR bypass
- Automatic inactivity detection (15s default)
- Hard max-duration caps (10min default)
- Telegram notifications with call summaries

### 🧪 Fully Tested
95 unit tests covering security, IVR safety, provider lifecycle, transcript archiving, and edge cases.

## Quick Start

### Prerequisites
- Node.js 18+
- [Twilio account](https://www.twilio.com/try-twilio) with a phone number
- [ElevenLabs account](https://elevenlabs.io) with Conversational AI enabled
- (Optional) [OpenAI account](https://platform.openai.com) for GPT-Live pilot

### Installation

\`\`\`bash
git clone https://github.com/yourusername/phone-agent.git
cd phone-agent
npm install
\`\`\`

### Configuration

1. Copy \`.env.example\` to \`.env\`:
\`\`\`bash
cp .env.example .env
\`\`\`

2. Fill in your credentials (see \`.env.example\` for all options)

3. Generate strong random tokens:
\`\`\`bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
\`\`\`

### Run Tests

\`\`\`bash
npm test
\`\`\`

All 95 tests should pass.

### Start the Server

\`\`\`bash
npm start
\`\`\`

Server runs on \`http://localhost:3000\` by default.

## Making Your First Call

### Outbound Call

\`\`\`bash
curl -X POST http://localhost:3000/api/calls/outbound \\
  -H "Authorization: Bearer YOUR_OUTBOUND_API_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "to": "+31612345678",
    "prompt": "Call the clinic and ask if they have appointments available.",
    "provider": "elevenlabs"
  }'
\`\`\`

### Retrieve Call Transcript

\`\`\`bash
curl http://localhost:3000/api/calls/CAxxxxxx/transcript \\
  -H "Authorization: Bearer YOUR_TRANSCRIPT_API_TOKEN"
\`\`\`

## Architecture

See [docs/CALL_FLOWS.md](docs/CALL_FLOWS.md) for detailed diagrams.

### Key Components

- **\`src/server.js\`** - Express app, webhooks, outbound API
- **\`src/gpt-live-bridge.js\`** - OpenAI Realtime API with smart IVR
- **\`src/elevenlabs-bridge.js\`** - ElevenLabs integration
- **\`src/smart-ivr-dtmf.js\`** - Safe IVR navigation
- **\`src/call-transcript-store.js\`** - Encrypted transcripts
- **\`src/transcript-routes.js\`** - Transcript retrieval API

## Smart IVR Safety

The \`press_digit\` function blocks consequential actions:

**Blocked patterns** (English + Dutch):
- Cancellations, payments, appointments, account changes

See [\`test/smart-ivr-dtmf.test.js\`](test/smart-ivr-dtmf.test.js) for safety test cases.

## Documentation

- [Call Flow Diagrams](docs/CALL_FLOWS.md)
- [GPT-Live Runbook](RUNBOOK-gpt-live.md)
- [Environment Variables](.env.example)

## Production Deployment

Use systemd + reverse proxy (Caddy/nginx). All tokens must be strong random values.

See \`.env.example\` for full configuration.

## API Reference

### \`POST /api/calls/outbound\`
Make an outbound call.

**Body:**
\`\`\`json
{
  "to": "+31612345678",
  "prompt": "Task for the AI",
  "provider": "elevenlabs",
  "smartIvr": false
}
\`\`\`

### \`GET /api/calls/:callSid/transcript\`
Retrieve encrypted call transcript (7-day retention).

**Query:** \`?format=json\` or \`?format=text\`

## Contributing

Contributions welcome! Please add tests for new features and ensure all tests pass.

## License

MIT License - see [LICENSE](LICENSE)

## Acknowledgments

Built with Twilio, OpenAI, ElevenLabs, and excessive coffee.

Made with ❤️ (and social anxiety) by someone who really didn't want to call their GP.
