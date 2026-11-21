import { SettingsFormField, SettingsFormFieldValidatorEvent, TriggerContext } from '@devvit/public-api';
import { Settings } from './types.js';

export const settings: SettingsFormField[] = [
  {
    type: "group",
    label: "Modmail",
    fields: [
      {
        type: "boolean",
        name: "sendModmail",
        label: "Send Modmail",
        helpText: "Send reports via Modmail",
        defaultValue: true,
      },
      {
        type: "boolean",
        name: "modmailNotification",
        label: "Send to Notifications Folder",
        helpText: "Route Modmail reports into the Modmail Notifications folder",
        defaultValue: false,
      },
      {
        type: "boolean",
        name: "archiveModmail",
        label: "Archive Modmail",
        helpText: "Automatically archive Modmail reports after sending",
        defaultValue: false,
      },
    ],
  },
  {
    type: "group",
    label: "Slack or Discord",
    fields: [
      {
        type: "string",
        name: "webhookURL",
        label: "Webhook URLs",
        helpText: "Enter one or more comma-separated Slack or Discord webhook URLs",
        defaultValue: "",
        onValidate: validateWebhookURL,
      },
    ],
  },
  {
    type: "group",
    label: "Options",
    fields: [
      {
        type: "boolean",
        name: "excludeContext",
        label: "Exclude Context from Reports",
        helpText: "Content actioned by Reddit is frequently vulgar, derogatory, or offensive. The context can alternatively be found in the subreddit Mod Log.",
        defaultValue: false,
      },
      {
        type: "boolean",
        name: "addModNote",
        label: "Add Mod Note",
        helpText: "Flag users actioned by the Reddit Admins with a Mod Note",
        defaultValue: false,
      },
    ],
  },
];

/**
 * Parse comma-separated webhook URLs, trimming whitespace and removing empty/duplicate entries
 * @param webhookURL Optional comma-separated webhook URL string
 * @returns Array of unique non-empty webhook URL strings
 */
export function parseWebhookURLs(webhookURL?: string): string[] {
  if (!webhookURL) {
    return [];
  }
  return [
    ...new Set(
      webhookURL
        .split(",")
        .map((url) => url.trim())
        .filter((url) => url.length > 0)
    ),
  ];
}

/**
 * Validates webhook URL string(s) from app configuration
 * @param event A SettingsFormFieldValidatorEvent object
 * @returns Returns a string containing an error message if invalid
 */
function validateWebhookURL(event: SettingsFormFieldValidatorEvent<string>): void | string {
  const urls = parseWebhookURLs(event.value);
  if (
    urls.some(
      (url) =>
        !(
          url.startsWith("https://hooks.slack.com/") ||
          url.startsWith("https://discord.com/api/webhooks/")
        )
    )
  ) {
    return "Must be valid Slack or Discord webhook URL(s)";
  }
}

/**
 * Load and return current app configuration settings 
 * @param context A TriggerContext object
 * @returns A Promise that resolves to a {@link Settings} object
 */
export async function getValidatedSettings(context: TriggerContext): Promise<Settings> {
  return await context.settings.getAll() as Settings;
}
