const listeners = new Set();

export function toast(message, type = 'info') {
  const id = Date.now() + Math.random();
  listeners.forEach(fn => fn({ id, message, type }));
}

export function subscribeToast(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
