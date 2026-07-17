'use strict';

const draft = document.getElementById('draft');
const backdrop = document.getElementById('backdrop');
const backdropContent = document.getElementById('backdropContent');
const readButton = document.getElementById('readButton');
const stopButton = document.getElementById('stopButton');
const clearButton = document.getElementById('clearButton');
const renderButton = document.getElementById('renderButton');
const exportButton = document.getElementById('exportButton');
const narrationInfo = document.getElementById('narrationInfo');
const speed = document.getElementById('speed');
const speedValue = document.getElementById('speedValue');
const selectionInfo = document.getElementById('selectionInfo');
const statusDot = document.getElementById('statusDot');
const statusTitle = document.getElementById('statusTitle');
const statusDetail = document.getElementById('statusDetail');

let ready = false;
let audioContext = null;
let currentSource = null;
let worker = null;
const openedDirectly = window.location.protocol === 'file:';

if (!openedDirectly) {
  worker = new Worker('sherpa-onnx-tts.worker.js', {type: 'module'});
}

/* ---------------------------------------------------------------- *
 * Sentence segmentation
 * ---------------------------------------------------------------- */

const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'rev', 'sr', 'jr', 'st', 'vs', 'etc',
  'cf', 'al', 'fig', 'no', 'vol', 'pp', 'approx', 'dept', 'est', 'inc',
  'ltd', 'co', 'mt', 'ft', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul',
  'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
]);
const TERMINATORS = '.!?\u2026';
const CLOSERS = "\"')]}\u2019\u201d";
const MAX_CHUNK = 600;

function segmentText(text, from, to) {
  const spans = [];
  let start = from;

  const flush = (s, e) => {
    let a = s;
    let b = e;
    while (a < b && /\s/.test(text[a])) a++;
    while (b > a && /\s/.test(text[b - 1])) b--;
    if (a < b) spans.push({start: a, end: b});
  };

  for (let i = from; i < to; i++) {
    const ch = text[i];
    if (ch === '\n') {
      flush(start, i);
      start = i + 1;
      continue;
    }
    if (!TERMINATORS.includes(ch)) continue;

    let j = i + 1;
    while (j < to && TERMINATORS.includes(text[j])) j++;
    const punctEnd = j;
    while (j < to && CLOSERS.includes(text[j])) j++;

    if (j < to && !/\s/.test(text[j])) {
      i = j - 1;
      continue;
    }

    if (ch === '.' && punctEnd === i + 1) {
      let w = i;
      while (w > from && /[A-Za-z0-9.]/.test(text[w - 1])) w--;
      const token = text.slice(w, i);
      const atLineStart = w === from || text[w - 1] === '\n';
      if (/^\d{1,3}$/.test(token) && atLineStart) {
        i = j - 1;
        continue;
      }
      if (/^[A-Za-z]/.test(token)) {
        const lower = token.toLowerCase();
        if (token.length === 1 || lower.includes('.') || ABBREVIATIONS.has(lower)) {
          i = j - 1;
          continue;
        }
      }
    }

    flush(start, j);
    start = j;
    i = j - 1;
  }
  flush(start, to);

  const out = [];
  for (const span of spans) chunkLong(text, span, out);
  return out;
}

function chunkLong(text, span, out) {
  let s = span.start;
  while (span.end - s > MAX_CHUNK) {
    let cut = -1;
    for (let k = s + MAX_CHUNK; k > s + 40; k--) {
      if (/\s/.test(text[k])) {
        cut = k;
        break;
      }
    }
    if (cut < 0) cut = s + MAX_CHUNK;
    out.push({start: s, end: cut});
    s = cut;
    while (s < span.end && /\s/.test(text[s])) s++;
  }
  if (s < span.end) out.push({start: s, end: span.end});
}

function buildSegments(text, from, to) {
  const spd = Number(speed.value);
  return segmentText(text, from, to).map((s) => {
    const spoken = text.slice(s.start, s.end).replace(/\s+/g, ' ').trim();
    return {
      start: s.start,
      end: s.end,
      text: spoken,
      speed: spd,
      key: spd.toFixed(2) + '|' + spoken,
    };
  });
}

/* ---------------------------------------------------------------- *
 * Sentence audio cache
 *
 * Content-addressed: the key is the exact spoken text plus the speed
 * it was generated at. When the draft is edited and re-rendered,
 * unchanged sentences are cache hits and are never sent to the engine
 * again -- only changed or new sentences are synthesized. Reordering
 * or moving sentences costs nothing. The cache backs both F8 playback
 * (instant replay of anything already rendered) and WAV export.
 * ---------------------------------------------------------------- */

