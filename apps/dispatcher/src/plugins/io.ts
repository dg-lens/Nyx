/**
 * I/O plane runtime — sources (external → normalized Signal, routed inward)
 * and sinks (Signal → external). Pure transport; never runs Core logic.
 */
import type { Signal, IoRegistry } from './sdk.js';

const sinks = new Map<string, (signal: Signal) => void | Promise<void>>();
const sourceStops: (() => void)[] = [];
let route: (signal: Signal) => void = () => {};
let onError: (where: string, err: unknown) => void = () => {};

export function _setIoRoute(fn: (signal: Signal) => void): void {
  route = fn;
}

export function _setIoErrorHandler(fn: (where: string, err: unknown) => void): void {
  onError = fn;
}

export function _resetIo(): void {
  sinks.clear();
  for (const stop of sourceStops.splice(0)) {
    try {
      stop();
    } catch {
      // ignore stop errors during reset
    }
  }
}

export async function sendSignal(sink: string, signal: Signal): Promise<void> {
  const handler = sinks.get(sink);
  if (!handler) return;
  try {
    await handler(signal);
  } catch (err) {
    onError(`sink:${sink}`, err);
  }
}

export function ioRegistryFor(_plugin: string): IoRegistry {
  return {
    source: (name, start) => {
      try {
        const stop = start((signal) => {
          try {
            route(signal);
          } catch (err) {
            onError(`source:${name}`, err);
          }
        });
        if (typeof stop === 'function') sourceStops.push(stop);
      } catch (err) {
        onError(`source-start:${name}`, err);
      }
    },
    sink: (name, handler) => {
      sinks.set(name, handler);
    },
    send: (name, signal) => sendSignal(name, signal),
  };
}
