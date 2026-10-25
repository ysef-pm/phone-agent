const WebSocket = require('ws');

const LIVE_URL = 'wss://api.openai.com/v1/live/sessions';
const DEFAULT_OPENING = "Hi, this is Min, Youssef Hounat's assistant. I'm calling on his behalf.";
const BLOCKED_IVR_ACTION = /\b(cancel|cancellation|cancellations|book|booking|bookings|schedule|reschedule|pay|payment|payments|purchase|delete|terminate|appointment|appointments|annuleren|annulering|annuleringen|boeken|boeking|boekingen|betalen|betaling|betalingen|verwijderen|beëindigen|wijzigen|verplaatsen|afspraak|afspraken)\b|\b(make|move|change|maak|maken|verplaats|wijzig)\b.{0,40}\b(appointment|appointments|afspraak|afspraken)\b|\b(appointment|appointments|afspraak|afspraken)\b.{0,40}\b(make|move|change|maak|maken|verplaats|wijzig)\b/i;
const AUTOMATED_AUDIO = /\b(press|dial|select|choose|menu|option|hold|queue|recorded|recording|automated|stay on the line|your call is important|thank you for calling|welcome to|hello and welcome|calls? may be recorded|opening hours|please wait|wait while|connect your call|monitored|training purposes|quality purposes|unavailable|not available|say one|druk|toets|kies|keuzemenu|ogenblik geduld|moment geduld|aan de lijn|welkom bij|openingstijden|zegt u)\b/i;
const HUMAN_GREETING = /\b(hello|hi|good morning|good afternoon|good evening|front desk|reception|receptie|how may i help|how can i help|speaking|goedemorgen|goedemiddag|goedenmiddag|goedenavond|kan ik u helpen)\b/i;
const HIGH_CONFIDENCE_HUMAN_GREETING = /\b(front desk|reception|receptie|how may i help|how can i help|speaking|kan ik u helpen)\b|^(?:good morning|good afternoon|good evening|goedemorgen|goedemiddag|goedenmiddag|goedenavond)\s+\S+/i;

