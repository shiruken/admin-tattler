import { TriggerContext } from "@devvit/public-api";
import { CommentSubmit, CommentUpdate, ModAction, PostSubmit, PostUpdate } from '@devvit/protos';
import { CachedPostData } from "./types.js";
import { getValidatedSettings } from "./settings.js";

const CACHE_DURATION = 60*60*24*14; // 14 days

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

    let targetID: `t1_${string}` | `t3_${string}` | undefined = undefined;
    let permalink = "";
    let createdAt = 0;
    let user = "";
    let is_banned = false;
    let url = "";
    let title = "";
    let body = "";

    let usedCachedTitle = false;
    let usedCachedBody = false;
    let usedCachedURL = false;

    // Posts
    const targetPost = event.targetPost;
    if (targetPost && targetPost.id) {
      targetID = targetPost.id as `t3_${string}`;
      if (targetPost.permalink) {
        permalink = `https://www.reddit.com${targetPost.permalink}`;
      }
      createdAt = targetPost.createdAt;
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
      targetID = targetComment.id as `t1_${string}`;
      if (targetComment.permalink) {
        permalink = `https://www.reddit.com${targetComment.permalink}`;
      }
      createdAt = targetComment.createdAt;
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
      const listing = await context.reddit.getBannedUsers({
        subredditName: subredditName,
        username: user,
      });
      is_banned = (await listing.all()).length == 1;
    }

    let modDisplayName = moderatorName;
    let modlogLinkDesc = "View Admin Modlog";
    let modlogLink = `https://www.reddit.com/mod/${subredditName}/log?moderatorNames=a`;
    if (moderatorName != "Anti-Evil Operations" && moderatorName != "Reddit Legal" && moderatorName != "[ Redacted ]") {
      modDisplayName = `u/${moderatorName}`;
      modlogLinkDesc = "View Modlog";
      modlogLink = `https://www.reddit.com/mod/${subredditName}/log?moderatorNames=${moderatorName}`;
    }

    if (modDisplayName == "[ Redacted ]") {
      modDisplayName = "Anti-Evil Operations";
    }

    let createdAtText = "";
    if (createdAt && Date.now() - createdAt > CACHE_DURATION*1000) {
      const createdAtDate = new Date(createdAt);
      createdAtText = createdAtDate.toLocaleDateString("fr-CA"); // YYYY-MM-DD
    }

    // Send Modmail
    if (settings.sendModmail) {
      const msg = `**${modDisplayName}** has performed an action in r/${subredditName}:\n\n` +
                  `* **Action:** \`${action}\`` +
                  (permalink ? `\n\n* **Permalink:** ${permalink}` : "") +
                  (createdAtText ? `\n\n* **Content Date:** ${createdAtText}` : "") + 
                  (user ? `\n\n* **Target User:** u/${user}${ is_banned ? ` (Banned in r/${subredditName})`: "" }` : "") +
                  (url ? `\n\n* **URL${ usedCachedURL ? " (Cached)" : "" }:** ${url}` : "") +
                  (!settings.excludeContext && title ? `\n\n* **Title${ usedCachedTitle ? " (Cached)" : "" }:** ${title}` : "") +
                  (!settings.excludeContext && body ? `\n\n* **Body${ usedCachedBody ? " (Cached)" : "" }:** ${quoteText(body.slice(0, 9000))}` : "") +
                  `\n\n[**${modlogLinkDesc}**](${modlogLink})\n\n` +
                  `^(Notification generated by )[^Admin ^Tattler](https://developers.reddit.com/apps/admin-tattler)` +
                  `^(. Configure settings )[^here](https://developers.reddit.com/r/${subredditName}/apps/admin-tattler)^(.)`;
      await context.reddit.modMail
        .createModInboxConversation({
          subredditId: subreddit.id,
          subject: "Admin Action Detected",
          bodyMarkdown: msg,
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
              text: `*${modDisplayName}* has performed an action in r/${subredditName}`
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
                          (createdAtText ? `\n*Content Date:* ${createdAtText}` : "") +
                          (user ? `\n*Target User:* <https://www.reddit.com/user/${user}|u/${user}>${ is_banned ? ` (Banned in r/${subredditName})`: "" }` : "") +
                          (url ? `\n*URL${ usedCachedURL ? " (Cached)" : "" }:* ${url}` : "") +
                          (!settings.excludeContext && title ? `\n*Title${ usedCachedTitle ? " (Cached)" : "" }:* ${title}` : "") +
                          (!settings.excludeContext && body ? `\n*Body${ usedCachedBody ? " (Cached)" : "" }:* ${body.slice(0, 2500)}` : "")
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
        content: `**${modDisplayName}** has performed an action in r/${subredditName}`,
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

      if (createdAtText) {
        discordPayload.embeds[0].fields.push({
          name: "Content Date",
          value: createdAtText
        });
      }

      if (user) {
        discordPayload.embeds[0].fields.push({
          name: "Target User",
          value: `[u/${user}](https://www.reddit.com/user/${user})${ is_banned ? ` (Banned in r/${subredditName})`: "" }`
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
          value: body.slice(0, 1024)
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

    // Add Mod Note for content removals
    if (
      settings.addModNote && user && user != "AutoModerator" && targetID &&
      (
        action == "removelink" || action == "spamlink" ||
        action == "removecomment" || action == "spamcomment"
      )
    ) {
      await context.reddit
        .addModNote({
          subreddit: subredditName,
          user: user,
          redditId: targetID,
          label: "ABUSE_WARNING",
          note: (modDisplayName.startsWith("u/") ? "Admin" : modDisplayName) + " Removal",
        })
        .then(() => console.log(`Added mod note to ${targetID}`))
        .catch((e) => console.error(`Error adding mod note to ${targetID}`, e));
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
      .expire(post.id, CACHE_DURATION)
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
      .expire(comment.id, CACHE_DURATION)
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
