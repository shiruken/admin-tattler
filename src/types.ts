/**
 * App configuration settings
 */
export type Settings = {
  /** Enable reports via Modmail */
  sendModmail: boolean;
  /** Route Modmail reports into the Notifications folder */
  modmailNotification: boolean;
  /** Automatically archive Modmail reports after sending */
  archiveModmail: boolean;
  /** Comma-separated Slack or Discord webhook URLs */
  webhookURL: string;
  /** Exclude post/comment context from reports */
  excludeContext: boolean;
  /** Add mod note to users actioned by Reddit Admins */
  addModNote: boolean;
};

/**
 * Cached post data
 */
export type CachedPostData = {
  /** Post title text */
  title: string;
  /** Post body text */
  body: string;
  /** Post url */
  url: string;
};

/**
 * Cached prior moderator content action
 */
export type CachedModAction = {
  /** Moderator action type (e.g. removecomment, removelink, spamcomment, spamlink, approvecomment, approvelink) */
  action: string;
  /** Username of the moderator (or AutoModerator / reddit) who performed the action */
  moderator: string;
  /** Timestamp (ms since epoch) when the moderator action occurred */
  timestamp?: number;
};