const sentenceCache = new Map(); // key -> {samples: Float32Array, sampleRate}
let cacheBytes = 0;
const CACHE_LIMIT_BYTES = 800 * 1024 * 1024;

function cacheStore(key, audio) {
  if (sentenceCache.has(key)) return;
  sentenceCache.set(key, audio);
  cacheBytes += audio.samples.length * 4;
  // Evict oldest entries when over the soft cap, but never while a
  // full render is in progress (export needs every sentence present).
  if (mode !== 'rendering') {
    for (const [k, v] of sentenceCache) {
      if (cacheBytes <= CACHE_LIMIT_BYTES) break;
      sentenceCache.delete(k);
      cacheBytes -= v.samples.length * 4;
    }
  }
}

/* ---------------------------------------------------------------- *
 * Engine pipeline
 *
 * One activity at a time: mode is 'idle', 'playing' (F8 continuous
 * read with follow-along highlight), or 'rendering' (walking every
 * sentence into the cache for export, no audio output). The worker is
 * FIFO and does not echo request metadata, so requestQueue maps each
 * result back to its request; results from a cancelled run are still
 * cached (they are valid audio for their key) but never played.
 * ---------------------------------------------------------------- */

let mode = 'idle';
let segments = [];
let playPos = 0;
let genPos = 0;
let runToken = 0;
let sourceToken = 0;
let renderReused = 0;
const requestQueue = [];

function setStatus(kind, title, detail) {
  statusDot.className = `dot ${kind}`;
  statusTitle.textContent = title;
  statusDetail.textContent = detail;
}

function updateButtons() {
  readButton.disabled = !ready || mode !== 'idle';
  stopButton.disabled = mode === 'idle';
  if (mode !== 'idle') {
    renderButton.disabled = true;
    exportButton.disabled = true;
  } else {
    refreshNarrationInfo();
  }
}

function describeSelection() {
  const startSel = draft.selectionStart;
  const endSel = draft.selectionEnd;
  if (startSel !== endSel) {
    const count = draft.value.slice(startSel, endSel).trim().length;
    selectionInfo.textContent = count > 0
      ? `${count} characters selected. F8 reads just the selection.`
      : 'The selection contains no readable text.';
  } else {
    selectionInfo.textContent = 'F8 reads aloud from the cursor to the end. Esc stops.';
  }
}

function pumpGenerator() {
  if (mode === 'idle' || !worker) return;
  if (requestQueue.some((r) => r.token === runToken)) return; // one in flight

  if (mode === 'playing') {
    while (
      genPos < segments.length &&
      genPos <= playPos + 1 &&
      sentenceCache.has(segments[genPos].key)
    ) genPos++;
    if (genPos >= segments.length || genPos > playPos + 1) return;
    // If any queued request (even from a cancelled run) covers this key,
    // its result will land in the cache shortly -- don't synthesize twice.
    if (requestQueue.some((r) => r.key === segments[genPos].key)) return;
    postGenerate(genPos++);
    return;
  }

  // rendering
  let advanced = false;
  while (genPos < segments.length && sentenceCache.has(segments[genPos].key)) {
    renderReused++;
    genPos++;
    advanced = true;
  }
  if (advanced) showRenderProgress();
  if (genPos >= segments.length) {
    finishRender();
    return;
  }
  if (requestQueue.some((r) => r.key === segments[genPos].key)) return;
  postGenerate(genPos++);
}

function postGenerate(index) {
  const seg = segments[index];
  requestQueue.push({token: runToken, index, key: seg.key});
  worker.postMessage({type: 'generate', text: seg.text, sid: 0, speed: seg.speed});
}

function handleResult(message) {
  const req = requestQueue.shift();
  if (!req) return;
  cacheStore(req.key, {samples: message.samples, sampleRate: message.sampleRate});
  // A result is useful whichever run requested it: the cache is
  // content-addressed, so even a cancelled run's result can complete
  // the sentence the current run is waiting on.
  if (mode === 'playing') {
    if (!currentSource && segments[playPos] && sentenceCache.has(segments[playPos].key)) {
      void playSegment();
    }
  } else if (mode === 'rendering' && req.token === runToken) {
    showRenderProgress();
  }
  pumpGenerator();
}

/* --------------------------- F8 playback ------------------------- */

