/*
 * Execution engine that mirrors cpp/arq_simulator.cpp statement by statement.
 * It produces the exact stdout of the compiled program together with an
 * execution trace (source line anchors, variable snapshots and channel
 * events) that drives the editor highlighting and the animations.
 */
(function (root) {
  'use strict';

  const PROPAGATION_DELAY = 2;
  const TIMEOUT_INTERVAL = 6;
  const MAX_FRAMES = 64;
  const MAX_SEQ_BITS = 8;
  const MAX_SIM_TIME = 100000;

  const FRAME_ARRIVAL = 0;
  const ACK_ARRIVAL = 1;
  const TIMER_EXPIRY = 2;

  const PROTOCOL_NAMES = { 1: 'Stop-and-Wait', 2: 'Go-Back-N', 3: 'Selective Repeat' };

  const pad = (n, w) => String(n).padStart(w, ' ');

  function atoi(text) {
    const v = parseInt(String(text), 10);
    return Number.isNaN(v) ? 0 : v;
  }

  function parseList(text) {
    const cleaned = String(text || '').replace(/[^0-9]/g, ' ').trim();
    if (!cleaned) return [];
    return [...new Set(cleaned.split(/\s+/).map(Number))].sort((a, b) => a - b);
  }

  class Trace {
    constructor() {
      this.steps = [];
      this.stdout = '';
    }
    push(step) {
      if (step.out) this.stdout += step.out;
      this.steps.push(step);
    }
  }

  /* ------------------------------ ARQProtocol ------------------------------ */
  class ARQProtocol {
    constructor(cfg, trace, scope) {
      this.cfg = Object.assign({}, cfg, {
        lostFrames: new Set(cfg.lostFrames),
        lostAcks: new Set(cfg.lostAcks)
      });
      this.trace = trace;
      this.scope = scope;
      this.N = cfg.totalFrames;
      this.stats = {
        transmissions: 0, retransmissions: 0, delivered: 0, discarded: 0,
        framesLost: 0, acksLost: 0, timeouts: 0, totalTime: 0
      };
      this.channel = [];
      this.sendCount = new Array(this.N).fill(0);
      this.clock = 0;
      this.seqSpace = 1 << cfg.seqBits;
      this.nextTimerId = 1;
      this.timerInfo = {};          // timer id -> { frame, start }
      this.expired = new Set();     // frames waiting to be resent (visual only)
    }

    seqOf(frame) { return frame % this.seqSpace; }
    A(snippet) { return this.scope + '|' + snippet; }

    emit(step) {
      step.clock = this.clock;
      step.snap = this.snapshot();
      this.trace.push(step);
    }

    at(anchor, extra) {
      this.emit(Object.assign({ anchor, kind: 'line' }, extra || {}));
    }

    print(text, anchor, kind) {
      this.emit({ out: text, anchor, kind: kind || 'print' });
    }

    log(who, msg, anchor, viz) {
      const text = '[t=' + pad(this.clock, 3) + '] ' + who.padEnd(8, ' ') + ' : ' + msg + '\n';
      this.emit({ out: text, anchor, viz, who, kind: 'log' });
    }

    transmitFrame(frame, anchor) {
      const isRetransmission = this.sendCount[frame] > 0;
      this.sendCount[frame]++;
      this.stats.transmissions++;
      if (isRetransmission) this.stats.retransmissions++;

      const lost = this.cfg.lostFrames.has(frame);
      if (lost) this.cfg.lostFrames.delete(frame);
      this.expired.delete(frame);

      const seq = this.seqOf(frame);
      this.channel.push({ time: this.clock + PROPAGATION_DELAY, type: FRAME_ARRIVAL, frame, ackNo: seq, lost, timerId: 0 });
      this.log('SENDER', 'Frame ' + frame + ' (seq ' + seq + ') ' + (isRetransmission ? 'retransmitted' : 'transmitted'),
        anchor, { type: 'frame', frame, seq, from: this.clock, to: this.clock + PROPAGATION_DELAY, lost, retrans: isRetransmission });
    }

    transmitAck(frame, ackNo, anchor) {
      const lost = this.cfg.lostAcks.has(frame);
      if (lost) this.cfg.lostAcks.delete(frame);

      this.channel.push({ time: this.clock + PROPAGATION_DELAY, type: ACK_ARRIVAL, frame, ackNo, lost, timerId: 0 });
      this.log('RECEIVER', 'ACK ' + ackNo + ' generated for Frame ' + frame,
        anchor, { type: 'ack', frame, ackNo, from: this.clock, to: this.clock + PROPAGATION_DELAY, lost });
    }

    startTimer(frame) {
      const id = this.nextTimerId;
      this.channel.push({ time: this.clock + TIMEOUT_INTERVAL, type: TIMER_EXPIRY, frame, ackNo: 0, lost: false, timerId: id });
      this.timerInfo[id] = { frame, start: this.clock };
      this.nextTimerId++;
      return id;
    }

    windowText(base, size) {
      if (base >= this.N) return 'all frames acknowledged';
      const last = Math.min(base + size, this.N) - 1;
      return 'window slides to Frames ' + base + '-' + last;
    }

    processEvents() {
      const due = [];
      const pending = [];
      for (const e of this.channel) (e.time === this.clock ? due : pending).push(e);
      this.channel = pending;

      for (const e of due) {
        if (e.type === FRAME_ARRIVAL) {
          if (e.lost) {
            this.stats.framesLost++;
            this.log('CHANNEL', 'Frame ' + e.frame + ' lost - frame loss detected',
              'ARQProtocol|log("CHANNEL", "Frame "', { type: 'frameLost', frame: e.frame });
          } else {
            this.at('ARQProtocol|receiveFrame(e.frame);');
            this.receiveFrame(e.frame);
          }
        } else if (e.type === ACK_ARRIVAL) {
          if (e.lost) {
            this.stats.acksLost++;
            this.log('CHANNEL', 'ACK ' + e.ackNo + ' for Frame ' + e.frame + ' lost',
              'ARQProtocol|log("CHANNEL", "ACK "', { type: 'ackLost', frame: e.frame });
          } else {
            this.at('ARQProtocol|receiveAck(e.frame, e.ackNo);');
            this.receiveAck(e.frame, e.ackNo);
          }
        }
      }
      for (const e of due) {
        if (e.type === TIMER_EXPIRY) this.onTimeout(e.frame, e.timerId);
      }
    }

    timer(id) {
      if (!id) return null;
      const info = this.timerInfo[id];
      return { frame: info.frame, start: info.start, end: info.start + TIMEOUT_INTERVAL };
    }

    run() {
      const P = 'ARQProtocol|';
      this.print('Protocol: ' + this.name() + '\n', P + 'cout << "Protocol: "');
      this.print('Sequence numbers: 0-' + (this.seqSpace - 1) + ' (m = ' + this.cfg.seqBits + ')\n', P + 'cout << "Sequence numbers: 0-"');
      this.print('Sender window: ' + this.cfg.senderWindow + ' | Receiver window: ' + this.cfg.receiverWindow + '\n', P + 'cout << "Sender window: "');
      this.print('Propagation delay: ' + PROPAGATION_DELAY + ' | Timeout: ' + TIMEOUT_INTERVAL + ' (time units)\n\n', P + 'cout << "Propagation delay: "');

      while (this.clock <= MAX_SIM_TIME) {
        this.emit({ anchor: P + 'processEvents();', kind: 'tick' });
        this.processEvents();
        if (this.finished()) {
          this.at(P + 'if (finished()) break;');
          break;
        }
        this.sendNext();
        this.clock++;
      }
      this.stats.totalTime = this.clock;
      this.printSummary();
    }

    printSummary() {
      const s = this.stats;
      const scaled = s.transmissions > 0
        ? Math.floor((20000 * s.delivered + s.transmissions) / (2 * s.transmissions)) : 0;
      const eff = Math.floor(scaled / 100) + '.' + String(scaled % 100).padStart(2, '0');
      const P = 'ARQProtocol|';
      const rows = [
        ['\n========== PERFORMANCE SUMMARY ==========\n', 'PERFORMANCE SUMMARY'],
        ['Protocol                      : ' + this.name() + '\n', 'cout << "Protocol                      : "'],
        ['Successfully delivered frames : ' + s.delivered + '\n', 'Successfully delivered frames :'],
        ['Total transmission attempts   : ' + s.transmissions + '\n', 'Total transmission attempts'],
        ['Total retransmissions         : ' + s.retransmissions + '\n', 'Total retransmissions'],
        ['Total frames discarded        : ' + s.discarded + '\n', 'Total frames discarded'],
        ['Frames lost in channel        : ' + s.framesLost + '\n', 'Frames lost in channel'],
        ['ACKs lost in channel          : ' + s.acksLost + '\n', 'ACKs lost in channel'],
        ['Timeouts                      : ' + s.timeouts + '\n', 'Timeouts  '],
        ['Total simulated time          : ' + s.totalTime + ' time units\n', 'Total simulated time'],
        ['Efficiency                    : ' + eff + ' %\n', 'Efficiency  ']
      ];
      this.at(P + 'long long scaled', { kind: 'summary' });
      for (const [text, snip] of rows) this.print(text, P + snip, 'summary');
      this.efficiency = Number(eff);
    }

    senderState(i) {
      if (this.isAcked(i)) return 'acked';
      if (this.expired.has(i)) return 'expired';
      if (this.sendCount[i] > 0) return 'out';
      return 'ready';
    }

    snapshot() {
      const sender = [];
      const receiver = [];
      for (let i = 0; i < this.N; i++) {
        sender.push(this.senderState(i));
        receiver.push(this.receiverState(i));
      }
      return Object.assign({ sender, receiver, timers: this.timers(), vars: this.vars() }, this.windows());
    }
  }

  /* ------------------------------ Stop-and-Wait ------------------------------ */
  class StopAndWait extends ARQProtocol {
    constructor(cfg, trace) {
      super(cfg, trace, 'StopAndWait');
      this.current = 0;
      this.waiting = false;
      this.timerId = 0;
      this.expected = 0;
    }
    name() { return 'Stop-and-Wait'; }

    sendNext() {
      if (this.waiting || this.current >= this.N) return;
      this.at(this.A('if (waiting || current >= cfg.totalFrames) return;'));
      this.transmitFrame(this.current, this.A('transmitFrame(current);'));
      this.timerId = this.startTimer(this.current);
      this.waiting = true;
      this.at(this.A('timerId = startTimer(current);'));
    }

    receiveFrame(frame) {
      if (this.seqOf(frame) === this.seqOf(this.expected)) {
        this.stats.delivered++;
        this.expected++;
        this.log('RECEIVER', 'Frame ' + frame + ' received successfully',
          this.A('" received successfully"'), { type: 'rx', frame, result: 'accepted' });
      } else {
        this.stats.discarded++;
        this.log('RECEIVER', 'Duplicate Frame ' + frame + ' discarded',
          this.A('"Duplicate Frame "'), { type: 'rx', frame, result: 'discarded' });
      }
      this.transmitAck(frame, this.seqOf(this.expected), this.A('transmitAck(frame, seqOf(expected));'));
    }

    receiveAck(frame, ackNo) {
      if (this.waiting && ackNo === this.seqOf(this.current + 1)) {
        this.timerId = 0;
        this.waiting = false;
        this.current++;
        this.log('SENDER', 'ACK ' + ackNo + ' received, timer stopped',
          this.A('" received, timer stopped"'), { type: 'ackRx', frame });
      } else {
        this.log('SENDER', 'Duplicate ACK ' + ackNo + ' ignored',
          this.A('"Duplicate ACK "'), { type: 'ackDup', frame });
      }
    }

    onTimeout(frame, id) {
      if (!this.waiting || id !== this.timerId) return;
      this.stats.timeouts++;
      this.expired.add(frame);
      this.timerId = 0;
      this.waiting = false;
      this.log('TIMER', 'Timeout occurred for Frame ' + frame,
        this.A('"Timeout occurred for Frame "'), { type: 'timeout', frame });
      this.log('SENDER', 'Retransmitting current unacknowledged Frame ' + frame,
        this.A('"Retransmitting current unacknowledged Frame "'), { type: 'retransmit', frames: [frame] });
    }

    finished() { return this.current >= this.N; }
    isAcked(i) { return i < this.current; }
    receiverState(i) { return i < this.expected ? 'delivered' : 'empty'; }
    timers() { const t = this.timer(this.timerId); return t ? [t] : []; }
    windows() {
      return { sBase: this.current, sWin: 1, sNext: this.current + (this.waiting ? 1 : 0), rBase: this.expected, rWin: 1 };
    }
    vars() {
      return [
        ['clock', this.clock], ['current', this.current], ['waiting', this.waiting],
        ['timerId', this.timerId], ['expected', this.expected], ['channel.size()', this.channel.length]
      ];
    }
  }

  /* -------------------------------- Go-Back-N -------------------------------- */
  class GoBackN extends ARQProtocol {
    constructor(cfg, trace) {
      super(cfg, trace, 'GoBackN');
      this.base = 0;
      this.nextFrame = 0;
      this.timerId = 0;
      this.expected = 0;
    }
    name() { return 'Go-Back-N'; }

    sendNext() {
      if (this.nextFrame < this.base + this.cfg.senderWindow && this.nextFrame < this.N) {
        this.at(this.A('if (nextFrame < base + cfg.senderWindow'));
        this.transmitFrame(this.nextFrame, this.A('transmitFrame(nextFrame);'));
        if (this.timerId === 0) {
          this.timerId = this.startTimer(this.base);
          this.at(this.A('if (timerId == 0) timerId = startTimer(base);'));
        }
        this.nextFrame++;
      }
    }

    receiveFrame(frame) {
      if (this.seqOf(frame) === this.seqOf(this.expected)) {
        this.stats.delivered++;
        this.expected++;
        this.log('RECEIVER', 'Frame ' + frame + ' received successfully',
          this.A('" received successfully"'), { type: 'rx', frame, result: 'accepted' });
        this.transmitAck(frame, this.seqOf(this.expected), this.A('transmitAck(frame, seqOf(expected));'));
      } else {
        this.stats.discarded++;
        this.log('RECEIVER', 'Out-of-order Frame ' + frame + ' discarded (expecting Frame ' + this.expected + ')',
          this.A('"Out-of-order Frame "'), { type: 'rx', frame, result: 'discarded' });
        if (this.expected > 0) {
          this.transmitAck(this.expected - 1, this.seqOf(this.expected), this.A('if (expected > 0) transmitAck('));
        }
      }
    }

    receiveAck(frame, ackNo) {
      if (frame >= this.base) {
        for (let i = this.base; i <= frame; i++) this.expired.delete(i);
        const oldBase = this.base;
        this.base = frame + 1;
        this.nextFrame = Math.max(this.nextFrame, this.base);
        this.log('SENDER', 'Cumulative ACK ' + ackNo + ' received (Frames up to ' + frame + ' acknowledged)',
          this.A('"Cumulative ACK "'), { type: 'ackRx', frame, from: oldBase });
        if (this.base === this.nextFrame) this.timerId = 0;
        else this.timerId = this.startTimer(this.base);
        this.log('SENDER', this.windowText(this.base, this.cfg.senderWindow),
          this.A('log("SENDER", windowText(base, cfg.senderWindow));'), { type: 'slide' });
      } else {
        this.log('SENDER', 'Duplicate ACK ' + ackNo + ' ignored',
          this.A('"Duplicate ACK "'), { type: 'ackDup', frame });
      }
    }

    onTimeout(frame, id) {
      if (id !== this.timerId) return;
      this.stats.timeouts++;
      const frames = [];
      for (let i = this.base; i < this.nextFrame; i++) { frames.push(i); this.expired.add(i); }
      this.log('TIMER', 'Timeout occurred for Frame ' + this.base,
        this.A('"Timeout occurred for Frame "'), { type: 'timeout', frame: this.base });
      this.log('SENDER', 'Retransmitting outstanding Frames ' + this.base + '-' + (this.nextFrame - 1),
        this.A('"Retransmitting outstanding Frames "'), { type: 'retransmit', frames });
      this.nextFrame = this.base;
      this.timerId = 0;
      this.at(this.A('nextFrame = base;'));
    }

    finished() { return this.base >= this.N; }
    isAcked(i) { return i < this.base; }
    receiverState(i) { return i < this.expected ? 'delivered' : 'empty'; }
    timers() { const t = this.timer(this.timerId); return t ? [t] : []; }
    windows() {
      return { sBase: this.base, sWin: this.cfg.senderWindow, sNext: this.nextFrame, rBase: this.expected, rWin: 1 };
    }
    vars() {
      return [
        ['clock', this.clock], ['base', this.base], ['nextFrame', this.nextFrame],
        ['timerId', this.timerId], ['expected', this.expected], ['channel.size()', this.channel.length]
      ];
    }
  }

  /* ----------------------------- Selective Repeat ----------------------------- */
  class SelectiveRepeat extends ARQProtocol {
    constructor(cfg, trace) {
      super(cfg, trace, 'SelectiveRepeat');
      this.base = 0;
      this.nextFrame = 0;
      this.acked = new Array(this.N).fill(false);
      this.timerIds = new Array(this.N).fill(0);
      this.resendQueue = [];
      this.rcvBase = 0;
      this.buffered = new Array(this.N).fill(false);
    }
    name() { return 'Selective Repeat'; }

    sendNext() {
      while (this.resendQueue.length > 0) {
        const frame = this.resendQueue.shift();
        if (this.acked[frame]) continue;
        this.at(this.A('int frame = resendQueue.front();'));
        this.transmitFrame(frame, this.A('transmitFrame(frame);'));
        this.timerIds[frame] = this.startTimer(frame);
        this.at(this.A('timerIds[frame] = startTimer(frame);'));
        return;
      }
      if (this.nextFrame < this.base + this.cfg.senderWindow && this.nextFrame < this.N) {
        this.at(this.A('if (nextFrame < base + cfg.senderWindow'));
        this.transmitFrame(this.nextFrame, this.A('transmitFrame(nextFrame);'));
        this.timerIds[this.nextFrame] = this.startTimer(this.nextFrame);
        this.at(this.A('timerIds[nextFrame] = startTimer(nextFrame);'));
        this.nextFrame++;
      }
    }

    receiveFrame(frame) {
      const Wr = this.cfg.receiverWindow;
      if (frame >= this.rcvBase && frame < this.rcvBase + Wr) {
        if (this.buffered[frame]) {
          this.stats.discarded++;
          this.log('RECEIVER', 'Duplicate Frame ' + frame + ' discarded',
            this.A('log("RECEIVER", "Duplicate Frame " + str(frame) + " discarded");'), { type: 'rx', frame, result: 'discarded' });
        } else if (frame === this.rcvBase) {
          this.buffered[frame] = true;
          this.log('RECEIVER', 'Frame ' + frame + ' received successfully',
            this.A('" received successfully"'), { type: 'rx', frame, result: 'accepted' });
        } else {
          this.buffered[frame] = true;
          this.log('RECEIVER', 'Out-of-order Frame ' + frame + ' buffered',
            this.A('"Out-of-order Frame "'), { type: 'rx', frame, result: 'buffered' });
        }
        this.transmitAck(frame, this.seqOf(frame), this.A('transmitAck(frame, seqOf(frame));'));
        while (this.rcvBase < this.N && this.buffered[this.rcvBase]) {
          this.stats.delivered++;
          const f = this.rcvBase;
          this.rcvBase++;
          this.log('RECEIVER', 'Frame ' + f + ' delivered to network layer',
            this.A('" delivered to network layer"'), { type: 'deliver', frame: f });
        }
      } else if (frame < this.rcvBase) {
        this.stats.discarded++;
        this.log('RECEIVER', 'Duplicate Frame ' + frame + ' discarded (already delivered)',
          this.A('" discarded (already delivered)"'), { type: 'rx', frame, result: 'discarded' });
        this.transmitAck(frame, this.seqOf(frame), this.A('transmitAck(frame, seqOf(frame));#2'));
      } else {
        this.stats.discarded++;
        this.log('RECEIVER', 'Frame ' + frame + ' outside receiver window discarded',
          this.A('" outside receiver window discarded"'), { type: 'rx', frame, result: 'discarded' });
      }
    }

    receiveAck(frame, ackNo) {
      if (!this.acked[frame]) {
        this.acked[frame] = true;
        this.timerIds[frame] = 0;
        this.expired.delete(frame);
        this.log('SENDER', 'ACK ' + ackNo + ' received for Frame ' + frame + ', timer stopped',
          this.A('" received for Frame "'), { type: 'ackRx', frame });
        if (frame === this.base) {
          while (this.base < this.N && this.acked[this.base]) this.base++;
          this.log('SENDER', this.windowText(this.base, this.cfg.senderWindow),
            this.A('log("SENDER", windowText(base, cfg.senderWindow));'), { type: 'slide' });
        }
      } else {
        this.log('SENDER', 'Duplicate ACK ' + ackNo + ' ignored',
          this.A('"Duplicate ACK "'), { type: 'ackDup', frame });
      }
    }

    onTimeout(frame, id) {
      if (this.acked[frame] || this.timerIds[frame] !== id) return;
      this.stats.timeouts++;
      this.timerIds[frame] = 0;
      this.expired.add(frame);
      this.log('TIMER', 'Timeout occurred for Frame ' + frame,
        this.A('"Timeout occurred for Frame "'), { type: 'timeout', frame });
      this.resendQueue.push(frame);
      this.log('SENDER', 'Selectively retransmitting only Frame ' + frame,
        this.A('"Selectively retransmitting only Frame "'), { type: 'retransmit', frames: [frame] });
    }

    finished() { return this.base >= this.N; }
    isAcked(i) { return this.acked[i]; }
    receiverState(i) {
      if (i < this.rcvBase) return 'delivered';
      return this.buffered[i] ? 'buffered' : 'empty';
    }
    timers() {
      const list = [];
      for (let i = 0; i < this.N; i++) {
        const t = this.timer(this.timerIds[i]);
        if (t) list.push(t);
      }
      return list;
    }
    windows() {
      return {
        sBase: this.base, sWin: this.cfg.senderWindow, sNext: this.nextFrame,
        rBase: this.rcvBase, rWin: this.cfg.receiverWindow
      };
    }
    vars() {
      const buf = [];
      for (let i = this.rcvBase; i < this.N; i++) if (this.buffered[i]) buf.push(i);
      return [
        ['clock', this.clock], ['base', this.base], ['nextFrame', this.nextFrame],
        ['rcvBase', this.rcvBase], ['resendQueue', '{' + this.resendQueue.join(', ') + '}'],
        ['buffer', '{' + buf.join(', ') + '}'], ['channel.size()', this.channel.length]
      ];
    }
  }

  function validateConfig(cfg) {
    if (cfg.totalFrames < 1 || cfg.totalFrames > MAX_FRAMES)
      return 'Number of frames must be between 1 and ' + MAX_FRAMES + '.';
    if (cfg.seqBits < 1 || cfg.seqBits > MAX_SEQ_BITS)
      return 'Sequence number bits must be between 1 and ' + MAX_SEQ_BITS + '.';
    const space = 1 << cfg.seqBits;
    if (cfg.protocol === 2 && (cfg.senderWindow < 1 || cfg.senderWindow > space - 1))
      return 'Go-Back-N requires 1 <= Ws <= 2^m - 1 = ' + (space - 1) + ' (given Ws = ' + cfg.senderWindow + ').';
    if (cfg.protocol === 3) {
      if (cfg.senderWindow < 1 || cfg.senderWindow > space / 2)
        return 'Selective Repeat requires 1 <= Ws <= 2^(m-1) = ' + (space / 2) + ' (given Ws = ' + cfg.senderWindow + ').';
      if (cfg.receiverWindow < 1 || cfg.receiverWindow > space / 2)
        return 'Selective Repeat requires 1 <= Wr <= 2^(m-1) = ' + (space / 2) + ' (given Wr = ' + cfg.receiverWindow + ').';
    }
    return '';
  }

  /*
   * Runs main() with the given stdin answers.
   * input: { protocol, frames, bits, ws, wr, lostFrames, lostAcks } (all as typed by the user)
   */
  function simulate(input) {
    const trace = new Trace();
    const M = 'main|';
    const print = (text, snip, kind) => trace.push({ out: text, anchor: snip ? M + snip : undefined, kind: kind || 'print' });
    const typed = (value) => trace.push({ input: String(value), kind: 'input' });
    const readInt = (prompt, value, snip) => {
      print(prompt, snip, 'prompt');
      typed(value);
      return atoi(value);
    };
    const readList = (prompt, value, snip) => {
      print(prompt, snip, 'prompt');
      typed(value);
      return parseList(value);
    };
    const fail = (message) => {
      print('\nERROR: Invalid configuration!\n' + message + '\nSimulation aborted.\n', 'printError(error);', 'error');
      return { trace, stdout: trace.stdout, exitCode: 1, error: message };
    };

    print('========== GENERALIZED ARQ SIMULATOR ==========\n\n', 'cout << "========== GENERALIZED ARQ SIMULATOR');
    print('Select ARQ Protocol:\n1. Stop-and-Wait\n2. Go-Back-N\n3. Selective Repeat\n\n', 'cout << "Select ARQ Protocol:\\n";');

    const cfg = {};
    cfg.protocol = readInt('Enter your choice: ', input.protocol, 'cfg.protocol = readInt(');
    if (cfg.protocol < 1 || cfg.protocol > 3) {
      print('\nERROR: Invalid configuration!\nProtocol choice must be 1, 2 or 3.\nSimulation aborted.\n', 'printError("Protocol choice', 'error');
      return { trace, stdout: trace.stdout, exitCode: 1, error: 'Protocol choice must be 1, 2 or 3.' };
    }
    print('\n');

    cfg.totalFrames = readInt('Enter total number of frames: ', input.frames, 'cfg.totalFrames = readInt(');
    cfg.seqBits = readInt('Enter sequence number bits: ', input.bits, 'cfg.seqBits = readInt(');
    if (cfg.protocol === 1) {
      cfg.senderWindow = cfg.receiverWindow = 1;
      print('Sender and receiver window fixed to 1 for Stop-and-Wait\n', 'cout << "Sender and receiver window fixed');
    } else if (cfg.protocol === 2) {
      cfg.senderWindow = readInt('Enter sender window size: ', input.ws, 'cfg.senderWindow = readInt(');
      cfg.receiverWindow = 1;
      print('Receiver window fixed to 1 for Go-Back-N\n', 'cout << "Receiver window fixed');
    } else {
      cfg.senderWindow = readInt('Enter sender window size: ', input.ws, 'cfg.senderWindow = readInt(#2');
      cfg.receiverWindow = readInt('Enter receiver window size: ', input.wr, 'cfg.receiverWindow = readInt(');
    }

    print('\nConfigure channel errors:\n', 'cout << "\\nConfigure channel errors');
    cfg.lostFrames = readList('Enter frame numbers to be lost: ', input.lostFrames, 'cfg.lostFrames = readList(');
    cfg.lostAcks = readList('Enter ACK numbers to be lost: ', input.lostAcks, 'cfg.lostAcks = readList(');

    const error = validateConfig(cfg);
    if (error) return fail(error);

    const dropUnknown = (list, what, snip) => list.filter((v) => {
      if (v < cfg.totalFrames) return true;
      print('Warning: ' + what + ' ' + v + ' does not exist and is ignored\n', snip, 'warning');
      return false;
    });
    cfg.lostFrames = dropUnknown(cfg.lostFrames, 'Frame', 'dropUnknown(cfg.lostFrames');
    cfg.lostAcks = dropUnknown(cfg.lostAcks, 'ACK', 'dropUnknown(cfg.lostAcks');

    print('\n========== TRANSMISSION LOG ==========\n\n', 'TRANSMISSION LOG');
    trace.push({ anchor: M + 'ARQProtocol* protocol = createProtocol(cfg);', kind: 'line' });
    const Impl = cfg.protocol === 1 ? StopAndWait : cfg.protocol === 2 ? GoBackN : SelectiveRepeat;
    const sim = new Impl(cfg, trace);
    trace.push({ anchor: M + 'protocol->run();', kind: 'line' });
    sim.run();
    trace.push({ anchor: M + 'return 0;', kind: 'line' });

    return {
      trace, stdout: trace.stdout, exitCode: 0, error: '', cfg,
      stats: Object.assign({ efficiency: sim.efficiency, totalFrames: cfg.totalFrames }, sim.stats)
    };
  }

  /*
   * Maps an anchor "Scope|snippet" (optionally "Scope|snippet#n" for the n-th match)
   * to a 1-based line number of the C++ source. The search starts at the scope header.
   */
  function makeAnchorResolver(source) {
    const lines = source.replace(/\r\n/g, '\n').split('\n');
    const headers = {
      ARQProtocol: 'class ARQProtocol {',
      StopAndWait: 'class StopAndWait',
      GoBackN: 'class GoBackN',
      SelectiveRepeat: 'class SelectiveRepeat',
      main: 'int main()'
    };
    const cache = new Map();
    return function resolve(anchor) {
      if (!anchor) return 0;
      if (cache.has(anchor)) return cache.get(anchor);
      const bar = anchor.indexOf('|');
      const scope = anchor.slice(0, bar);
      let snippet = anchor.slice(bar + 1);
      let nth = 1;
      const hash = snippet.lastIndexOf('#');
      if (hash > 0 && /^#\d+$/.test(snippet.slice(hash))) {
        nth = Number(snippet.slice(hash + 1));
        snippet = snippet.slice(0, hash);
      }
      let start = lines.findIndex((l) => l.includes(headers[scope]));
      let line = 0;
      for (let i = Math.max(start, 0); i < lines.length; i++) {
        if (lines[i].includes(snippet) && --nth === 0) { line = i + 1; break; }
      }
      cache.set(anchor, line);
      return line;
    };
  }

  const api = { simulate, makeAnchorResolver, parseList, PROTOCOL_NAMES, PROPAGATION_DELAY, TIMEOUT_INTERVAL, MAX_FRAMES, MAX_SEQ_BITS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ARQEngine = api;
})(typeof window !== 'undefined' ? window : this);
