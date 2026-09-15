/**
 * Coarse product kind from the tree. Fixtures are real git repos so a
 * later cycle commit cannot walk up into the developer's working tree.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CATEGORY_SKILL,
  categorySkillFor,
  categorySkillForKind,
  detectProductKind,
  extensionLookDir,
  playwrightLookApplies,
  ulwRoleInlineSkills,
  type ProductKind,
} from "../src/util/product-kind.js";

function tmpRepo(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

function write(root: string, rel: string, body: string): void {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body, "utf8");
}

function withRepo(prefix: string, setup: (dir: string) => void, fn: (dir: string) => void): void {
  const dir = tmpRepo(prefix);
  try {
    setup(dir);
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("detectProductKind", () => {
  it("project.godot → game", () => {
    withRepo("forge-kind-godot-", (d) => write(d, "project.godot", "; godot\n"), (d) => {
      assert.equal(detectProductKind(d), "game");
      assert.equal(categorySkillFor(d), "forge-game-assets");
      assert.equal(playwrightLookApplies(d), false);
    });
  });

  it("vite web app gets Playwright; a CLI bin does not", () => {
    withRepo("forge-kind-vite-", (d) => {
      write(d, "vite.config.ts", "export default {}\n");
      write(d, "package.json", JSON.stringify({ name: "app" }));
    }, (d) => {
      assert.equal(detectProductKind(d), "web");
      assert.equal(playwrightLookApplies(d), true);
    });
    withRepo("forge-kind-cli-pw-", (d) => {
      write(d, "package.json", JSON.stringify({ name: "tool", bin: { tool: "./cli.js" } }));
    }, (d) => {
      assert.equal(playwrightLookApplies(d), false);
    });
  });

  it("package.json bin → cli", () => {
    withRepo(
      "forge-kind-cli-",
      (d) => write(d, "package.json", JSON.stringify({ name: "tool", bin: { tool: "./cli.js" } })),
      (d) => {
        assert.equal(detectProductKind(d), "cli");
        assert.equal(categorySkillFor(d), "forge-shape");
      },
    );
  });

  it("browser extension look dir prefers public over leftover dist", () => {
    withRepo("forge-kind-ext-", (d) => {
      write(d, "extension/manifest.json", JSON.stringify({ action: {}, name: "pet" }));
      write(d, "extension/public/popup.html", "<h1>src</h1>\n");
      write(d, "extension/dist/popup.html", "<h1>stale</h1>\n");
    }, (d) => {
      assert.equal(playwrightLookApplies(d), true);
      assert.match(extensionLookDir(d) || "", /public$/);
    });
  });

  it("vite.config.ts → web", () => {
    withRepo("forge-kind-vite-", (d) => write(d, "vite.config.ts", "export default {}\n"), (d) => {
      assert.equal(detectProductKind(d), "web");
      assert.equal(categorySkillFor(d), "forge-surface");
    });
  });

  it("exports no bin → library", () => {
    withRepo(
      "forge-kind-lib-",
      (d) =>
        write(
          d,
          "package.json",
          JSON.stringify({ name: "lib", exports: { ".": "./index.js" } }),
        ),
      (d) => {
        assert.equal(detectProductKind(d), "library");
        assert.equal(categorySkillFor(d), "forge-prove");
      },
    );
  });

  it("Package.swift + Sources → game, Playwright off", () => {
    withRepo("forge-kind-swift-", (d) => {
      write(d, "Package.swift", "// swift-tools-version: 5.9\n");
      write(d, "Sources/App/main.swift", "print(1)\n");
    }, (d) => {
      assert.equal(detectProductKind(d), "game");
      assert.equal(playwrightLookApplies(d), false);
    });
  });

  it("Cargo.toml macroquad → game, Playwright off", () => {
    withRepo("forge-kind-mq-", (d) => {
      write(d, "Cargo.toml", "[package]\nname=\"yard\"\n[dependencies]\nmacroquad = \"0.4\"\n");
      write(d, "src/main.rs", "fn main() {}\n");
    }, (d) => {
      assert.equal(detectProductKind(d), "game");
      assert.equal(playwrightLookApplies(d), false);
    });
  });

  it("xcodeproj → game, Playwright off", () => {
    withRepo("forge-kind-xc-", (d) => {
      fs.mkdirSync(path.join(d, "PixelPets.xcodeproj"));
      write(d, "PixelPets.xcodeproj/project.pbxproj", "//\n");
    }, (d) => {
      assert.equal(detectProductKind(d), "game");
      assert.equal(playwrightLookApplies(d), false);
    });
  });

  it("empty → unknown", () => {
    withRepo("forge-kind-empty-", () => {}, (d) => {
      assert.equal(detectProductKind(d), "unknown");
      assert.equal(categorySkillFor(d), undefined);
    });
  });

  it("missing workspace is unknown", () => {
    assert.equal(detectProductKind(""), "unknown");
    assert.equal(detectProductKind("/no/such/forge-kind-workspace"), "unknown");
  });

  it("game wins over a bin; a bin wins over vite.config; bin wins over exports", () => {
    withRepo(
      "forge-kind-pri-game-",
      (d) => {
        write(d, "project.godot", "; godot\n");
        write(d, "package.json", JSON.stringify({ bin: "./cli.js" }));
      },
      (d) => assert.equal(detectProductKind(d), "game"),
    );
    withRepo(
      "forge-kind-pri-web-",
      (d) => {
        write(d, "vite.config.ts", "export default {}\n");
        write(d, "package.json", JSON.stringify({ bin: "./cli.js" }));
      },
      (d) => assert.equal(detectProductKind(d), "cli"),
    );
    withRepo(
      "forge-kind-pri-cli-",
      (d) =>
        write(
          d,
          "package.json",
          JSON.stringify({ bin: "./cli.js", exports: { ".": "./index.js" } }),
        ),
      (d) => assert.equal(detectProductKind(d), "cli"),
    );
  });

  it("chrome extension action / cargo [[bin]] / go cmd/ are conservative extras", () => {
    withRepo(
      "forge-kind-ext-",
      (d) => write(d, "manifest.json", JSON.stringify({ action: { default_title: "pet" } })),
      (d) => assert.equal(detectProductKind(d), "game"),
    );
    withRepo(
      "forge-kind-cargo-",
      (d) => write(d, "Cargo.toml", '[package]\nname = "t"\n\n[[bin]]\nname = "t"\n'),
      (d) => assert.equal(detectProductKind(d), "cli"),
    );
    withRepo(
      "forge-kind-go-",
      (d) => {
        write(d, "go.mod", "module example.com/t\n");
        fs.mkdirSync(path.join(d, "cmd"));
      },
      (d) => assert.equal(detectProductKind(d), "cli"),
    );
  });

  it("index.html + lockfile without a bin is web; with a bin is cli", () => {
    withRepo(
      "forge-kind-html-",
      (d) => {
        write(d, "index.html", "<html></html>\n");
        write(d, "package-lock.json", "{}\n");
        write(d, "package.json", JSON.stringify({ name: "site" }));
      },
      (d) => assert.equal(detectProductKind(d), "web"),
    );
    withRepo(
      "forge-kind-html-bin-",
      (d) => {
        write(d, "index.html", "<html></html>\n");
        write(d, "package-lock.json", "{}\n");
        write(d, "package.json", JSON.stringify({ name: "site", bin: "./cli.js" }));
      },
      (d) => assert.equal(detectProductKind(d), "cli"),
    );
  });
});

describe("categorySkillForKind + ulwRoleInlineSkills", () => {
  it("maps each kind to one skill and unknown to none", () => {
    const expected: Record<ProductKind, string | undefined> = {
      game: "forge-game-assets",
      web: "forge-surface",
      cli: "forge-shape",
      library: "forge-prove",
      unknown: undefined,
    };
    for (const kind of Object.keys(expected) as ProductKind[]) {
      assert.equal(categorySkillForKind(kind), expected[kind]);
    }
    assert.equal(CATEGORY_SKILL.cli, "forge-shape");
  });

  it("appends the category skill to the role's inlined set", () => {
    withRepo("forge-kind-inline-", (d) => write(d, "package.json", JSON.stringify({ bin: "./cli.js" })), (d) => {
      assert.deepEqual(ulwRoleInlineSkills("planner", d), [
        "forge-planner",
        "forge-veteran",
        "forge-rootcause",
        "forge-shape",
      ]);
      assert.deepEqual(ulwRoleInlineSkills("reviewer", d), [
        "forge-reviewer",
        "forge-veteran",
        "forge-rootcause",
        "forge-shape",
      ]);
    });
    withRepo("forge-kind-inline-none-", () => {}, (d) => {
      assert.deepEqual(ulwRoleInlineSkills("planner", d), [
        "forge-planner",
        "forge-veteran",
        "forge-rootcause",
      ]);
    });
  });
});
