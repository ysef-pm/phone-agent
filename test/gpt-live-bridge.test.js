const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { GPTLiveBridge } = require('../src/gpt-live-bridge');

class FakeSocket extends EventEmitter {
  static OPEN = 1;

  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    this.readyState = FakeSocket.OPEN;
    this.sent = [];
    this.closeCalls = 0;
    this.terminateCalls = 0;
    FakeSocket.instances.push(this);
  }

  send(value) {
    this.sent.push(JSON.parse(value));
  }

  close() {
    this.closeCalls += 1;
    this.readyState = 3;
    this.emit('close', 1000, Buffer.from('closed'));
  }

  terminate() {
    this.terminateCalls += 1;
    this.close();
  }
}
FakeSocket.instances = [];

function makeBridge(overrides = {}) {
  FakeSocket.instances = [];
  return new GPTLiveBridge({
    apiKey: 'test-key',
    taskPrompt: 'Find the restaurant menu URL and confirm it.',
    callSid: 'CAtest',
    WebSocketImpl: FakeSocket,
    closeGraceMs: 5,
    connectTimeoutMs: 50,
    ...overrides
  });
}

async function startReadySession(bridge) {
  const connecting = bridge.connect();
  const socket = FakeSocket.instances.at(-1);
  socket.emit('open');
  socket.emit('message', JSON.stringify({ type: 'session.started', session: { id: 'live_123' } }));
  await connecting;
  return socket;
}

test('connect settles only after GPT-Live reports session.started', async () => {
  const bridge = makeBridge();
  let settled = false;
  const connecting = bridge.connect().then(() => { settled = true; });
  const socket = FakeSocket.instances[0];

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);

  socket.emit('open');
  socket.emit('message', JSON.stringify({ type: 'session.started', session: { id: 'live_123' } }));
  await connecting;
  assert.equal(settled, true);
});

test('ends the call after conversational inactivity so the line does not sit open', async () => {
  let ended = 0;
  let endMeta;
  const bridge = makeBridge({ inactivityTimeoutMs: 20, onEnd: (t, m) => { ended += 1; endMeta = m; } });
  const socket = await startReadySession(bridge);

  await new Promise((r) => setTimeout(r, 20 + 5 + 40));

  assert.equal(ended, 1);
  assert.equal(endMeta.endReason, 'inactivity');
  assert.equal(socket.sent.some((e) => e.type === 'session.close'), true);
});

test('transcript activity resets the inactivity timer', async () => {
  let ended = 0;
  const bridge = makeBridge({ inactivityTimeoutMs: 40, onEnd: () => { ended += 1; } });
  const socket = await startReadySession(bridge);

  await new Promise((r) => setTimeout(r, 25));
  socket.emit('message', JSON.stringify({ type: 'session.output_transcript.delta', delta: 'still here', start_ms: 0, end_ms: 10 }));
  await new Promise((r) => setTimeout(r, 25));

  assert.equal(ended, 0);
});

test('does not treat IVR silence or hold time as conversational inactivity', async () => {
  let ended = 0;
  const bridge = makeBridge({
    smartIvr: true,
    inactivityTimeoutMs: 20,
    maxCallMs: 10000,
    onEnd: () => { ended += 1; }
  });
  const socket = await startReadySession(bridge);

  await new Promise((r) => setTimeout(r, 20 + 5 + 40));

  assert.equal(ended, 0);
  assert.equal(socket.sent.some((e) => e.type === 'session.close'), false);
  bridge.close();
});

test('ends the call when the hard max-duration cap is reached', async () => {
  let ended = 0;
  let endMeta;
  const bridge = makeBridge({ inactivityTimeoutMs: 10000, maxCallMs: 25, onEnd: (t, m) => { ended += 1; endMeta = m; } });
  await startReadySession(bridge);

  await new Promise((r) => setTimeout(r, 25 + 5 + 40));

  assert.equal(ended, 1);
  assert.equal(endMeta.endReason, 'max_duration');
});

test('closing during the OpenAI handshake terminates the connecting socket', () => {
  const bridge = makeBridge();
  bridge.connect().catch(() => {});
  const socket = FakeSocket.instances[0];
  socket.readyState = 0;

  bridge.close();

  assert.equal(socket.terminateCalls, 1);
  socket.readyState = FakeSocket.OPEN;
  socket.emit('open');
  assert.equal(socket.sent.some((event) => event.type === 'session.start'), false);
});

