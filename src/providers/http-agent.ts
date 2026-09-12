/**
 * Dedicated undici Agent for provider chat so four concurrent ULWs plus
 * Playwright/MCP do not share Node's default ~6 keep-alives per origin.
 *
 * The Agent and the fetch must come from the **same** undici. Node 24+/26
 * bundles undici 7/8 as global `fetch`; npm `undici@6` Agent passed there
 * throws `TypeError: fetch failed (UND_ERR_INVALID_ARG)` / `invalid onError
 * method` — HashPet 052af525 retried that eight times and never reached xAI.
 */
import { Agent, fetch as undiciFetch } from "undici";

let agent: Agent | undefined;

/** Node's global fetch at load — tests replace `globalThis.fetch`. */
const nativeFetch = globalThis.fetch;

export function providerHttpDispatcher(): Agent {
  if (!agent) {
    agent = new Agent({
      connections: 32,
      pipelining: 0,
      keepAliveTimeout: 30_000,
      keepAliveMaxTimeout: 60_000,
    });
  }
  return agent;
}

export function providerFetch(
  url: string,
  init: RequestInit,
): Promise<Response> {
  // A replaced global fetch (unit tests, rare polyfills) is a different
  // undici than npm `Agent`. Passing the Agent there is UND_ERR_INVALID_ARG.
  if (globalThis.fetch !== nativeFetch) {
    return globalThis.fetch(url, init);
  }
  return undiciFetch(url, {
    method: init.method,
    headers: init.headers as Record<string, string> | undefined,
    body: init.body as string | Buffer | Uint8Array | undefined,
    signal: init.signal ?? undefined,
    dispatcher: providerHttpDispatcher(),
  }) as unknown as Promise<Response>;
}
