import { TriggerContext } from "@devvit/public-api";
import { CommentSubmit, CommentUpdate, ModAction, PostSubmit, PostUpdate } from '@devvit/protos';
import { CachedPostData } from "./types.js";
import { getValidatedSettings } from "./settings.js";

/**
 * Checks ModAction for Admins
 * @param event A ModAction object
 * @param context A TriggerContext object
 */
export async function checkModAction(event: ModAction, context: TriggerContext) {
  const action = event.action;
  if (!action) {
    throw new Error('Missing `action` from ModActionTrigger event');
  }

  const moderator = event.moderator;
  if (!moderator || !moderator.name) {
    throw new Error('Missing `moderator` from ModActionTrigger event');
  }
  const moderatorName = moderator.name;

  const subreddit = event.subreddit;
  if (!subreddit || !subreddit.name) {
    throw new Error('Missing `subreddit` from ModActionTrigger event');
  }
  const subredditName = subreddit.name;

  const settings = await getValidatedSettings(context);

  // Update cached modlist on modlist change
  if (
    action == "acceptmoderatorinvite" || action == "addmoderator" ||
    action == "removemoderator" || action == "reordermoderators"
  ) {
    console.log(`Updating cached modlist on ${action} by ${moderatorName}`);
    await cacheModerators(context);
  }

  // Check if acting moderator is NOT in modlist
  const moderators = await getCachedModerators(context);
  if (
    !moderators.includes(moderatorName) && 
    moderatorName != "AutoModerator" && moderatorName != "reddit"
  ) {

    // Ignore user removing themselves as moderator
    if (action == "removemoderator" && moderatorName == event.targetUser!.name) {
      console.log(`Ignored ${action} by ${moderatorName}`);
      return;
    }

    console.log(`Detected ${action} by ${moderatorName}`);

    let permalink = "";
    let user = "";
    let url = "";
    let title = "";
    let body = "";
      
    let usedCachedTitle = false;
    let usedCachedBody = false;
    let usedCachedURL = false;

    // Posts
    const targetPost = event.targetPost;
    if (targetPost && targetPost.id) {
      if (targetPost.permalink) {
        permalink = `https://www.reddit.com${targetPost.permalink}`;
      }
      if (targetPost.url && !targetPost.url.includes(targetPost.id.slice(3))) {
        url = targetPost.url;
      }
      if (targetPost.selftext) {
        body = targetPost.selftext;
      }
      if (targetPost.title) {
        title = targetPost.title;
        if (title == "[ Removed by Reddit ]") {
          const cachedPost = await getCachedPost(targetPost.id, context);
          if (cachedPost) {
            if (cachedPost.title) {
              title = cachedPost.title;
              usedCachedTitle = true;
            }
            if (cachedPost.url && !cachedPost.url.includes(targetPost.id.slice(3))) {
              url = cachedPost.url;
              usedCachedURL = true;
            }
            if (cachedPost.body) {
              body = cachedPost.body;
              usedCachedBody = true;
            }
          }
        }
      }
    }

    // Comments
    const targetComment = event.targetComment;
    if (targetComment && targetComment.id) {
      if (targetComment.permalink) {
        permalink = `https://www.reddit.com${targetComment.permalink}`;
      }
      if (targetComment.body) {
        body = targetComment.body;
        if (body == "[ Removed by Reddit ]") {
          const cachedComment = await getCachedComment(targetComment.id, context);
          if (cachedComment) {
            body = cachedComment;
            usedCachedBody = true;
          }
        }
      }
    }

    // Target User
    const targetUser = event.targetUser;
    if (targetUser && targetUser.id) {
      user = targetUser.name;
    }

    let isUser = false;
    let modlogLinkDesc = "View Admin Modlog";
    let modlogLink = `https://www.reddit.com/mod/${subredditName}/log?moderatorNames=a`;
    if (moderatorName != "Anti-Evil Operations" && moderatorName != "Reddit Legal" && moderatorName != "[ Redacted ]") {
      isUser = true;
      modlogLinkDesc = "View User Modlog";
      modlogLink = `https://www.reddit.com/mod/${subredditName}/log?moderatorNames=${moderatorName}`;
    }

    // Send Modmail
    if (settings.sendModmail) {
      const msg = `**${ isUser ? "u/" : "" }${moderatorName}** has performed an action in r/${subredditName}:\n\n` +
                  `* **Action:** \`${action}\`` +
                  (permalink ? `\n\n* **Permalink:** ${permalink}` : "") +
                  (user ? `\n\n* **Target User:** u/${user}` : "") +
                  (url ? `\n\n* **URL${ usedCachedURL ? " (Cached)" : "" }:** ${url}` : "") +
                  (!settings.excludeContext && title ? `\n\n* **Title${ usedCachedTitle ? " (Cached)" : "" }:** ${title}` : "") +
                  (!settings.excludeContext && body ? `\n\n* **Body${ usedCachedBody ? " (Cached)" : "" }:** ${quoteText(body)}` : "") +
                  `\n\n[**${modlogLinkDesc}**](${modlogLink})\n\n` +
                  `^(Notification generated by )[^Admin ^Tattler](https://developers.reddit.com/apps/admin-tattler)` +
                  `^(. Configure settings )[^here](https://developers.reddit.com/r/${subredditName}/apps/admin-tattler)^(.)`;
      await context.reddit.modMail
        .createConversation({
          to: "admin-tattler",
          subject: "Admin Action Detected",
          body: msg,
          subredditName: subredditName,
        })
        .then(() => console.log(`Sent modmail about ${action} by ${moderatorName}`))
        .catch((e) => console.error(`Error sending modmail about ${action} by ${moderatorName}`, e));
    }

    // Send to Slack
    if (settings.webhookURL && settings.webhookURL.startsWith("https://hooks.slack.com/")) {
      const slackPayload = {
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*${ isUser ? "u/" : "" }${moderatorName}* has performed an action in r/${subredditName}`
            }
          }
        ],
        attachments: [
          {
            color: "#FF4500", // OrangeRed
            blocks: [
              {
                type: "context",
                elements: [
                  {
                    type: "mrkdwn",
                    text: `*Action:* \`${action}\`` +
                          (permalink ? `\n*Permalink:* ${permalink}` : "") +
                          (user ? `\n*Target User:* <https://www.reddit.com/user/${user}|u/${user}>` : "") +
                          (url ? `\n*URL${ usedCachedURL ? " (Cached)" : "" }:* ${url}` : "") +
                          (!settings.excludeContext && title ? `\n*Title${ usedCachedTitle ? " (Cached)" : "" }:* ${title}` : "") +
                          (!settings.excludeContext && body ? `\n*Body${ usedCachedBody ? " (Cached)" : "" }:* ${body}` : "")
                  }
                ]
              },
              {
                type: "actions",
                elements: [
                  {
                    type: "button",
                    text: {
                      type: "plain_text",
                      text: modlogLinkDesc
                    },
                    url: modlogLink
                  }
                ]
              },
              // {
              //   type: "section",
              //   text: {
              //     type: "mrkdwn",
              //     text: `\`\`\`${JSON.stringify(event)}\`\`\``
              //   }
              // }
            ]
          }
        ]
      };
      await fetch(settings.webhookURL, {
        method: 'POST',
        body: JSON.stringify(slackPayload),
      })
        .then(() => console.log(`Sent Slack message about ${action} by ${moderatorName}`))
        .catch((e) => console.error(`Error sending Slack message about ${action} by ${moderatorName}`, e));
    }

    // Send to Discord
    if (settings.webhookURL && settings.webhookURL.startsWith("https://discord.com/api/webhooks/")) {
      const discordPayload = {
        username: "Admin Tattler",
        avatar_url: "https://raw.githubusercontent.com/shiruken/admin-tattler/main/assets/avatar.jpg",
        content: `**${ isUser ? "u/" : "" }${moderatorName}** has performed an action in r/${subredditName}`,
        embeds: [
          {
            color: 16729344, // #FF4500 (OrangeRed)
            fields: [
              {
                name: "Action",
                value: `\`${action}\``
              }
            ]
          }
        ]
      };

      if (permalink) {
        discordPayload.embeds[0].fields.push({
          name: "Permalink",
          value: permalink
        });
      }

      if (user) {
        discordPayload.embeds[0].fields.push({
          name: "Target User",
          value: `[u/${user}](https://www.reddit.com/user/${user})`
        });
      }

      if (url) {
        discordPayload.embeds[0].fields.push({
          name: (usedCachedTitle ? "URL (Cached)" : "URL"),
          value: url
        });
      }

      if (!settings.excludeContext && title) {
        discordPayload.embeds[0].fields.push({
          name: (usedCachedTitle ? "Title (Cached)" : "Title"),
          value: title
        });
      }

      if (!settings.excludeContext && body) {
        discordPayload.embeds[0].fields.push({
          name: (usedCachedBody ? "Body (Cached)" : "Body"),
          value: body
        });
      }

      discordPayload.embeds[0].fields.push({
        name: modlogLinkDesc,
        value: `[Link](${modlogLink})`
      });

      await fetch(settings.webhookURL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(discordPayload),
      })
        .then(() => console.log(`Sent Discord message about ${action} by ${moderatorName}`))
        .catch((e) => console.error(`Error sending Discord message about ${action} by ${moderatorName}`, e));
    }
  }
}

