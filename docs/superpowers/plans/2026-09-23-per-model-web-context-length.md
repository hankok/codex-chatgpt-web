# Per-model ChatGPT Web Context Length Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Add a persisted Default / 512K / 1M choice for each available ChatGPT Web model route, applying it to Web catalog metadata and local request limits only.

**Architecture:** Store explicit profiles in runtime configuration under stable ChatGPT Web route slugs; an absent entry means Default and continues to use the existing route and capability resolver. Carry the original route slug through catalog and request resolution so the selected profile controls Web metadata, aggregate preflight, and existing Sol multipart planning without entering Codex native-model context handling. The launcher obtains current route/default metadata from a control-token-protected local endpoint and writes changes through the existing setup transaction.

**Tech Stack:** TypeScript, Bun, Vitest, Electron main/preload IPC, React launcher, Node test runner.

**Spec:** docs/superpowers/specs/2026-09-23-web-model-context-length-design.md

## Global Constraints

- Persist explicit map values as 512k or 1m, keyed by stable ChatGPT Web route slug; missing keys mean Default.
- Interpret 512k as 512,000 tokens and 1m as 1,000,000 tokens.
- Default retains the existing route- and capability-specific resolver, including the experimentalBiggerContext compatibility baseline.
- Change only generated chatgpt-web/* model rows; do not change built-in Codex model context or Codex's top-level model_context_window setting.
- For explicit profiles, set Web context_window and max_context_window to the selected token count; preserve the route's existing auto-compaction-to-window ratio and recompute the effective context percentage.
- Luna Default remains 1.05M, keeps rolling checkpoints, and never uses multipart upload. Manual Zero Risk exposes Default only.
- Automatic Sol multipart keeps the existing planner, caps a plan at six parts, and preserves every measured per-message, image, and attachment boundary. Never split a Codex message or JSON record to bypass an individual-message limit.
- Reject a locally oversized request before browser submission with a non-retryable context_length_exceeded result. Surface actual backend length errors, HTTP 413, and timeouts; do not truncate, downgrade, or retry under another profile.
- Safe logs may include route slug, profile, stage, status, and error code; never log prompt content.
- A changed profile must mark catalog refresh and Codex restart as required. Keep 512K and 1M labeled experimental.

## Review Focus

- An absent or partially populated map must preserve existing Default budgets, including the legacy Bigger Context baseline. Pin this in Task 1 configuration tests and Task 2 resolver tests.
- A route hidden by current account capabilities must retain its saved profile and restore it when available again. Pin this in Task 1 map round-trip tests and Task 4 route-list tests.
- Changing a Web profile must leave native model rows byte-for-byte equivalent under the same native catalog and context override. Pin this in Task 2 catalog tests.
- Luna and manual Zero Risk must not acquire multipart behavior or unsupported high-profile choices. Pin this in Tasks 2, 3, and 4.
- Requests above the selected aggregate or individual-message limit must fail before browser submission; backend 413 and timeout responses must remain visible without fallback. Pin this in Task 3 adapter tests.

---

### Task 1: Persist and validate per-route profiles

**Files:**
- Modify: src/config.ts
- Modify: src/types.ts
- Modify: src/setup.ts
- Modify: src/cli.ts
- Modify: launcher/electron/runtime-supervisor.cjs
- Test: tests/config.test.ts (create)
- Test: tests/setup-lifecycle.test.ts
- Test: launcher/tests/runtime-supervisor.test.cjs

**Interfaces:**
- Persist AppConfig.chatgptWebContextProfiles as an optional partial map from canonical ChatGPT Web route slugs to "512k" | "1m".
- Add the setup option --chatgpt-web-context-profile <slug>=<default|512k|1m>. Repeating it for different slugs updates those entries; default removes that slug's explicit override.
- Keep unknown-but-canonical route slugs in the map when the current account does not expose them.

- [ ] **Step 1: Write failing configuration tests**

In tests/config.test.ts, define loadConfigWith(patch) by setting a temporary CODEX_HOME, creating the parent of getConfigPath(), writing {...defaultConfig(), ...patch} to that path, and calling loadConfig(). Test an absent map, a valid partial map, and a known route that is currently unavailable to the account. Add rejection tests for a non-Web key, unknown route slug, unsupported profile value, array, null, and non-object map.

~~~typescript
it("preserves explicit profiles for currently hidden Web routes", () => {
  const config = loadConfigWith({
    chatgptWebContextProfiles: { "chatgpt-web/gpt-5.6-pro": "1m" },
    proAvailable: false,
  });
  expect(config.chatgptWebContextProfiles).toEqual({
    "chatgpt-web/gpt-5.6-pro": "1m",
  });
});
~~~

- [ ] **Step 2: Run the configuration tests and verify the new cases fail**

Run: bun test tests/config.test.ts
Expected: the new profile-map tests fail because configuration loading does not yet recognize or validate the field.

- [ ] **Step 3: Add the validated config type and parser**

Add ChatGptWebContextProfile = "512k" | "1m" and an optional slug-keyed profile map to AppConfig. Parse absent maps as an empty effective map, preserve canonical hidden-route keys, reject malformed keys and values, and leave experimentalBiggerContext unchanged.

~~~typescript
export type ChatGptWebContextProfile = "512k" | "1m";
export type ChatGptWebContextProfiles = Partial<
  Record<string, ChatGptWebContextProfile>
>;
~~~

- [ ] **Step 4: Add the setup flag and update operation**

Parse --chatgpt-web-context-profile as one slug=value argument. Accept only default, 512k, or 1m; delete the key for default; merge other keys without dropping hidden-route entries. Update setup serialization without writing model_context_window.

- [ ] **Step 5: Run config and setup tests**

Run: bun test tests/config.test.ts tests/setup-lifecycle.test.ts tests/dev-profile.test.ts
Run: node --test launcher/tests/runtime-supervisor.test.cjs
Expected: valid maps round-trip, malformed maps fail at the boundary, and legacy configurations still load with their previous Bigger Context behavior.

- [ ] **Step 6: Commit the config boundary**

~~~sh
git add src/config.ts src/types.ts src/setup.ts src/cli.ts launcher/electron/runtime-supervisor.cjs tests/config.test.ts tests/setup-lifecycle.test.ts launcher/tests/runtime-supervisor.test.cjs
git commit -m "feat: persist ChatGPT Web context profiles"
~~~

### Task 2: Resolve profiles in Web catalog rows and prove native isolation

**Files:**
- Modify: src/chatgpt-web-models.ts
- Modify: src/model-catalog.ts
- Test: tests/chatgpt-web-models.test.ts
- Test: tests/model-catalog.test.ts
- Test: tests/server-models.test.ts

**Interfaces:**
- Extend resolveChatGptWebContextLimits(backendModel, effort, capabilities, modelSlug?) so an optional original route slug selects its explicit profile.
- Missing modelSlug or a missing map entry follows the old resolver exactly.
- Explicit profiles replace only Web route limits; native Codex context override handling remains in augmentNativeModelCatalog's existing native-only loop.

- [ ] **Step 1: Write failing resolver tests**

Cover 512,000 and 1,000,000 windows, compaction-ratio preservation, effective percentage, Default preservation with experimentalBiggerContext both false and true, and two route slugs sharing one backend but resolving independently.

~~~typescript
expect(resolveChatGptWebContextLimits(model, effort, capabilities, routeSlug))
  .toMatchObject({
    contextWindow: 512_000,
    autoCompactTokenLimit: Math.round(
      defaultLimits.autoCompactTokenLimit * 512_000 / defaultLimits.contextWindow,
    ),
  });
~~~

- [ ] **Step 2: Run the focused resolver tests and verify they fail**

Run: bun test tests/chatgpt-web-models.test.ts
Expected: explicit profiles are ignored or the new route-slug argument is rejected by the current signature.

- [ ] **Step 3: Implement profile-aware Web limit resolution**

Resolve the existing Default limits first. For an explicit map entry, choose 512_000 or 1_000_000, scale autoCompactTokenLimit by the Default ratio using integer rounding, and derive effectiveContextWindowPercent from the resulting limits. Keep Luna's 1_050_000 Default and the Zero Risk guard intact.

- [ ] **Step 4: Apply the resolver only to generated Web rows**

Pass route.slug from buildChatGptWebModel into the resolver for both the default effort and every grouped supported effort. Do not pass chatgptWebContextProfiles to nativeTemplateCandidate or the native context-override loop.

- [ ] **Step 5: Add catalog isolation and route tests**

Assert each Web row reports the selected context_window, max_context_window, auto_compact_token_limit, and effective_context_window_percent. Compare the native model array before and after changing a Web profile using the same upstream catalog and the same CodexModelContextOverride; expect exact deep equality.

- [ ] **Step 6: Run focused catalog tests and commit**

Run: bun test tests/chatgpt-web-models.test.ts tests/model-catalog.test.ts tests/server-models.test.ts
Expected: all resolver, catalog, Default, Luna, Zero Risk, and native-isolation assertions pass.

~~~sh
git add src/chatgpt-web-models.ts src/model-catalog.ts tests/chatgpt-web-models.test.ts tests/model-catalog.test.ts tests/server-models.test.ts
git commit -m "feat: apply profiles to ChatGPT Web catalog rows"
~~~

### Task 3: Carry the selected route budget through request preflight and staging

**Files:**
- Modify: src/config.ts
- Modify: src/server.ts
- Modify: src/adapters/chatgpt-web/index.ts
- Modify: src/adapters/chatgpt-web/usage.ts
- Modify: src/adapters/chatgpt-web/browser-worker.ts
- Modify: src/dev-chat/driver.ts
- Test: tests/chatgpt-web-harness.test.ts
- Test: tests/browser-worker-contract.test.ts
- Test: tests/dev-chat.test.ts

**Interfaces:**
- Include the profile map in the ChatGPT Web adapter capability/config object created by providerConfig.
- Preserve the original chatgpt-web/* request model slug until profile resolution; do not reduce it to only the shared backend model.
- Usage estimation and aggregate preflight use the same resolved limits as the matching catalog row.

- [ ] **Step 1: Write failing request-path tests**

Use two Web route slugs backed by the same ChatGPT model but with different profiles. Assert each request resolves its own aggregate window. Add an over-budget request and spy on browser submission; expect context_length_exceeded and zero browser submissions.

~~~typescript
expect(result.error.code).toBe("context_length_exceeded");
expect(browserSubmit).not.toHaveBeenCalled();
~~~

- [ ] **Step 2: Write failing staging and backend-error tests**

For automatic Sol, exercise a six-part plan while verifying every stage stays inside the existing composer character, visible-message-token, image, and attachment limits. Verify one individually oversized Codex message is rejected without splitting. Verify Luna and Zero Risk never create multipart plans. Verify a backend HTTP 413 and a browser timeout are surfaced as those actual failures without profile downgrade or a second submission.

- [ ] **Step 3: Run the focused adapter tests and verify they fail**

Run: bun test tests/chatgpt-web-harness.test.ts tests/browser-worker-contract.test.ts tests/dev-chat.test.ts
Expected: request preflight still uses the compatibility boolean instead of the selected route profile.

- [ ] **Step 4: Thread route identity and limits through the adapter**

Use the incoming Web model slug with resolveChatGptWebContextLimits in usage estimation and message-budget resolution. Use its selected aggregate limit in the existing preflight and Sol planner; keep the planner maximum at six and do not weaken any individual-message boundary.

- [ ] **Step 5: Run focused adapter and compaction regressions**

Run: bun test tests/chatgpt-web-harness.test.ts tests/browser-worker-contract.test.ts tests/dev-chat.test.ts tests/retained-compaction.test.ts
Expected: selected budgets govern preflight; existing Default, retained compaction, Luna checkpoint, and Zero Risk behavior remains unchanged.

- [ ] **Step 6: Commit request-path enforcement**

~~~sh
git add src/server.ts src/adapters/chatgpt-web/index.ts src/adapters/chatgpt-web/usage.ts src/adapters/chatgpt-web/browser-worker.ts src/dev-chat/driver.ts tests/chatgpt-web-harness.test.ts tests/browser-worker-contract.test.ts tests/dev-chat.test.ts
git commit -m "feat: enforce Web context profiles in request preflight"
~~~

### Task 4: Add protected route metadata and per-model launcher controls

**Files:**
- Modify: src/server.ts
- Modify: src/model-catalog.ts
- Modify: launcher/electron/runtime.cjs
- Modify: launcher/electron/main.cjs
- Modify: launcher/electron/preload.cjs
- Modify: launcher/src/App.tsx
- Modify: launcher/src/types.ts
- Modify: launcher/src/i18n.ts
- Test: launcher/tests/runtime-host.test.cjs
- Test: launcher/tests/renderer-wiring.test.cjs

**Interfaces:**
- Add GET /admin/chatgpt-web/context-profiles, protected by the existing control-token authorization. Return only currently available Web routes with slug, display name, Default context window, current profile, and allowed profiles.
- Electron exposes getWebContextRoutes() and setWebContextProfile(slug, profile) through preload IPC. The runtime setter uses the setup flag from Task 1 and existing setup/restart transaction behavior.
- Define WebContextRouteOption as { slug: string; displayName: string; defaultContextWindow: number; profile: "default" | "512k" | "1m"; allowedProfiles: Array<"default" | "512k" | "1m"> }.
- Keep profile persistence in runtime config as the single source of truth; do not persist a second copy in launcher state.

- [ ] **Step 1: Write failing endpoint and IPC tests**

Assert unauthenticated endpoint access is denied, an authorized response includes only currently available Web route rows, Default context windows remain visible while an explicit profile is selected, and hidden route settings remain in config. Assert invalid IPC slugs and profile values fail before setup starts.

- [ ] **Step 2: Write failing renderer tests**

Assert Settings renders one selector for each returned Web route, offers Default / 512K / 1M for automatic routes, offers Default only for manual Zero Risk, shows the resolved Default value, and calls the profile IPC with the stable route slug. Assert a successful change shows the experimental note and restart/catalog-refresh notice.

- [ ] **Step 3: Run focused launcher tests and verify they fail**

Run: node --test launcher/tests/runtime-host.test.cjs launcher/tests/renderer-wiring.test.cjs
Expected: route metadata IPC and per-model selectors do not exist yet.

- [ ] **Step 4: Implement the protected route snapshot and validated setter**

Build the route snapshot from availableChatGptWebModelRoutes. Resolve each Default window with the legacy resolver and report the stored current profile. Require the existing control token for the endpoint. Validate IPC input before calling the setup transaction; after success, set codexRestartRequired and catalog refresh state.

- [ ] **Step 5: Replace the global Bigger Context control and localize it**

Replace the Settings Bigger Context switch with per-route selectors and the experimental explanation. Keep setup compatibility with experimentalBiggerContext but do not present it as a global Web profile. Add matching strings for every locale already defined in launcher/src/i18n.ts.

- [ ] **Step 6: Run launcher tests and commit**

Run: node --test launcher/tests/runtime-host.test.cjs launcher/tests/renderer-wiring.test.cjs
Expected: IPC validation, available-route rendering, Default labels, persistence, manual-mode restrictions, and restart state all pass.

~~~sh
git add src/server.ts src/model-catalog.ts launcher/electron/runtime.cjs launcher/electron/main.cjs launcher/electron/preload.cjs launcher/src/App.tsx launcher/src/types.ts launcher/src/i18n.ts launcher/tests/runtime-host.test.cjs launcher/tests/renderer-wiring.test.cjs
git commit -m "feat: add per-model context controls to launcher"
~~~

### Task 5: Run cross-layer verification and build the Windows installer

**Files:**
- Modify: README.md only if its existing context-limit documentation becomes inaccurate.
- Generate: launcher/artifacts/codex-web-gpt-6.0.0-win-x64.exe and its blockmap.

**Interfaces:**
- No new runtime interfaces. This task verifies that the config, catalog, adapter, and launcher use the same stable route slug and profile values.

- [ ] **Step 1: Run focused tests and type checks**

Run: bun test tests/config.test.ts tests/chatgpt-web-models.test.ts tests/model-catalog.test.ts tests/server-models.test.ts tests/chatgpt-web-harness.test.ts tests/browser-worker-contract.test.ts tests/dev-chat.test.ts
Run: bun run typecheck
Run: bun run launcher:typecheck
Expected: all focused tests and both type checks pass.

- [ ] **Step 2: Build the launcher and run the full test suites**

Run: bun run test
Run: bun run launcher:test
Expected: passing suites; report any environment-only Windows symlink EPERM separately from code failures.

- [ ] **Step 3: Run repository verification**

Run: bun run verify
Expected: all supported verification gates pass. Automated checks establish local behavior only; they do not certify ChatGPT acceptance of a 512K or 1M aggregate context.

- [ ] **Step 4: Build and verify the Windows installer without launching it**

Run: & 'C:\Users\crazy\Desktop\Rebuild-and-Install-Codex-Web-GPT.bat' rebuild
Expected: the script targets 6.0.0, archives the existing EXE and blockmap before packaging, and writes the new x64 installer under launcher/artifacts. Read the artifact version and SHA-256; do not execute the installer.

- [ ] **Step 5: Review the final diff**

Confirm every profile read is keyed by the original Web route slug; no profile reaches native Codex model context overrides or model_context_window; the 512K/1M experimental note is visible; no request text enters logs; no fallback, truncation, or automatic retry was added.
