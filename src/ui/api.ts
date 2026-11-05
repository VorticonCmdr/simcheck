type Listener = (message: any) => void;

let port: chrome.runtime.Port | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
const listeners = new Set<Listener>();

function connect(): chrome.runtime.Port {
  const opened = chrome.runtime.connect({ name: "workspace" });
  opened.onMessage.addListener((message) => {
    if (message.replyTo !== undefined) {
      const request = pending.get(message.replyTo);
      pending.delete(message.replyTo);
      if (message.error) request?.reject(new Error(message.error));
      else request?.resolve(message.result);
    } else {
      listeners.forEach((listener) => listener(message));
    }
  });
  // The service worker stops when idle, which closes the port. Reconnecting wakes
  // it, and it replies with the job list, so nothing is missed in between.
  opened.onDisconnect.addListener(() => {
    port = null;
    for (const [id, request] of pending) {
      request.reject(new Error("lost the connection to the extension, please try again"));
      pending.delete(id);
    }
    setTimeout(() => (port ??= connect()), 300);
  });
  return opened;
}

export function startConnection() {
  port ??= connect();
}

export function call<T = any>(action: string, payload: unknown = {}): Promise<T> {
  port ??= connect();
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    port!.postMessage({ id, action, payload });
  });
}

export function onMessage(listener: Listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
