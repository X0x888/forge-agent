import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createOrderGate, enqueueGitWorktreeMeta } from "../src/agent/spawn-join.js";

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("createOrderGate", () => {
  it("runs tickets in original order even when later work is faster", async () => {
    const g = createOrderGate();
    const order: number[] = [];
    await Promise.all([
      g.run(1, async () => {
        await delay(5);
        order.push(1);
        return "b";
      }),
      g.run(0, async () => {
        await delay(25);
        order.push(0);
        return "a";
      }),
    ]);
    assert.deepEqual(order, [0, 1]);
  });

  it("(a) finish without run unblocks a later run", async () => {
    const g = createOrderGate();
    const order: string[] = [];
    const later = g.run(1, async () => {
      order.push("run-1");
      return "ok";
    });
    await delay(10);
    assert.deepEqual(order, []);
    await g.finish(0);
    assert.equal(await later, "ok");
    assert.deepEqual(order, ["run-1"]);
  });

  it("(b) nop slot then later run", async () => {
    const g = createOrderGate();
    const order: string[] = [];
    await Promise.all([
      g.run(0, async () => {
        order.push("nop");
        return undefined;
      }),
      g.run(1, async () => {
        order.push("land");
        return { kept: true };
      }),
    ]);
    assert.deepEqual(order, ["nop", "land"]);
  });

  it("(c) skip/refuse slot still lets a later land run", async () => {
    const g = createOrderGate();
    const order: string[] = [];
    await Promise.all([
      g.run(0, async () => {
        order.push("skip");
        return { status: "skipped", kept: true };
      }),
      g.run(1, async () => {
        order.push("land");
        return { status: "applied", kept: false };
      }),
    ]);
    assert.deepEqual(order, ["skip", "land"]);
  });

  it("(d) abort while a sibling waits — join settles and fn still runs", async () => {
    const ac = new AbortController();
    const g = createOrderGate(ac.signal);
    let ran0 = 0;
    let ran1 = 0;
    const p = Promise.all([
      g.run(0, async () => {
        ran0 += 1;
        ac.abort();
        await delay(15);
        return { status: "applied", kept: false };
      }),
      g.run(1, async () => {
        ran1 += 1;
        return { status: "applied", kept: false };
      }),
    ]);
    const results = await p;
    assert.equal(ran0, 1);
    assert.equal(ran1, 1);
    assert.equal(results[0]?.status, "applied");
    assert.equal(results[1]?.status, "applied");
  });

  it("finish is idempotent with run", async () => {
    const g = createOrderGate();
    let n = 0;
    const running = g.run(0, async () => {
      n += 1;
      return "x";
    });
    await running;
    await g.finish(0);
    await g.finish(0);
    assert.equal(n, 1);
  });
});

describe("enqueueGitWorktreeMeta", () => {
  it("runs jobs on one key serially even when started together", async () => {
    const key = `/tmp/forge-wt-meta-${process.pid}`;
    const order: number[] = [];
    await Promise.all([
      enqueueGitWorktreeMeta(key, async () => {
        await delay(20);
        order.push(0);
      }),
      enqueueGitWorktreeMeta(key, async () => {
        order.push(1);
      }),
    ]);
    assert.deepEqual(order, [0, 1]);
  });

  it("a rejected job does not skip the next", async () => {
    const key = `/tmp/forge-wt-meta-fail-${process.pid}`;
    const order: string[] = [];
    const first = enqueueGitWorktreeMeta(key, async () => {
      order.push("a");
      throw new Error("boom");
    });
    const second = enqueueGitWorktreeMeta(key, async () => {
      order.push("b");
      return 1;
    });
    await assert.rejects(first, /boom/);
    assert.equal(await second, 1);
    assert.deepEqual(order, ["a", "b"]);
  });
});
