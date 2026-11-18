import type { Part } from 'firebase/ai';
import { classify, describe, deviceAvailability, initDevice, type Source } from './ai.ts';
import { applyAltOnPage, collectFromPage, highlightOnPage, type PdfLink } from './page.ts';
import {
  GRADE_LABEL, gradeAlt, needsAI, ruleDecorative, shouldEscalate, tidyAlt,
  type AltGrade, type Kind, type PageImage,
} from './rules.ts';

type Status = 'skipped' | 'fine' | 'queued' | 'working' | 'review' | 'accepted' | 'error';

interface Item {
  img: PageImage;
  grade: AltGrade;
  status: Status;
  note: string; // why it was skipped, routed or failed
  kind?: Kind;
  hasPeople?: boolean;
  suggestion?: string;
  longDescription?: string;
  sources: Source[]; // every place this image was processed
  thumb?: string;
}

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

let items: Item[] = [];
let pdfs: PdfLink[] = [];
let page = { title: '', url: '' };
let tabId = 0;
let filter: 'todo' | 'all' = 'todo';
let strict = false;
let busy = false;

// ---------- on-device model status ----------

let downloadTried = false;
let pollTimer = 0;

async function refreshDevice() {
  const a = await deviceAvailability();
  const chip = $('#device');
  const text: Record<string, string> = {
    available: 'Gemini Nano ready',
    downloadable: downloadTried ? 'Gemini Nano not available here, using cloud' : 'Gemini Nano not downloaded yet',
    downloading: 'Gemini Nano downloading, using cloud meanwhile',
    unavailable: 'No on-device model here, using cloud',
    unsupported: 'No on-device model here, using cloud',
  };
  chip.textContent = text[a] ?? a;
  chip.dataset.state = a === 'available' ? 'ok' : a === 'downloading' || (a === 'downloadable' && !downloadTried) ? 'wait' : 'off';
  return a;
}

/** Starts the Nano download (needs a click) and polls until Chrome reports the model ready. */
function startDownload() {
  downloadTried = true;
  initDevice((f) => { $('#device').textContent = f < 1 ? `Downloading Gemini Nano ${Math.round(f * 100)}%` : 'Installing Gemini Nano…'; })
    .catch(() => {});
  clearInterval(pollTimer);
  let polls = 0;
  pollTimer = window.setInterval(async () => {
    const a = await refreshDevice();
    if (a === 'available' || ++polls > 60) clearInterval(pollTimer);
  }, 5000);
}

// ---------- image loading ----------

