import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  lookChromeDisabled,
  lookChromeLiveArgs,
  lookChromeShotArgs,
  lookChromeUdd,
} from "../src/util/look-chrome.js";
import {
  LOOK_CHROME_PORT_BASE,
  LOOK_PORT_BASE,
  lookChromePortForSession,
  lookPortForSession,
} from "../src/util/look-port.js";

describe("look-chrome", () => {
  it("CDP port is in the next span from the Vite look port", () => {
    const sid = "18747acb-886a-4792-a711-026398fd66d8";
    const vite = lookPortForSession(sid);
    const cdp = lookChromePortForSession(sid);
    assert.equal(cdp, LOOK_CHROME_PORT_BASE + (vite - LOOK_PORT_BASE));
    assert.notEqual(cdp, vite);
    assert.equal(cdp, lookChromePortForSession(sid));
  });

  it("shot args are headless Chromium of the look URL, never Chrome.app", () => {
    const spec = lookChromeShotArgs({
      exe: "/tmp/chrome-for-testing",
      dest: "/tmp/look.png",
      url: "http://127.0.0.1:5321/",
      udd: "/tmp/look-shot",
    });
    assert.equal(spec.command, "/tmp/chrome-for-testing");
    assert.ok(spec.args.includes("--headless=new"));
    assert.ok(spec.args.includes("--screenshot=/tmp/look.png"));
    assert.ok(spec.args.includes("http://127.0.0.1:5321/"));
    assert.ok(spec.args.some((a) => a.startsWith("--user-data-dir=")));
    assert.ok(!spec.args.some((a) => /Chrome\.app/i.test(a)));
  });

  it("live args bind remote debugging on the session chrome port", () => {
    const spec = lookChromeLiveArgs({
      exe: "/tmp/cft",
      udd: "/tmp/look-chrome",
      port: 6123,
      url: "http://127.0.0.1:5321/",
    });
    assert.ok(spec.args.includes("--remote-debugging-port=6123"));
    assert.ok(spec.args.includes("http://127.0.0.1:5321/"));
  });

  it("unit tests do not spawn Chromium", () => {
    assert.equal(lookChromeDisabled(), true);
    assert.match(lookChromeUdd("sess-a", "shot"), /look-shot$/);
  });
});