/**
 * Cache post text
 * @param event A PostSubmit or PostUpdate object
 * @param context A TriggerContext object
 */
export async function cachePost(event: PostSubmit | PostUpdate, context: TriggerContext) {
  const post = event.post;
  if (post && post.title) {
    const data: CachedPostData = {
      title: post.title,
      body: post.selftext,
      url: post.url
    };
    await context.redis
      .set(post.id, JSON.stringify(data))
      .catch((e) => console.error(`Error writing ${post.id} to Redis`, e));
    await context.redis
      .expire(post.id, 60*60*24*14) // 14 days
      .catch((e) => console.error(`Error setting expiration for ${post.id} in Redis`, e));
  }
}

/**
 * Get cached post text
 * @param comment_id A post fullname (including t3_ prefix)
 * @param context A TriggerContext object
 * @returns A Promise that resolves to a {@link CachedPostData} object containing the cached post text
 */
async function getCachedPost(post_id: string, context: TriggerContext): Promise<CachedPostData | undefined> {
  const value = await context.redis.get(post_id);
  let cachedPost: CachedPostData | undefined = undefined;
  if (value) {
    cachedPost = JSON.parse(value);
  }
  return cachedPost;
}

/**
 * Cache comment text
 * @param event A CommentSubmit or CommentUpdate object
 * @param context A TriggerContext object
 */