/** Fetches the image and re-encodes it as JPEG, max 768 px (what Gemini Nano sees anyway). */
async function loadImage(src: string): Promise<{ part: Part; thumb: string }> {
  const res = await fetch(src);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const url = URL.createObjectURL(await res.blob());
  try {
    const el = new Image();
    el.src = url;
    await el.decode();
    const scale = Math.min(1, 768 / Math.max(el.naturalWidth || 1, el.naturalHeight || 1));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round((el.naturalWidth || 300) * scale));
    canvas.height = Math.max(1, Math.round((el.naturalHeight || 150) * scale));
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    return { part: { type: 'inlineData', inlineData: { mimeType: 'image/jpeg', data: dataUrl.split(',')[1] } }, thumb: dataUrl };
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------- scan ----------

async function scan() {
  if (busy) return;
  busy = true;
  $('#scan').setAttribute('disabled', '');
  $('#error').textContent = '';
  try {
    // initializeDeviceModel must run inside the click, before the first prompt.
    const availability = await refreshDevice();
    if (availability === 'downloadable' || availability === 'downloading') startDownload();

    // ?target=<url part> lets the panel run in a normal tab for testing.
    const target = new URLSearchParams(location.search).get('target');
    const [tab] = target
      ? (await chrome.tabs.query({})).filter((t) => t.url?.includes(target))
      : await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https?:|^file:/.test(tab.url ?? '')) throw new Error('Open a web page first, then scan.');
    tabId = tab.id;
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func: collectFromPage });
    if (!result) throw new Error('Could not read this page.');
    page = { title: result.title, url: result.url };
    pdfs = result.pdfs;

    items = result.images.map((img): Item => {
      const grade = gradeAlt(img.alt);
      const decorative = ruleDecorative(img);
      // A decorative image with no alt attribute still fails WCAG: screen readers read the file name.
      // The fix is alt="", which needs no AI.
      if (decorative && img.alt === null && !img.hidden && !img.ariaHidden) {
        return { img, grade, status: 'review', note: `${decorative}: add an empty alt so screen readers skip it`, kind: 'decorative', suggestion: '', sources: [] };
      }
      if (decorative) return { img, grade, status: 'skipped', note: decorative, sources: [] };
      if (!needsAI(img, grade)) return { img, grade, status: 'fine', note: GRADE_LABEL[grade], sources: [] };
      return { img, grade, status: 'queued', note: '', sources: [] };
    });
    filter = 'todo';
    render();

    const queue = items.filter((i) => i.status === 'queued');
    for (const [n, item] of queue.entries()) {
      setProgress(`Checking image ${n + 1} of ${queue.length}`, n / queue.length);
      await processItem(item);
      render();
    }
    setProgress(queue.length ? `Done. ${queue.length} images checked.` : 'Nothing to fix on this page.', 1);
  } catch (e) {
    $('#error').textContent = e instanceof Error ? e.message : String(e);
    setProgress('', 0);
  } finally {
    busy = false;
    $('#scan').removeAttribute('disabled');
  }
}

async function processItem(item: Item) {
  item.status = 'working';
  render();
  try {
    const { part, thumb } = await loadImage(item.img.src);
    item.thumb = thumb;
    const c = await classify(item.img, part, page.title, strict);
    item.sources.push(c.source);
    item.kind = c.kind;
    item.hasPeople = c.has_people;
    item.suggestion = c.kind === 'decorative' ? '' : tidyAlt(c.alt);

    if (shouldEscalate(c)) {
      item.note = c.kind === 'complex' ? 'Chart or diagram: sent to cloud for a full description' : 'Contains text: sent to cloud to read it';
      render();
      const d = await describe(item.img, part, page.title);
      item.sources.push(d.source);
      item.suggestion = tidyAlt(d.alt);
      item.longDescription = d.long_description.trim();
    } else if (c.has_people) {
      item.note = c.source === 'on_device'
        ? 'People in photo: kept on this device'
        : 'People in photo. Gemini Nano is not ready, so this used the cloud. Turn on strict privacy to prevent that.';
    } else {
      item.note = '';
    }
    item.status = 'review';
  } catch (e) {
    item.status = 'error';
    item.note = errorText(e);
  }
}

function errorText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (/ONLY_ON_DEVICE|on-device model is not available/i.test(m)) return 'Strict privacy is on and no on-device model is ready';
  if (/HTTP|Failed to fetch|decode/i.test(m)) return 'Could not load this image';
  return m.slice(0, 140);
}

function setProgress(text: string, fraction: number) {
  $('#progress-text').textContent = text;
  $('#progress-bar').style.width = `${Math.round(fraction * 100)}%`;
}

// ---------- scoring and counters ----------

const OK_NOW: Status[] = ['skipped', 'fine'];
const OK_AFTER: Status[] = ['skipped', 'fine', 'accepted', 'review']; // review = a suggestion is ready

function score(list: Item[], after: boolean): number {
  if (!list.length) return 100;
  const ok = list.filter((i) => (after ? OK_AFTER : OK_NOW).includes(i.status)).length;
  return Math.round((ok / list.length) * 100);
}

// ---------- render ----------

