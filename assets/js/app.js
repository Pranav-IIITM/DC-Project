/*
 * ARQ Simulator front end: editor, terminal, execution player and visualisations.
 */
(function () {
  'use strict';

  const E = window.ARQEngine;
  const V = window.CppView;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const el = (tag, cls, html) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  };
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const SVGNS = 'http://www.w3.org/2000/svg';
  const svg = (tag, attrs) => {
    const e = document.createElementNS(SVGNS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  };

  const PROMPT = 'student@dc-lab:~/arq-simulator$ ';
  const UNIT_MS = 620;
  const DUR = { tick: 110, line: 150, log: 380, print: 80, prompt: 200, summary: 110, error: 420, warning: 260 };
  const CHAR_MS = 75;

  const PROTOCOLS = {
    1: {
      name: 'Stop-and-Wait', cls: 'StopAndWait', color: 'sw',
      rules: [['Sender window', '1'], ['Receiver window', '1'], ['ACK', 'Individual'], ['Out-of-order', 'Not applicable'], ['Retransmit', 'Current frame']]
    },
    2: {
      name: 'Go-Back-N', cls: 'GoBackN', color: 'gbn',
      rules: [['Sender window', 'Ws ≤ 2^m − 1'], ['Receiver window', '1'], ['ACK', 'Cumulative'], ['Out-of-order', 'Discarded'], ['Retransmit', 'All outstanding']]
    },
    3: {
      name: 'Selective Repeat', cls: 'SelectiveRepeat', color: 'sr',
      rules: [['Sender window', 'Ws ≤ 2^(m−1)'], ['Receiver window', 'Wr ≤ 2^(m−1)'], ['ACK', 'Individual'], ['Out-of-order', 'Buffered'], ['Retransmit', 'Timed-out only']]
    }
  };

  // Test cases from the assignment; values depend on the selected protocol.
  const PRESETS = [
    { label: 'No loss', make: (p) => ({ frames: 10, bits: 3, ws: 4, wr: p === 3 ? 4 : 1, lf: '', la: '' }) },
    { label: 'One frame lost', make: (p) => ({ frames: 10, bits: 3, ws: 4, wr: p === 3 ? 4 : 1, lf: '3', la: '' }) },
    { label: 'One ACK lost', make: (p) => ({ frames: 10, bits: 3, ws: 4, wr: p === 3 ? 4 : 1, lf: '', la: '4' }) },
    { label: 'Consecutive losses', make: (p) => ({ frames: 10, bits: 3, ws: 4, wr: p === 3 ? 4 : 1, lf: '3, 4, 5', la: '' }) },
    { label: 'Larger window', make: (p) => ({ frames: 14, bits: 4, ws: p === 2 ? 7 : 8, wr: p === 3 ? 8 : 1, lf: '5', la: '9' }) },
    { label: 'Seq. bits m = 2', make: (p) => ({ frames: 10, bits: 2, ws: p === 2 ? 3 : 2, wr: p === 3 ? 2 : 1, lf: '6', la: '' }) },
    {
      label: 'Invalid configuration',
      make: (p) => p === 1 ? { frames: 10, bits: 0, ws: 1, wr: 1, lf: '', la: '' }
        : p === 2 ? { frames: 10, bits: 2, ws: 4, wr: 1, lf: '', la: '' }
          : { frames: 10, bits: 2, ws: 3, wr: 3, lf: '', la: '' }
    }
  ];

  const state = {
    protocol: 2,
    source: '',
    lines: [],
    resolve: () => 0,
    blocks: [],
    lineEls: [],
    marked: [],
    activeEl: null,
    follow: true,
    view: 'sim',
    stage: 'channel'
  };

  /* =============================== Configuration =============================== */
  const F = {
    frames: $('#cfgFrames'), bits: $('#cfgBits'), ws: $('#cfgWs'), wr: $('#cfgWr'),
    lf: $('#cfgLostFrames'), la: $('#cfgLostAcks')
  };
  const saved = { ws: '4', wr: '4' };

  function readConfig(protocol) {
    const p = protocol || state.protocol;
    return {
      protocol: String(p),
      frames: F.frames.value.trim(),
      bits: F.bits.value.trim(),
      ws: p === 1 ? '1' : (F.ws.disabled ? saved.ws : F.ws.value.trim()),
      wr: p === 3 ? (F.wr.disabled ? saved.wr : F.wr.value.trim()) : '1',
      lostFrames: F.lf.value.trim(),
      lostAcks: F.la.value.trim()
    };
  }

  function stdinLines(cfg) {
    const p = Number(cfg.protocol);
    const lines = [cfg.protocol, cfg.frames, cfg.bits];
    if (p === 2) lines.push(cfg.ws);
    if (p === 3) lines.push(cfg.ws, cfg.wr);
    lines.push(cfg.lostFrames, cfg.lostAcks);
    return lines;
  }

  function syncFields() {
    const p = state.protocol;
    const setFixed = (input, key, fixed) => {
      if (fixed && !input.disabled) { saved[key] = input.value; input.value = '1'; input.disabled = true; }
      if (!fixed && input.disabled) { input.value = saved[key]; input.disabled = false; }
    };
    setFixed(F.ws, 'ws', p === 1);
    setFixed(F.wr, 'wr', p !== 3);
    validateHint();
    renderStdin();
  }

  function validateHint() {
    const p = state.protocol;
    const m = parseInt(F.bits.value, 10);
    const n = parseInt(F.frames.value, 10);
    const ws = parseInt(F.ws.value, 10);
    const wr = parseInt(F.wr.value, 10);
    const box = $('#constraint');
    let msg = '';
    let bad = false;
    $$('.field').forEach((f) => f.classList.remove('invalid'));
    const mark = (input) => input.closest('.field').classList.add('invalid');
    if (!(n >= 1 && n <= 64)) { bad = true; mark(F.frames); msg = 'Frames must be between 1 and 64.'; }
    else if (!(m >= 1 && m <= 8)) { bad = true; mark(F.bits); msg = 'Sequence bits must be between 1 and 8.'; }
    else {
      const space = 1 << m;
      if (p === 1) msg = 'Ws = Wr = 1. Sequence numbers 0–' + (space - 1) + ' label the frames.';
      else if (p === 2) {
        bad = !(ws >= 1 && ws <= space - 1);
        if (bad) mark(F.ws);
        msg = (bad ? 'Ws = ' + (isNaN(ws) ? '?' : ws) + ' breaks ' : 'Valid: ') + '1 ≤ Ws ≤ 2^m − 1 = ' + (space - 1);
      } else {
        const lim = space / 2;
        const badWs = !(ws >= 1 && ws <= lim);
        const badWr = !(wr >= 1 && wr <= lim);
        if (badWs) mark(F.ws);
        if (badWr) mark(F.wr);
        bad = badWs || badWr;
        msg = (bad ? 'Window exceeds ' : 'Valid: Ws, Wr ≤ ') + '2^(m−1) = ' + lim;
      }
    }
    if (bad) msg += '. The program will reject this configuration.';
    box.className = 'constraint' + (bad ? ' bad' : '');
    box.innerHTML = '<span>' + (bad ? '✕' : '✓') + '</span><span>' + esc(msg) + '</span>';
  }

  function renderRules() {
    $('#rules').innerHTML = PROTOCOLS[state.protocol].rules
      .map(([k, v]) => '<div class="rule"><span>' + k + '</span><b>' + v + '</b></div>').join('');
  }

  function renderPresets() {
    const grid = $('#presets');
    grid.innerHTML = '';
    PRESETS.forEach((pr, i) => {
      const b = el('button', 'preset', '<i>' + (i + 1) + '</i><span>' + pr.label + '</span>');
      b.type = 'button';
      b.addEventListener('click', () => {
        const v = pr.make(state.protocol);
        F.frames.value = v.frames;
        F.bits.value = v.bits;
        saved.ws = String(v.ws);
        saved.wr = String(v.wr);
        if (!F.ws.disabled) F.ws.value = v.ws;
        if (!F.wr.disabled) F.wr.value = v.wr;
        F.lf.value = v.lf;
        F.la.value = v.la;
        $$('.preset').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        onConfigChange();
        toast('Loaded test case ' + (i + 1) + ': ' + pr.label);
      });
      grid.appendChild(b);
    });
  }

  function onConfigChange() {
    validateHint();
    renderStdin();
    if (!P.active) preview();
  }

  function setProtocol(p) {
    if (state.protocol === p) return;
    state.protocol = p;
    $$('#protocolSeg button').forEach((b) => b.classList.toggle('active', Number(b.dataset.p) === p));
    $$('.preset').forEach((x) => x.classList.remove('active'));
    renderRules();
    syncFields();
    resetRun();
    focusClass();
    if (state.view === 'compare') renderCompare();
  }

  /* ================================== Editor ================================== */
  function buildEditor(source) {
    state.source = source;
    state.lines = source.replace(/\r\n/g, '\n').split('\n');
    state.resolve = E.makeAnchorResolver(source);
    state.blocks = V.blocks(source);
    const html = V.highlight(source);
    const code = $('#code');
    const frag = document.createDocumentFragment();
    state.lineEls = html.map((h, i) => {
      const d = el('div', 'ln', '<span class="g">' + (i + 1) + '</span><span class="c">' + h + '</span>');
      frag.appendChild(d);
      return d;
    });
    code.innerHTML = '';
    code.appendChild(frag);
    focusClass();
  }

  function clearMarks() {
    for (const e of state.marked) e.classList.remove('in-block', 'blk-start', 'blk-end', 'class-focus');
    state.marked = [];
    if (state.activeEl) {
      state.activeEl.classList.remove('active');
      const b = state.activeEl.querySelector('.badge');
      if (b) b.remove();
      state.activeEl = null;
    }
  }

  function scrollToLine(line, center) {
    const code = $('#code');
    const target = state.lineEls[line - 1];
    if (!target) return;
    const top = target.offsetTop;
    const h = code.clientHeight;
    const vis = top > code.scrollTop + h * 0.15 && top < code.scrollTop + h * 0.8;
    if (center || !vis) {
      code.scrollTo({ top: Math.max(0, top - h * (center ? 0.12 : 0.4)), behavior: P.speed >= 4 || P.instant ? 'auto' : 'smooth' });
    }
  }

  // Highlights the class of the selected protocol while idle.
  function focusClass() {
    if (!state.lineEls.length || P.active) return;
    clearMarks();
    const cls = PROTOCOLS[state.protocol].cls;
    const start = state.lines.findIndex((l) => l.startsWith('class ' + cls));
    if (start < 0) return;
    const blk = state.blocks.find((b) => b.start === start + 1);
    const end = blk ? blk.end : start + 1;
    for (let i = start; i < end; i++) {
      state.lineEls[i].classList.add('class-focus');
      state.marked.push(state.lineEls[i]);
    }
    scrollToLine(start + 1, true);
    setBreadcrumb(cls, null, start + 1);
  }

  function setBreadcrumb(scope, fn, line) {
    const parts = ['<span>arq_simulator.cpp</span>'];
    if (scope && scope !== 'main') parts.push('<span class="sep">›</span><span>' + scope + '</span>');
    if (fn) parts.push('<span class="sep">›</span><span class="cur">' + fn + '</span>');
    $('#breadcrumb').innerHTML = parts.join('');
    $('#stPos').textContent = 'Ln ' + line + ', Col 1';
  }

  function highlightStep(step) {
    const line = state.resolve(step.anchor);
    if (!line) return;
    clearMarks();
    const blk = V.enclosingBlock(state.blocks, line);
    if (blk) {
      for (let i = blk.start; i <= blk.end; i++) {
        const e = state.lineEls[i - 1];
        e.classList.add('in-block');
        state.marked.push(e);
      }
      state.lineEls[blk.start - 1].classList.add('blk-start');
      state.lineEls[blk.end - 1].classList.add('blk-end');
    }
    const active = state.lineEls[line - 1];
    active.classList.add('active');
    state.activeEl = active;

    let badge = '';
    if (step.kind === 'tick') badge = 'loop iteration ' + (step.clock + 1) + ' · clock = ' + step.clock;
    else if (step.kind === 'prompt') badge = 'waiting for stdin';
    else if (step.viz && step.viz.frame !== undefined) badge = 'frame = ' + step.viz.frame;
    else if (step.viz && step.viz.frames) badge = 'frames ' + step.viz.frames.join(', ');
    if (badge && !P.instant) active.appendChild(el('span', 'badge', esc(badge)));

    const scope = step.anchor.split('|')[0];
    setBreadcrumb(scope, V.functionAt(state.lines, line), line);
    $('#watchScope').textContent = scope === 'main' ? 'main()' : PROTOCOLS[state.protocol].cls;
    if (state.follow && !P.instant) scrollToLine(line, false);
  }

  function renderStdin() {
    $('#stdinView').textContent = stdinLines(readConfig()).join('\n') + '\n';
  }

  /* ================================= Terminal ================================= */
  const term = {
    body: $('#term'),
    line: null,
    caret: el('span', 'caret'),
    clear() { this.body.innerHTML = ''; this.line = null; },
    newLine(cls) {
      const d = el('div', 'tl' + (cls ? ' ' + cls : '') + (P.instant ? '' : ' new'));
      this.body.appendChild(d);
      this.line = d;
      return d;
    },
    ensure() { return this.line || this.newLine(); },
    write(text, kind) {
      const parts = text.split('\n');
      parts.forEach((part, i) => {
        if (i > 0) this.newLine();
        if (!part) return;
        const line = this.ensure();
        const cls = lineClass(part, kind);
        if (cls) line.classList.add(cls);
        line.insertAdjacentHTML('beforeend', fmt(part, kind));
      });
      this.scroll();
    },
    html(h, cls) { const d = this.newLine(cls); d.innerHTML = h; this.scroll(); return d; },
    prompt(cmd) {
      const d = this.newLine();
      d.innerHTML = '<span class="ps">student@dc-lab</span>:<span class="ps2">~/arq-simulator</span>$ <span class="cmd">' + esc(cmd || '') + '</span>';
      this.scroll();
      return d;
    },
    showCaret() { this.ensure().appendChild(this.caret); this.scroll(); },
    hideCaret() { this.caret.remove(); },
    scroll() {
      const b = this.body;
      b.scrollTop = b.scrollHeight;
    }
  };

  function lineClass(text, kind) {
    if (/^=+ .* =+$/.test(text)) return 'head';
    if (kind === 'error') return 'err';
    if (kind === 'warning') return 'warnl';
    if (kind === 'summary') return 'sum';
    return '';
  }

  function fmt(text, kind) {
    if (kind === 'log') {
      const m = text.match(/^(\[t=\s*\d+\]) (\S+)(\s+: )(.*)$/);
      if (m) {
        const msg = m[4];
        let k = '';
        if (/lost/.test(msg)) k = 'k-lost';
        else if (/Timeout|Retransmitting|retransmitted|Selectively/.test(msg)) k = 'k-warn';
        else if (/discarded/.test(msg)) k = 'k-lost';
        else if (/buffered/.test(msg)) k = 'k-buf';
        else if (/received successfully|delivered|all frames acknowledged/.test(msg)) k = 'k-ok';
        return '<span class="t">' + esc(m[1]) + '</span> <span class="w-' + m[2] + '">' + esc(m[2]) + '</span>' +
          esc(m[3]) + (k ? '<span class="' + k + '">' + esc(msg) + '</span>' : esc(msg));
      }
    }
    if (kind === 'summary') {
      const m = text.match(/^(.*?: )(.*)$/);
      if (m) return esc(m[1]) + '<b>' + esc(m[2]) + '</b>';
    }
    return esc(text);
  }

  function termWelcome() {
    term.clear();
    term.prompt('ls');
    term.html('<span class="ps2">arq_simulator.cpp</span>  stdin.txt', 'dim');
    term.prompt('');
    term.showCaret();
  }

  /* ================================ Channel view ================================ */
  const C = {
    lanes: $('#lanes'), scroll: $('#lanesScroll'),
    N: 0, col: 52, sBoxes: [], rBoxes: [], sWin: null, rWin: null, next: null, exp: null, last: null, seqSpace: 8
  };

  function buildLanes(N, bits, ws, wr) {
    C.N = N;
    C.seqSpace = 1 << clamp(bits, 1, 8);
    C.lanes.innerHTML = '';
    C.band = el('div', 'channel-band');
    C.sRow = el('div', 'row sender');
    C.rRow = el('div', 'row receiver');
    C.sWin = el('div', 'window sender');
    C.rWin = el('div', 'window receiver');
    C.next = el('div', 'pointer next', 'next');
    C.exp = el('div', 'pointer exp', 'expected');
    C.sBoxes = [];
    C.rBoxes = [];
    for (let i = 0; i < N; i++) {
      const s = el('div', 'fbox', '<b>' + i + '</b><small>seq ' + (i % C.seqSpace) + '</small><span class="mark">✓</span><div class="tbar"><i></i></div>');
      s.dataset.state = 'ready';
      const r = el('div', 'fbox', '<b>' + i + '</b><small>seq ' + (i % C.seqSpace) + '</small>');
      r.dataset.state = 'empty';
      C.sRow.appendChild(s);
      C.rRow.appendChild(r);
      C.sBoxes.push(s);
      C.rBoxes.push(r);
    }
    C.lanes.append(C.band, C.sWin, C.rWin, C.sRow, C.rRow, C.next, C.exp);
    $('#senderSub').textContent = 'Ws = ' + ws;
    $('#receiverSub').textContent = 'Wr = ' + wr;
    relayout();
    applySnapshot({
      sender: new Array(N).fill('ready'), receiver: new Array(N).fill('empty'),
      sBase: 0, sWin: ws, sNext: 0, rBase: 0, rWin: wr, timers: []
    });
  }

  function relayout() {
    if (!C.N) return;
    const avail = C.scroll.clientWidth - 40;
    C.col = clamp(Math.floor(avail / C.N), 46, 86);
    C.lanes.style.setProperty('--col', C.col + 'px');
    C.lanes.style.width = (C.N * C.col + 40) + 'px';
    C.band.style.width = (C.N * C.col) + 'px';
    if (C.last) applySnapshot(C.last);
  }

  const colX = (i) => 20 + i * C.col + C.col / 2;

  function applySnapshot(snap) {
    C.last = snap;
    for (let i = 0; i < C.N; i++) {
      if (C.sBoxes[i].dataset.state !== snap.sender[i]) C.sBoxes[i].dataset.state = snap.sender[i];
      if (C.rBoxes[i].dataset.state !== snap.receiver[i]) C.rBoxes[i].dataset.state = snap.receiver[i];
    }
    const place = (win, base, size) => {
      if (base >= C.N) {
        win.style.opacity = '0';
        win.style.left = (20 + C.N * C.col) + 'px';
        win.style.width = '0px';
        return;
      }
      const span = Math.min(size, C.N - base);
      win.style.opacity = '1';
      win.style.left = (20 + base * C.col + 1) + 'px';
      win.style.width = (span * C.col - 2) + 'px';
    };
    place(C.sWin, snap.sBase, snap.sWin);
    place(C.rWin, snap.rBase, snap.rWin);
    C.next.style.display = snap.sNext < C.N ? '' : 'none';
    C.next.style.left = colX(Math.min(snap.sNext, C.N - 1)) + 'px';
    C.exp.style.display = snap.rBase < C.N ? '' : 'none';
    C.exp.style.left = colX(Math.min(snap.rBase, C.N - 1)) + 'px';
    P.timers = snap.timers || [];
    if (snap.vars) renderWatch(snap.vars);
  }

  function laneY() {
    const h = C.lanes.clientHeight || 372;
    return { a: 32 + 52 + 18, b: h - 32 - 52 - 18, h };
  }

  function flash(frame, side, cls, text) {
    if (P.instant || frame === undefined || frame >= C.N) return;
    const { a, b } = laneY();
    const f = el('div', 'flash ' + cls, esc(text));
    f.style.left = colX(frame) + 'px';
    f.style.top = (side === 's' ? a - 8 : b - 16) + 'px';
    C.lanes.appendChild(f);
    setTimeout(() => f.remove(), 1600);
  }

  function preview() {
    const cfg = readConfig();
    const n = clamp(parseInt(cfg.frames, 10) || 1, 1, 64);
    const m = clamp(parseInt(cfg.bits, 10) || 1, 1, 8);
    buildLanes(n, m, Number(cfg.ws) || 1, Number(cfg.wr) || 1);
    $('#stageOverlay').hidden = true;
  }

  /* ============================= Space-time diagram ============================= */
  const D = { svg: $('#diagram'), scroll: $('#diagramScroll'), top: 46, scale: 30, xS: 0, xR: 0 };
  const dy = (t) => D.top + t * D.scale;

  function buildDiagram(maxClock) {
    const s = D.svg;
    s.innerHTML = '';
    const w = Math.max(560, $('.stage-body').clientWidth - 4);
    D.xS = Math.round(w * 0.27);
    D.xR = Math.round(w * 0.73);
    const height = dy(maxClock + 2) + 20;
    s.setAttribute('width', w);
    s.setAttribute('height', height);
    s.setAttribute('viewBox', '0 0 ' + w + ' ' + height);

    const defs = svg('defs', {});
    [['af', '#2563eb'], ['ar', '#d97706'], ['aa', '#059669']].forEach(([id, c]) => {
      const mk = svg('marker', { id, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
      mk.appendChild(svg('path', { d: 'M0 0L10 5L0 10z', fill: c }));
      defs.appendChild(mk);
    });
    s.appendChild(defs);

    for (let t = 0; t <= maxClock + 1; t++) {
      s.appendChild(svg('line', { x1: 52, x2: w - 12, y1: dy(t), y2: dy(t), stroke: t % 5 === 0 ? '#e2e8f0' : '#f1f5f9', 'stroke-width': 1 }));
      const tx = svg('text', { x: 44, y: dy(t) + 4, 'text-anchor': 'end', 'font-size': 10, fill: '#94a3b8' });
      tx.textContent = 't=' + t;
      s.appendChild(tx);
    }
    [[D.xS, 'SENDER', '#2563eb'], [D.xR, 'RECEIVER', '#7c3aed']].forEach(([x, label, c]) => {
      s.appendChild(svg('line', { x1: x, x2: x, y1: D.top - 10, y2: height - 6, stroke: c, 'stroke-width': 3, 'stroke-linecap': 'round', opacity: .85 }));
      s.appendChild(svg('rect', { x: x - 44, y: 8, width: 88, height: 22, rx: 7, fill: c }));
      const tx = svg('text', { x, y: 23, 'text-anchor': 'middle', 'font-size': 11, 'font-weight': 700, fill: '#fff' });
      tx.textContent = label;
      s.appendChild(tx);
    });
    D.layer = svg('g', {});
    D.marks = svg('g', {});
    s.appendChild(D.layer);
    s.appendChild(D.marks);
    D.now = svg('g', {});
    D.now.appendChild(svg('line', { x1: 52, x2: w - 12, y1: 0, y2: 0, stroke: '#6366f1', 'stroke-width': 1.5, 'stroke-dasharray': '5 4' }));
    s.appendChild(D.now);
  }

  function diagPacket(p) {
    const frame = p.kind === 'frame';
    const color = p.lost ? '#e11d48' : frame ? (p.retrans ? '#d97706' : '#2563eb') : '#059669';
    p.x1 = frame ? D.xS : D.xR;
    p.x2 = frame ? D.xR : D.xS;
    p.y1 = dy(p.from);
    p.y2 = dy(p.to);
    p.dl = svg('line', {
      x1: p.x1, y1: p.y1, x2: p.x1, y2: p.y1, stroke: color, 'stroke-width': 2,
      'stroke-dasharray': p.lost ? '6 4' : 'none', 'stroke-linecap': 'round'
    });
    if (!p.lost) p.dl.setAttribute('marker-end', 'url(#' + (frame ? (p.retrans ? 'ar' : 'af') : 'aa') + ')');
    const tx = svg('text', {
      x: p.x1 + (p.x2 - p.x1) * 0.1, y: p.y1 + (p.y2 - p.y1) * 0.1 - 6, 'text-anchor': 'middle',
      'font-size': 10.5, 'font-weight': 600, fill: color, stroke: '#fff', 'stroke-width': 3, 'paint-order': 'stroke'
    });
    tx.textContent = frame ? p.label + (p.retrans ? ' ↻' : '') : p.label;
    p.dt = tx;
    p.dl.style.display = 'none';
    tx.style.display = 'none';
    D.layer.append(p.dl, tx);
  }

  function diagUpdate(p, prog) {
    if (p.diagDone) return;
    if (prog <= 0) return;
    p.dl.style.display = '';
    p.dt.style.display = '';
    const k = p.lost ? Math.min(prog, 0.5) : Math.min(prog, 1);
    p.dl.setAttribute('x2', p.x1 + (p.x2 - p.x1) * k);
    p.dl.setAttribute('y2', p.y1 + (p.y2 - p.y1) * k);
    if (p.lost && prog >= 0.5) {
      const x = (p.x1 + p.x2) / 2;
      const y = (p.y1 + p.y2) / 2;
      const g = svg('g', {});
      g.appendChild(svg('circle', { cx: x, cy: y, r: 8, fill: '#fff1f2', stroke: '#e11d48', 'stroke-width': 1.5 }));
      g.appendChild(svg('path', { d: 'M' + (x - 3.5) + ' ' + (y - 3.5) + 'l7 7m0 -7l-7 7', stroke: '#e11d48', 'stroke-width': 2, 'stroke-linecap': 'round' }));
      D.layer.appendChild(g);
      p.diagDone = true;
    } else if (!p.lost && prog >= 1) {
      p.diagDone = true;
    }
  }

  function diagMark(side, t, text, color) {
    if (!D.marks) return;
    const x = side === 's' ? D.xS : D.xR;
    D.marks.appendChild(svg('circle', { cx: x, cy: dy(t), r: 4.5, fill: color, stroke: '#fff', 'stroke-width': 2 }));
    const tx = svg('text', {
      x: side === 's' ? x - 12 : x + 12, y: dy(t) + 4, 'text-anchor': side === 's' ? 'end' : 'start',
      'font-size': 10, 'font-weight': 600, fill: color
    });
    tx.textContent = text;
    D.marks.appendChild(tx);
  }

  /* ============================== Watch & metrics ============================== */
  let lastVars = {};
  function renderWatch(vars) {
    const body = $('#watch tbody');
    if (body.dataset.n !== String(vars.length) || !body.querySelector('tr[data-k]')) {
      body.innerHTML = vars.map(([k]) => '<tr data-k="' + esc(k) + '"><td>' + esc(k) + '</td><td></td></tr>').join('');
      body.dataset.n = String(vars.length);
      lastVars = {};
    }
    vars.forEach(([k, v], i) => {
      const row = body.children[i];
      const val = String(v);
      if (lastVars[k] !== val) {
        row.children[1].textContent = val;
        if (lastVars[k] !== undefined && !P.instant) {
          row.classList.remove('chg');
          void row.offsetWidth;
          row.classList.add('chg');
        }
        lastVars[k] = val;
      }
    });
  }

  const METRICS = [
    ['tx', 'Transmissions', 'blue'], ['re', 'Retransmissions', 'amber'], ['del', 'Delivered', 'green'],
    ['disc', 'Discarded', 'red'], ['lost', 'Lost frame / ACK', 'red'], ['to', 'Timeouts', 'amber']
  ];
  function renderMetrics() {
    const L = P.live;
    const vals = {
      tx: L.tx, re: L.re, del: L.del + ' / ' + (C.N || 0), disc: L.disc, lost: L.flost + ' / ' + L.alost, to: L.to
    };
    const grid = $('#metrics');
    if (!grid.children.length) {
      grid.innerHTML = METRICS.map(([k, label, c]) => '<div class="metric ' + c + '" data-m="' + k + '"><span>' + label + '</span><b>0</b></div>').join('');
    }
    METRICS.forEach(([k]) => {
      const box = grid.querySelector('[data-m="' + k + '"]');
      const b = box.querySelector('b');
      const v = String(vals[k]);
      if (b.textContent !== v) {
        b.textContent = v;
        if (!P.instant) { box.classList.remove('bump'); void box.offsetWidth; box.classList.add('bump'); }
      }
    });
  }

  /* =================================== Player =================================== */
  const P = {
    active: false, playing: false, done: false, instant: false, stepMode: false,
    steps: [], idx: 0, vt: 0, speed: 1, waitUntil: 0, typing: null, last: 0,
    packets: [], timers: [], result: null, session: 0, maxClock: 0,
    live: { tx: 0, re: 0, del: 0, disc: 0, flost: 0, alost: 0, to: 0 }
  };

  function resetLive() { P.live = { tx: 0, re: 0, del: 0, disc: 0, flost: 0, alost: 0, to: 0 }; renderMetrics(); }

  function setStatus(kind, text) {
    $('#stState').innerHTML = '<i class="dot ' + kind + '"></i>' + text;
  }

  function updateControls() {
    const pause = $('#pauseBtn');
    pause.disabled = !P.active || P.done || P.compiling;
    pause.querySelector('span').textContent = P.playing ? 'Pause' : 'Resume';
    pause.querySelector('svg').innerHTML = P.playing
      ? '<path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor"/>'
      : '<path d="M7 5v14l11-7z" fill="currentColor"/>';
    $('#stepBtn').disabled = !P.active || P.done || P.compiling;
    $('#skipBtn').disabled = !P.active || P.done || P.compiling;
    const run = $('#runBtn');
    run.classList.toggle('running', P.active && !P.done);
    run.querySelector('span').textContent = P.active && !P.done ? 'Restart' : 'Run';
    if (P.active && !P.done && !P.compiling) setStatus(P.playing ? 'run' : 'pause', P.playing ? 'Running' : 'Paused');
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function typeCommand(line, text, session) {
    const span = line.querySelector('.cmd');
    for (let i = 1; i <= text.length; i++) {
      if (session !== P.session) return false;
      span.textContent = text.slice(0, i);
      term.showCaret();
      await sleep(14);
    }
    return true;
  }

  async function compileAndRun() {
    const session = ++P.session;
    stopPlayer();
    const cfg = readConfig();
    const result = E.simulate(cfg);
    P.result = result;
    P.steps = result.trace.steps;
    P.idx = 0;
    P.vt = 0;
    P.packets = [];
    P.timers = [];
    P.done = false;
    P.typing = null;
    P.active = true;
    P.compiling = true;
    P.maxClock = P.steps.reduce((m, s) => (s.clock !== undefined ? Math.max(m, s.clock) : m), 0);
    resetLive();
    $('#watch tbody').innerHTML = '<tr><td class="muted" colspan="2">Waiting for the program…</td></tr>';
    $('#stageOverlay').hidden = true;
    $('#progressBar').style.width = '0%';
    $('#clockVal').textContent = '0.0';

    if (result.exitCode === 0) {
      buildLanes(result.cfg.totalFrames, result.cfg.seqBits, result.cfg.senderWindow, result.cfg.receiverWindow);
      buildDiagram(P.maxClock);
    } else {
      preview();
      D.svg.innerHTML = '';
    }

    clearMarks();
    showFile('cpp');
    updateControls();
    setStatus('compile', 'Compiling…');

    term.clear();
    const cmd = 'g++ -std=c++17 -Wall -Wextra -O2 arq_simulator.cpp -o arq_simulator';
    const l1 = term.prompt('');
    if (!(await typeCommand(l1, cmd, session))) return;
    term.hideCaret();
    const sweep = $('#compileSweep');
    sweep.classList.remove('go');
    void sweep.offsetWidth;
    sweep.classList.add('go');
    const spin = term.html('<span class="spin">⠋</span> Compiling arq_simulator.cpp …', 'dim');
    const frames = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
    const t0 = performance.now();
    for (let i = 0; i < 14; i++) {
      if (session !== P.session) return;
      spin.querySelector('.spin').textContent = frames[i % frames.length];
      await sleep(80);
    }
    const secs = ((performance.now() - t0) / 1000 + 0.18).toFixed(2);
    spin.className = 'tl ok';
    spin.innerHTML = '✔ Build succeeded · 0 errors, 0 warnings · ' + secs + ' s';
    const l2 = term.prompt('');
    if (!(await typeCommand(l2, './arq_simulator < stdin.txt', session))) return;
    term.hideCaret();
    term.newLine();
    await sleep(250);
    if (session !== P.session) return;

    P.compiling = false;
    P.playing = true;
    P.last = performance.now();
    P.waitUntil = 0;
    updateControls();
  }

  function stopPlayer() {
    P.playing = false;
    P.typing = null;
    for (const p of P.packets) if (p.elm) p.elm.remove();
    P.packets = [];
    $$('.flash').forEach((f) => f.remove());
  }

  function resetRun() {
    P.session++;
    stopPlayer();
    P.active = false;
    P.done = false;
    P.compiling = false;
    P.steps = [];
    P.idx = 0;
    P.vt = 0;
    resetLive();
    clearMarks();
    $('#watch tbody').innerHTML = '<tr><td class="muted" colspan="2">Run the program to inspect state</td></tr>';
    $('#watchScope').textContent = '—';
    $('#progressBar').style.width = '0%';
    $('#clockVal').textContent = '0.0';
    D.svg.innerHTML = '';
    preview();
    termWelcome();
    updateControls();
    setStatus('idle', 'Ready');
    focusClass();
  }

  function durationOf(step) {
    if (step.kind === 'log' && step.viz && step.viz.type === 'frame') return DUR.log + 60;
    return DUR[step.kind] || 120;
  }

  function applyStep(step) {
    if (step.input !== undefined) {
      if (P.instant) {
        term.ensure().insertAdjacentHTML('beforeend', '<span class="in">' + esc(step.input) + '</span>');
        term.newLine();
      } else {
        const span = el('span', 'in');
        term.ensure().appendChild(span);
        P.typing = { text: step.input, span, start: performance.now() };
      }
      return;
    }
    if (step.anchor && !P.instant) highlightStep(step);
    if (step.out) term.write(step.out, step.kind);
    if (step.kind === 'prompt' && !P.instant) term.showCaret();
    if (step.snap) applySnapshot(step.snap);
    if (step.viz) applyViz(step.viz);
    if (step.kind === 'log' || step.viz) renderMetrics();
  }

  function applyViz(v) {
    const L = P.live;
    switch (v.type) {
      case 'frame':
      case 'ack': {
        const p = {
          kind: v.type, frame: v.frame, from: v.from, to: v.to, lost: v.lost, retrans: v.retrans,
          label: v.type === 'frame' ? 'F' + v.frame : 'ACK ' + v.ackNo
        };
        if (v.type === 'frame') {
          L.tx++;
          if (v.retrans) L.re++;
          p.elm = el('div', 'packet frame' + (v.retrans ? ' re' : ''), 'F' + v.frame + '<small>seq ' + v.seq + '</small>');
        } else {
          p.elm = el('div', 'packet ack', 'ACK ' + v.ackNo + '<small>F' + v.frame + '</small>');
        }
        p.elm.style.display = 'none';
        C.lanes.appendChild(p.elm);
        if (D.layer) diagPacket(p);
        P.packets.push(p);
        break;
      }
      case 'frameLost':
        L.flost++;
        flash(v.frame, 's', 'bad', 'Frame ' + v.frame + ' lost');
        break;
      case 'ackLost':
        L.alost++;
        flash(v.frame, 'r', 'bad', 'ACK lost');
        break;
      case 'rx':
        if (v.result === 'accepted') {
          if (state.protocol !== 3) {
            L.del++;
            diagMark('r', P.vt, '✓ F' + v.frame, '#059669');
          }
          flash(v.frame, 'r', 'ok', '✓ accepted');
        } else if (v.result === 'buffered') {
          flash(v.frame, 'r', 'buf', 'buffered');
          diagMark('r', P.vt, '▣ F' + v.frame + ' buffered', '#7c3aed');
        } else {
          L.disc++;
          flash(v.frame, 'r', 'bad', '✕ discarded');
          diagMark('r', P.vt, '✕ F' + v.frame + ' discarded', '#e11d48');
        }
        break;
      case 'deliver':
        L.del++;
        diagMark('r', P.vt, '✓ F' + v.frame + ' delivered', '#059669');
        break;
      case 'ackRx':
        flash(v.frame, 's', 'ok', 'ACK ✓');
        break;
      case 'ackDup':
        flash(v.frame, 's', 'info', 'duplicate ACK');
        break;
      case 'timeout':
        L.to++;
        flash(v.frame, 's', 'warn', '⏱ timeout');
        diagMark('s', P.vt, '⏱ timeout F' + v.frame, '#d97706');
        break;
      default:
        break;
    }
  }

  function advance(now, dt) {
    let budget = dt;
    for (let guard = 0; guard < 400 && P.playing; guard++) {
      if (P.typing) {
        const n = Math.floor((now - P.typing.start) / (CHAR_MS / P.speed));
        P.typing.span.textContent = P.typing.text.slice(0, n);
        term.showCaret();
        if (n < P.typing.text.length) return;
        term.hideCaret();
        P.typing = null;
        term.newLine();
        P.waitUntil = now + 150 / P.speed;
        if (finishStep()) return;
      }
      if (now < P.waitUntil) return;
      if (P.idx >= P.steps.length) { finishRun(); return; }
      const s = P.steps[P.idx];
      if (s.clock !== undefined && s.clock > P.vt) {
        P.vt = Math.min(s.clock, P.vt + budget * P.speed / UNIT_MS);
        budget = 0;
        if (P.vt < s.clock) return;
      }
      term.hideCaret();
      applyStep(s);
      P.idx++;
      $('#progressBar').style.width = (100 * P.idx / P.steps.length).toFixed(1) + '%';
      if (P.typing) continue;
      P.waitUntil = now + durationOf(s) / P.speed;
      if (finishStep()) return;
    }
  }

  function finishStep() {
    if (!P.stepMode) return false;
    P.stepMode = false;
    P.playing = false;
    P.waitUntil = 0;
    updateControls();
    return true;
  }

  function renderDynamic() {
    $('#clockVal').textContent = P.vt.toFixed(1);
    const { a, b } = laneY();
    for (const p of P.packets) {
      const prog = (P.vt - p.from) / (p.to - p.from);
      if (p.dl) diagUpdate(p, prog);
      if (p.gone || !p.elm) continue;
      if (prog <= 0) { p.elm.style.display = 'none'; continue; }
      p.elm.style.display = '';
      let k = prog;
      if (p.lost && prog >= 0.5) {
        k = 0.5;
        if (!p.dead) { p.dead = true; p.elm.classList.add('dead'); }
        if (prog >= 0.95) { p.elm.classList.add('fading'); }
        if (prog >= 1.25 || P.done) { p.elm.remove(); p.gone = true; continue; }
      } else if (prog >= 1) {
        p.elm.remove();
        p.gone = true;
        continue;
      }
      const y = p.kind === 'frame' ? a + (b - a) * k : b - (b - a) * k;
      const x = colX(p.frame) + (p.kind === 'frame' ? -3 : 3);
      p.elm.style.transform = 'translate(' + x + 'px,' + y + 'px) translate(-50%,-50%)';
    }
    // timers under sender frames
    const map = new Map(P.timers.map((t) => [t.frame, t]));
    for (let i = 0; i < C.sBoxes.length; i++) {
      const bar = C.sBoxes[i].lastElementChild;
      const t = map.get(i);
      if (!t) { if (bar.classList.contains('on')) bar.className = 'tbar'; continue; }
      const frac = clamp((P.vt - t.start) / (t.end - t.start), 0, 1);
      bar.className = 'tbar on' + (frac > 0.85 ? ' crit' : frac > 0.6 ? ' warn' : '');
      bar.firstElementChild.style.width = (frac * 100).toFixed(1) + '%';
    }
    if (D.now && D.now.firstChild) {
      const y = dy(P.vt);
      D.now.firstChild.setAttribute('y1', y);
      D.now.firstChild.setAttribute('y2', y);
      if (state.stage === 'diagram' && P.playing) {
        const sc = D.scroll;
        if (y > sc.scrollTop + sc.clientHeight * 0.75 || y < sc.scrollTop) sc.scrollTop = y - sc.clientHeight * 0.45;
      }
    }
  }

  function finishRun() {
    if (P.done) return;
    P.done = true;
    P.playing = false;
    P.typing = null;
    const r = P.result;
    term.hideCaret();
    term.newLine();
    term.html('Process finished with exit code ' + r.exitCode, r.exitCode === 0 ? 'dim' : 'err');
    term.prompt('');
    term.showCaret();
    $('#progressBar').style.width = '100%';
    updateControls();
    if (r.exitCode === 0) {
      setStatus('done', 'Finished · exit code 0');
      const s = r.stats;
      P.live = { tx: s.transmissions, re: s.retransmissions, del: s.delivered, disc: s.discarded, flost: s.framesLost, alost: s.acksLost, to: s.timeouts };
      renderMetrics();
      showOverlay('ok', '✓', 'Transmission complete',
        PROTOCOLS[state.protocol].name + ' delivered all ' + s.delivered + ' frames in ' + s.totalTime + ' time units.',
        [[s.transmissions, 'transmissions'], [s.retransmissions, 'retransmissions'], [s.efficiency.toFixed(2) + '%', 'efficiency']]);
    } else {
      setStatus('err', 'Exited with code 1');
      showOverlay('err', '!', 'Invalid configuration', r.error + ' The program stopped before transmitting.', null);
    }
  }

  function showOverlay(kind, icon, title, text, stats) {
    const ov = $('#stageOverlay');
    ov.innerHTML = '<div class="overlay-card ' + kind + '"><div class="ico">' + icon + '</div><h3>' + esc(title) + '</h3><p>' + esc(text) + '</p>' +
      (stats ? '<div class="ov-stats">' + stats.map(([v, l]) => '<div><b>' + v + '</b><span>' + l + '</span></div>').join('') + '</div>' : '') +
      '<div class="ov-actions"><button class="btn" data-ov="close">View final state</button><button class="btn primary" data-ov="replay">Run again</button></div></div>';
    ov.hidden = false;
    ov.querySelector('[data-ov="close"]').onclick = () => { ov.hidden = true; };
    ov.querySelector('[data-ov="replay"]').onclick = () => { ov.hidden = true; compileAndRun(); };
  }

  function finishNow() {
    if (!P.active || P.done || P.compiling) return;
    P.instant = true;
    if (P.typing) {
      P.typing.span.textContent = P.typing.text;
      P.typing = null;
      term.newLine();
    }
    let lastAnchored = null;
    while (P.idx < P.steps.length) {
      const s = P.steps[P.idx++];
      if (s.anchor) lastAnchored = s;
      if (s.clock !== undefined) P.vt = Math.max(P.vt, s.clock);
      applyStep(s);
    }
    P.instant = false;
    if (lastAnchored) highlightStep(lastAnchored);
    renderDynamic();
    finishRun();
  }

  function loop(now) {
    const dt = Math.min(80, now - (P.last || now));
    P.last = now;
    if (P.playing && !P.compiling) advance(now, dt);
    if (P.active) renderDynamic();
    requestAnimationFrame(loop);
  }

  /* ================================== Compare ================================== */
  function renderCompare() {
    const base = readConfig();
    const wsVal = (F.ws.disabled ? saved.ws : F.ws.value).trim();
    const wrVal = (F.wr.disabled ? saved.wr : F.wr.value).trim();
    const runs = [1, 2, 3].map((p) => {
      const cfg = Object.assign({}, base, { protocol: String(p), ws: p === 1 ? '1' : wsVal, wr: p === 3 ? wrVal : '1' });
      return { p, cfg, r: E.simulate(cfg) };
    });
    $('#compareCfg').innerHTML = [
      'frames = ' + base.frames, 'm = ' + base.bits, 'Ws (GBN/SR) = ' + runs[1].cfg.ws, 'Wr (SR) = ' + runs[2].cfg.wr,
      'lost frames = {' + E.parseList(base.lostFrames).join(', ') + '}', 'lost ACKs = {' + E.parseList(base.lostAcks).join(', ') + '}'
    ].map((t) => '<span>' + esc(t) + '</span>').join('');

    const ok = runs.filter((x) => x.r.exitCode === 0);
    const best = (key, low) => {
      const vals = ok.map((x) => x.r.stats[key]);
      return vals.length ? (low ? Math.min(...vals) : Math.max(...vals)) : null;
    };
    const cols = [
      ['delivered', 'Delivered', false], ['transmissions', 'Transmissions', true], ['retransmissions', 'Retransmissions', true],
      ['discarded', 'Discarded', true], ['timeouts', 'Timeouts', true], ['totalTime', 'Sim. time', true], ['efficiency', 'Efficiency %', false]
    ];
    const head = '<thead><tr><th>Protocol</th>' + cols.map((c) => '<th class="num">' + c[1] + '</th>').join('') + '</tr></thead>';
    const rows = runs.map(({ p, r }) => {
      const name = '<td><span class="proto"><span class="seg-dot ' + PROTOCOLS[p].color + '"></span>' + PROTOCOLS[p].name + '</span></td>';
      if (r.exitCode !== 0) return '<tr>' + name + '<td colspan="' + cols.length + '" class="err-cell">Invalid configuration: ' + esc(r.error) + '</td></tr>';
      return '<tr>' + name + cols.map(([k, , low]) => {
        const v = r.stats[k];
        const isBest = ok.length > 1 && v === best(k, low);
        return '<td class="num' + (isBest ? ' best' : '') + '">' + (k === 'efficiency' ? v.toFixed(2) : v) + '</td>';
      }).join('') + '</tr>';
    }).join('');
    $('#compareTable').innerHTML = head + '<tbody>' + rows + '</tbody>';

    const charts = [['retransmissions', 'Retransmissions'], ['totalTime', 'Simulated time (units)'], ['efficiency', 'Efficiency (%)']];
    $('#compareBars').innerHTML = charts.map(([k, title]) => {
      const max = Math.max(1, ...ok.map((x) => x.r.stats[k]));
      return '<div class="bar-card"><h4>' + title + '</h4>' + runs.map(({ p, r }) => {
        const v = r.exitCode === 0 ? r.stats[k] : null;
        return '<div class="bar-row"><span>' + PROTOCOLS[p].name + '</span><div class="bar-track"><i class="c-' + PROTOCOLS[p].color + '" style="width:' +
          (v === null ? 0 : (100 * v / max).toFixed(1)) + '%"></i></div><b>' + (v === null ? '—' : k === 'efficiency' ? v.toFixed(1) : v) + '</b></div>';
      }).join('') + '</div>';
    }).join('');

    // test-case matrix
    let mh = '<thead><tr><th>Test case</th>' + [1, 2, 3].map((p) => '<th>' + PROTOCOLS[p].name + '</th>').join('') + '</tr></thead><tbody>';
    PRESETS.forEach((pr, i) => {
      mh += '<tr><td><b>' + (i + 1) + '.</b> ' + pr.label + '</td>';
      [1, 2, 3].forEach((p) => {
        const v = pr.make(p);
        const r = E.simulate({ protocol: String(p), frames: String(v.frames), bits: String(v.bits), ws: String(v.ws), wr: String(v.wr), lostFrames: v.lf, lostAcks: v.la });
        if (r.exitCode !== 0) mh += '<td><span class="bad">Rejected</span><div class="muted" style="font-size:11px">' + esc(r.error) + '</div></td>';
        else {
          const s = r.stats;
          mh += '<td class="cell">' + s.delivered + ' delivered · ' + s.retransmissions + ' retx · t=' + s.totalTime +
            '<small>m=' + v.bits + ', Ws=' + (p === 1 ? 1 : v.ws) + (p === 3 ? ', Wr=' + v.wr : '') + (v.lf ? ', lose F{' + v.lf + '}' : '') + (v.la ? ', lose ACK{' + v.la + '}' : '') + '</small></td>';
        }
      });
      mh += '</tr>';
    });
    $('#matrixTable').innerHTML = mh + '</tbody>';
    state.compareRuns = runs;
  }

  function transcript(result) {
    let out = '';
    for (const s of result.trace.steps) {
      if (s.input !== undefined) out += s.input + '\n';
      else if (s.out) out += s.out;
    }
    return out;
  }

  function download(name, text) {
    const blob = new Blob([text], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  /* =================================== Misc =================================== */
  let toastTimer = 0;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2000);
  }

  function showFile(which) {
    $$('.file-tab').forEach((b) => b.classList.toggle('active', b.dataset.file === which));
    $('#code').hidden = which !== 'cpp';
    $('#stdinView').hidden = which !== 'stdin';
  }

  function setView(v) {
    state.view = v;
    $$('#viewNav button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
    $$('.view').forEach((s) => s.classList.toggle('active', s.id === 'view-' + v));
    if (v === 'compare') renderCompare();
    window.scrollTo({ top: 0 });
  }

  function bind() {
    $$('#protocolSeg button').forEach((b) => b.addEventListener('click', () => setProtocol(Number(b.dataset.p))));
    $$('#viewNav button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
    Object.values(F).forEach((input) => input.addEventListener('input', () => {
      $$('.preset').forEach((x) => x.classList.remove('active'));
      onConfigChange();
    }));
    $('#runBtn').addEventListener('click', compileAndRun);
    $('#runBtn2').addEventListener('click', () => {
      compileAndRun();
      if (window.innerWidth < 1180) $('.stage').scrollIntoView({ behavior: 'smooth' });
    });
    $('#pauseBtn').addEventListener('click', togglePause);
    $('#stepBtn').addEventListener('click', () => {
      if (!P.active || P.done) return;
      P.stepMode = true;
      P.playing = true;
      P.waitUntil = 0;
      P.last = performance.now();
      updateControls();
      setStatus('pause', 'Stepping');
    });
    $('#skipBtn').addEventListener('click', finishNow);
    $('#resetBtn').addEventListener('click', resetRun);
    $$('#speedSeg button').forEach((b) => b.addEventListener('click', () => {
      P.speed = Number(b.dataset.s);
      $$('#speedSeg button').forEach((x) => x.classList.toggle('active', x === b));
    }));
    $$('#stageTabs button').forEach((b) => b.addEventListener('click', () => {
      state.stage = b.dataset.stage;
      $$('#stageTabs button').forEach((x) => x.classList.toggle('active', x === b));
      $('#channelView').hidden = state.stage !== 'channel';
      $('#diagramView').hidden = state.stage !== 'diagram';
    }));
    $$('.file-tab').forEach((b) => b.addEventListener('click', () => showFile(b.dataset.file)));
    $('#followToggle').addEventListener('change', (e) => { state.follow = e.target.checked; });
    $('#copyBtn').addEventListener('click', () => {
      navigator.clipboard.writeText(state.source).then(() => toast('Source copied to clipboard'), () => toast('Copy failed'));
    });
    $('#clearTermBtn').addEventListener('click', () => { if (!P.active || P.done) termWelcome(); });
    $('#saveLogBtn').addEventListener('click', () => {
      if (!P.result) { toast('Run the program first'); return; }
      download('arq_' + PROTOCOLS[state.protocol].cls + '_log.txt', transcript(P.result));
    });
    $('#compareBtn').addEventListener('click', () => { renderCompare(); toast('Comparison updated'); });
    $('#downloadLogsBtn').addEventListener('click', () => {
      if (!state.compareRuns) renderCompare();
      const text = state.compareRuns.map(({ p, cfg, r }) =>
        '############ ' + PROTOCOLS[p].name.toUpperCase() + ' ############\n$ ./arq_simulator\n' + (r ? transcript(r) : '') +
        '\n[stdin: ' + stdinLines(cfg).join(' | ') + ']\n\n').join('');
      download('arq_execution_logs.txt', text);
    });
    window.addEventListener('resize', () => { relayout(); });
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); compileAndRun(); return; }
      const tag = (e.target.tagName || '').toLowerCase();
      if (e.code === 'Space' && tag !== 'input' && tag !== 'button' && state.view === 'sim' && P.active && !P.done) {
        e.preventDefault();
        togglePause();
      }
    });
  }

  function togglePause() {
    if (!P.active || P.done || P.compiling) return;
    P.playing = !P.playing;
    P.stepMode = false;
    if (P.playing) { P.last = performance.now(); P.waitUntil = 0; }
    updateControls();
  }

  async function init() {
    renderRules();
    renderPresets();
    syncFields();
    bind();
    termWelcome();
    renderMetrics();
    preview();
    updateControls();
    try {
      const res = await fetch('cpp/arq_simulator.cpp', { cache: 'no-cache' });
      if (!res.ok) throw new Error(res.status);
      buildEditor(await res.text());
    } catch (err) {
      $('#code').innerHTML = '<div style="padding:20px;color:#e11d48">Could not load cpp/arq_simulator.cpp. Serve the site over HTTP.</div>';
    }
    requestAnimationFrame(loop);
  }

  init();
})();
