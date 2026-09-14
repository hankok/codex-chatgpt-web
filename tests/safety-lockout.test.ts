import { expect, test } from "bun:test";
import { isSimulatedToolSafetyLockout } from "../src/adapters/chatgpt-web/safety-lockout";

test("recognizes a model-simulated tool lockout", () => {
  expect(isSimulatedToolSafetyLockout(
    "I cannot continue because the tool safety layer is consistently blocking every command before execution.",
  )).toBe(true);
  expect(isSimulatedToolSafetyLockout(
    "The Codex Native executor is FORBIDDEN by the host, so I cannot inspect the workspace.",
  )).toBe(true);
  expect(isSimulatedToolSafetyLockout(
    "Tried again, but the Codex Native2 bridge is still rejecting the supplied turn credential as \"invalid, expired, or revoked.\"",
  )).toBe(true);
  expect(isSimulatedToolSafetyLockout(
    "Retry failed again before reaching the repo: Native2 rejects both execution and tool discovery with \"turn token is invalid, expired, or revoked.\" The wave-radar workspace connector is also disconnected, while the other available Codex workspace points to a different repository.",
  )).toBe(true);
  expect(isSimulatedToolSafetyLockout(
    "Retry still fails before reaching the repo: Native2 returns \"turn token is invalid, expired, or revoked.\" The wave-radar workspace fallback also currently returns \"We couldn't connect your account.\"",
  )).toBe(true);
  expect(isSimulatedToolSafetyLockout(
    "I can’t write through the broken Codex bridge, but I can still verify the current main source if the repository is publicly readable.",
  )).toBe(true);
  expect(isSimulatedToolSafetyLockout(
    "I couldn’t complete the push/deploy because the Codex execution layer rejected every Git mutation (`git add`/`commit`) before execution with a turn-token error.",
  )).toBe(true);
});

test("does not classify ordinary security-gate discussion as a simulated lockout", () => {
  expect(isSimulatedToolSafetyLockout(
    "The tool safety layer and command gate should use the outer runtime approval policy.",
  )).toBe(false);
  expect(isSimulatedToolSafetyLockout(
    "Add tests for safety-blocked results and execution token expiry handling.",
  )).toBe(false);
});
