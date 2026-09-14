const LEGACY_TOOL_LOCKOUT = /does not support developer MCPs|Codex Native.*FORBIDDEN|Codex Native 执行器仍然被宿主禁用|does not currently expose the Codex Native execution tool|blocked at the harness level/i;
const SAFETY_GATE = /automatic safety review|tool safety layer|patch gate(?:way)?|command gate|safety check|runner/i;
const LOCKOUT_OUTCOME = /block(?:ed|ing)|reject(?:ed|ing)|prevent(?:ed|ing)|cannot|can't|unable|forbidden|expired|disconnected/i;

export function isSimulatedToolSafetyLockout(answer: string): boolean {
  if (LEGACY_TOOL_LOCKOUT.test(answer)) return true;
  return answer
    .split(/(?<=[.!?。！？])\s+|\r?\n+/)
    .some(sentence => SAFETY_GATE.test(sentence) && LOCKOUT_OUTCOME.test(sentence));
}
