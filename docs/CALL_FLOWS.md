# Call Flows (v1)

## 1) Inbound call flow
1. Twilio receives call on your Twilio phone number.
2. Twilio hits `POST /twilio/voice/inbound`.
3. Server returns TwiML:
   - Intro: **"Hi, I'm Min, Youssef's assistant."**
   - Starts speech gather.
4. Twilio posts recognized speech to `POST /twilio/voice/respond`.
5. Assistant logic:
   - Handles normal requests.
   - Triggers confirmation gate for sensitive intents.
6. Response loop continues with speech gather until caller hangs up.

## 2) Outbound call flow
1. Authorized client calls `POST /api/calls/outbound` with token and `to` number.
2. Server verifies:
   - `OUTBOUND_API_TOKEN`
   - `OUTBOUND_ALLOWLIST` includes destination number
3. Server uses Twilio REST API `calls.create(...)`.
4. Twilio invokes same voice flow endpoint (`/twilio/voice/inbound`) for conversation.
5. Call progress updates are sent to `POST /twilio/voice/status`.

## 3) Voicemail fallback flow
1. If no speech is captured twice in `/twilio/voice/respond`, assistant offers voicemail.
2. Server redirects to `POST /twilio/voice/voicemail`.
3. Twilio records up to 120 seconds and transcribes.
4. Recording callback received on `POST /twilio/voice/recording-status`.
5. Metadata and transcript (if available) are logged locally.

## 4) Sensitive action confirmation gate
- Triggered on detected keywords (payment, transfer, password, OTP, buy/order, etc.).
- Assistant says: "This sounds sensitive. For safety, please say yes to confirm this request, or no to cancel."
- If caller says:
  - **Yes** → action request is marked confirmed (still logged and intended for human verification).
  - **No** → request is canceled.

> v1 policy: no irreversible action is executed automatically; everything is logged for review.
