import type { Part } from 'firebase/ai';
import { classify, describe, deviceAvailability, initDevice, loadSettings, reviewPdf, settings, type PdfReview, type Source } from './ai.ts';
import { applyAltOnPage, clearMarks, collectFromPage, highlightOnPage, markOnPage, type PdfLink } from './page.ts';
import { pdfFacts, vagueLinkText, type PdfFacts } from './pdf.ts';
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

interface PdfItem {
  link: PdfLink;
  status: 'queued' | 'working' | 'done' | 'error';
  facts?: PdfFacts;
  review?: PdfReview;
  sizeKb?: number;
  note?: string;
}

let items: Item[] = [];
let pdfs: PdfItem[] = [];
let page = { title: '', url: '' };
let tabId = 0;
let filter: 'todo' | 'all' | 'pdf' = 'todo';
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
    downloadable: downloadTried ? 'No Nano here · using cloud' : 'Gemini Nano not downloaded',
    downloading: 'Nano downloading · cloud for now',
    unavailable: 'No Nano here · using cloud',
    unsupported: 'No Nano here · using cloud',
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
    await inPage(clearMarks, []);
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func: collectFromPage });
    if (!result) throw new Error('Could not read this page.');
    page = { title: result.title, url: result.url };
    pdfs = result.pdfs.map((link) => ({ link, status: 'queued' }));

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
    $('#empty').hidden = true;
    render();
    for (const i of items.filter((i) => i.status === 'review')) await inPage(markOnPage, [i.img.id, 'Rules: alt=""', 'rules', false]);

    const waiting = items.filter((i) => i.status === 'queued');
    const queue = waiting.slice(0, settings.max_images);
    for (const extra of waiting.slice(settings.max_images)) {
      extra.status = 'error';
      extra.note = `Not checked: this scan stops at ${settings.max_images} images`;
    }
    const steps = queue.length + pdfs.length;
    for (const [n, item] of queue.entries()) {
      setProgress(`Checking image ${n + 1} of ${queue.length}`, n / steps);
      await processItem(item);
      render();
    }
    for (const [n, p] of pdfs.entries()) {
      setProgress(`Checking PDF ${n + 1} of ${pdfs.length} in the cloud`, (queue.length + n) / steps);
      await processPdf(p);
      render();
    }
    setProgress(steps ? `Done. ${queue.length} images and ${pdfs.length} PDFs checked.` : 'Nothing to fix on this page.', 1);
  } catch (e) {
    $('#error').textContent = e instanceof Error ? e.message : String(e);
    setProgress('', 0);
  } finally {
    busy = false;
    $('#scan').removeAttribute('disabled');
  }
}

async function inPage(func: (...a: never[]) => void, args: unknown[]) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: func as () => void, args: args as [] });
  } catch {
    // the tab navigated away; the panel keeps working
  }
}

async function processItem(item: Item) {
  item.status = 'working';
  render();
  await inPage(markOnPage, [item.img.id, 'Reading…', 'working', true]);
  try {
    const { part, thumb } = await loadImage(item.img.src);
    item.thumb = thumb;
    const c = await classify(item.img, part, page.title, strict);
    item.sources.push(c.source);
    item.kind = c.kind;
    item.hasPeople = c.has_people;
    item.suggestion = c.kind === 'decorative' ? '' : tidyAlt(c.alt);

    if (shouldEscalate(c, settings.escalate_text_images)) {
      item.note = c.kind === 'complex' ? 'Chart or diagram: sent to cloud for a full description' : 'Contains text: sent to cloud to read it';
      render();
      await inPage(markOnPage, [item.img.id, 'Sending to cloud…', 'working', false]);
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
    const cloud = item.sources.includes('in_cloud');
    const label = cloud ? (item.sources.includes('on_device') ? 'Nano → Cloud' : 'Cloud') : 'On device';
    await inPage(markOnPage, [item.img.id, `${label} · ${KIND_LABEL[item.kind!]}`, cloud ? 'cloud' : 'device', false]);
  } catch (e) {
    item.status = 'error';
    item.note = errorText(e);
    await inPage(markOnPage, [item.img.id, 'Not checked', 'rules', false]);
  }
}

const toBase64 = (buf: ArrayBuffer) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1]);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(new Blob([buf]));
});