function startReading() {
  if (!ready) return;
  if (!worker) {
    setStatus('error', 'Start with the launcher', 'Do not open shared/index.html directly. Open START - WINDOWS.exe, START - MACOS.app, or START - LINUX.sh.');
    return;
  }
  if (mode !== 'idle') stopAll({restarting: true});

  const text = draft.value;
  if (!text.trim()) {
    setStatus('error', 'Nothing to read', 'Paste text or place the cursor first.');
    return;
  }

  const selStart = draft.selectionStart;
  const selEnd = draft.selectionEnd;
  if (selStart !== selEnd) {
    segments = buildSegments(text, selStart, selEnd);
  } else {
    const all = buildSegments(text, 0, text.length);
    const first = all.findIndex((s) => s.end > selStart);
    segments = first >= 0 ? all.slice(first) : [];
  }
  if (!segments.length) {
    setStatus('error', 'Nothing to read', 'The selection contains no readable text.');
    return;
  }

  mode = 'playing';
  playPos = 0;
  genPos = 0;
  renderHighlight(segments[0]);
  setStatus('loading', 'Generating speech…', 'The first sentence is being prepared.');
  updateButtons();
  pumpGenerator();
  if (!currentSource && sentenceCache.has(segments[playPos].key)) void playSegment();
}

async function playSegment() {
  const seg = segments[playPos];
  const audio = sentenceCache.get(seg.key);
  if (!audio) return;
  renderHighlight(seg);

  audioContext ??= new AudioContext();
  await audioContext.resume();
  if (mode !== 'playing') return;

  const buffer = audioContext.createBuffer(1, audio.samples.length, audio.sampleRate);
  buffer.getChannelData(0).set(audio.samples);
  const source = audioContext.createBufferSource();
  source.buffer = buffer;
  source.connect(audioContext.destination);
  currentSource = source;
  const token = ++sourceToken;
  source.onended = () => {
    if (token === sourceToken) advance();
  };

  setStatus(
    'speaking',
    segments.length > 1 ? `Reading ${playPos + 1} of ${segments.length}` : 'Speaking…',
    'Press Esc or Stop to interrupt. F8 restarts from the cursor.'
  );
  updateButtons();
  source.start();
  pumpGenerator();
}

function advance() {
  currentSource = null;
  playPos++;
  if (playPos >= segments.length) {
    finishReading();
    return;
  }
  if (sentenceCache.has(segments[playPos].key)) {
    void playSegment();
  } else {
    renderHighlight(segments[playPos]);
    setStatus('loading', `Generating ${playPos + 1} of ${segments.length}…`, 'The next sentence is being prepared.');
    updateButtons();
    pumpGenerator();
  }
}

function finishReading() {
  const last = segments[segments.length - 1];
  mode = 'idle';
  runToken++;
  segments = [];
  clearHighlight();
  if (last) draft.setSelectionRange(last.end, last.end);
  setStatus('ready', 'Finished reading', 'Place the cursor and press F8 to read again.');
  updateButtons();
  describeSelection();
}

/* ------------------------ Render and export ---------------------- */

function startRender() {
  if (!ready) return;
  if (!worker) {
    setStatus('error', 'Start with the launcher', 'Do not open shared/index.html directly. Open START - WINDOWS.exe, START - MACOS.app, or START - LINUX.sh.');
    return;
  }
  if (mode !== 'idle') stopAll({restarting: true});

  const text = draft.value;
  if (!text.trim()) {
    setStatus('error', 'Nothing to render', 'Paste text first.');
    return;
  }
  segments = buildSegments(text, 0, text.length);
  if (!segments.length) {
    setStatus('error', 'Nothing to render', 'The draft contains no readable text.');
    return;
  }

  mode = 'rendering';
  playPos = 0;
  genPos = 0;
  renderReused = 0;
  updateButtons();
  showRenderProgress();
  pumpGenerator();
}

function showRenderProgress() {
  if (mode !== 'rendering') return;
  const total = segments.length;
  const current = Math.min(genPos, total - 1);
  setStatus(
    'loading',
    `Rendering ${Math.min(genPos + 1, total)} of ${total}…`,
    renderReused > 0
      ? `${renderReused} unchanged sentence${renderReused === 1 ? '' : 's'} reused. Esc cancels.`
      : 'Every sentence is stored, so edits only re-render what changed. Esc cancels.'
  );
  if (segments[current]) renderHighlight(segments[current]);
}

function finishRender() {
  const total = segments.length;
  mode = 'idle';
  runToken++;
  segments = [];
  clearHighlight();
  setStatus(
    'ready',
    'Narration ready',
    `${total} sentence${total === 1 ? '' : 's'} rendered, ${renderReused} reused. Export a WAV or keep editing.`
  );
  updateButtons();
  describeSelection();
}