function normalizeIvrText(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function findTranscriptContext(entries, claim, { before = 80, after = 80 } = {}) {
  const normalizedClaim = normalizeIvrText(claim);
  if (!normalizedClaim) return null;
  const needle = ` ${normalizedClaim} `;
  const haystack = ` ${entries.map((entry) => normalizeIvrText(entry?.text)).filter(Boolean).join(' ')} `;
  const index = haystack.lastIndexOf(needle);
  if (index < 0) return null;
  return haystack.slice(
    Math.max(0, index - before),
    Math.min(haystack.length, index + needle.length + after)
  );
}

function optionMentionsDigit(text, digit) {
  const normalized = normalizeIvrText(text);
  const words = {
    '0': ['0', 'zero', 'nul'],
    '1': ['1', 'one'],
    '2': ['2', 'two', 'twee'],
    '3': ['3', 'three', 'drie'],
    '4': ['4', 'four', 'vier'],
    '5': ['5', 'five', 'vijf'],
    '6': ['6', 'six', 'zes'],
    '7': ['7', 'seven', 'zeven'],
    '8': ['8', 'eight', 'acht'],
    '9': ['9', 'nine', 'negen'],
    '*': ['star', 'asterisk', 'ster'],
    '#': ['hash', 'pound', 'hekje']
  };
  const alternatives = (words[digit] || []).join('|');
  if (!alternatives) return false;
  const keyPhrase = new RegExp(`\\b(?:press|druk|toets|kies)(?:\\s+op)?(?:\\s+toets)?\\s+(?:${alternatives})\\b`, 'i');
  return keyPhrase.test(normalized);
}

class GPTLiveBridge {
  constructor({
    apiKey,
    taskPrompt,
    callSid,
    model = 'gpt-live-1',
    backendModel = 'gpt-5.6-luna',
    voice = 'willow',
    opening = DEFAULT_OPENING,
    WebSocketImpl = WebSocket,
    closeGraceMs = 15000,
    connectTimeoutMs = 10000,
    inactivityTimeoutMs = 15000,
    maxCallMs = 10 * 60 * 1000,
    maxBufferedAudioFrames = 50,
    smartIvr = false,
    ivrHistory = [],
    onPressDigit,
    onConversationStart,
    onTranscript,
    onAgentResponse,
    onWarning,
    onError,
    onEnd
  }) {
    this.apiKey = apiKey;
    this.taskPrompt = taskPrompt;
    this.callSid = callSid;
    this.model = model;
    this.backendModel = backendModel;
    this.voice = voice;
    this.opening = opening;
    this.WebSocketImpl = WebSocketImpl;
    this.closeGraceMs = closeGraceMs;
    this.connectTimeoutMs = connectTimeoutMs;
    this.inactivityTimeoutMs = inactivityTimeoutMs;
    this.maxCallMs = maxCallMs;
    this.smartIvr = Boolean(smartIvr);
    this.maxBufferedAudioFrames = this.smartIvr
      ? Math.max(maxBufferedAudioFrames, 250)
      : maxBufferedAudioFrames;
    this.ivrHistory = Array.isArray(ivrHistory) ? ivrHistory.slice(-40) : [];
    this.onPressDigit = onPressDigit || (async () => {});
    this.onConversationStart = onConversationStart || (() => {});
    this.onTranscript = onTranscript || (() => {});
    this.onAgentResponse = onAgentResponse || (() => {});
    this.onWarning = onWarning || (() => {});
    this.onError = onError || (() => {});
    this.onEnd = onEnd || (() => {});
    this.liveWs = null;
    this.twilioWs = null;
    this.streamSid = null;
    this.sessionReady = false;
    this.sessionId = null;
    this.fragments = [];
    this.finalized = false;
    this.closing = false;
    this.closeTimer = null;
    this.connectTimer = null;
    this.connectionPromise = null;
    this.resolveConnection = null;
    this.rejectConnection = null;
    this.pendingAudio = [];
    this.endReason = null;
    this.inactivityTimer = null;
    this.maxCallTimer = null;
    this.handledToolCalls = new Set();
    this.handoffStarted = false;
    this.conversationStarted = false;
  }

  connect() {
    if (this.connectionPromise) return this.connectionPromise;
    this.connectionPromise = new Promise((resolve, reject) => {
      this.resolveConnection = resolve;
      this.rejectConnection = reject;
    });

    this.liveWs = new this.WebSocketImpl(LIVE_URL, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'User-Agent': 'min-phone-agent-v1/gpt-live-pilot'
      }
    });

    this.liveWs.on('open', () => {
      if (this.closing || this.finalized) {
        this.liveWs.terminate?.();
        return;
      }
      this._startSession();
    });
    this.liveWs.on('message', (data) => {
      try {
        this._handleMessage(JSON.parse(data.toString()));
      } catch (error) {
        if (!this.finalized) {
          this._rejectConnection(error);
          this.onError(error);
          this.close();
        }
      }
    });
    this.liveWs.on('error', (error) => {
      this._rejectConnection(error);
      this.onError(error);
    });
    this.liveWs.on('close', () => {
      if (!this.sessionReady) {
        this._rejectConnection(new Error('GPT-Live closed before session start'));
      }
      if (!this.closing && this._twilioOpen()) {
        this.twilioWs.close(1011, 'Voice provider disconnected');
      }
      this._finalize();
    });

    this.connectTimer = setTimeout(() => {
      const error = new Error('GPT-Live session start timed out');
      this._rejectConnection(error);
      this.onError(error);
      this.liveWs?.terminate?.();
    }, this.connectTimeoutMs);
    this.connectTimer.unref?.();
    return this.connectionPromise;
  }

  _startSession() {
    if (this.closing || this.finalized) return;
    const ivrInstructions = this.smartIvr ? [
      'SMART IVR MODE: stay silent while an automated phone menu, recorded announcement, or hold music is playing.',
      'Listen to the complete menu before choosing. Never speak a digit aloud to an IVR.',
      'When one exact numbered option clearly advances the call task, delegate to press_digit with that single digit and the verbatim option you heard.',
      'When a live human gives a direct greeting, delegate to begin_conversation with that verbatim greeting. Do not use it for recordings, menus, hold messages, queues, or music.',
      'Never guess a key. Never select booking, cancellation, payment, or another consequential action unless the call task explicitly authorizes it.',
      'Remain silent until begin_conversation is accepted by the application.'
    ] : [];
    const historyText = this.ivrHistory.length
      ? `Prior IVR handoff context: ${JSON.stringify(this.ivrHistory.slice(-3))}`
      : '';
    const responseTools = [{ type: 'web_search' }];
    const responseInstructions = [
      'Support a live telephone assistant with current, verifiable information.',
      'Use web search for restaurant menus, official restaurant pages, opening details, and other current facts.',
      ...(this.smartIvr ? [
        'For an automated phone menu, use press_digit only after the complete menu clearly associates an allowed digit with the chosen option. Never guess.',
        'When a live human directly greets or addresses the caller, you must call begin_conversation with the verbatim greeting. Do not answer the human directly and do not return spoken text while smart IVR mode is active.'
      ] : []),
      'Prefer official sources. Return concise facts suitable for speech and clearly state uncertainty.',
      'Never claim an external action succeeded unless the application confirms it.'
    ].join('\n');
    if (this.smartIvr) {
      responseTools.push({
        type: 'function',
        name: 'press_digit',
        description: 'Press exactly one DTMF key on the current phone call after its spoken menu option has been heard and verified.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            digit: { type: 'string', enum: ['0','1','2','3','4','5','6','7','8','9','*','#'] },
            heard_option: { type: 'string', description: 'The verbatim spoken menu option associated with this key.' }
          },
          required: ['digit', 'heard_option']
        },
        strict: true
      });
      responseTools.push({
        type: 'function',
        name: 'begin_conversation',
        description: 'Leave silent IVR mode only after a live human directly greets or addresses the caller. Never use for a recording, menu, queue, hold message, or music.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            heard_greeting: { type: 'string', description: 'The verbatim live-human greeting just heard.' }
          },
          required: ['heard_greeting']
        },
        strict: true
      });
    }
    this._send({
      type: 'session.start',
      session: {
        model: this.model,
        instructions: [
          'You are Min, Youssef Hounat\'s AI assistant, speaking on a telephone call.',
          'Always identify yourself as an AI assistant acting on Youssef\'s behalf; never impersonate him.',
          'Be concise, natural, and patient with pauses, interruptions, background noise, IVRs, and hold music.',
          'Do not disclose secrets or agree to payments, contracts, or sensitive actions.',
          'Delegate requests requiring current restaurant or menu information to the backend web search.',
          ...ivrInstructions,
          historyText,
          `Call task: ${this.taskPrompt}`
        ].filter(Boolean).join('\n'),
        audio: {
          format: { type: 'audio/pcmu', rate: 8000 },
          output: { voice: this.voice }
        },
        delegation: {
          type: 'responses',
          responses: {
            model: this.backendModel,
            instructions: responseInstructions,
            tools: responseTools,
            parallel_tool_calls: false,
            tool_choice: 'auto'
          }
        }
      }
    });
  }

  _handleMessage(event) {
    switch (event.type) {
      case 'session.started':
        this.sessionReady = true;
        this.sessionId = event.session?.id || null;
        clearTimeout(this.connectTimer);
        this.resolveConnection?.();
        this.resolveConnection = null;
        this.rejectConnection = null;
        if (!this.smartIvr) {
          this._send({
            type: 'session.instructions.append',
            delegation_id: null,
            content: `Your first spoken line must identify you clearly. Begin with: "${this.opening}" Then briefly state the call task and listen.`
          });
          this._send({
            type: 'session.commentary.append',
            delegation_id: null,
            content: this.opening
          });
        }
        for (const audio of this.pendingAudio.splice(0)) {
          this._send({ type: 'session.input_audio.append', audio });
        }
        this._startIdleTimers();
        break;

      case 'session.output_audio.delta':
        if (!this.smartIvr && event.delta && this._twilioOpen()) {
          this.twilioWs.send(JSON.stringify({
            event: 'media',
            streamSid: this.streamSid,
            media: { payload: event.delta }
          }));
        }
        break;

      case 'session.input_transcript.delta':
        this._resetInactivityTimer();
        this._addFragment('user', event);
        this.onTranscript(event.delta || '');
        break;

      case 'session.output_transcript.delta':
        this._resetInactivityTimer();
        if (this.smartIvr && event.delta) this._handleDirectResponseFallback();
        this._addFragment('agent', event);
        this.onAgentResponse(event.delta || '');
        break;

      case 'response.event':
        this._handleResponseEvent(event);
        break;

      case 'session.closed':
        this._finalize();
        if (this.liveWs && this.liveWs.readyState === this.WebSocketImpl.OPEN) {
          this.liveWs.close();
        }
        break;

      case 'error': {
        const message = event.error?.message || 'Unknown GPT-Live error';
        const error = new Error(message);
        error.code = event.error?.code;
        this._rejectConnection(error);
        this.onError(error);
        this.close();
        break;
      }
    }
  }

  _handleResponseEvent(envelope) {
    const event = envelope?.event;
    const item = event?.item;
    if (event?.type !== 'response.output_item.done' || item?.type !== 'function_call') return;
    if (item?.name === 'begin_conversation') {
      this._handleConversationStart(item, envelope);
      return;
    }
    if (item?.name !== 'press_digit') return;
    if (!this.smartIvr || this.closing || this.finalized || this.endReason !== null ||
        !item.call_id || this.handledToolCalls.has(item.call_id) || this.handoffStarted) return;

    let args;
    try {
      args = JSON.parse(item.arguments || '{}');
    } catch {
      return;
    }
    if (!/^[0-9*#]$/.test(args.digit || '') || typeof args.heard_option !== 'string' || !args.heard_option.trim()) return;

    const transcript = this._buildTranscript();
    const recentCallerEntries = transcript
      .filter((entry) => entry.role === 'user')
      .slice(-6);
    const claimedOption = normalizeIvrText(args.heard_option);
    const optionIsShort = claimedOption.split(' ').length <= 3;
    const optionContext = findTranscriptContext(recentCallerEntries, args.heard_option, {
      before: optionIsShort ? 160 : 0,
      after: optionIsShort ? 60 : 0
    });
    if (claimedOption.length < 4 || !optionContext) {
      this.onWarning(new Error('Claimed IVR option was not found in recent IVR transcript'));
      return;
    }
    if (!optionMentionsDigit(args.heard_option, args.digit)) {
      this.onWarning(new Error('Selected digit does not match the key stated in the IVR option'));
      return;
    }
    if (BLOCKED_IVR_ACTION.test(optionContext)) {
      this.onWarning(new Error('Consequential IVR option is blocked in smart navigation mode'));
      return;
    }

    this.handledToolCalls.add(item.call_id);
    this.handoffStarted = true;
    this.endReason = 'ivr_dtmf';
    this._clearIdleTimers();
    const request = {
      callSid: this.callSid,
      digit: args.digit,
      heardOption: args.heard_option.trim().slice(0, 500),
      callId: item.call_id,
      delegationId: envelope.delegation_id || null,
      transcript
    };
    Promise.resolve(this.onPressDigit(request)).then(() => {
      this.close();
    }).catch((error) => {
      this.endReason = 'ivr_dtmf_failed';
      this.onError(error);
    });
  }

  _handleConversationStart(item, envelope) {
    if (!this.smartIvr || this.conversationStarted || this.closing || this.finalized ||
        this.endReason !== null || this.handoffStarted || !item.call_id ||
        this.handledToolCalls.has(item.call_id)) return;

    let args;
    try {
      args = JSON.parse(item.arguments || '{}');
    } catch {
      return;
    }
    if (typeof args.heard_greeting !== 'string' || !args.heard_greeting.trim()) return;

    const transcript = this._buildTranscript();
    const recentCallerEntries = transcript
      .filter((entry) => entry.role === 'user')
      .slice(-4);
    const claimedGreeting = normalizeIvrText(args.heard_greeting);
    const greetingIsShort = claimedGreeting.split(' ').length <= 3;
    const greetingContext = findTranscriptContext(recentCallerEntries, args.heard_greeting, {
      before: greetingIsShort ? 24 : 0,
      after: greetingIsShort ? 160 : 0
    });
    if (claimedGreeting.length < 4 || !greetingContext) {
      this.onWarning(new Error('Claimed live-human greeting was not found in recent transcript'));
      return;
    }
    if (AUTOMATED_AUDIO.test(greetingContext) ||
        !HIGH_CONFIDENCE_HUMAN_GREETING.test(claimedGreeting)) {
      this.onWarning(new Error('Live-human greeting could not be verified'));
      return;
    }

    this.handledToolCalls.add(item.call_id);
    this._startConversation({
      heardGreeting: args.heard_greeting.trim().slice(0, 500),
      callId: item.call_id,
      delegationId: envelope.delegation_id || null
    });
  }

  _handleDirectResponseFallback() {
    if (!this.smartIvr || this.conversationStarted || this.closing || this.finalized ||
        this.endReason !== null || this.handoffStarted) return;

    const callerEntries = this._buildTranscript()
      .filter((entry) => entry.role === 'user')
      .slice(-4);
    if (callerEntries.length < 2) return;

    const latestTwo = callerEntries.slice(-2);
    const normalizedEntries = latestTwo.map((entry) => normalizeIvrText(entry.text));
    if (normalizedEntries.some((text) => AUTOMATED_AUDIO.test(text) || !HUMAN_GREETING.test(text))) return;

    const greeting = latestTwo.map((entry) => entry.text.trim()).filter(Boolean).join(' ');
    const normalizedGreeting = normalizeIvrText(greeting);
    if (!HIGH_CONFIDENCE_HUMAN_GREETING.test(normalizedGreeting)) return;

    this._startConversation({
      heardGreeting: greeting.slice(0, 500),
      callId: null,
      delegationId: null
    });
  }

  _startConversation({ heardGreeting, callId, delegationId }) {
    if (!this.smartIvr || this.conversationStarted || this.closing || this.finalized ||
        this.endReason !== null || this.handoffStarted) return;
    this.conversationStarted = true;
    this.smartIvr = false;
    this._resetInactivityTimer();
    this.onConversationStart({
      callSid: this.callSid,
      heardGreeting,
      callId,
      delegationId
    });
    this._send({
      type: 'session.instructions.append',
      delegation_id: null,
      content: `A live human has now addressed you. Speak naturally and complete the call task. Your first spoken line must identify you clearly. Begin with: "${this.opening}"`
    });
    this._send({
      type: 'session.commentary.append',
      delegation_id: null,
      content: this.opening
    });
  }

  _rejectConnection(error) {
    if (!this.rejectConnection) return;
    clearTimeout(this.connectTimer);
    this.rejectConnection(error);
    this.resolveConnection = null;
    this.rejectConnection = null;
  }

  _startIdleTimers() {
    this._resetInactivityTimer();
    if (this.maxCallMs > 0) {
      this.maxCallTimer = setTimeout(() => this._endCall('max_duration'), this.maxCallMs);
      this.maxCallTimer.unref?.();
    }
  }

  _resetInactivityTimer() {
    if (this.finalized || this.closing) return;
    clearTimeout(this.inactivityTimer);
    this.inactivityTimer = null;
    // IVR menus, transfer announcements, queues, and hold music can contain
    // long silent gaps. The hard max-call timer still bounds the call; start
    // conversational inactivity enforcement only after a human is verified.
    if (this.smartIvr && !this.conversationStarted) return;
    if (this.inactivityTimeoutMs > 0) {
      this.inactivityTimer = setTimeout(() => this._endCall('inactivity'), this.inactivityTimeoutMs);
      this.inactivityTimer.unref?.();
    }
  }

  _clearIdleTimers() {
    clearTimeout(this.inactivityTimer);
    clearTimeout(this.maxCallTimer);
  }

  // Ends the call for an application-decided reason (idle/timeout) by requesting
  // a graceful GPT-Live close, which drives _finalize -> onEnd -> Twilio hangup.
  _endCall(reason) {
    if (this.finalized || this.closing || this.handoffStarted) return;
    this.endReason = reason;
    this.close();
  }

  _addFragment(role, event) {
    if (!event.delta) return;
    this.fragments.push({
      role,
      text: event.delta,
      audioSuppressed: role === 'agent' && this.smartIvr,
      startMs: Number(event.start_ms || 0),
      endMs: Number(event.end_ms || event.start_ms || 0),
      sequence: this.fragments.length
    });
  }

  _buildTranscript() {
    const segments = [];
    const lastByRole = new Map();
    const ordered = [...this.fragments].sort(
      (a, b) => a.startMs - b.startMs || a.sequence - b.sequence
    );

    for (const fragment of ordered) {
      let segment = lastByRole.get(fragment.role);
      if (!segment || fragment.startMs - segment.endMs > 600 || segment.audioSuppressed !== fragment.audioSuppressed) {
        segment = {
          role: fragment.role,
          text: '',
          audioSuppressed: fragment.audioSuppressed,
          startMs: fragment.startMs,
          endMs: fragment.endMs
        };
        segments.push(segment);
        lastByRole.set(fragment.role, segment);
      }
      segment.text += fragment.text;
      segment.endMs = Math.max(segment.endMs, fragment.endMs);
    }

    return segments
      .sort((a, b) => a.startMs - b.startMs)
      .map(({ role, text, audioSuppressed }) => ({ role, text, ...(audioSuppressed ? { audioSuppressed: true } : {}) }))
      .filter((item) => item.text);
  }

  _send(event) {
    if (this.liveWs?.readyState === this.WebSocketImpl.OPEN) {
      this.liveWs.send(JSON.stringify(event));
      return true;
    }
    return false;
  }

  _twilioOpen() {
    return this.streamSid && this.twilioWs?.readyState === this.WebSocketImpl.OPEN;
  }

  setTwilioStream(twilioWs, streamSid) {
    this.twilioWs = twilioWs;
    this.streamSid = streamSid;
  }

  sendAudio(base64MulawAudio) {
    if (this.finalized || this.closing) return false;
    if (!this.sessionReady) {
      if (this.pendingAudio.length >= this.maxBufferedAudioFrames) this.pendingAudio.shift();
      this.pendingAudio.push(base64MulawAudio);
      return true;
    }
    return this._send({
      type: 'session.input_audio.append',
      audio: base64MulawAudio
    });
  }

  close() {
    if (this.finalized) return;
    this.closing = true;
    if (this.sessionReady && this._send({ type: 'session.close' })) {
      clearTimeout(this.closeTimer);
      this.closeTimer = setTimeout(() => {
        this._finalize();
        if (this.liveWs?.terminate) this.liveWs.terminate();
      }, this.closeGraceMs);
      this.closeTimer.unref?.();
      return;
    }

    this._finalize();
    if (!this.liveWs) return;
    if (this.liveWs.readyState === this.WebSocketImpl.OPEN) this.liveWs.close();
    else this.liveWs.terminate?.();
  }

  _finalize() {
    if (this.finalized) return;
    this.finalized = true;
    clearTimeout(this.closeTimer);
    clearTimeout(this.connectTimer);
    this._clearIdleTimers();
    this.pendingAudio = [];
    this.onEnd(this._buildTranscript(), {
      provider: 'gpt-live',
      sessionId: this.sessionId,
      endReason: this.endReason
    });
  }
}

module.exports = { GPTLiveBridge, LIVE_URL, DEFAULT_OPENING };
