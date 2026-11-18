// Entry for the web version (try.html): the same panel as the extension, running in an iframe next to a
// same-origin demo page. This stands in for the few chrome.* APIs the panel uses, then loads the panel.

type Listener = (...a: unknown[]) => void;
type Injected = (...a: unknown[]) => unknown;

const frame = () => parent.document.getElementById('page') as HTMLIFrameElement;
const updated: Listener[] = [];
// When the demo page changes, tell the panel, so it can say its results are for another page.
frame().addEventListener('load', () => updated.forEach((f) => f(1, { status: 'complete' })));

const safe = (get: () => Storage): Storage | null => { try { return get(); } catch { return null; } };

function store(area: Storage | null) {
  return {
    get: async (key: string) => {
      try {
        const v = area?.getItem(`altwise:${key}`);
        return v ? { [key]: JSON.parse(v) } : {};
      } catch {
        return {};
      }
    },
    set: async (items: Record<string, unknown>) => {
      try {
        for (const [k, v] of Object.entries(items)) area?.setItem(`altwise:${k}`, JSON.stringify(v));
      } catch {
        // storage full or blocked: results just won't survive a reload
      }
    },
  };
}

(window as unknown as { chrome: unknown }).chrome = {
  tabs: {
    query: async () => [{ id: 1, url: frame().contentWindow!.location.href }],
    onActivated: { addListener() {} },
    onUpdated: { addListener: (f: Listener) => updated.push(f) },
  },
  scripting: {
    // The injected functions are self-contained by design (executeScript requires it), so they can be
    // re-created from their source inside the demo page.
    executeScript: async ({ func, args = [] }: { func: Injected; args?: unknown[] }) =>
      [{ result: (frame().contentWindow as unknown as { eval(s: string): Injected }).eval(`(${func})`)(...args) }],
  },
  storage: { local: store(safe(() => localStorage)), session: store(safe(() => sessionStorage)) },
};

import('./main.ts');
