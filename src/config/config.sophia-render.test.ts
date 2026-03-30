import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateConfigObject, validateConfigObjectWithPlugins } from "./config.js";

describe("sophia/openclaw.render.json", () => {
  it("keeps the Sophia Render config valid", () => {
    const raw = JSON.parse(
      readFileSync(new URL("../../sophia/openclaw.render.json", import.meta.url), "utf-8"),
    ) as Record<string, unknown>;

    expect(raw.env).toMatchObject({
      ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY}",
      OPENAI_API_KEY: "${OPENAI_API_KEY}",
      DEEPGRAM_API_KEY: "${DEEPGRAM_API_KEY}",
      ELEVENLABS_API_KEY: "${ELEVENLABS_API_KEY}",
      LLAMA_CLOUD_API_KEY: "${LLAMA_CLOUD_API_KEY}",
    });
    expect(raw.tools).toMatchObject({
      media: {
        audio: {
          enabled: true,
          language: "multi",
          providerOptions: {
            deepgram: {
              smart_format: true,
            },
          },
          models: [{ provider: "deepgram", model: "nova-3" }],
        },
      },
    });
    expect(raw.messages).toMatchObject({
      tts: {
        auto: "inbound",
        provider: "elevenlabs",
        strictProvider: true,
        elevenlabs: {
          voiceId: "aFueGIISJUmscc05ZNfD",
          modelId: "eleven_multilingual_v2",
        },
      },
    });
    expect(raw.browser).toMatchObject({
      enabled: true,
      defaultProfile: "openclaw",
      headless: true,
      noSandbox: true,
    });
    expect(
      (raw.messages as { tts?: { elevenlabs?: { voiceSettings?: Record<string, unknown> } } }).tts
        ?.elevenlabs?.voiceSettings,
    ).toMatchObject({
      speed: 0.92,
      stability: 0.6,
      similarityBoost: 0.82,
      style: 0,
    });
    expect(raw.channels).toMatchObject({
      whatsapp: {
        selfChatMode: false,
        dmPolicy: "allowlist",
        allowFrom: ["+393894991082"],
        ackReaction: {
          emoji: "💙",
          direct: true,
          group: "mentions",
        },
      },
    });
    expect(raw.plugins).toMatchObject({
      entries: {
        "prompt-observer": {
          enabled: true,
          config: {
            toolNames: [
              "memory_search",
              "memory_get",
              "web_search",
              "web_fetch",
              "check_assumptions",
              "steelman",
              "find_analogy",
              "decompose_claim",
              "inhabit_scene",
              "perspective_shift",
              "name_the_state",
            ],
          },
        },
        "sophia-document": {
          enabled: true,
          config: {
            tier: "cost_effective",
            version: "latest",
            pollIntervalMs: 2000,
            pollTimeoutMs: 45000,
            maxChars: 48000,
            alwaysParseExtensions: [".ppt", ".pptx", ".xls", ".xlsx"],
            fallbackParseExtensions: [".pdf", ".doc", ".docx"],
          },
        },
        "sophia-thinking-tools": {
          enabled: true,
          config: {
            specialist: {
              primary: {
                provider: "openai",
                model: "gpt-5.4",
                reasoningEffort: "high",
                timeoutMs: 12000,
                maxOutputTokens: 500,
              },
              fallback: {
                provider: "anthropic",
                model: "claude-opus-4-6",
                timeoutMs: 12000,
                maxOutputTokens: 400,
              },
            },
          },
        },
      },
    });

    const result = validateConfigObject(raw);
    expect(result.ok).toBe(true);

    const pluginAwareResult = validateConfigObjectWithPlugins(raw);
    expect(pluginAwareResult.ok).toBe(true);
  });
});