test('unexpected OpenAI closure closes the Twilio media stream', () => {
  const bridge = makeBridge();
  const twilio = new FakeSocket('twilio', {});
  bridge.setTwilioStream(twilio, 'MZ123');
  bridge.connect().catch(() => {});
  const socket = FakeSocket.instances.at(-1);

  socket.emit('close', 1011, Buffer.from('provider failed'));

  assert.equal(twilio.closeCalls, 1);
});

test('starts a GPT-Live session using Twilio native mu-law audio', async () => {
  const bridge = makeBridge();
  const connecting = bridge.connect();
  const socket = FakeSocket.instances[0];

  assert.equal(socket.url, 'wss://api.openai.com/v1/live/sessions');
  assert.equal(socket.options.headers.Authorization, 'Bearer test-key');

  socket.emit('open');
  const start = socket.sent[0];
  assert.equal(start.type, 'session.start');
  assert.equal(start.session.model, 'gpt-live-1');
  assert.deepEqual(start.session.audio.format, { type: 'audio/pcmu', rate: 8000 });
  assert.equal(start.session.delegation.type, 'responses');
  assert.match(start.session.instructions, /Find the restaurant menu URL/);
  socket.emit('message', JSON.stringify({ type: 'session.started', session: { id: 'live_123' } }));
  await connecting;
});

test('buffers caller audio until the Live session is ready', async () => {
  const bridge = makeBridge();
  const connecting = bridge.connect();
  const socket = FakeSocket.instances[0];
  socket.emit('open');

  bridge.sendAudio('before-ready');
  assert.equal(socket.sent.some((event) => event.audio === 'before-ready'), false);

  socket.emit('message', JSON.stringify({ type: 'session.started', session: { id: 'live_123' } }));
  await connecting;
  assert.equal(socket.sent.some((event) => event.audio === 'before-ready'), true);

  bridge.sendAudio('after-ready');
  assert.equal(socket.sent.at(-1).type, 'session.input_audio.append');
  assert.equal(socket.sent.at(-1).audio, 'after-ready');
});

test('relays GPT-Live output audio directly to the matching Twilio stream', async () => {
  const bridge = makeBridge();
  const twilio = new FakeSocket('twilio', {});
  bridge.setTwilioStream(twilio, 'MZ123');
  const socket = await startReadySession(bridge);
  socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: 'mulaw-bytes' }));

  assert.deepEqual(twilio.sent.at(-1), {
    event: 'media',
    streamSid: 'MZ123',
    media: { payload: 'mulaw-bytes' }
  });
});

test('collects overlapping transcript fragments and reports one final transcript', async () => {
  let finalTranscript;
  const bridge = makeBridge({ onEnd: (transcript) => { finalTranscript = transcript; } });
  const socket = await startReadySession(bridge);
  socket.emit('message', JSON.stringify({ type: 'session.input_transcript.delta', delta: 'Hello ', start_ms: 0, end_ms: 200 }));
  socket.emit('message', JSON.stringify({ type: 'session.output_transcript.delta', delta: 'Hi!', start_ms: 150, end_ms: 300 }));
  socket.emit('message', JSON.stringify({ type: 'session.input_transcript.delta', delta: 'there', start_ms: 200, end_ms: 400 }));
  socket.emit('close', 1000, Buffer.from('done'));

  assert.deepEqual(finalTranscript, [
    { role: 'user', text: 'Hello there' },
    { role: 'agent', text: 'Hi!' }
  ]);
});

test('preserves separate conversational turns in the final transcript', async () => {
  let finalTranscript;
  const bridge = makeBridge({ onEnd: (transcript) => { finalTranscript = transcript; } });
  const socket = await startReadySession(bridge);
  socket.emit('message', JSON.stringify({ type: 'session.input_transcript.delta', delta: 'First question', start_ms: 0, end_ms: 200 }));
  socket.emit('message', JSON.stringify({ type: 'session.output_transcript.delta', delta: 'First answer', start_ms: 500, end_ms: 700 }));
  socket.emit('message', JSON.stringify({ type: 'session.input_transcript.delta', delta: 'Second question', start_ms: 1000, end_ms: 1200 }));
  socket.emit('close', 1000, Buffer.from('done'));

  assert.deepEqual(finalTranscript, [
    { role: 'user', text: 'First question' },
    { role: 'agent', text: 'First answer' },
    { role: 'user', text: 'Second question' }
  ]);
});

