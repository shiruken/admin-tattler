/**
 * App configuration data structure
 * @property {boolean} sendModmail: Enable reports via Modmail
 * @property {string} webhookURL: Slack or Discord webhook URL
 */
export interface Settings {
  sendModmail: boolean,
  webhookURL: string
};

/**
 * Cached post data structure
 * @property {string} title: Post title text
 * @property {string} body: Post body text
 * @property {string} url: Post url
 */
export interface CachedPostData {
  title: string,
  body: string,
  url: string
};
