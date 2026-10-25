# Min Phone Agent — GPT-Live Runbook

Built & verified 2026-09-17. Outbound AI phone calls via Twilio, with a
GPT-Live-1 full-duplex voice option alongside the original ElevenLabs path.

## What it is
- Repo: `/home/clawd/clawd/phone-agent-v1`
- Service: systemd `--user` unit `phone-agent-v1.service`, listens on `:3000`
- Public: `https://srv1304573.hstgr.cloud` (nginx TLS; Let's Encrypt, auto-renew)
- Providers: `elevenlabs` (default, fail-safe) and `gpt-live` (per-call opt-in)
- Auth boundary: opaque one-time `callToken` in `<Parameter>`, validated at the
  Twilio media-stream `start` event. Twilio webhooks are signature-validated.

## Placing a call
```bash
set -a; . /home/clawd/clawd/phone-agent-v1/.env; set +a   # never echo secrets
curl -sS -X POST 'https://srv1304573.hstgr.cloud/api/calls/outbound' \
  -H "Authorization: Bearer ${OUTBOUND_API_TOKEN}" \
  -H 'Content-Type: application/json' \
  --data @/tmp/min-phone-call-payload.json
```
Payload fields:
- `to` — E.164, e.g. `+31201234567` (must pass allowlist; `*` = allow all)
- `prompt` — full voice-agent instructions (identity, task, boundaries)
- `provider` — `"gpt-live"` or omit for ElevenLabs default
- `preDialDigits` — optional DTMF to clear IVRs BEFORE the stream connects

Health check: `curl -fsS https://srv1304573.hstgr.cloud/health` →
`gptLivePilotEnabled` + `voiceProviderDefault`.

## GPT-Live pilot controls
- Enable: `.env` `GPT_LIVE_PILOT_ENABLED=true`, then restart service.
- Instant rollback: set it `false` + restart — new AND queued gpt-live calls
  fall back; ElevenLabs unaffected. Per-call: just omit `provider`.
- Tunables (`.env`): `GPT_LIVE_MODEL` (gpt-live-1), `GPT_LIVE_BACKEND_MODEL`
  (gpt-5.6-luna, does delegated web_search), `GPT_LIVE_VOICE` (willow),
  `GPT_LIVE_INACTIVITY_MS` (15000), `GPT_LIVE_MAX_CALL_MS` (600000).
- Key: `OPENAI_API_KEY` already set; has `gpt-live-1` access. Do not print it.

## IVR / phone-menu navigation (IMPORTANT)
GPT-Live and Twilio bidirectional Media Streams **cannot send DTMF once the
voice stream is live** — the model saying "two" does nothing to a menu. So any
phone menu MUST be pre-programmed via `preDialDigits`, which emits
`<Play digits>` BEFORE `<Connect><Stream>`.
- Allowed chars: `0-9 A-D * # w W` (others stripped; 32-char cap; injection-safe)
- Pauses: `w` = 0.5s, `W` = 1s. Chain for multi-level menus.
- Example (verified live): `"1WWWWW6"` = press 1 (English), wait ~5s, press 6
  (team member) — cleared a two-level Hilton menu and reached a human.
- Unknown menu? Place one call to learn the tree, then retry with the sequence.

## Smart IVR navigation (model-selected DTMF)
For unknown or branching menus, opt a GPT-Live call into smart IVR mode:

```json
{
  "to": "+31...",
  "provider": "gpt-live",
  "smartIvr": true,
  "prompt": "Listen to the complete menu, choose only verified options that advance the authorized task, and never guess or choose booking/cancellation/payment actions."
}
```

In this mode Min does not play its normal opening line over the IVR, and all
model-generated audio is suppressed at the bridge while navigation is active.
GPT-Live listens to the menu and delegates a constrained `press_digit` function
call only after associating one spoken option with one key. The server updates
the active Twilio call to `<Play>` that single digit, reconnects `<Stream>` with
a fresh one-time token, and supplies bounded prior IVR context to the replacement
Live session.

When a live human directly greets the caller, GPT-Live delegates
`begin_conversation` with the verbatim greeting. The bridge accepts it only when
the greeting appears in the recent transcript, contains a human-greeting cue,
and contains no menu/recording/hold markers. It then unmutes audio **inside the
same call and Live session**, injects the required assistant identification, and
continues the original task. Rejected or ambiguous handoffs remain silent.
Successful transitions are logged as `ivr_human_handoff`.

Each DTMF handoff is logged as `ivr_digit_selected`; `SMART_IVR_MAX_HOPS`
(default 12) prevents loops. `smartIvr` is boolean, opt-in, and rejected for
non-GPT-Live providers.

Keep `preDialDigits` for known stable paths. Use `smartIvr` when the menu must be
heard before choosing. Do not combine them unless the pre-dial prefix is already
confirmed and the agent must choose only a later branch.

## Call lifecycle & hangup
- Model has no "I'm done" signal, so the bridge auto-ends and hangs up Twilio on:
  conversation end, inactivity (no transcript activity for INACTIVITY_MS), or the
  MAX_CALL_MS hard cap. All routes call `hangUpCall` →
  `calls(sid).update({status:'completed'})` (idempotent). Prevents dead-air loops.
- NOTE: continuous ambient audio (hold music, busy reception) keeps resetting the
  inactivity timer, so live human calls can legitimately run minutes — that's not
  a stuck call. A long call ending with a natural goodbye = success.

## Transcripts / results (current limitation)
- Local logs `logs/calls/<CallSid>.{json,md}` store only event types + char
  COUNTS, never spoken content (privacy hardening).
- Full transcript is sent to Telegram at call end (bot token/chat id in `.env`).
  The bot cannot read its own sent messages back, so the agent CANNOT retrieve
  call content afterward — only the user has it. TODO if needed: write a local,
  readable summary so results can be reported back.

## Monitoring a call
```bash
# key lifecycle events (suppress transcript-activity noise)
python3 - <<'PY'
from pathlib import Path
p=Path('/home/clawd/clawd/phone-agent-v1/logs/calls/CA<SID>.md')
for l in p.read_text().splitlines():
    if 'transcript_activity' not in l: print(l)
PY
```
Watch for: `pre_dial_digits`, `voice_stream_start`, `voice_conversation_end`
(has `endReason`), `call_hangup`. `endReason:null` = ended naturally.

## Tests & commits
- `cd phone-agent-v1 && npm test` (node --test, 50+ tests). `npm audit --omit=dev`.
- Feature commits on `master`, prefixed `[verified]`:
  GPT-Live pilot; hangup on end; inactivity/max-duration; IVR pre-dial DTMF.

## Proven
Booked a real 2-person lunch reservation (We Are EDN restaurant, DoubleTree by
Hilton Amsterdam Centraal, Fri 2 Oct 12:00, name Youssef Hounat) — GPT-Live
navigated a two-level IVR, held a natural 5-min conversation with a human
receptionist, adapted when redirected, and confirmed the booking.

## Follow-ups
1. Local readable transcript/summary so results are visible agent-side.
2. Add an application-level audio mute/unmute gate if live testing shows GPT-Live
   can still speak over an IVR despite smart-mode instructions.