test('requests graceful Live shutdown and emits the final callback once', async () => {
  let ended = 0;
  const bridge = makeBridge({ onEnd: () => { ended += 1; } });
  const socket = await startReadySession(bridge);

  bridge.close();
  assert.equal(socket.sent.at(-1).type, 'session.close');
  socket.emit('message', JSON.stringify({ type: 'session.closed', usage: { seconds: 4 } }));
  assert.equal(ended, 1);
});

test('smart IVR mode stays silent at startup and exposes constrained navigation and human-handoff tools', async () => {
  const bridge = makeBridge({ smartIvr: true });
  const connecting = bridge.connect();
  const socket = FakeSocket.instances[0];
  socket.emit('open');

  const start = socket.sent[0];
  const tool = start.session.delegation.responses.tools.find((item) => item.name === 'press_digit');
  const handoffTool = start.session.delegation.responses.tools.find((item) => item.name === 'begin_conversation');
  assert.equal(tool.type, 'function');
  assert.deepEqual(tool.parameters.properties.digit.enum, ['0','1','2','3','4','5','6','7','8','9','*','#']);
  assert.equal(handoffTool.type, 'function');
  assert.deepEqual(handoffTool.parameters.required, ['heard_greeting']);
  assert.match(start.session.instructions, /stay silent/i);
  assert.match(start.session.delegation.responses.instructions, /must call begin_conversation/i);
  assert.match(start.session.delegation.responses.instructions, /do not answer the human directly/i);

  socket.emit('message', JSON.stringify({ type: 'session.started', session: { id: 'live_123' } }));
  await connecting;
  assert.equal(socket.sent.some((event) => event.type === 'session.commentary.append'), false);
});

test('smart IVR mode buffers enough startup audio to avoid losing the next menu after reconnect', async () => {
  const bridge = makeBridge({ smartIvr: true });
  const connecting = bridge.connect();
  const socket = FakeSocket.instances[0];
  socket.emit('open');

  for (let i = 0; i < 100; i += 1) bridge.sendAudio(`frame-${i}`);
  socket.emit('message', JSON.stringify({ type: 'session.started', session: { id: 'live_123' } }));
  await connecting;

  const audio = socket.sent.filter((event) => event.type === 'session.input_audio.append').map((event) => event.audio);
  assert.equal(audio.length, 100);
  assert.equal(audio[0], 'frame-0');
});

test('suppresses all model audio while smart IVR navigation is active', async () => {
  const bridge = makeBridge({ smartIvr: true });
  const twilio = new FakeSocket('twilio', {});
  bridge.setTwilioStream(twilio, 'MZ123');
  const socket = await startReadySession(bridge);

  socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: 'must-not-play' }));

  assert.equal(twilio.sent.length, 0);
});

test('transitions in place from silent IVR navigation to a verified live-human conversation', async () => {
  const transitions = [];
  const bridge = makeBridge({
    smartIvr: true,
    opening: "Hi, this is Min, Youssef's AI assistant.",
    onConversationStart: (event) => transitions.push(event)
  });
  const twilio = new FakeSocket('twilio', {});
  bridge.setTwilioStream(twilio, 'MZ123');
  const socket = await startReadySession(bridge);
  socket.emit('message', JSON.stringify({
    type: 'session.input_transcript.delta',
    delta: 'Good afternoon, front desk, how may I help you?',
    start_ms: 0,
    end_ms: 500
  }));
  socket.emit('message', JSON.stringify({
    type: 'response.event',
    delegation_id: 'item_human_1',
    event: {
      type: 'response.output_item.done',
      item: {
        type: 'function_call',
        call_id: 'call_human_1',
        name: 'begin_conversation',
        arguments: '{"heard_greeting":"Good afternoon, front desk, how may I help you?"}'
      }
    }
  }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(bridge.smartIvr, false);
  assert.equal(bridge.conversationStarted, true);
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].heardGreeting, 'Good afternoon, front desk, how may I help you?');
  assert.equal(socket.sent.some((event) => event.type === 'session.instructions.append' && /live human/i.test(event.content)), true);
  assert.equal(socket.sent.some((event) => event.type === 'session.commentary.append' && /AI assistant/i.test(event.content)), true);

  socket.emit('message', JSON.stringify({ type: 'session.output_audio.delta', delta: 'spoken-answer' }));
  assert.deepEqual(twilio.sent.at(-1), {
    event: 'media',
    streamSid: 'MZ123',
    media: { payload: 'spoken-answer' }
  });
});

