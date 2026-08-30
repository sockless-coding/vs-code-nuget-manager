/**
 * Webview-side bridge to the extension host. Wraps `postMessage` in a
 * promise-based request/response API and exposes host events.
 */

import type {
  HostMessage,
  HostResponsePayload,
  WebviewRequest
} from "../panel/messaging";

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

export const vscode = acquireVsCodeApi();

type HostEventName = "projectsChanged" | "installedChanged" | "settingsChanged";

let nextId = 1;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
const eventListeners = new Set<(event: HostEventName) => void>();
const progressListeners = new Set<(message: string, done: boolean) => void>();

window.addEventListener("message", (e: MessageEvent<HostMessage>) => {
  const msg = e.data;
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "response") {
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.ok) entry.resolve(msg.payload);
    else entry.reject(new Error(msg.error));
    return;
  }

  if (msg.type === "event") {
    if (msg.event === "progress") {
      progressListeners.forEach((l) => l(msg.message, msg.done));
    } else {
      eventListeners.forEach((l) => l(msg.event));
    }
  }
});

export function request<K extends WebviewRequest["kind"]>(
  req: Extract<WebviewRequest, { kind: K }>
): Promise<Extract<HostResponsePayload, { kind: K }>> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    vscode.postMessage({ ...req, id });
  });
}

export function onHostEvent(listener: (event: HostEventName) => void): () => void {
  eventListeners.add(listener);
  return () => eventListeners.delete(listener);
}

export function onProgress(listener: (message: string, done: boolean) => void): () => void {
  progressListeners.add(listener);
  return () => progressListeners.delete(listener);
}
