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
});

test("does not classify ordinary security-gate discussion as a simulated lockout", () => {
  expect(isSimulatedToolSafetyLockout(
    "The tool safety layer and command gate should use the outer runtime approval policy.",
  )).toBe(false);
  expect(isSimulatedToolSafetyLockout(
    "Add tests for safety-blocked results and execution token expiry handling.",
  )).toBe(false);
});
