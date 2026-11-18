import { TriggerContext } from "@devvit/public-api";
import { CommentSubmit, CommentUpdate, ModAction, PostSubmit, PostUpdate } from '@devvit/protos';
import { CachedPostData } from "./types.js";
import { getValidatedSettings } from "./settings.js";
import { logger } from "./logger.js";

const CACHE_DURATION = 60*60*24*30; // 30 days
const MODERATOR_CACHE_TTL_SECONDS = 60*60*24; // 24 hours (self-heal missed webhooks)

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
    logger.modlist.info(`Updating cached modlist on ${action} by ${moderatorName}`);
    await cacheModerators(context);
  }

  // Ignore actions by platform bots
  if (moderatorName == "AutoModerator" || moderatorName == "reddit") {
    logger.action.debug(`Ignored ${action} by platform bot ${moderatorName}`);
    return;
  }

  // Ignore actions from [deleted] moderators. Should prevent notification 
  // spam when former moderators delete their content or accounts.
  if (moderatorName == "[deleted]") {
    logger.action.debug(`Ignored ${action} by [deleted] moderator`);
    return;
  }

  // Ignore user removing themselves as moderator
  if (action == "removemoderator" && moderatorName.toLowerCase() == event.targetUser?.name?.toLowerCase()) {
    logger.action.info(`Ignored removemoderator by ${moderatorName} on self`);
    return;
  }

  let moderators = await getCachedModerators(context);
  let isMod = moderators.some((m) => m.toLowerCase() === moderatorName.toLowerCase());

  // Check if acting moderator is NOT in modlist (or simulated admin during playtest)
  // Devvit playtest versions contain a 4th prerelease segment (e.g. 0.8.1.2) or a hyphen
  const isPrerelease = (v?: string) => Boolean(v && (v.includes("-") || v.split(".").length > 3));
  const isPlaytestDev =
    subredditName === "admin_tattler_dev" && isPrerelease(context.appVersion);

  if (isMod && !isPlaytestDev) {
    logger.action.debug(`Ignored ${action} by local moderator u/${moderatorName}`);
    return;
  }

  // If acting user is not in cached modlist and this is not a known admin/playtest,
  // perform a live refresh of the modlist to prevent false positives for newly added mods
  if (
    !isMod &&
    !isPlaytestDev &&
    moderatorName != "Anti-Evil Operations" &&
    moderatorName != "Reddit Legal" &&
    moderatorName != "[ Redacted ]"
  ) {
    logger.action.info(`u/${moderatorName} not found in cached modlist, performing live refresh to verify`);
    try {
      moderators = await cacheModerators(context);
      isMod = moderators.some((m) => m.toLowerCase() === moderatorName.toLowerCase());
      if (isMod) {
        logger.action.info(`u/${moderatorName} confirmed as moderator after live refresh; skipping`);
        return;
      }
    } catch (e) {
      logger.action.error("Error performing live modlist refresh", e);
    }
  }

  if (isPlaytestDev && isMod) {
    logger.action.info(`[Playtest] Simulating Admin action for mod u/${moderatorName}`);
  }

  logger.action.info(`Detected ${action} by ${moderatorName}`);

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
      }

      if (title == "[ Removed by Reddit ]" || body == "[ Removed by Reddit ]") {
        const cachedPost = await getCachedPost(targetPost.id, context);
        if (cachedPost) {
          if (title == "[ Removed by Reddit ]" && cachedPost.title) {
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

      if (title == "[ Removed by Reddit ]") {
        title = formatRemovedFallback(createdAt);
      } else if (body == "[ Removed by Reddit ]") {
        body = formatRemovedFallback(createdAt);
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
          } else {
            body = formatRemovedFallback(createdAt);
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

    // Send Modmail
    if (settings.sendModmail) {
      let msg = `**${modDisplayName}** has performed an action in r/${subredditName}:\n\n` +
                `* **Action:** \`${action}\`` +
                (permalink ? `\n* **Permalink:** ${permalink}` : "") +
                (user ? `\n* **Target User:** u/${user}${ is_banned ? ` (Banned in r/${subredditName})`: "" }` : "") +
                (url ? `\n* **URL${ usedCachedURL ? " (Cached)" : "" }:** ${url}` : "");

      if (!settings.excludeContext && title) {
        msg += `\n\n**Title${ usedCachedTitle ? " (Cached)" : "" }:**\n${quoteText(title)}`;
      }

      if (!settings.excludeContext && body) {
        msg += `\n\n**${targetComment ? "Comment" : "Body"}${ usedCachedBody ? " (Cached)" : "" }:**\n${quoteText(body.slice(0, 9000))}`;
      }

      msg += `\n\n[**${modlogLinkDesc}**](${modlogLink})\n\n` +
             `---\n\n` +
             `Notification generated by [Admin Tattler](https://developers.reddit.com/apps/admin-tattler). ` +
             `Configure settings [here](https://developers.reddit.com/r/${subredditName}/apps/admin-tattler).`;
      const subredditId = (subreddit.id.startsWith('t5_') ? subreddit.id : `t5_${subreddit.id}`) as `t5_${string}`;
      await context.reddit.modMail
        .createModInboxConversation({
          subredditId,
          subject: "Admin Action Detected",
          bodyMarkdown: msg,
        })
        .then(() => logger.notify.info(`Sent modmail about ${action} by ${moderatorName}`))
        .catch((e) => logger.notify.error(`Error sending modmail about ${action} by ${moderatorName}`, e));
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
        .then(() => logger.notify.info(`Sent Slack message about ${action} by ${moderatorName}`))
        .catch((e) => logger.notify.error(`Error sending Slack message about ${action} by ${moderatorName}`, e));
    }

    // Send to Discord
    if (settings.webhookURL && settings.webhookURL.startsWith("https://discord.com/api/webhooks/")) {
      const discordPayload = {
        username: "Admin Tattler",
        avatar_url: "https://raw.githubusercontent.com/shiruken/admin-tattler/main/assets/icon.png",
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
        .then(() => logger.notify.info(`Sent Discord message about ${action} by ${moderatorName}`))
        .catch((e) => logger.notify.error(`Error sending Discord message about ${action} by ${moderatorName}`, e));
    }

    // Add Mod Note for content removals
    if (
      settings.addModNote && user && user.toLowerCase() != "automoderator" && targetID &&
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
        .then(() => logger.notify.info(`Added mod note to ${targetID}`))
        .catch((e) => logger.notify.error(`Error adding mod note to ${targetID}`, e));
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
      .set(post.id, JSON.stringify(data), {
        expiration: new Date(Date.now() + CACHE_DURATION * 1000),
      })
      .then(() => logger.cache.debug(`Wrote ${post.id} to Redis`))
      .catch((e) => logger.cache.error(`Error writing ${post.id} to Redis`, e));
  }
}

/**
 * Get cached post text
 * @param post_id A post fullname (including t3_ prefix)
 * @param context A TriggerContext object
 * @returns A Promise that resolves to a {@link CachedPostData} object containing the cached post text
 */
async function getCachedPost(post_id: string, context: TriggerContext): Promise<CachedPostData | undefined> {
  const value = await context.redis.get(post_id);
  let cachedPost: CachedPostData | undefined = undefined;
  if (value) {
    try {
      cachedPost = JSON.parse(value);
      logger.cache.debug(`Retrieved cached post data for ${post_id}`);
    } catch (e) {
      logger.cache.error(`Error parsing JSON for ${post_id}`, e);
    }
  } else {
    logger.cache.debug(`No cached post data found for ${post_id}`);
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
      .set(comment.id, comment.body, {
        expiration: new Date(Date.now() + CACHE_DURATION * 1000),
      })
      .then(() => logger.cache.debug(`Wrote ${comment.id} to Redis`))
      .catch((e) => logger.cache.error(`Error writing ${comment.id} to Redis`, e));
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
  if (cachedComment) {
    logger.cache.debug(`Retrieved cached comment data for ${comment_id}`);
  } else {
    logger.cache.debug(`No cached comment data found for ${comment_id}`);
  }
  return cachedComment;
}

/**
 * Cache subreddit modlist in Redis with a 24-hour expiration TTL
 * @param context A TriggerContext object
 * @returns A Promise that resolves to the array of moderator usernames
 */
export async function cacheModerators(context: TriggerContext): Promise<string[]> {
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

  // Write string representation of array to Redis with 24-hour TTL
  try {
    await context.redis.set("mods", moderators.toString(), {
      expiration: new Date(Date.now() + MODERATOR_CACHE_TTL_SECONDS * 1000),
    });
    logger.modlist.info(`Wrote ${moderators.length} moderators to Redis with ${MODERATOR_CACHE_TTL_SECONDS}s TTL`);
  } catch (e) {
    logger.modlist.error('Error writing moderators to Redis', e);
  }

  return moderators;
}

/**
 * Get cached subreddit modlist, automatically refreshing if expired or missing
 * @param context A TriggerContext object
 * @returns A promise that resolves to an array of moderator usernames
 */
async function getCachedModerators(context: TriggerContext): Promise<string[]> {
  const cached = await context.redis.get("mods");
  if (cached) {
    const moderators = cached.split(","); // Parse string representation of array
    logger.modlist.debug(`Retrieved ${moderators.length} cached moderators`);
    return moderators;
  }

  logger.modlist.info("Cached modlist is empty or expired, refreshing...");
  return await cacheModerators(context);
}

/**
 * Format string as quoted text in Reddit Markdown
 * @param text A string to format as quoted text
 * @returns A string containing quoted text
 */
function quoteText(text: string): string {
  return text
    .trim()
    .split("\n")
    .map((line) => (line.length ? `> ${line}` : ">"))
    .join("\n");
}

/**
 * Format fallback text for content removed by Reddit that was not found in cache
 * @param createdAt Optional creation timestamp in milliseconds
 * @returns Formatted fallback text string
 */
export function formatRemovedFallback(createdAt?: number): string {
  if (createdAt) {
    const dateStr = new Date(createdAt).toLocaleDateString("fr-CA");
    if (Date.now() - createdAt > CACHE_DURATION * 1000) {
      return `[ Removed by Reddit ] (Submitted ${dateStr}, exceeds 30-day cache)`;
    }
    return `[ Removed by Reddit ] (Submitted ${dateStr}, not cached)`;
  }
  return "[ Removed by Reddit ] (Not cached)";
}
