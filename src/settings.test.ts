import { describe, expect, it, vi } from "vitest";
import { getValidatedSettings, parseWebhookURLs, settings } from "./settings.js";
import type { Devvit, SettingsFormField, TriggerContext } from "@devvit/public-api";

type NamedFormField = Extract<SettingsFormField, { name: string }>;

function flattenNamedFields(fields: SettingsFormField[]): NamedFormField[] {
  return fields.flatMap((field) =>
    field.type === "group" ? flattenNamedFields(field.fields) : [field]
  );
}

function findNamedField(name: string): NamedFormField | undefined {
  return flattenNamedFields(settings).find((s) => s.name === name);
}

describe("settings", () => {
  it("defines the expected grouped form fields", () => {
    expect(settings).toHaveLength(3);
    expect(settings.map((s) => s.label)).toEqual(["Modmail", "Slack or Discord", "Options"]);

    const sendModmail = findNamedField("sendModmail");
    expect(sendModmail).toBeDefined();
    expect(sendModmail?.defaultValue).toBe(true);

    const modmailNotification = findNamedField("modmailNotification");
    expect(modmailNotification).toBeDefined();
    expect(modmailNotification?.defaultValue).toBe(false);

    const archiveModmail = findNamedField("archiveModmail");
    expect(archiveModmail).toBeDefined();
    expect(archiveModmail?.defaultValue).toBe(false);

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

  describe("parseWebhookURLs", () => {
    it("returns empty array for empty, whitespace, or undefined input", () => {
      expect(parseWebhookURLs(undefined)).toEqual([]);
      expect(parseWebhookURLs("")).toEqual([]);
      expect(parseWebhookURLs("   ,  , ")).toEqual([]);
    });

    it("splits, trims, ignores empty entries, and deduplicates URLs", () => {
      expect(
        parseWebhookURLs(
          " https://hooks.slack.com/services/A/B/C , https://discord.com/api/webhooks/1/2, , https://hooks.slack.com/services/A/B/C "
        )
      ).toEqual([
        "https://hooks.slack.com/services/A/B/C",
        "https://discord.com/api/webhooks/1/2",
      ]);
    });
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

    it("accepts multiple comma-separated valid Slack and Discord webhook URLs", () => {
      expect(
        validator?.(
          {
            value:
              "https://hooks.slack.com/services/T00/B00/X, https://discord.com/api/webhooks/123/abc",
          } as never,
          dummyContext
        )
      ).toBeUndefined();
    });

    it("rejects invalid webhook URLs including mixed valid and invalid lists", () => {
      expect(validator?.({ value: "https://example.com/webhook" } as never, dummyContext)).toBe(
        "Must be valid Slack or Discord webhook URL(s)"
      );
      expect(
        validator?.(
          {
            value: "https://hooks.slack.com/services/T00/B00/X, https://example.com/bad",
          } as never,
          dummyContext
        )
      ).toBe("Must be valid Slack or Discord webhook URL(s)");
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

    it("returns settings even when all reporting routes are disabled", async () => {
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

      const result = await getValidatedSettings(mockContext);
      expect(result.sendModmail).toBe(false);
      expect(result.webhookURL).toBe("");
      expect(result.addModNote).toBe(false);
    });
  });
});