export async function cacheComment(event: CommentSubmit | CommentUpdate, context: TriggerContext) {
  const comment = event.comment;
  if (comment && comment.body) {
    await context.redis
      .set(comment.id, comment.body)
      .catch((e) => console.error(`Error writing ${comment.id} to Redis`, e));
    await context.redis
      .expire(comment.id, 60*60*24*14) // 14 days
      .catch((e) => console.error(`Error setting expiration for ${comment.id} in Redis`, e));
  }
}

/**
 * Get cached comment text
 * @param comment_id A comment fullname (including t1_ prefix)
 * @param context A TriggerContext object
 * @returns A Promise that resolves to the cached comment text
 */
async function getCachedComment(comment_id: string, context: TriggerContext): Promise<string | undefined> {
  const cachedComment = await context.redis.get(comment_id);
  return cachedComment;
}

/**
 * Cache subreddit modlist
 * @param context A TriggerContext object
 */
export async function cacheModerators(context: TriggerContext) {
  const subreddit = await context.reddit.getCurrentSubreddit();
  const moderators: string[] = [];
  try {
    for await(const moderator of subreddit.getModerators({ pageSize: 500 })) {
      moderators.push(moderator.username);
    }
  } catch (err) {
    throw new Error(`Error fetching modlist for r/${subreddit.name}: ${err}`);
  }

  if (!moderators.length) {
    throw new Error(`Fetched modlist for r/${subreddit.name} is empty, skipping cache update`);
  }

  // Write string representation of array to Redis
  await context.redis
    .set("mods", moderators.toString())
    .then(() => console.log(`Wrote ${moderators.length} moderators to Redis`))
    .catch((e) => console.error('Error writing moderators to Redis', e));
}

/**
 * Get cached subreddit modlist
 * @param context A TriggerContext object
 * @returns A promise that resolves to an array of moderator usernames
 */
async function getCachedModerators(context: TriggerContext): Promise<string[]> {
  const moderators = await context.redis.get("mods");
  if (!moderators) {
    throw new Error('Cached modlist is empty');
  }
  return moderators.split(","); // Parse string representation of array
}

/**
 * Format string as quoted text in Reddit Markdown
 * @param text A string to format as quoted text
 * @returns A string containing quoted text
 */
function quoteText(text: string): string {
  return "\n >" + text.replace(/\n/g, "\n> ");
}
