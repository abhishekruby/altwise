// Dev only: stands in for chrome.tabs / scripting / storage when the panel runs in dev/index.html.
const page = () => parent.document.getElementById('page').contentWindow;
window.chrome = {
  tabs: { query: async () => [{ id: 1, url: page().location.href }] },
  scripting: { executeScript: async ({ func, args = [] }) => [{ result: page().eval(`(${func})`)(...args) }] },
  storage: { local: { get: async () => ({}), set: async () => {} } },
};
