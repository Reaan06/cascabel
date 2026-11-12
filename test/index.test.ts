import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import register from "../src/index";

let sandbox: string;
let routedTool: any;
let commands: Array<{ name: string; options: any }>;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "cascabel-index-"));
  process.env.CASCABEL_ROUTINGS = join(sandbox, "routings.json");
  process.env.CASCABEL_LOG_DIR = join(sandbox, "logs");
  commands = [];
  let tools: any[] = [];
  register({
    registerTool: (tool: unknown) => {
      tools.push(tool);
      routedTool = tool;
    },
    registerCommand: ((name: string, options: any) => {
      commands.push({ name, options });
    }) as any,
  });
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
  delete process.env.CASCABEL_ROUTINGS;
  delete process.env.CASCABEL_LOG_DIR;
});

describe("extension registration", () => {
  it("keeps the cascabel_route_run tool name and adds exactly one command", () => {
    expect(routedTool.name).toBe("cascabel_route_run");
    expect(commands.map((c) => c.name)).toEqual(["cascabel:tiers"]);
    expect(commands[0].options.description).toContain("tier");
  });

  it("serves /cascabel:tiers args mode headless through ctx.ui.notify", async () => {
    let notified = "";
    await commands[0].options.handler("show", {
      ui: {
        notify: (message: string) => {
          notified = message;
        },
      },
    });
    expect(notified).toContain("/cascabel:tiers set <tier> <provider/model> <effort>");
    expect(notified).toMatch(/quick\s+cli-proxy-api\/gemini-3\.8-flash-high@medium/);
    expect(notified).toContain("(no receipts yet)");
  });

  it("never crashes the session when notify is unavailable or throws", async () => {
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true as never);
    try {
      await expect(
        commands[0].options.handler("stats", { ui: {} }),
      ).resolves.toBeUndefined();
      expect(stderr).toHaveBeenCalled();
      await expect(
        commands[0].options.handler("stats", {
          ui: {
            notify: () => {
              throw new Error("headless");
            },
          },
        }),
      ).resolves.toBeUndefined();
    } finally {
      stderr.mockRestore();
    }
  });
});
