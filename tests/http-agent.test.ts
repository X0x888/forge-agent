import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { providerFetch } from "../src/providers/http-agent.js";

async function listen(): Promise<{ server: Server; url: string }> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    server.close();
    throw new Error("no listen port");
  }
  return { server, url: `http://127.0.0.1:${addr.port}` };
}

describe("provider HTTP agent", () => {
  it("POSTs JSON through the dedicated undici Agent (not Node global fetch)", async () => {
    const { server, url } = await listen();
    try {
      server.on("request", (req, res) => {
        assert.equal(req.method, "POST");
        assert.equal(req.url, "/chat/completions");
        assert.match(String(req.headers.authorization), /^Bearer /);
        let body = "";
        req.on("data", (c) => {
          body += c;
        });
        req.on("end", () => {
          assert.match(body, /grok-4\.6/);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, id: "chat-1" }));
        });
      });
      const resp = await providerFetch(`${url}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-token",
        },
        body: JSON.stringify({ model: "grok-4.6", messages: [] }),
      });
      assert.equal(resp.status, 200);
      const json = (await resp.json()) as { ok: boolean; id: string };
      assert.equal(json.ok, true);
      assert.equal(json.id, "chat-1");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("honors a replaced globalThis.fetch without attaching the Agent", async () => {
    const prev = globalThis.fetch;
    let hit = false;
    globalThis.fetch = (async () => {
      hit = true;
      return new Response(JSON.stringify({ mocked: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const resp = await providerFetch("https://api.x.ai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      assert.equal(hit, true);
      assert.equal(resp.status, 200);
      assert.equal(((await resp.json()) as { mocked: boolean }).mocked, true);
    } finally {
      globalThis.fetch = prev;
    }
  });

  it("streams a body the chat client can getReader()", async () => {
    const { server, url } = await listen();
    try {
      server.on("request", (_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: {\"delta\":\"hi\"}\n\n");
        res.end("data: [DONE]\n\n");
      });
      const resp = await providerFetch(`${url}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      assert.equal(resp.ok, true);
      assert.ok(resp.body, "stream body");
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let text = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += dec.decode(value, { stream: true });
      }
      assert.match(text, /\[DONE\]/);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