/** Structure checks run locally on the bytes; the content review needs the cloud (PDF input is cloud only). */
async function processPdf(p: PdfItem) {
  p.status = 'working';
  render();
  try {
    const res = await fetch(p.link.href);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    p.sizeKb = Math.round(buf.byteLength / 1024);
    p.facts = await pdfFacts(buf);
    if (buf.byteLength > settings.pdf_max_mb * 1024 * 1024) {
      p.note = `Larger than ${settings.pdf_max_mb} MB, so only the structure was checked`;
    } else {
      p.review = await reviewPdf(await toBase64(buf), p.link.text, page.title);
    }
    p.status = 'done';
  } catch (e) {
    p.status = 'error';
    p.note = errorText(e);
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
  $('#tabs').hidden = total === 0;
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
  $('#tab-pdf').textContent = `PDFs (${pdfs.length})`;
  $('#tab-pdf').hidden = pdfs.length === 0;
  for (const t of ['todo', 'all', 'pdf'] as const) $(`#tab-${t}`).ariaSelected = String(filter === t);
  $('#list').hidden = filter === 'pdf';
  $('#pdfs').hidden = filter !== 'pdf';
  const reviewable = items.filter((i) => i.status === 'review').length;
  $('#accept-all').textContent = reviewable ? `Accept all ${reviewable}` : 'Accept all';
  $('#accept-all').toggleAttribute('disabled', !reviewable);

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

function pdfChecks(p: PdfItem): [string, boolean][] {
  const f = p.facts!;
  return [
    ['Real text, not a scanned image', f.hasText && !p.review?.scanned],
    ['Tagged for screen readers', f.tagged],
    ['Has a descriptive title', f.title],
    ['Language is set', f.lang],
    ['Link text names the document', !vagueLinkText(p.link.text)],
  ];
}

const pdfPasses = (p: PdfItem) => p.status === 'done' && pdfChecks(p).every(([, ok]) => ok);

function pdfCard(p: PdfItem, n: number): string {
  const name = p.link.text || p.link.href.split('/').pop() || p.link.href;
  const head = `<div class="pdf-head"><a href="${esc(p.link.href)}" target="_blank" rel="noopener">${esc(name)}</a>
    ${p.review ? '<span class="badge cloud" title="Read by Gemini in the cloud. PDF input is cloud only.">Cloud</span>' : ''}
    ${p.sizeKb ? `<span class="size">${p.sizeKb} KB</span>` : ''}</div>`;
  if (p.status === 'queued') return `<article class="card">${head}<div class="state">Waiting</div></article>`;
  if (p.status === 'working') return `<article class="card">${head}<div class="state working">Reading PDF…</div></article>`;
  if (p.status === 'error') return `<article class="card">${head}<div class="note">${esc(p.note ?? '')}</div></article>`;

  const checks = pdfChecks(p).map(([label, ok]) =>
    `<li class="${ok ? 'pass' : 'fail'}"><span aria-hidden="true">${ok ? '✓' : '✕'}</span> ${label}<span class="sr"> ${ok ? 'passes' : 'needs a fix'}</span></li>`).join('');
  const r = p.review;
  const review = r ? `
    <p class="summary">${esc(r.summary)}</p>
    ${r.issues.length ? `<details><summary>${r.issues.length} problem${r.issues.length > 1 ? 's' : ''} inside the document</summary><ul>${r.issues.map((i) => `<li>${esc(i)}</li>`).join('')}</ul></details>` : ''}
    <label class="field-label" for="pdf-link-${n}">Suggested link text</label>
    <textarea id="pdf-link-${n}" data-pdf="${n}" rows="1">${esc(r.link_text)}</textarea>
    <div class="note">Suggested title: ${esc(r.title)}</div>
    <div class="actions"><button data-act="copy-pdf" data-pdf="${n}">Copy link HTML</button></div>` : p.note ? `<div class="note">${esc(p.note)}</div>` : '';
  return `<article class="card">${head}<ul class="checks">${checks}</ul>${review}</article>`;
}

function renderPdfs() {
  const done = pdfs.filter((p) => p.status === 'done');
  $('#pdf-count').textContent = done.length ? `${pdfs.filter(pdfPasses).length} of ${pdfs.length} pass` : String(pdfs.length);
  $('#pdf-list').innerHTML = pdfs.map(pdfCard).join('');
}

function pdfLinkHtml(p: PdfItem): string {
  return `<a href="${esc(p.link.href)}">${esc(p.review?.link_text ?? p.link.text)}${p.sizeKb ? `, ${p.sizeKb} KB` : ''}</a>`;
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
  for (const p of pdfs) {
    const failed = p.facts ? pdfChecks(p).filter(([, ok]) => !ok).map(([l]) => l).join('; ') : p.note ?? '';
    rows.push([page.url, p.link.href, p.link.text, failed, 'pdf', p.review?.link_text ?? '', [p.review?.summary, ...(p.review?.issues ?? [])].filter(Boolean).join(' '),
      p.review ? 'in_cloud' : 'rules only', p.status]);
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
$('#tab-pdf').addEventListener('click', () => { filter = 'pdf'; render(); });
$('#accept-all').addEventListener('click', async () => {
  for (const i of items.filter((i) => i.status === 'review')) {
    i.status = 'accepted';
    await inPage(applyAltOnPage, [i.img.id, i.suggestion ?? '']);
  }
  render();
});
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

$('#pdf-list').addEventListener('input', (e) => {
  const t = e.target as HTMLTextAreaElement;
  const p = pdfs[Number(t.dataset.pdf)];
  if (p?.review) p.review.link_text = t.value;
});

$('#pdf-list').addEventListener('click', async (e) => {
  const btn = (e.target as HTMLElement).closest('button');
  const p = btn && pdfs[Number(btn.dataset.pdf)];
  if (!btn || !p) return;
  await navigator.clipboard.writeText(pdfLinkHtml(p));
  flash(btn, 'Copied');
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
  switch (btn.dataset.act) {
    case 'show': await inPage(highlightOnPage, [item.img.id]); break;
    case 'copy': await navigator.clipboard.writeText(htmlFor(item)); flash(btn, 'Copied'); break;
    case 'accept':
      item.status = 'accepted';
      await inPage(applyAltOnPage, [item.img.id, item.suggestion ?? '']);
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
loadSettings();
