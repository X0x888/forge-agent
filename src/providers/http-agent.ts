/**
 * Dedicated undici Agent for provider chat so four concurrent ULWs plus
 * Playwright/MCP do not share Node's default ~6 keep-alives per origin.
 */
import { Agent } from "undici";

let agent: Agent | undefined;

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

export function providerFetch(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, {
    ...init,
    dispatcher: providerHttpDispatcher(),
  } as RequestInit);
}