function render() {
  const total = items.length;
  $('#summary').hidden = total === 0;
  if (!total) return;

  // Three tiers: rules only (no AI), Gemini Nano on this device, Gemini in the cloud.
  const cloud = items.filter((i) => i.sources.includes('in_cloud')).length;
  const device = items.filter((i) => i.sources.includes('on_device') && !i.sources.includes('in_cloud')).length;
  const rules = total - cloud - device;
  $('#page-title').textContent = page.title || page.url;
  $('#score-before').textContent = String(score(items, false));
  $('#score-after').textContent = String(score(items, true));
  $('#count-rules').textContent = String(rules);
  $('#count-local').textContent = String(device);
  $('#count-cloud').textContent = String(cloud);
  $('#meter-rules').style.flexGrow = String(rules);
  $('#meter-local').style.flexGrow = String(device);
  $('#meter-cloud').style.flexGrow = String(cloud);
  $('#privacy-line').textContent = `${total - cloud} of ${total} images never left this device`;

  const todo = items.filter((i) => !['skipped', 'fine', 'accepted'].includes(i.status));
  $('#tab-todo').textContent = `To fix (${todo.length})`;
  $('#tab-all').textContent = `All (${total})`;
  $('#tab-todo').ariaSelected = String(filter === 'todo');
  $('#tab-all').ariaSelected = String(filter === 'all');

  const shown = filter === 'todo' ? todo : items;
  $('#list').innerHTML = shown.length ? shown.map(card).join('') : `<p class="empty">Everything on this list is fixed.</p>`;
  renderPdfs();
}

const KIND_LABEL: Record<Kind, string> = { decorative: 'Decorative', informative: 'Informative', functional: 'Link or button', complex: 'Chart or diagram' };

function badges(i: Item): string {
  return [...new Set(i.sources)]
    .map((s) => s === 'on_device'
      ? `<span class="badge device" title="Processed by Gemini Nano on this computer">On device</span>`
      : `<span class="badge cloud" title="Processed by Gemini in the cloud">Cloud</span>`)
    .join('');
}

function card(i: Item): string {
  const id = i.img.id;
  const current = i.img.alt === null ? '<em>none</em>' : i.img.alt === '' ? '<em>empty</em>' : esc(i.img.alt);
  const thumb = `<img class="thumb" src="${esc(i.thumb ?? i.img.src)}" alt="" loading="lazy">`;
  const head = `<div class="card-head">${thumb}<div class="meta">
      <div class="chips"><span class="chip grade-${i.grade}">${GRADE_LABEL[i.grade]}</span>${i.kind ? `<span class="chip">${KIND_LABEL[i.kind]}</span>` : ''}${badges(i)}</div>
      <div class="current">Current alt: ${current}</div>
      ${i.note ? `<div class="note">${esc(i.note)}</div>` : ''}
    </div></div>`;

  let body = '';
  if (i.status === 'queued') body = `<div class="state">Waiting</div>`;
  else if (i.status === 'working') body = `<div class="state working">Reading image…</div>`;
  else if (i.status === 'review' || i.status === 'accepted') {
    body = `<label class="field-label" for="alt-${id}">Suggested alt text${i.kind === 'decorative' ? ' (empty, decorative)' : ''}</label>
      <textarea id="alt-${id}" data-id="${id}" rows="2" maxlength="250">${esc(i.suggestion ?? '')}</textarea>
      ${i.longDescription ? `<details><summary>Long description</summary><p>${esc(i.longDescription)}</p></details>` : ''}
      <div class="actions">
        ${i.status === 'accepted' ? `<span class="done">Accepted</span>` : `<button class="primary" data-act="accept" data-id="${id}">Accept</button>`}
        <button data-act="show" data-id="${id}">Show on page</button>
        <button data-act="copy" data-id="${id}">Copy HTML</button>
      </div>`;
  } else if (i.status === 'error') body = `<div class="actions"><button data-act="retry" data-id="${id}">Try again</button><button data-act="show" data-id="${id}">Show on page</button></div>`;
  else body = `<div class="actions"><button data-act="show" data-id="${id}">Show on page</button></div>`;

  return `<article class="card status-${i.status}">${head}${body}</article>`;
}

