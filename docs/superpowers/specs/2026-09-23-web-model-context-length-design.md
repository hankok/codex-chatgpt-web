# Per-model ChatGPT Web context length profiles

**Status:** Approved for implementation planning

**Date:** 2026-09-23

## Goal

Let users choose a context length independently for each available ChatGPT Web model route. The Settings UI will offer `Default`, `512K`, and `1M`. `Default` preserves the current resolved budget for that route and account. The larger profiles are experimental because six-part upload reduces individual message size but does not prove that ChatGPT accepts the same aggregate context size.

This feature changes context metadata and enforcement only for generated `chatgpt-web/*` model rows. It must not change the context of any built-in Codex model or write to Codex's top-level `model_context_window` setting. Existing native-model context behavior, if configured separately, remains outside this feature.

## Current behavior

The launcher currently exposes one `experimentalBiggerContext` switch. Its value reaches the ChatGPT Web model catalog and adapter. Context limits are resolved by route and account capability, not from the global `AppConfig.contextWindow` alone. For example, the current Sol Instant and Sol Medium/High profiles have different budgets; Luna's route reports a 1.05M context window and uses rolling checkpoints. Manual Zero Risk does not support multipart transport.

The model catalog constructs ChatGPT Web rows separately from native Codex rows. The adapter converts the selected Web route to a backend model during request routing, so the route slug must be retained long enough to resolve the per-model profile consistently for catalog display and request preflight.

## User experience

Replace the single Bigger Context switch in Settings with one selector per currently available ChatGPT Web route. Each row shows the route's display name and `Default`, `512K`, or `1M`. The Default label includes the current resolved value, such as `Default (90K)` or `Default (270K)`, because route budgets vary.

The route list follows current account capabilities. A temporarily unavailable route keeps its saved profile by stable model slug and restores it if the route becomes available again. Luna keeps its current 1.05M Default, continues using rolling checkpoints, and never enters multipart upload. In manual Zero Risk mode, only Default is offered because that route does not use automated multipart transport.

The two larger profiles carry a concise experimental note: the bridge applies the selected local budget, but ChatGPT may still reject a request that exceeds its own effective limit. Changes mark the model catalog as needing refresh and require a Codex restart before the new context metadata is active.

## Configuration and compatibility

Persist explicit overrides in the runtime configuration as a map keyed by ChatGPT Web route slug. The allowed values are `512k` and `1m`; a missing key means Default. Interpret these as 512,000 and 1,000,000 tokens. Validate the map at the configuration boundary: keys must identify ChatGPT Web routes and values must be supported profile names. Ignore or preserve entries for routes that are currently hidden by account capability, but do not apply an override to a native model or a manual route that does not support it.

Existing configurations without the map continue to use their current route resolver. Preserve the existing `experimentalBiggerContext` value as the compatibility baseline for Default so upgrading does not change current budgets. Selecting 512K or 1M overrides that baseline only for the chosen Web route. The launcher UI and the runtime configuration must use the same persisted source of truth.

## Budget resolution and request flow

Resolve the profile while the original Web route slug is still available. Use that result both when building the generated Web row in the model catalog and when preparing the adapter request. Do not pass the Web profile map into the native Codex context-override path.

For Default, use the existing route- and capability-specific `resolveChatGptWebContextLimits` result. For an explicit profile, set the generated Web row's `context_window` and `max_context_window` to the selected token count, and derive `auto_compact_token_limit` by preserving the route's existing compaction-to-window ratio. Recompute the effective context percentage from those values.

For automatic Sol routes, the selected total window also governs aggregate input preflight. If one message cannot fit, retain the existing planner's two- or six-part behavior, with six as the maximum. Every staged message and final message must still pass the existing measured composer-character, visible-message-token, image, and attachment limits. Never split an individual Codex message or JSON record to bypass those limits. Luna keeps its rolling-checkpoint path and separate measured per-turn browser transport limit; a context profile does not enable multipart there.

Native Codex model entries must be identical before and after changing a Web profile, using the same upstream catalog and same pre-existing native context override. No Web profile may change a native model's `context_window`, `max_context_window`, compaction limit, or Codex configuration.

## Errors and observability

If local estimation exceeds the selected aggregate budget or an individual message boundary, reject before submitting anything to ChatGPT and return a non-retryable `context_length_exceeded` response that includes the estimated amount, applicable boundary, selected budget, and a compaction suggestion where appropriate.

If ChatGPT rejects a submitted high-profile request with a length error or HTTP 413, surface the actual backend error. Surface timeouts as timeouts. Do not silently truncate input, automatically lower the profile, or retry the same task under a different budget; those behaviors can lose context or duplicate work. Safe logs may include the Web route slug, profile, multipart stage, status, and error code, but never prompt content.

## Validation

- Configuration tests cover absent-map compatibility, valid per-route values, malformed keys or values, and preservation of the legacy Default behavior.
- Model-catalog tests verify each Web route's Default/512K/1M fields and compaction ratio. They compare native model entries before and after profile changes under identical existing native override inputs.
- Adapter tests verify aggregate acceptance up to the selected local budget, rejection above it before browser submission, per-message limits in two/six-part plans, and that Luna and Zero Risk never gain multipart support.
- Launcher tests verify the available route list, displayed current Default values, per-model selection persistence, IPC validation, and restart/catalog-refresh state.
- Run focused tests, type checks, launcher build, and package validation. Automated tests can establish local metadata, preflight, and segmentation behavior; they cannot certify ChatGPT's acceptance of 512K or 1M aggregate input. Keep both larger profiles labeled experimental until separately validated against the target Web routes.

## Out of scope

- Changing native Codex model context or the user's top-level `model_context_window` setting.
- Claiming an official or guaranteed 512K/1M ChatGPT Web context limit.
- Enabling multipart upload for Luna or manual Zero Risk.
- Silent fallback, truncation, or automatic retries after a backend length rejection.
