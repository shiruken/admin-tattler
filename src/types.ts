/**
 * App configuration settings
 */
export type Settings = {
  /** Enable reports via Modmail */
  sendModmail: boolean;
  /** Slack or Discord webhook URL */
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
