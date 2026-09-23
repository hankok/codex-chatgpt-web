import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defaultConfig, getConfigPath, loadConfig } from "../src/config";

function loadConfigWith(patch: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), "codex-web-config-"));
  const previous = process.env.CODEX_CHATGPT_WEB_HOME;
  process.env.CODEX_CHATGPT_WEB_HOME = root;
  try {
    const path = getConfigPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...defaultConfig(), ...patch }));
    return loadConfig();
  } finally {
    if (previous === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME;
    else process.env.CODEX_CHATGPT_WEB_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

test("missing Web context profile map preserves Default behavior", () => {
  const loaded = loadConfigWith({});
  expect((loaded as any).chatgptWebContextProfiles).toEqual({});
});

test("preserves explicit profiles for currently hidden Web routes", () => {
  const loaded = loadConfigWith({
    chatgptWebContextProfiles: { "chatgpt-web/gpt-5.6-pro": "1m" },
    proAvailable: false,
  });
  expect((loaded as any).chatgptWebContextProfiles).toEqual({
    "chatgpt-web/gpt-5.6-pro": "1m",
  });
});

for (const [label, value] of [
  ["non-object", "512k"],
  ["null", null],
  ["array", []],
  ["native model key", { "gpt-5.6-sol": "512k" }],
  ["unknown Web route", { "chatgpt-web/not-a-route": "512k" }],
  ["unsupported profile", { "chatgpt-web/gpt-5.6-sol": "2m" }],
] as const) {
  test(`rejects ${label} Web context profile map`, () => {
    expect(() => loadConfigWith({ chatgptWebContextProfiles: value }))
      .toThrow("chatgptWebContextProfiles");
  });
}
