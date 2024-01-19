import { SettingsFormField, SettingsFormFieldValidatorEvent, TriggerContext } from '@devvit/public-api';

/**
 * Settings
 * @typeParam reportAEO: Enable Anti-Evil Operations reporting
 * @typeParam reportLegal: Enable Reddit Legal reporting
 * @typeParam reportMCoC: Enable u/ModCodeofConduct reporting
 * @typeParam sendModmail: Enable reports via Modmail
 * @typeParam webhookURL: Slack or Discord webhook URL
 */
export type Settings = {
  reportAEO: boolean,
  reportLegal: boolean,
  reportMCoC: boolean,
  sendModmail: boolean,
  webhookURL: string
};

export const settings: SettingsFormField[] = [
  {
    type: 'boolean',
    name: 'reportAEO',
    label: 'Report Anti-Evil Operations',
    helpText: 'Report actions by Anti-Evil Operations',
    defaultValue: true
  },
  {
    type: 'boolean',
    name: 'reportLegal',
    label: 'Report Reddit Legal',
    helpText: 'Report actions by Reddit Legal',
    defaultValue: true
  },
  {
    type: 'boolean',
    name: 'reportMCoC',
    label: 'Report u/ModCodeofConduct',
    helpText: 'Report actions by u/ModCodeofConduct',
    defaultValue: true
  },
  {
    type: 'boolean',
    name: 'sendModmail',
    label: 'Send Modmail',
    helpText: 'Send reports via Modmail',
    defaultValue: true
  },
  {
    type: 'string',
    name: 'webhookURL',
    label: 'Webhook URL (Slack or Discord)',
    helpText: 'Enter webhook URL to send reports via Slack or Discord',
    defaultValue: '',
    onValidate: validateWebhookURL
  }
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
  if (!settings.reportAEO && !settings.reportLegal && !settings.reportMCoC) {
    throw new Error('All admin accounts are disabled in app configuration');
  }
  if (!settings.sendModmail && !settings.webhookURL) {
    throw new Error('All reporting routes are disabled in app configuration');
  }
  return settings;
}