test('accepts the Dutch live greeting spelling observed on the TCA call', async () => {
  const transitions = [];
  const bridge = makeBridge({
    smartIvr: true,
    onConversationStart: (event) => transitions.push(event)
  });
  const socket = await startReadySession(bridge);
  socket.emit('message', JSON.stringify({
    type: 'session.input_transcript.delta',
    delta: 'Goedenmiddag TCA.',
    start_ms: 0,
    end_ms: 500
  }));
  socket.emit('message', JSON.stringify({
    type: 'response.event',
    delegation_id: 'item_human_tca',
    event: {
      type: 'response.output_item.done',
      item: {
        type: 'function_call',
        call_id: 'call_human_tca',
        name: 'begin_conversation',
        arguments: '{"heard_greeting":"Goedenmiddag TCA."}'
      }
    }
  }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(bridge.smartIvr, false);
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].heardGreeting, 'Goedenmiddag TCA.');
});

test('falls back to a verified high-confidence greeting when the model tries to answer directly', async () => {
  const transitions = [];
  const bridge = makeBridge({
    smartIvr: true,
    onConversationStart: (event) => transitions.push(event)
  });
  const twilio = new FakeSocket('twilio', {});
  bridge.setTwilioStream(twilio, 'MZ123');
  const socket = await startReadySession(bridge);
  socket.emit('message', JSON.stringify({
    type: 'session.input_transcript.delta',
    delta: 'Goedenmiddag TCA.',
    start_ms: 0,
    end_ms: 500
  }));
  socket.emit('message', JSON.stringify({
    type: 'session.input_transcript.delta',
    delta: 'Goedenmiddag.',
    start_ms: 1500,
    end_ms: 1800
  }));
  socket.emit('message', JSON.stringify({
    type: 'session.output_transcript.delta',
    delta: 'Hi, good afternoon.'
  }));

  assert.equal(bridge.smartIvr, false);
  assert.equal(bridge.conversationStarted, true);
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].heardGreeting, 'Goedenmiddag TCA. Goedenmiddag.');
  assert.equal(socket.sent.some((event) => event.type === 'session.commentary.append'), true);
});

test('direct-response fallback stays muted for automated and ambiguous greetings', async () => {
  const cases = [
    ['Hello. For reception, press 1.'],
    ['Good morning.', 'Your call is important; please hold.'],
    ['Hello, this is an automated recording.'],
    ['Hello.'],
    ['Good afternoon, reception. To hear our opening hours, say one.'],
    ['Good afternoon, reception. Please wait while we connect your call.'],
    ['Good afternoon, reception. This call can be monitored for training purposes.'],
    ['Your call is important; please hold.', 'Good afternoon, reception.'],
    ['This is a recording for quality purposes.', 'Good afternoon, reception.'],
    ['Goedemiddag TCA. Een moment geduld alstublieft.'],
    ['Goedemiddag TCA. Voor openingstijden zegt u één.'],
    ['Hello, reception is currently unavailable.']
  ];
  for (const transcriptParts of cases) {
    const transitions = [];
    const bridge = makeBridge({ smartIvr: true, onConversationStart: (event) => transitions.push(event) });
    const twilio = new FakeSocket('twilio', {});
    bridge.setTwilioStream(twilio, 'MZ123');
    const socket = await startReadySession(bridge);
    transcriptParts.forEach((delta, index) => socket.emit('message', JSON.stringify({
      type: 'session.input_transcript.delta',
      delta,
      start_ms: index * 1000,
      end_ms: index * 1000 + 500
    })));
    socket.emit('message', JSON.stringify({ type: 'session.output_transcript.delta', delta: 'Hello there.' }));

    assert.equal(bridge.smartIvr, true, transcriptParts.join(' / '));
    assert.equal(bridge.conversationStarted, false, transcriptParts.join(' / '));
    assert.deepEqual(transitions, [], transcriptParts.join(' / '));
    assert.equal(twilio.sent.length, 0, transcriptParts.join(' / '));
    bridge.close();
  }
});

