import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseGithubRepo,
  rewriteGithubBlobUrl,
  githubEnabled,
  githubReposFromUrls,
  queryLooksLikeGithubLookup,
  toolGithub,
} from "../src/agent/tools/github.js";

describe("github tool", () => {
  it("parses owner/repo and github.com blob/tree URLs", () => {
    assert.deepEqual(parseGithubRepo("vercel/next.js"), {
      owner: "vercel",
      repo: "next.js",
      ref: undefined,
      path: undefined,
    });
    const blob = parseGithubRepo(
      "https://github.com/vercel/next.js/blob/canary/packages/next/package.json",
    );
    assert.equal(blob?.owner, "vercel");
    assert.equal(blob?.repo, "next.js");
    assert.equal(blob?.ref, "canary");
    assert.equal(blob?.path, "packages/next/package.json");
    assert.equal(parseGithubRepo("https://example.com/x/y"), null);
    assert.equal(parseGithubRepo("../etc/passwd"), null);
  });

  it("treats github.com and owner/repo as a GitHub lookup, not src/ paths", () => {
    assert.equal(queryLooksLikeGithubLookup("https://github.com/vercel/next.js"), true);
    assert.equal(queryLooksLikeGithubLookup("vercel/next.js"), true);
    assert.equal(queryLooksLikeGithubLookup("vercel/next.js app router"), true);
    assert.equal(queryLooksLikeGithubLookup("repo:microsoft/playwright-mcp"), true);
    assert.equal(queryLooksLikeGithubLookup("src/agent/loop.ts"), false);
    assert.equal(queryLooksLikeGithubLookup("best chrome extension MV3 practices"), false);
    assert.deepEqual(
      githubReposFromUrls([
        "https://github.com/microsoft/playwright-mcp",
        "https://github.com/microsoft/playwright-mcp/blob/main/README.md",
        "https://example.com/x",
      ]),
      ["microsoft/playwright-mcp"],
    );
  });

  it("rewrites blob URLs to raw.githubusercontent.com and leaves trees alone", () => {
    assert.equal(
      rewriteGithubBlobUrl(
        "https://github.com/owner/repo/blob/main/src/index.ts",
      ),
      "https://raw.githubusercontent.com/owner/repo/main/src/index.ts",
    );
    assert.equal(
      rewriteGithubBlobUrl("https://github.com/owner/repo/tree/main/src"),
      "https://github.com/owner/repo/tree/main/src",
    );
    assert.equal(
      rewriteGithubBlobUrl("https://example.com/x"),
      "https://example.com/x",
    );
  });

  it("FORGE_GITHUB=0 disables", async () => {
    const prev = process.env.FORGE_GITHUB;
    process.env.FORGE_GITHUB = "0";
    try {
      assert.equal(githubEnabled(), false);
      const r = await toolGithub({ action: "search", query: "x" });
      assert.equal(r.isError, true);
      assert.match(r.output, /FORGE_GITHUB=0/);
    } finally {
      if (prev === undefined) delete process.env.FORGE_GITHUB;
      else process.env.FORGE_GITHUB = prev;
    }
  });

  it("fails closed on missing action / repo / query", async () => {
    const noAction = await toolGithub({});
    assert.equal(noAction.isError, true);
    assert.match(noAction.output, /action is required/);
    const noRepo = await toolGithub({ action: "readme" });
    assert.equal(noRepo.isError, true);
    assert.match(noRepo.output, /repo is required/);
    const noQuery = await toolGithub({ action: "search" });
    assert.equal(noQuery.isError, true);
    assert.match(noQuery.output, /query is required/);
    const noPath = await toolGithub({ action: "contents", repo: "o/r" });
    assert.equal(noPath.isError, true);
    assert.match(noPath.output, /path is required/);
  });
});
