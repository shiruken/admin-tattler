import { describe, expect, it, vi } from "vitest";
import { getValidatedSettings, settings } from "./settings.js";
import type { Devvit, SettingsFormField, TriggerContext } from "@devvit/public-api";

type NamedFormField = Extract<SettingsFormField, { name: string }>;

function findNamedField(name: string): NamedFormField | undefined {
  return settings.find((s): s is NamedFormField => "name" in s && s.name === name);
}

describe("settings", () => {
  it("defines the expected form fields", () => {
    expect(settings).toHaveLength(4);

    const sendModmail = findNamedField("sendModmail");
    expect(sendModmail).toBeDefined();
    expect(sendModmail?.defaultValue).toBe(true);

    const webhookURL = findNamedField("webhookURL");
    expect(webhookURL).toBeDefined();
    expect(webhookURL?.defaultValue).toBe("");

    const excludeContext = findNamedField("excludeContext");
    expect(excludeContext).toBeDefined();
    expect(excludeContext?.defaultValue).toBe(false);

    const addModNote = findNamedField("addModNote");
    expect(addModNote).toBeDefined();
    expect(addModNote?.defaultValue).toBe(false);
  });

  describe("validateWebhookURL", () => {
    const webhookSetting = findNamedField("webhookURL");
    const validator = webhookSetting && "onValidate" in webhookSetting ? webhookSetting.onValidate : undefined;
    const dummyContext = {} as Devvit.Context;

    it("accepts empty or undefined values", () => {
      expect(validator?.({ value: "" } as never, dummyContext)).toBeUndefined();
      expect(validator?.({ value: undefined } as never, dummyContext)).toBeUndefined();
    });

    it("accepts valid Slack webhook URLs", () => {
      expect(validator?.({ value: "https://hooks.slack.com/services/T00/B00/X" } as never, dummyContext)).toBeUndefined();
    });

    it("accepts valid Discord webhook URLs", () => {
      expect(validator?.({ value: "https://discord.com/api/webhooks/123/abc" } as never, dummyContext)).toBeUndefined();
    });

    it("rejects invalid webhook URLs", () => {
      expect(validator?.({ value: "https://example.com/webhook" } as never, dummyContext)).toBe(
        "Must be valid Slack or Discord webhook URL"
      );
    });
  });

  describe("getValidatedSettings", () => {
    it("returns settings when sendModmail is true", async () => {
      const mockContext = {
        settings: {
          getAll: vi.fn().mockResolvedValue({
            sendModmail: true,
            webhookURL: "",
            excludeContext: false,
            addModNote: false,
          }),
        },
      } as unknown as TriggerContext;

      const result = await getValidatedSettings(mockContext);
      expect(result.sendModmail).toBe(true);
    });

    it("returns settings when webhookURL is configured", async () => {
      const mockContext = {
        settings: {
          getAll: vi.fn().mockResolvedValue({
            sendModmail: false,
            webhookURL: "https://discord.com/api/webhooks/123/abc",
            excludeContext: false,
            addModNote: false,
          }),
        },
      } as unknown as TriggerContext;

      const result = await getValidatedSettings(mockContext);
      expect(result.webhookURL).toBe("https://discord.com/api/webhooks/123/abc");
    });

    it("throws when all reporting routes are disabled", async () => {
      const mockContext = {
        settings: {
          getAll: vi.fn().mockResolvedValue({
            sendModmail: false,
            webhookURL: "",
            excludeContext: false,
            addModNote: false,
          }),
        },
      } as unknown as TriggerContext;

      await expect(getValidatedSettings(mockContext)).rejects.toThrow(
        "All reporting routes are disabled in app configuration"
      );
    });
  });
});