test('rejects human handoff when greeting is absent or still sounds automated', async () => {
  for (const [transcript, greeting] of [
    ['Please hold while we connect your call.', 'Good afternoon, front desk, how may I help you?'],
    ['Hello. For reception, press 1.', 'Hello. For reception, press 1.'],
    ['Thank you for calling Hilton. Hello and welcome.', 'Thank you for calling Hilton. Hello and welcome.'],
    ['Hello.', 'Hello.'],
    ['Hello, reception is currently unavailable.', 'Hello, reception is currently unavailable.'],
    ['Good afternoon, reception. Please wait while we connect your call.', 'Good afternoon, reception. Please wait while we connect your call.'],
    ['Goedemiddag TCA. Een moment geduld alstublieft.', 'Goedemiddag TCA. Een moment geduld alstublieft.']
  ]) {
    const errors = [];
    const bridge = makeBridge({ smartIvr: true, onWarning: (error) => errors.push(error.message) });
    const twilio = new FakeSocket('twilio', {});
    bridge.setTwilioStream(twilio, 'MZ123');
    const socket = await startReadySession(bridge);
    socket.emit('message', JSON.stringify({ type: 'session.input_transcript.delta', delta: transcript, start_ms: 0, end_ms: 500 }));
    socket.emit('message', JSON.stringify({
      type: 'response.event', delegation_id: 'item_human_1',
      event: { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_human_1', name: 'begin_conversation', arguments: JSON.stringify({ heard_greeting: greeting }) } }
    }));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(bridge.smartIvr, true, transcript);
    assert.equal(bridge.conversationStarted, false, transcript);
    assert.equal(twilio.sent.length, 0, transcript);
    assert.ok(errors.length > 0, transcript);
    bridge.close();
  }
});

test('rejects shortened greeting claims when surrounding transcript is automated', async () => {
  const cases = [
    ['Hello. For reception, press 1.', 'Hello'],
    ['Good morning. Your call is important; please hold.', 'Good morning'],
    ['Hello, this is an automated recording.', 'Hello'],
    ['Tonight our recording is Othello.', 'hello']
  ];
  for (const [transcript, greeting] of cases) {
    const transitions = [];
    const bridge = makeBridge({ smartIvr: true, onConversationStart: (event) => transitions.push(event) });
    const twilio = new FakeSocket('twilio', {});
    bridge.setTwilioStream(twilio, 'MZ123');
    const socket = await startReadySession(bridge);
    socket.emit('message', JSON.stringify({ type: 'session.input_transcript.delta', delta: transcript, start_ms: 0, end_ms: 500 }));
    socket.emit('message', JSON.stringify({
      type: 'response.event', delegation_id: 'item_human_1',
      event: { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_human_1', name: 'begin_conversation', arguments: JSON.stringify({ heard_greeting: greeting }) } }
    }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(bridge.smartIvr, true, transcript);
    assert.deepEqual(transitions, [], transcript);
    assert.equal(twilio.sent.length, 0, transcript);
    bridge.close();
  }
});

test('rejects shortened greeting claims when automation is in an adjacent transcript entry', async () => {
  const cases = [
    ['Hello.', 'For reception, press 1.', 'Hello'],
    ['Good morning.', 'Your call is important; please hold.', 'Good morning'],
    ['Hello.', 'This is an automated recording.', 'Hello']
  ];
  for (const [first, second, greeting] of cases) {
    const transitions = [];
    const bridge = makeBridge({ smartIvr: true, onConversationStart: (event) => transitions.push(event) });
    const socket = await startReadySession(bridge);
    socket.emit('message', JSON.stringify({ type: 'session.input_transcript.delta', delta: first, start_ms: 0, end_ms: 200 }));
    socket.emit('message', JSON.stringify({ type: 'session.input_transcript.delta', delta: second, start_ms: 1000, end_ms: 1300 }));
    socket.emit('message', JSON.stringify({
      type: 'response.event', delegation_id: 'item_human_1',
      event: { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_human_1', name: 'begin_conversation', arguments: JSON.stringify({ heard_greeting: greeting }) } }
    }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(bridge.smartIvr, true, `${first} / ${second}`);
    assert.deepEqual(transitions, [], `${first} / ${second}`);
    bridge.close();
  }
});

test('accepts a full human greeting after an unrelated prior menu entry', async () => {
  const transitions = [];
  const bridge = makeBridge({ smartIvr: true, onConversationStart: (event) => transitions.push(event) });
  const socket = await startReadySession(bridge);
  socket.emit('message', JSON.stringify({ type: 'session.input_transcript.delta', delta: 'For billing, press 2.', start_ms: 0, end_ms: 200 }));
  socket.emit('message', JSON.stringify({ type: 'session.input_transcript.delta', delta: 'Good afternoon, front desk, how may I help you?', start_ms: 1000, end_ms: 1300 }));
  socket.emit('message', JSON.stringify({
    type: 'response.event', delegation_id: 'item_human_1',
    event: { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_human_1', name: 'begin_conversation', arguments: '{"heard_greeting":"Good afternoon, front desk, how may I help you?"}' } }
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(bridge.smartIvr, false);
  assert.equal(transitions.length, 1);
});

test('allows only one digit handoff and timers cannot override a pending handoff', async () => {
  let resolvePress;
  const presses = [];
  const bridge = makeBridge({
    smartIvr: true,
    inactivityTimeoutMs: 15,
    onPressDigit: (request) => new Promise((resolve) => {
      presses.push(request);
      resolvePress = resolve;
    })
  });
  const socket = await startReadySession(bridge);
  socket.emit('message', JSON.stringify({ type: 'session.input_transcript.delta', delta: 'For English press 1. For Dutch press 2.', start_ms: 0, end_ms: 500 }));
  const call = (id, digit, option) => socket.emit('message', JSON.stringify({
    type: 'response.event', delegation_id: 'item_1',
    event: { type: 'response.output_item.done', item: { type: 'function_call', call_id: id, name: 'press_digit', arguments: JSON.stringify({ digit, heard_option: option }) } }
  }));

  call('call_1', '1', 'For English press 1');
  call('call_2', '2', 'For Dutch press 2');
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(presses.length, 1);
  assert.equal(bridge.endReason, 'ivr_dtmf');
  resolvePress();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(socket.sent.some((event) => event.type === 'session.close'), true);
});

test('rejects a digit whose claimed option is absent from the recent IVR transcript', async () => {
  const presses = [];
  const errors = [];
  const bridge = makeBridge({
    smartIvr: true,
    onPressDigit: async (request) => presses.push(request),
    onWarning: (error) => errors.push(error.message)
  });
  const socket = await startReadySession(bridge);
  socket.emit('message', JSON.stringify({ type: 'session.input_transcript.delta', delta: 'For Dutch press 2.', start_ms: 0, end_ms: 500 }));
  socket.emit('message', JSON.stringify({
    type: 'response.event', delegation_id: 'item_1',
    event: { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_1', name: 'press_digit', arguments: '{"digit":"1","heard_option":"For English press 1"}' } }
  }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(presses, []);
  assert.match(errors[0], /not found in recent IVR transcript/i);
});

test('rejects a digit that does not match the key stated in the claimed option', async () => {
  const presses = [];
  const errors = [];
  const bridge = makeBridge({
    smartIvr: true,
    onPressDigit: async (request) => presses.push(request),
    onWarning: (error) => errors.push(error.message)
  });
  const socket = await startReadySession(bridge);
  socket.emit('message', JSON.stringify({ type: 'session.input_transcript.delta', delta: 'For English press 1.', start_ms: 0, end_ms: 500 }));
  socket.emit('message', JSON.stringify({
    type: 'response.event', delegation_id: 'item_1',
    event: { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_1', name: 'press_digit', arguments: '{"digit":"9","heard_option":"For English press 1"}' } }
  }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(presses, []);
  assert.match(errors[0], /digit does not match/i);
});

test('does not mistake Dutch article een for digit one', async () => {
  const presses = [];
  const errors = [];
  const bridge = makeBridge({ smartIvr: true, onPressDigit: async (r) => presses.push(r), onWarning: (e) => errors.push(e.message) });
  const socket = await startReadySession(bridge);
  socket.emit('message', JSON.stringify({ type: 'session.input_transcript.delta', delta: 'Voor een medewerker, druk twee.', start_ms: 0, end_ms: 500 }));
  socket.emit('message', JSON.stringify({ type: 'response.event', delegation_id: 'item_1', event: { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_1', name: 'press_digit', arguments: '{"digit":"1","heard_option":"Voor een medewerker, druk twee"}' } } }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(presses, []);
  assert.match(errors[0], /digit does not match/i);
});

test('blocks Dutch cancellation options', async () => {
  const presses = [];
  const errors = [];
  const bridge = makeBridge({ smartIvr: true, onPressDigit: async (r) => presses.push(r), onWarning: (e) => errors.push(e.message) });
  const socket = await startReadySession(bridge);
  socket.emit('message', JSON.stringify({ type: 'session.input_transcript.delta', delta: 'Om uw afspraak te annuleren, druk drie.', start_ms: 0, end_ms: 500 }));
  socket.emit('message', JSON.stringify({ type: 'response.event', delegation_id: 'item_1', event: { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_1', name: 'press_digit', arguments: '{"digit":"3","heard_option":"Om uw afspraak te annuleren, druk drie"}' } } }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(presses, []);
  assert.match(errors[0], /consequential IVR option is blocked/i);
});

test('does not treat Dutch article een after druk as digit one', async () => {
  const presses = [];
  const errors = [];
  const bridge = makeBridge({ smartIvr: true, onPressDigit: async (r) => presses.push(r), onWarning: (e) => errors.push(e.message) });
  const socket = await startReadySession(bridge);
  socket.emit('message', JSON.stringify({ type: 'session.input_transcript.delta', delta: 'Voor ondersteuning, druk een keuze.', start_ms: 0, end_ms: 500 }));
  socket.emit('message', JSON.stringify({ type: 'response.event', delegation_id: 'item_1', event: { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_1', name: 'press_digit', arguments: '{"digit":"1","heard_option":"Voor ondersteuning, druk een keuze"}' } } }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(presses, []);
  assert.match(errors[0], /digit does not match/i);
});

test('blocks consequential appointment booking cancellation and payment nouns in English and Dutch', async () => {
  const phrases = [
    ['For appointments, press 4', '4'],
    ['For cancellation, press 3', '3'],
    ['For booking, press 2', '2'],
    ['For payments, press 5', '5'],
    ['Voor afspraken, druk vier', '4'],
    ['Voor annulering, druk drie', '3'],
    ['Voor boekingen, druk twee', '2'],
    ['Voor betalingen, druk vijf', '5']
  ];

  for (const [phrase, digit] of phrases) {
    const presses = [];
    const errors = [];
    const bridge = makeBridge({ smartIvr: true, onPressDigit: async (r) => presses.push(r), onWarning: (e) => errors.push(e.message) });
    const socket = await startReadySession(bridge);
    socket.emit('message', JSON.stringify({ type: 'session.input_transcript.delta', delta: `${phrase}.`, start_ms: 0, end_ms: 500 }));
    socket.emit('message', JSON.stringify({ type: 'response.event', delegation_id: 'item_1', event: { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_1', name: 'press_digit', arguments: JSON.stringify({ digit, heard_option: phrase }) } } }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(presses, [], phrase);
    assert.match(errors[0], /consequential IVR option is blocked/i, phrase);
    bridge.close();
  }
});

test('ignores late digit tools after timeout shutdown has started', async () => {
  const presses = [];
  const bridge = makeBridge({ smartIvr: true, onPressDigit: async (r) => presses.push(r) });
  const socket = await startReadySession(bridge);
  socket.emit('message', JSON.stringify({ type: 'session.input_transcript.delta', delta: 'For English press 1.', start_ms: 0, end_ms: 500 }));
  bridge._endCall('inactivity');
  socket.emit('message', JSON.stringify({ type: 'response.event', delegation_id: 'item_1', event: { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_1', name: 'press_digit', arguments: '{"digit":"1","heard_option":"For English press 1"}' } } }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(presses, []);
  assert.equal(bridge.endReason, 'inactivity');
});

test('blocks consequential IVR choices even when transcript and digit agree', async () => {
  const presses = [];
  const errors = [];
  const bridge = makeBridge({
    smartIvr: true,
    onPressDigit: async (request) => presses.push(request),
    onWarning: (error) => errors.push(error.message)
  });
  const socket = await startReadySession(bridge);
  socket.emit('message', JSON.stringify({ type: 'session.input_transcript.delta', delta: 'To cancel your appointment, press 3.', start_ms: 0, end_ms: 500 }));
  socket.emit('message', JSON.stringify({
    type: 'response.event', delegation_id: 'item_1',
    event: { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_1', name: 'press_digit', arguments: '{"digit":"3","heard_option":"To cancel your appointment, press 3"}' } }
  }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(presses, []);
  assert.match(errors[0], /consequential IVR option is blocked/i);
});

test('blocks consequential IVR context when the claimed option is shortened to the key phrase', async () => {
  const presses = [];
  const errors = [];
  const bridge = makeBridge({
    smartIvr: true,
    onPressDigit: async (request) => presses.push(request),
    onWarning: (error) => errors.push(error.message)
  });
  const socket = await startReadySession(bridge);
  socket.emit('message', JSON.stringify({ type: 'session.input_transcript.delta', delta: 'To cancel your appointment, press 3.', start_ms: 0, end_ms: 500 }));
  socket.emit('message', JSON.stringify({
    type: 'response.event', delegation_id: 'item_1',
    event: { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_1', name: 'press_digit', arguments: '{"digit":"3","heard_option":"press 3"}' } }
  }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(presses, []);
  assert.match(errors[0], /consequential IVR option is blocked/i);
});

test('blocks consequential IVR context split across adjacent transcript entries', async () => {
  const presses = [];
  const errors = [];
  const bridge = makeBridge({ smartIvr: true, onPressDigit: async (request) => presses.push(request), onWarning: (error) => errors.push(error.message) });
  const socket = await startReadySession(bridge);
  socket.emit('message', JSON.stringify({ type: 'session.input_transcript.delta', delta: 'To cancel your appointment,', start_ms: 0, end_ms: 200 }));
  socket.emit('message', JSON.stringify({ type: 'session.input_transcript.delta', delta: 'press 3.', start_ms: 1000, end_ms: 1300 }));
  socket.emit('message', JSON.stringify({
    type: 'response.event', delegation_id: 'item_1',
    event: { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_1', name: 'press_digit', arguments: '{"digit":"3","heard_option":"press 3"}' } }
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(presses, []);
  assert.match(errors[0], /consequential IVR option is blocked/i);
});

test('accepts a full safe IVR option after an unrelated consequential menu entry', async () => {
  const presses = [];
  const bridge = makeBridge({ smartIvr: true, onPressDigit: async (request) => presses.push(request) });
  const socket = await startReadySession(bridge);
  socket.emit('message', JSON.stringify({ type: 'session.input_transcript.delta', delta: 'To cancel your appointment, press 3.', start_ms: 0, end_ms: 200 }));
  socket.emit('message', JSON.stringify({ type: 'session.input_transcript.delta', delta: 'For English, press 1.', start_ms: 1000, end_ms: 1300 }));
  socket.emit('message', JSON.stringify({
    type: 'response.event', delegation_id: 'item_1',
    event: { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_1', name: 'press_digit', arguments: '{"digit":"1","heard_option":"For English, press 1."}' } }
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(presses.length, 1);
  assert.equal(presses[0].digit, '1');
});

test('executes a completed press_digit function call once and marks the bridge for IVR handoff', async () => {
  const presses = [];
  let endMeta;
  const bridge = makeBridge({
    smartIvr: true,
    onPressDigit: async (request) => { presses.push(request); },
    onEnd: (transcript, meta) => { endMeta = meta; }
  });
  const socket = await startReadySession(bridge);
  socket.emit('message', JSON.stringify({ type: 'session.input_transcript.delta', delta: 'To continue in English, press 1.', start_ms: 0, end_ms: 500 }));
  const envelope = {
    type: 'response.event',
    delegation_id: 'item_delegation_1',
    event: {
      type: 'response.output_item.done',
      item: { type: 'function_call', call_id: 'call_1', name: 'press_digit', arguments: '{"digit":"1","heard_option":"To continue in English, press 1."}' }
    }
  };

  socket.emit('message', JSON.stringify(envelope));
  socket.emit('message', JSON.stringify(envelope));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(presses.length, 1);
  assert.equal(presses[0].digit, '1');
  assert.equal(presses[0].heardOption, 'To continue in English, press 1.');
  assert.equal(presses[0].callSid, 'CAtest');
  assert.equal(presses[0].transcript.some((item) => item.text.includes('English')), true);
  assert.equal(bridge.endReason, 'ivr_dtmf');

  socket.emit('close', 1000, Buffer.from('handoff'));
  assert.equal(endMeta.endReason, 'ivr_dtmf');
});
