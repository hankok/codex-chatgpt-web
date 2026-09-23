const CHATGPT_WEB_CONTEXT_PROFILE_MODELS = Object.freeze([
  Object.freeze({ slug: "chatgpt-web/gpt-5.6-sol-instant", label: "GPT-5.6 Sol Instant" }),
  Object.freeze({ slug: "chatgpt-web/gpt-5.6-sol", label: "GPT-5.6 Sol" }),
  Object.freeze({ slug: "chatgpt-web/gpt-5.6-pro", label: "GPT-5.6 Pro" }),
  Object.freeze({ slug: "chatgpt-web/gpt-6-pro", label: "GPT-6 Pro" }),
]);

const CHATGPT_WEB_CONTEXT_PROFILE_SLUGS = new Set(
  CHATGPT_WEB_CONTEXT_PROFILE_MODELS.map(model => model.slug),
);

function isChatGptWebContextProfileModel(slug) {
  return typeof slug === "string" && CHATGPT_WEB_CONTEXT_PROFILE_SLUGS.has(slug);
}

function validateChatGptWebContextProfileSelection(slug, profile) {
  if (!isChatGptWebContextProfileModel(slug)) {
    throw new Error("Unknown ChatGPT Web context-profile model");
  }
  if (profile !== "default" && profile !== "512k" && profile !== "1m") {
    throw new Error("ChatGPT Web context profile must be default, 512k, or 1m");
  }
  return { slug, profile };
}

function normalizeChatGptWebContextProfiles(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const profiles = {};
  for (const [slug, profile] of Object.entries(value)) {
    if (isChatGptWebContextProfileModel(slug) && (profile === "512k" || profile === "1m")) {
      profiles[slug] = profile;
    }
  }
  return profiles;
}

module.exports = {
  CHATGPT_WEB_CONTEXT_PROFILE_MODELS,
  isChatGptWebContextProfileModel,
  normalizeChatGptWebContextProfiles,
  validateChatGptWebContextProfileSelection,
};