function renderPdfs() {
  const box = $('#pdfs');
  box.hidden = pdfs.length === 0;
  $('#pdf-count').textContent = String(pdfs.length);
  $('#pdf-list').innerHTML = pdfs.map((p) => `<li><a href="${esc(p.href)}" target="_blank" rel="noopener">${esc(p.text || p.href.split('/').pop() || p.href)}</a></li>`).join('');
}

// ---------- export ----------

function htmlFor(i: Item): string {
  const alt = esc(i.suggestion ?? '');
  const src = esc(i.img.src);
  if (!i.longDescription) return `<img src="${src}" alt="${alt}">`;
  const did = `desc-${i.img.id}`;
  return `<figure>\n  <img src="${src}" alt="${alt}" aria-describedby="${did}">\n  <details id="${did}">\n    <summary>Description of this image</summary>\n    <p>${esc(i.longDescription)}</p>\n  </details>\n</figure>`;
}

function csv(): string {
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const rows = [['page', 'image', 'current_alt', 'issue', 'type', 'suggested_alt', 'long_description', 'processed', 'status']];
  for (const i of items) {
    rows.push([page.url, i.img.src, i.img.alt ?? '', GRADE_LABEL[i.grade], i.kind ?? '', i.suggestion ?? '', i.longDescription ?? '',
      [...new Set(i.sources)].join('+') || 'rules only', i.status]);
  }
  return rows.map((r) => r.map(q).join(',')).join('\n');
}

function download(name: string, text: string, type: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function flash(btn: HTMLElement, text: string) {
  const old = btn.textContent;
  btn.textContent = text;
  setTimeout(() => { btn.textContent = old; }, 1400);
}

// ---------- events ----------

$('#scan').addEventListener('click', scan);
$('#tab-todo').addEventListener('click', () => { filter = 'todo'; render(); });
$('#tab-all').addEventListener('click', () => { filter = 'all'; render(); });
$('#export-csv').addEventListener('click', () => download(`altwise-${new URL(page.url).hostname}.csv`, csv(), 'text/csv'));
$('#copy-all').addEventListener('click', async (e) => {
  const done = items.filter((i) => i.status === 'accepted');
  await navigator.clipboard.writeText(done.map(htmlFor).join('\n\n'));
  flash(e.currentTarget as HTMLElement, done.length ? `Copied ${done.length}` : 'Accept some first');
});

$('#strict').addEventListener('change', (e) => {
  strict = (e.target as HTMLInputElement).checked;
  chrome.storage.local.set({ strict });
});

$('#list').addEventListener('input', (e) => {
  const t = e.target as HTMLTextAreaElement;
  const item = items.find((i) => i.img.id === Number(t.dataset.id));
  if (item) item.suggestion = t.value;
});

$('#list').addEventListener('click', async (e) => {
  const btn = (e.target as HTMLElement).closest('button');
  if (!btn) return;
  const item = items.find((i) => i.img.id === Number(btn.dataset.id));
  if (!item) return;
  const run = (func: (...a: never[]) => void, args: unknown[]) =>
    chrome.scripting.executeScript({ target: { tabId }, func: func as () => void, args: args as [] });
  switch (btn.dataset.act) {
    case 'show': await run(highlightOnPage, [item.img.id]); break;
    case 'copy': await navigator.clipboard.writeText(htmlFor(item)); flash(btn, 'Copied'); break;
    case 'accept':
      item.status = 'accepted';
      await run(applyAltOnPage, [item.img.id, item.suggestion ?? '']);
      render();
      break;
    case 'retry':
      if (busy) return;
      busy = true;
      await processItem(item);
      busy = false;
      render();
      break;
  }
});

chrome.storage.local.get('strict').then((v) => {
  strict = Boolean(v.strict);
  ($('#strict') as HTMLInputElement).checked = strict;
});
refreshDevice();
