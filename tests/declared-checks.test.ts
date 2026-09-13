import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  finiteCheckCommand,
  isNeverExitingCheckCommand,
  looksLikeCheckCommand,
  stripArrangePrefix,
} from "../src/harness/declared-checks.js";

describe("declared-checks — finite gate and swiftc harvest", () => {
  it("strips mkdir/cd arrange prefixes so HostCareCheck harvests", () => {
    const raw =
      "mkdir -p .forge/tmp && swiftc -parse-as-library PixelPetsWatch/PetState.swift PixelPetsWatch/PetStore.swift PixelPetsWatchTests/HostCareCheck.swift -o .forge/tmp/HostCareCheck && .forge/tmp/HostCareCheck";
    assert.match(stripArrangePrefix(raw), /^swiftc /);
    assert.equal(looksLikeCheckCommand(raw), true);
  });

  it("drops preview/dev/watch segments from a compound", () => {
    assert.equal(
      finiteCheckCommand("cd game && npm run build:ea && npm run preview"),
      "npm run build:ea",
    );
    assert.equal(isNeverExitingCheckCommand("npm run preview"), true);
    assert.equal(finiteCheckCommand("npm run preview"), undefined);
    assert.equal(looksLikeCheckCommand("npm test"), true);
    assert.equal(finiteCheckCommand("python3 -m http.server 8080"), undefined);
    assert.equal(isNeverExitingCheckCommand("npm run serve"), true);
  });
});