function narrationState() {
  const text = draft.value;
  if (!text.trim()) return {total: 0, missing: 0, segs: []};
  const segs = buildSegments(text, 0, text.length);
  let missing = 0;
  for (const s of segs) {
    if (!sentenceCache.has(s.key)) missing++;
  }
  return {total: segs.length, missing, segs};
}

function refreshNarrationInfo() {
  const {total, missing} = narrationState();
  if (!total) {
    narrationInfo.textContent = 'Paste text, render it once, then export a WAV. Edits only re-render changed sentences.';
  } else if (missing === 0) {
    narrationInfo.textContent = `All ${total} sentence${total === 1 ? '' : 's'} rendered. Ready to export.`;
  } else if (missing === total) {
    narrationInfo.textContent = `${total} sentence${total === 1 ? '' : 's'} to render.`;
  } else {
    narrationInfo.textContent = `${missing} of ${total} sentences changed and need rendering.`;
  }
  renderButton.disabled = !ready || mode !== 'idle' || total === 0 || missing === 0;
  exportButton.disabled = !ready || mode !== 'idle' || total === 0 || missing > 0;
  if (total > 0 && missing === 0) renderButton.disabled = true;
}

function exportWav() {
  const {total, missing, segs} = narrationState();
  if (!total || missing > 0) {
    refreshNarrationInfo();
    return;
  }
  const text = draft.value;
  const sampleRate = sentenceCache.get(segs[0].key).sampleRate;
  const SENTENCE_GAP = Math.round(sampleRate * 0.35);
  const PARAGRAPH_GAP = Math.round(sampleRate * 0.75);
  const CHUNK_GAP = Math.round(sampleRate * 0.12);

  const parts = [];
  let totalSamples = 0;
  segs.forEach((seg, i) => {
    if (i > 0) {
      const prev = segs[i - 1];
      const prevChar = text[prev.end - 1] || '';
      const between = text.slice(prev.end, seg.start);
      let gap;
      if (!TERMINATORS.includes(prevChar) && !/[:;,]/.test(prevChar)) {
        gap = CHUNK_GAP; // continuation of a long split sentence
      } else if (/\n[^\S\n]*\n/.test(between)) {
        gap = PARAGRAPH_GAP;
      } else {
        gap = SENTENCE_GAP;
      }
      parts.push(gap);
      totalSamples += gap;
    }
    const audio = sentenceCache.get(seg.key);
    parts.push(audio.samples);
    totalSamples += audio.samples.length;
  });

  const pcm = new Int16Array(totalSamples); // silence gaps stay zero
  let offset = 0;
  for (const part of parts) {
    if (typeof part === 'number') {
      offset += part;
      continue;
    }
    for (let i = 0; i < part.length; i++) {
      const v = Math.max(-1, Math.min(1, part[i]));
      pcm[offset++] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
  }

  const wav = new ArrayBuffer(44 + pcm.length * 2);
  const dv = new DataView(wav);
  const writeStr = (at, s) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(at + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  dv.setUint32(4, 36 + pcm.length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);  // PCM
  dv.setUint16(22, 1, true);  // mono
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  writeStr(36, 'data');
  dv.setUint32(40, pcm.length * 2, true);
  new Int16Array(wav, 44).set(pcm);

  const blob = new Blob([wav], {type: 'audio/wav'});
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'read-aloud-narration.wav';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 30000);

  const seconds = Math.round(totalSamples / sampleRate);
  const mm = Math.floor(seconds / 60);
  const ss = String(seconds % 60).padStart(2, '0');
  setStatus('ready', 'WAV exported', `${total} sentence${total === 1 ? '' : 's'}, about ${mm}:${ss} of audio.`);
}

/* ----------------------------- Stop ------------------------------ */

function stopAll({restarting = false, keepCaret = false} = {}) {
  if (mode === 'idle' && !currentSource) return;
  const wasPlaying = mode === 'playing';
  const seg = segments[playPos];
  runToken++;
  sourceToken++;
  if (currentSource) {
    const source = currentSource;
    currentSource = null;
    source.onended = null;
    try {
      source.stop();
    } catch (_) {
      // The source may already have stopped.
    }
  }
  mode = 'idle';
  segments = [];
  playPos = 0;
  genPos = 0;
  clearHighlight();
  if (!restarting) {
    if (wasPlaying && seg && !keepCaret) draft.setSelectionRange(seg.start, seg.start);
    setStatus('ready', 'Stopped', wasPlaying ? 'Press F8 to resume from this sentence.' : 'Rendering cancelled. Finished sentences are kept.');
    updateButtons();
    describeSelection();
  }
}

/* ------------------------ Follow-along highlight ------------------ */

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderHighlight(seg) {
  const text = draft.value;
  backdropContent.innerHTML =
    escapeHtml(text.slice(0, seg.start)) +
    '<mark>' + escapeHtml(text.slice(seg.start, seg.end)) + '</mark>' +
    escapeHtml(text.slice(seg.end)) + '\n';
  const markEl = backdropContent.querySelector('mark');
  if (markEl) {
    const markTop = markEl.offsetTop;
    const markBottom = markTop + markEl.offsetHeight;
    const viewTop = draft.scrollTop;
    const viewBottom = viewTop + draft.clientHeight;
    if (markTop < viewTop + 8 || markBottom > viewBottom - 8) {
      const target = markTop - draft.clientHeight * 0.35;
      draft.scrollTop = Math.max(0, Math.min(target, draft.scrollHeight - draft.clientHeight));
    }
  }
  syncBackdropScroll();
}

function clearHighlight() {
  backdropContent.textContent = '';
  syncBackdropScroll();
}

function syncBackdropScroll() {
  backdrop.scrollTop = draft.scrollTop;
  backdrop.scrollLeft = draft.scrollLeft;
}

/* --------------------- Worker wiring and events ------------------- */

if (worker) worker.onmessage = (event) => {
  const message = event.data || {};
  switch (message.type) {
    case 'sherpa-onnx-tts-progress': {
      const raw = String(message.status || 'Loading voice…');
      const match = raw.match(/Downloading data\.\.\. \((\d+)\/(\d+)\)/);
      if (match) {
        const received = Number(match[1]);
        const total = Number(match[2]);
        const percent = total > 0 ? Math.round((received / total) * 100) : 0;
        setStatus('loading', `Loading Lessac High… ${percent}%`, 'Reading the offline model from this drive.');
      } else {
        setStatus('loading', 'Loading Lessac High…', raw.replace('Running...', 'Initializing the voice model…'));
      }
      break;
    }
    case 'sherpa-onnx-tts-ready':
      ready = true;
      setStatus('ready', 'Lessac High is ready', 'Place the cursor and press F8, or render the whole draft below.');
      updateButtons();
      break;
    case 'sherpa-onnx-tts-result':
      handleResult(message);
      break;
    case 'error': {
      const req = requestQueue.shift();
      if (req && req.token === runToken && mode !== 'idle') {
        stopAll({restarting: true});
      }
      setStatus('error', 'Voice error', String(message.message || 'The speech engine failed.'));
      updateButtons();
      describeSelection();
      break;
    }
    default:
      break;
  }
};

if (worker) worker.onerror = (event) => {
  ready = false;
  stopAll({restarting: true});
  setStatus('error', 'Could not load the voice', event.message || 'Check that the generated WASM files are present.');
  updateButtons();
};

readButton.addEventListener('click', startReading);
stopButton.addEventListener('click', () => stopAll());
renderButton.addEventListener('click', startRender);
exportButton.addEventListener('click', exportWav);
clearButton.addEventListener('click', () => {
  stopAll({restarting: true});
  draft.value = '';
  draft.focus();
  if (ready) setStatus('ready', 'Lessac High is ready', 'Paste text, then press F8 or render the draft.');
  updateButtons();
  describeSelection();
});

speed.addEventListener('input', () => {
  speedValue.value = `${Number(speed.value).toFixed(2)}×`;
  if (mode === 'idle') refreshNarrationInfo();
});

for (const eventName of ['select', 'keyup', 'click']) {
  draft.addEventListener(eventName, describeSelection);
}

draft.addEventListener('input', () => {
  if (mode !== 'idle') {
    stopAll({keepCaret: true});
    if (ready) setStatus('ready', 'Lessac High is ready', 'Press F8 to read, or render the draft below.');
    updateButtons();
  } else {
    refreshNarrationInfo();
  }
  describeSelection();
});

draft.addEventListener('scroll', syncBackdropScroll);

if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(() => {
    if (mode !== 'idle' && segments[Math.min(playPos, segments.length - 1)]) {
      renderHighlight(segments[Math.min(playPos, segments.length - 1)]);
    }
    syncBackdropScroll();
  }).observe(draft);
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'F8') {
    event.preventDefault();
    startReading();
  } else if (event.key === 'Escape') {
    stopAll();
  }
});

window.addEventListener('beforeunload', () => {
  stopAll({restarting: true});
  if (worker) worker.terminate();
  if (audioContext) void audioContext.close();
});

describeSelection();
updateButtons();

if (openedDirectly) {
  setStatus('error', 'Start with the launcher', 'This page cannot load the voice from file://. Open the matching START launcher in the parent folder.');
}
