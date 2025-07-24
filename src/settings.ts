import { SettingsFormField, SettingsFormFieldValidatorEvent, TriggerContext } from '@devvit/public-api';
import { Settings } from './types.js';

export const settings: SettingsFormField[] = [
  {
    type: "boolean",
    name: "sendModmail",
    label: "Send Modmail",
    helpText: "Send reports via Modmail",
    defaultValue: true,
  },
  {
    type: "string",
    name: "webhookURL",
    label: "Webhook URL (Slack or Discord)",
    helpText: "Enter webhook URL to send reports via Slack or Discord",
    defaultValue: "",
    onValidate: validateWebhookURL,
  },
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
];

/**
 * Validates webhook URL string from app configuration
 * @param event A SettingsFormFieldValidatorEvent object
 * @returns Returns a string containing an error message if invalid
 */
function validateWebhookURL(event: SettingsFormFieldValidatorEvent<string>): void | string {
  if (event.value &&
    !(
      event.value?.startsWith("https://hooks.slack.com/") ||
      event.value?.startsWith("https://discord.com/api/webhooks/")
    )
  ) {
    return "Must be valid Slack or Discord webhook URL";
  }
}

/**
 * Load, validate, and return current app configuration settings 
 * @param context A TriggerContext object
 * @returns A Promise that resolves to a {@link Settings} object
 */
export async function getValidatedSettings(context: TriggerContext): Promise<Settings> {
  const settings = await context.settings.getAll() as Settings;
  if (!settings.sendModmail && !settings.webhookURL) {
    throw new Error('All reporting routes are disabled in app configuration');
  }
  return settings;
}
