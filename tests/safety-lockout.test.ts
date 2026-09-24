import { expect, test } from "bun:test";
import {
  isUpstreamToolSafetyLockoutReply,
  shouldRetryUpstreamToolSafetyLockout,
} from "../src/adapters/chatgpt-web/safety-lockout";

test("recognizes upstream tool safety lockouts", () => {
  expect(isUpstreamToolSafetyLockoutReply(
    "This tool call was blocked by OpenAI's safety checks. Please double check what you are sending.",
  )).toBe(true);
  expect(isUpstreamToolSafetyLockoutReply(
    "Script error: This tool call was blocked by OpenAI because we couldn't determine the safety status of the request.",
  )).toBe(true);
  expect(isUpstreamToolSafetyLockoutReply(
    "The command gate blocked this operation before execution.",
  )).toBe(true);
});

test("does not classify ordinary safety discussion as a tool lockout", () => {
  expect(isUpstreamToolSafetyLockoutReply(
    "Add tests for safety-blocked results and execution token expiry handling.",
  )).toBe(false);
});

test("preserves genuine outer runtime failures instead of auto-retrying them", () => {
  const answer = "The command gate blocked this operation before execution.";
  expect(shouldRetryUpstreamToolSafetyLockout(answer, false)).toBe(true);
  expect(shouldRetryUpstreamToolSafetyLockout(answer, true)).toBe(false);
});
