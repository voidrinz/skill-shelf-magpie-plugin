import { embedded, request } from './api';

export async function initializeMagpie() {
  if (!embedded) return;
  let values = await request<Record<string, string>>('/window-storage');
  let saving = Promise.resolve<unknown>(undefined);
  function save() {
    const next = { ...values };
    saving = saving.then(() => request('/window-storage', 'PUT', next));
  }
  // Magpie's sandbox has no browser storage, including after frame navigation.
  const storage: Storage = {
    get length() { return Object.keys(values).length; },
    key(index) { return Object.keys(values)[index] ?? null; },
    getItem(key) { return values[key] ?? null; },
    setItem(key, value) {
      if (values[key] === String(value)) return;
      values[key] = String(value);
      save();
    },
    removeItem(key) { delete values[key]; save(); },
    clear() { values = {}; save(); },
  };
  Object.defineProperty(window, 'localStorage', { value: storage });
  const theme = new URLSearchParams(location.search).get('theme');
  if (!storage.getItem('shelf-theme') && theme) storage.setItem('shelf-theme', JSON.stringify(theme));

  const openUrl = (url: string) => request('/open-url', 'POST', { url });
  document.addEventListener('click', event => {
    const link = (event.target as Element).closest<HTMLAnchorElement>('a[target="_blank"]');
    if (!link) return;
    event.preventDefault();
    void openUrl(link.href);
  });
  window.open = url => { void openUrl(String(url)); return null; };
}
