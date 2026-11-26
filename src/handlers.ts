import { TriggerContext } from "@devvit/public-api";
import { CommentSubmit, CommentUpdate, ModAction, PostSubmit, PostUpdate } from '@devvit/protos';
import { CachedModAction, CachedPostData } from "./types.js";
import { getValidatedSettings, parseWebhookURLs } from "./settings.js";
import { logger } from "./logger.js";

const CACHE_DURATION = 60*60*24*30; // 30 days
const MODERATOR_CACHE_TTL_SECONDS = 60*60*24; // 24 hours (self-heal missed webhooks)
const RECENT_SUBMISSION_RETRY_WINDOW_MS = 60_000; // 60 seconds
const RETRY_DELAY_MS = 1000; // 1 second
const DEDUP_CACHE_TTL_SECONDS = 60*60*24; // 24 hours (1 day)
const COMMENT_MOD_ACTIONS = new Set(["removecomment", "spamcomment", "approvecomment"]);
const POST_MOD_ACTIONS = new Set(["removelink", "spamlink", "approvelink"]);
const REMOVAL_MOD_ACTIONS = new Set(["removecomment", "spamcomment", "removelink", "spamlink"]);
const REMOVED_BY_REDDIT_REGEX = /^\[\s*removed by reddit\s*\]$/i;
const REDACTED_CONTENT_REGEX = /^\[\s*(?:deleted|removed)\s*\]$/i;

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
    logger.action.warn(`Missing or empty moderator in ${action} ModActionTrigger event; skipping`);
    return;
  }
  const moderatorName = moderator.name;
  const modLower = moderatorName.toLowerCase();

  const subreddit = event.subreddit;
  if (!subreddit || !subreddit.name) {
    throw new Error('Missing `subreddit` from ModActionTrigger event');
  }
  const subredditName = subreddit.name;

  // Update cached modlist on modlist change
  let moderators: string[] | undefined;
  let didLiveRefresh = false;
  let fullRefreshFailed = false;
  if (
    action == "acceptmoderatorinvite" || action == "addmoderator" ||
    action == "removemoderator" || action == "reordermoderators"
  ) {
    logger.modlist.info(`Updating cached modlist on ${action} by ${moderatorName}`);
    try {
      moderators = await cacheModerators(context);
      didLiveRefresh = true;
    } catch (e) {
      logger.modlist.error(`Error updating cached modlist on ${action}`, e);
      fullRefreshFailed = true;
    }
  }

  // Ignore actions by AutoModerator and reddit (but record content removals/approvals)
  if (modLower === "automoderator" || modLower === "reddit") {
    await cacheModAction(event, context);
    logger.action.debug(`Ignored ${action} by ${moderatorName}`);
    return;
  }

  // Ignore actions from [deleted] moderators. Should prevent notification 
  // spam when former moderators delete their content or accounts.
  if (modLower === "[deleted]") {
    logger.action.debug(`Ignored ${action} by [deleted] moderator`);
    return;
  }

  // Ignore actions performed by this app itself (e.g. addnote)
  const appSlugLower = (context.appSlug || "admin-tattler").toLowerCase();
  if (modLower === appSlugLower) {
    logger.action.debug(`Ignored ${action} by app account u/${moderatorName}`);
    return;
  }

  // Ignore user removing themselves as moderator
  if (action == "removemoderator" && modLower === event.targetUser?.name?.toLowerCase()) {
    logger.action.debug(`Ignored removemoderator by ${moderatorName} on self`);
    return;
  }

  if (!moderators) {
    const cachedResult = await getCachedModerators(context, fullRefreshFailed);
    moderators = cachedResult.moderators;
    if (cachedResult.refreshed) {
      didLiveRefresh = true;
    }
    if (cachedResult.refreshFailed) {
      fullRefreshFailed = true;
    }
  }
  let isMod = moderators.some((m) => m.toLowerCase() === modLower);

  // Check if acting moderator is NOT in modlist (or simulated admin during playtest)
  // Devvit playtest versions contain a 4th prerelease segment (e.g. 0.8.1.2) or a hyphen
  const isPrerelease = (v?: string) => Boolean(v && (v.includes("-") || v.split(".").length > 3));
  const isPlaytestDev =
    subredditName === "admin_tattler_dev" && isPrerelease(context.appVersion);

  if (isMod && !isPlaytestDev) {
    await cacheModAction(event, context);
    logger.action.debug(`Ignored ${action} by local moderator u/${moderatorName}`);
    return;
  }

  // If acting user is not in cached modlist and this is not a known admin/playtest,
  // perform a live refresh of the modlist to prevent false positives for newly added mods
  if (
    !isMod &&
    !didLiveRefresh &&
    !isPlaytestDev &&
    moderatorName != "Anti-Evil Operations" &&
    moderatorName != "Reddit Legal" &&
    moderatorName != "[ Redacted ]"
  ) {
    if (!fullRefreshFailed) {
      logger.action.info(`u/${moderatorName} not found in cached modlist, performing live refresh to verify`);
      try {
        moderators = await cacheModerators(context);
        isMod = moderators.some((m) => m.toLowerCase() === modLower);
        if (isMod) {
          await cacheModAction(event, context);
          logger.action.info(`u/${moderatorName} confirmed as moderator after live refresh; skipping`);
          return;
        }
      } catch (e) {
        logger.action.error("Error performing live modlist refresh", e);
        fullRefreshFailed = true;
      }
    }

    if (fullRefreshFailed) {
      logger.action.info(`Falling back to single-user moderator lookup for u/${moderatorName}`);
      isMod = await isModeratorViaSingleLookup(subredditName, moderatorName, context);
      if (isMod) {
        await cacheModAction(event, context);
        logger.action.info(`u/${moderatorName} confirmed as moderator via single-user lookup; skipping`);
        return;
      }
    }
  }

  if (isPlaytestDev && isMod) {
    logger.action.info(`[Playtest] Simulating Admin action for mod u/${moderatorName}`);
  }

  const settings = await getValidatedSettings(context);
  const webhookURLs = parseWebhookURLs(settings.webhookURL);

  // If all reporting routes and mod notes are disabled, skip processing
  if (!settings.sendModmail && webhookURLs.length === 0 && !settings.addModNote) {
    logger.action.info(`Ignored ${action} by ${moderatorName}: all reporting routes and mod notes are disabled`);
    return;
  }

  // Ignore unsticky actions on content that has been deleted
  if (action === "unsticky" && await isUnstickyTargetDeleted(event, context)) {
    const targetId = event.targetComment?.id || event.targetPost?.id || "unknown";
    logger.action.info(`Ignored unsticky on deleted content (${targetId})`);
    return;
  }

  // Deduplicate mod actions to prevent duplicate alerts if Devvit redelivers the event
  const targetIdentifier = event.targetComment?.id || event.targetPost?.id || event.targetUser?.name || "";
  const timestamp = event.actionedAt instanceof Date ? event.actionedAt.getTime() : (event.actionedAt ?? "");
  const dedupId = event.id ? `id:${event.id}` : `${action}:${targetIdentifier}:${timestamp}`;
  const dedupKey = `dedup:action:${dedupId}`;

  try {
    const isNewAction = await context.redis.set(dedupKey, "1", {
      nx: true,
      expiration: new Date(Date.now() + DEDUP_CACHE_TTL_SECONDS * 1000),
    });
    if (!isNewAction) {
      logger.action.info(`Ignored duplicate ${action} action (${dedupKey})`);
      return;
    }
    logger.action.debug(`Stored deduplication key ${dedupKey}`);
  } catch (e) {
    logger.action.error(`Error checking action deduplication for ${dedupKey}`, e);
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

      if (isRemovedByReddit(title) || isRemovedByReddit(body)) {
        let cachedPost = await getCachedPost(targetPost.id, context);
        if (!cachedPost && createdAt && Math.abs(Date.now() - createdAt) < RECENT_SUBMISSION_RETRY_WINDOW_MS) {
          logger.cache.info(`Post ${targetPost.id} was recently created; retrying cache lookup in 1s`);
          await sleep(RETRY_DELAY_MS);
          cachedPost = await getCachedPost(targetPost.id, context);
        }
        if (cachedPost) {
          if (isRemovedByReddit(title) && cachedPost.title && !isRedactedContent(cachedPost.title)) {
            title = cachedPost.title;
            usedCachedTitle = true;
          }
          if (!url && cachedPost.url && !cachedPost.url.includes(targetPost.id.slice(3))) {
            url = cachedPost.url;
            usedCachedURL = true;
          }
          if ((isRemovedByReddit(body) || !body) && cachedPost.body && !isRedactedContent(cachedPost.body)) {
            body = cachedPost.body;
            usedCachedBody = true;
          }
        }
      }

      if (isRemovedByReddit(title)) {
        title = formatRemovedFallback(createdAt);
      } else if (isRemovedByReddit(body)) {
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
        if (isRemovedByReddit(body)) {
          let cachedComment = await getCachedComment(targetComment.id, context);
          if (!cachedComment && createdAt && Math.abs(Date.now() - createdAt) < RECENT_SUBMISSION_RETRY_WINDOW_MS) {
            logger.cache.info(`Comment ${targetComment.id} was recently created; retrying cache lookup in 1s`);
            await sleep(RETRY_DELAY_MS);
            cachedComment = await getCachedComment(targetComment.id, context);
          }
          if (cachedComment && !isRedactedContent(cachedComment)) {
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
    if (targetUser && (targetUser.name || targetUser.id)) {
      user = targetUser.name || "";
      if (user) {
        try {
          const listing = await context.reddit.getBannedUsers({
            subredditName: subredditName,
            username: user,
          });
          is_banned = (await listing.all()).length == 1;
        } catch (e) {
          logger.action.error(`Error checking ban status for u/${user}`, e);
        }
      }
    }

    let modDisplayName = moderatorName;
    let modlogLinkDesc = "View Admin Modlog";
    let modlogLink = `https://www.reddit.com/mod/${subredditName}/log?moderatorNames=a`;
    if (isPlaytestDev && isMod) {
      modDisplayName = "Anti-Evil Operations";
    } else if (moderatorName != "Anti-Evil Operations" && moderatorName != "Reddit Legal" && moderatorName != "[ Redacted ]") {
      modDisplayName = `u/${moderatorName}`;
      modlogLinkDesc = "View Modlog";
      modlogLink = `https://www.reddit.com/mod/${subredditName}/log?moderatorNames=${moderatorName}`;
    }

    if (modDisplayName == "[ Redacted ]") {
      modDisplayName = "Anti-Evil Operations";
    }

    let priorModActionNote = "";
    const contentTargetId = getContentTargetId(action, event);
    if (contentTargetId && (settings.sendModmail || webhookURLs.length > 0)) {
      const priorModAction = await getCachedModAction(contentTargetId, context);
      const adminActionTime = event.actionedAt instanceof Date ? event.actionedAt.getTime() : undefined;
      if (priorModAction) {
        if (
          priorModAction.timestamp !== undefined &&
          adminActionTime !== undefined &&
          priorModAction.timestamp > adminActionTime
        ) {
          logger.cache.info(`Ignored cached mod action for ${contentTargetId}: occurred after Admin action`);
        } else {
          priorModActionNote = ` (${formatPriorModAction(priorModAction)})`;
        }
      }
    }

    let adminRemovalCount = 0;
    if (user && contentTargetId) {
      adminRemovalCount = await updateAdminRemovalCount(
        user,
        action,
        contentTargetId,
        event.actionedAt,
        context
      );
    }

    const userBadges: string[] = [];
    if (is_banned) {
      userBadges.push(`Banned in r/${subredditName}`);
    }
    if (adminRemovalCount >= 2) {
      userBadges.push(`${adminRemovalCount} Admin removals`);
    }
    const targetUserNote = userBadges.length ? ` (${userBadges.join(", ")})` : "";

    // Send Modmail
    if (settings.sendModmail) {
      let msg = `**${modDisplayName}** has performed an action in r/${subredditName}:\n\n` +
                `* **Action:** \`${action}\`${priorModActionNote}` +
                (permalink ? `\n* **Permalink:** ${permalink}` : "") +
                (user ? `\n* **Target User:** u/${user}${targetUserNote}` : "") +
                (url ? `\n* **URL${ usedCachedURL ? " (Cached)" : "" }:** ${url}` : "");

      if (!settings.excludeContext && title) {
        msg += `\n* **Title${ usedCachedTitle ? " (Cached)" : "" }:** ${title}`;
      }

      if (!settings.excludeContext && body) {
        const bodyLabel = `${targetComment?.id ? "Comment" : "Body"}${ usedCachedBody ? " (Cached)" : "" }`;
        if (body.startsWith("[ Removed by Reddit ]") || isRedactedContent(body)) {
          msg += `\n* **${bodyLabel}:** ${body}`;
        } else {
          msg += `\n* **${bodyLabel}:**\n${quoteText(body.slice(0, 9000))}`;
        }
      }

      msg += `\n\n[**${modlogLinkDesc}**](${modlogLink})`;
      const modmailFooter = `\n\n` +
             `*Notification generated by [Admin Tattler](https://developers.reddit.com/apps/admin-tattler). ` +
             `Configure settings [here](https://developers.reddit.com/r/${subredditName}/apps/admin-tattler).*`;
      const rawSubredditId = subreddit.id || context.subredditId || "";
      const subredditId = (rawSubredditId.startsWith("t5_") ? rawSubredditId : `t5_${rawSubredditId}`) as `t5_${string}`;
      const subjectPrefix = settings.modmailNotification ? "[Notification] " : "";
      let conversationId: string | undefined;

      // Reply to existing Modmail conversation if Admins previously actioned this post or comment
      if (targetID) {
        const existingConversationId = await getCachedModmailId(targetID, context);
        if (existingConversationId) {
          try {
            await context.reddit.modMail.reply({
              conversationId: existingConversationId,
              body: msg,
              isInternal: true,
            });
            conversationId = existingConversationId;
            logger.notify.info(`Replied to modmail conversation ${existingConversationId} about ${action} by ${moderatorName}`);
          } catch (e) {
            logger.notify.warn(`Error replying to modmail conversation ${existingConversationId}; creating new conversation`, e);
          }
        }
      }

      if (!conversationId) {
        conversationId = await context.reddit.modMail
          .createModInboxConversation({
            subredditId,
            subject: `${subjectPrefix}Admin Action Detected: ${action}`,
            bodyMarkdown: msg + modmailFooter,
          })
          .then((id) => {
            logger.notify.info(`Sent modmail about ${action} by ${moderatorName}`);
            return id;
          })
          .catch((e) => {
            logger.notify.error(`Error sending modmail about ${action} by ${moderatorName}`, e);
            return undefined;
          });
      }

      if (conversationId && targetID) {
        await cacheModmailId(targetID, conversationId, context);
      }

      if (settings.archiveModmail && conversationId) {
        await context.reddit.modMail
          .archiveConversation(conversationId)
          .then(() => logger.notify.info(`Archived modmail conversation ${conversationId}`))
          .catch((e) => logger.notify.error(`Error archiving modmail conversation ${conversationId}`, e));
      }
    }

    // Send to Slack
    const slackURLs = webhookURLs.filter((u) => u.startsWith("https://hooks.slack.com/"));
    if (slackURLs.length > 0) {
      const slackContextText = (
        `*Action:* \`${action}\`${priorModActionNote}` +
        (permalink ? `\n*Permalink:* ${permalink}` : "") +
        (user ? `\n*Target User:* <https://www.reddit.com/user/${user}|u/${user}>${targetUserNote}` : "") +
        (url ? `\n*URL${ usedCachedURL ? " (Cached)" : "" }:* ${url}` : "") +
        (!settings.excludeContext && title ? `\n*Title${ usedCachedTitle ? " (Cached)" : "" }:* ${title}` : "") +
        (!settings.excludeContext && body ? `\n*Body${ usedCachedBody ? " (Cached)" : "" }:* ${body.slice(0, 2500)}` : "")
      ).slice(0, 3000);

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
                    text: slackContextText
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
      const slackBody = JSON.stringify(slackPayload);
      for (const slackURL of slackURLs) {
        await fetch(slackURL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: slackBody,
        })
          .then((res) => {
            if (!res.ok) {
              throw new Error(`HTTP ${res.status} ${res.statusText}`);
            }
            logger.notify.info(`Sent Slack message about ${action} by ${moderatorName}`);
          })
          .catch((e) => logger.notify.error(`Error sending Slack message about ${action} by ${moderatorName}`, e));
      }
    }

    // Send to Discord
    const discordURLs = webhookURLs.filter((u) => u.startsWith("https://discord.com/api/webhooks/"));
    if (discordURLs.length > 0) {
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
                value: `\`${action}\`${priorModActionNote}`
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
          value: `[u/${user}](https://www.reddit.com/user/${user})${targetUserNote}`
        });
      }

      if (url) {
        discordPayload.embeds[0].fields.push({
          name: (usedCachedURL ? "URL (Cached)" : "URL"),
          value: url.slice(0, 1024)
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

      const discordBody = JSON.stringify(discordPayload);
      for (const discordURL of discordURLs) {
        await fetch(discordURL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: discordBody,
        })
          .then((res) => {
            if (!res.ok) {
              throw new Error(`HTTP ${res.status} ${res.statusText}`);
            }
            logger.notify.info(`Sent Discord message about ${action} by ${moderatorName}`);
          })
          .catch((e) => logger.notify.error(`Error sending Discord message about ${action} by ${moderatorName}`, e));
      }
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

    // Delete app-created Mod Note(s) if content is re-approved by Admins
    if (
      settings.addModNote && user && user.toLowerCase() != "automoderator" && targetID &&
      (action == "approvelink" || action == "approvecomment")
    ) {
      try {
        const notes = await context.reddit
          .getModNotes({
            subreddit: subredditName,
            user: user,
            filter: "NOTE",
            limit: 100,
          })
          .all();
        const matchingNotes = notes.filter(
          (note) =>
            note.operator.name?.toLowerCase() === appSlugLower &&
            note.userNote?.redditId === targetID
        );
        for (const note of matchingNotes) {
          await context.reddit
            .deleteModNote({
              subreddit: subredditName,
              user: user,
              noteId: note.id,
            })
            .then((deleted) => {
              if (deleted) {
                logger.notify.info(`Deleted mod note ${note.id} from ${targetID}`);
              } else {
                logger.notify.warn(`Failed to delete mod note ${note.id} from ${targetID}`);
              }
            })
            .catch((e) => logger.notify.error(`Error deleting mod note ${note.id} from ${targetID}`, e));
        }
      } catch (e) {
        logger.notify.error(`Error fetching mod notes for u/${user} on ${targetID}`, e);
      }
    }
}

/**
 * Cache post text
 * @param event A PostSubmit or PostUpdate object
 * @param context A TriggerContext object
 */
export async function cachePost(
  event: (PostSubmit | PostUpdate) & { type?: "PostSubmit" | "PostUpdate" },
  context: TriggerContext
) {
  const post = event.post;
  if (post && post.title) {
    const eventType = event.type ?? ("previousBody" in event ? "PostUpdate" : "PostSubmit");
    if (post.deleted || isRedactedContent(post.title) || isRedactedContent(post.selftext)) {
      const prevInfo = formatPreviousBodyDebug(event);
      logger.cache.debug(`[${eventType}] Skipped caching ${post.id}: content is redacted or deleted${prevInfo}`);
      return;
    }

    const data: CachedPostData = {
      title: post.title,
      body: post.selftext,
      url: post.url
    };
    await context.redis
      .set(post.id, JSON.stringify(data), {
        expiration: new Date(Date.now() + CACHE_DURATION * 1000),
      })
      .then(() => logger.cache.debug(`[${eventType}] Wrote ${post.id} to Redis`))
      .catch((e) => logger.cache.error(`[${eventType}] Error writing ${post.id} to Redis`, e));
  }
}

/**
 * Get cached post text
 * @param post_id A post fullname (including t3_ prefix)
 * @param context A TriggerContext object
 * @returns A Promise that resolves to a {@link CachedPostData} object containing the cached post text
 */
async function getCachedPost(post_id: string, context: TriggerContext): Promise<CachedPostData | undefined> {
  let value: string | undefined;
  try {
    value = await context.redis.get(post_id);
  } catch (e) {
    logger.cache.error(`Error fetching cached post data for ${post_id}`, e);
    return undefined;
  }
  let cachedPost: CachedPostData | undefined = undefined;
  if (value) {
    try {
      cachedPost = JSON.parse(value);
      logger.cache.info(`Retrieved cached post data for ${post_id}`);
    } catch (e) {
      logger.cache.error(`Error parsing JSON for ${post_id}`, e);
    }
  } else {
    logger.cache.info(`No cached post data found for ${post_id}`);
  }
  return cachedPost;
}

/**
 * Cache comment text
 * @param event A CommentSubmit or CommentUpdate object
 * @param context A TriggerContext object
 */
export async function cacheComment(
  event: (CommentSubmit | CommentUpdate) & { type?: "CommentSubmit" | "CommentUpdate" },
  context: TriggerContext
) {
  const comment = event.comment;
  if (comment && comment.body) {
    const eventType = event.type ?? ("previousBody" in event ? "CommentUpdate" : "CommentSubmit");
    if (comment.deleted || isRedactedContent(comment.body)) {
      const prevInfo = formatPreviousBodyDebug(event);
      logger.cache.debug(`[${eventType}] Skipped caching ${comment.id}: content is redacted or deleted${prevInfo}`);
      return;
    }

    await context.redis
      .set(comment.id, comment.body, {
        expiration: new Date(Date.now() + CACHE_DURATION * 1000),
      })
      .then(() => logger.cache.debug(`[${eventType}] Wrote ${comment.id} to Redis`))
      .catch((e) => logger.cache.error(`[${eventType}] Error writing ${comment.id} to Redis`, e));
  }
}

/**
 * Get cached comment text
 * @param comment_id A comment fullname (including t1_ prefix)
 * @param context A TriggerContext object
 * @returns A Promise that resolves to the cached comment text
 */
async function getCachedComment(comment_id: string, context: TriggerContext): Promise<string | undefined> {
  let cachedComment: string | undefined;
  try {
    cachedComment = await context.redis.get(comment_id);
  } catch (e) {
    logger.cache.error(`Error fetching cached comment data for ${comment_id}`, e);
    return undefined;
  }
  if (cachedComment) {
    logger.cache.info(`Retrieved cached comment data for ${comment_id}`);
  } else {
    logger.cache.info(`No cached comment data found for ${comment_id}`);
  }
  return cachedComment;
}

/**
 * Cache subreddit modlist in Redis with a 24-hour expiration TTL
 * @param context A TriggerContext object
 * @returns A Promise that resolves to the array of moderator usernames
 */
export async function cacheModerators(context: TriggerContext): Promise<string[]> {
  const startTime = Date.now();
  const subreddit = await context.reddit.getCurrentSubreddit();
  const moderators: string[] = [];
  try {
    for await(const moderator of subreddit.getModerators({ pageSize: 500 })) {
      moderators.push(moderator.username);
    }
  } catch (err) {
    const elapsedMs = Date.now() - startTime;
    throw new Error(
      `Error fetching modlist for r/${subreddit.name} after ${elapsedMs}ms (${moderators.length} fetched): ${err}`
    );
  }

  if (!moderators.length) {
    throw new Error(`Fetched modlist for r/${subreddit.name} is empty, skipping cache update`);
  }

  // Write string representation of array to Redis with 24-hour TTL
  try {
    await context.redis.set("mods", moderators.toString(), {
      expiration: new Date(Date.now() + MODERATOR_CACHE_TTL_SECONDS * 1000),
    });
    const elapsedMs = Date.now() - startTime;
    logger.modlist.info(
      `Wrote ${moderators.length} moderators to Redis in ${elapsedMs}ms with ${MODERATOR_CACHE_TTL_SECONDS}s TTL`
    );
  } catch (e) {
    logger.modlist.error('Error writing moderators to Redis', e);
  }

  return moderators;
}

type CachedModeratorsResult = {
  moderators: string[];
  refreshed: boolean;
  refreshFailed: boolean;
};

/**
 * Get cached subreddit modlist, automatically refreshing if expired or missing
 * @param context A TriggerContext object
 * @param skipRefresh If true, do not attempt a full refresh when cache is empty (e.g. already failed on this event)
 * @returns A promise that resolves to cached moderators and refresh status
 */
async function getCachedModerators(
  context: TriggerContext,
  skipRefresh = false
): Promise<CachedModeratorsResult> {
  let cached: string | undefined;
  try {
    cached = await context.redis.get("mods");
  } catch (e) {
    logger.modlist.error("Error fetching cached modlist from Redis", e);
  }
  if (cached) {
    const moderators = cached.split(","); // Parse string representation of array
    logger.modlist.debug(`Retrieved ${moderators.length} cached moderators`);
    return { moderators, refreshed: false, refreshFailed: false };
  }

  if (skipRefresh) {
    return { moderators: [], refreshed: false, refreshFailed: true };
  }

  logger.modlist.info("Cached modlist is empty or expired, refreshing...");
  try {
    const moderators = await cacheModerators(context);
    return { moderators, refreshed: true, refreshFailed: false };
  } catch (e) {
    logger.modlist.error("Error refreshing empty or expired modlist cache", e);
    return { moderators: [], refreshed: false, refreshFailed: true };
  }
}

/**
 * Check whether a single user is a moderator of the subreddit via a targeted API lookup (O(1)).
 * Used as a read-only fallback when a full modlist refresh fails.
 * @param subredditName The subreddit name (without r/ prefix)
 * @param username The username to verify
 * @param context A TriggerContext object
 * @returns True if the user is confirmed as a moderator, false otherwise
 */
async function isModeratorViaSingleLookup(
  subredditName: string,
  username: string,
  context: TriggerContext
): Promise<boolean> {
  try {
    const matches = await context.reddit
      .getModerators({ subredditName, username })
      .all();
    return matches.some((m) => m.username.toLowerCase() === username.toLowerCase());
  } catch (e) {
    logger.action.error(`Error verifying moderator status for u/${username} via single-user lookup`, e);
    return false;
  }
}

/**
 * Check whether the target post or comment of an `unsticky` action has been deleted
 * @param event A ModAction object
 * @param context A TriggerContext object
 * @returns True if the target content is deleted
 */
async function isUnstickyTargetDeleted(event: ModAction, context: TriggerContext): Promise<boolean> {
  if (
    event.targetComment?.deleted ||
    event.targetPost?.deleted ||
    event.targetComment?.body === "[deleted]" ||
    event.targetPost?.selftext === "[deleted]" ||
    event.targetPost?.title === "[deleted]" ||
    event.targetUser?.name === "[deleted]"
  ) {
    return true;
  }

  if (event.targetComment?.id) {
    try {
      const comment = await context.reddit.getCommentById(event.targetComment.id);
      return comment.authorName === "[deleted]" || comment.body === "[deleted]";
    } catch (e) {
      if (e instanceof Error && (e.message === "not found" || e.message.includes("404"))) {
        return true;
      }
      logger.action.error(`Error checking deletion status for ${event.targetComment.id}`, e);
      return false;
    }
  }

  if (event.targetPost?.id) {
    try {
      const post = await context.reddit.getPostById(event.targetPost.id);
      return (
        post.authorName === "[deleted]" ||
        post.body === "[deleted]" ||
        post.title === "[deleted]"
      );
    } catch (e) {
      if (e instanceof Error && (e.message.startsWith("no post ") || e.message.includes("404"))) {
        return true;
      }
      logger.action.error(`Error checking deletion status for ${event.targetPost.id}`, e);
      return false;
    }
  }

  return false;
}

/**
 * Format string as quoted text in Reddit Markdown indented under a list item
 * @param text A string to format as quoted text
 * @returns A string containing quoted text
 */
function quoteText(text: string): string {
  return text
    .trim()
    .split("\n")
    .map((line) => (line.length ? `  > ${line}` : "  >"))
    .join("\n");
}

/**
 * Pause execution for specified milliseconds
 * @param ms Milliseconds to sleep
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Update and return a user's all-time Admin content removal count in Redis.
 * Adds targetId on content removals and removes targetId on content approvals (reversals).
 * @param user Target username
 * @param action Content removal or approval ModAction string
 * @param targetId Target post (t3_) or comment (t1_) fullname
 * @param actionedAt Optional event timestamp
 * @param context A TriggerContext object
 * @returns Total all-time Admin removal count for the user, or 0 on error/ignored user
 */
async function updateAdminRemovalCount(
  user: string,
  action: string,
  targetId: string,
  actionedAt: Date | undefined,
  context: TriggerContext
): Promise<number> {
  const userLower = user.toLowerCase();
  if (userLower === "automoderator" || userLower === "[deleted]") {
    return 0;
  }

  const key = `admin_removals:${userLower}`;
  const score = actionedAt instanceof Date ? actionedAt.getTime() : Date.now();

  try {
    if (REMOVAL_MOD_ACTIONS.has(action)) {
      await context.redis.zAdd(key, { member: targetId, score });
      logger.cache.debug(`Recorded Admin removal ${targetId} in ${key}`);
    } else {
      const removed = await context.redis.zRem(key, [targetId]);
      if (removed > 0) {
        logger.cache.info(`Removed reversed Admin removal ${targetId} from ${key}`);
      }
    }
    return await context.redis.zCard(key);
  } catch (e) {
    logger.cache.error(`Error updating Admin removal count for ${key}`, e);
    return 0;
  }
}

/**
 * Cache a Modmail conversation ID for an actioned post or comment so follow-up Admin actions can reply to it
 * @param targetId A post (t3_) or comment (t1_) fullname
 * @param conversationId The Modmail conversation ID
 * @param context A TriggerContext object
 */
async function cacheModmailId(
  targetId: string,
  conversationId: string,
  context: TriggerContext
): Promise<void> {
  const key = `modmail:${targetId}`;
  try {
    await context.redis.set(key, conversationId, {
      expiration: new Date(Date.now() + CACHE_DURATION * 1000),
    });
    logger.cache.debug(`Wrote ${key} (${conversationId}) to Redis`);
  } catch (e) {
    logger.cache.error(`Error writing ${key} to Redis`, e);
  }
}

/**
 * Retrieve cached Modmail conversation ID for a post or comment
 * @param targetId A post (t3_) or comment (t1_) fullname
 * @param context A TriggerContext object
 * @returns A Promise resolving to the cached Modmail conversation ID, or undefined
 */
async function getCachedModmailId(
  targetId: string,
  context: TriggerContext
): Promise<string | undefined> {
  const key = `modmail:${targetId}`;
  try {
    const conversationId = await context.redis.get(key);
    if (conversationId) {
      logger.cache.info(`Retrieved cached modmail conversation ${conversationId} for ${targetId}`);
      return conversationId;
    }
  } catch (e) {
    logger.cache.error(`Error fetching cached modmail conversation for ${targetId}`, e);
  }
  return undefined;
}

/**
 * Extract the target content ID matching a content removal/approval ModAction
 * @param action The ModAction action string
 * @param event A ModAction object
 * @returns Comment ID (for *comment actions) or Post ID (for *link actions), or undefined
 */
function getContentTargetId(action: string, event: ModAction): string | undefined {
  if (COMMENT_MOD_ACTIONS.has(action)) {
    return event.targetComment?.id || undefined;
  }
  if (POST_MOD_ACTIONS.has(action)) {
    return event.targetPost?.id || undefined;
  }
  return undefined;
}

/**
 * Cache a local moderator, AutoModerator, or reddit content removal/approval action in Redis
 * @param event A ModAction object
 * @param context A TriggerContext object
 */
async function cacheModAction(event: ModAction, context: TriggerContext): Promise<void> {
  const action = event.action;
  const moderator = event.moderator?.name;
  const targetId = action ? getContentTargetId(action, event) : undefined;
  if (!action || !moderator || !targetId) {
    return;
  }

  const key = `modaction:${targetId}`;
  const timestamp = event.actionedAt instanceof Date ? event.actionedAt.getTime() : undefined;
  const value: CachedModAction =
    timestamp !== undefined ? { action, moderator, timestamp } : { action, moderator };
  try {
    await context.redis.set(key, JSON.stringify(value), {
      expiration: new Date(Date.now() + CACHE_DURATION * 1000),
    });
    logger.cache.debug(`Wrote ${key} (${action} by ${moderator}) to Redis`);
  } catch (e) {
    logger.cache.error(`Error writing ${key} to Redis`, e);
  }
}

/**
 * Retrieve cached prior moderator content action for a post or comment
 * @param targetId A post (t3_) or comment (t1_) fullname
 * @param context A TriggerContext object
 * @returns A Promise resolving to the cached prior mod action, or undefined
 */
async function getCachedModAction(
  targetId: string,
  context: TriggerContext
): Promise<CachedModAction | undefined> {
  const key = `modaction:${targetId}`;
  let raw: string | undefined;
  try {
    raw = await context.redis.get(key);
  } catch (e) {
    logger.cache.error(`Error fetching cached mod action for ${targetId}`, e);
    return undefined;
  }

  if (!raw) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<CachedModAction>;
    if (typeof parsed.action === "string" && typeof parsed.moderator === "string") {
      logger.cache.info(`Retrieved cached mod action for ${targetId}: ${parsed.action} by ${parsed.moderator}`);
      return {
        action: parsed.action,
        moderator: parsed.moderator,
        ...(typeof parsed.timestamp === "number" ? { timestamp: parsed.timestamp } : {}),
      };
    }
  } catch {
    logger.cache.debug(`Ignored malformed cached mod action for ${targetId}`);
  }
  return undefined;
}

/**
 * Format a cached prior moderator action as a human-readable phrase
 * @param priorAction Cached prior moderator action
 * @returns Formatted description (e.g. "Previously removed by u/AutoModerator")
 */
export function formatPriorModAction(priorAction: CachedModAction): string {
  const actor =
    priorAction.moderator.toLowerCase() === "reddit"
      ? "reddit"
      : `u/${priorAction.moderator}`;

  switch (priorAction.action) {
    case "removecomment":
    case "removelink":
      return `Previously removed by ${actor}`;
    case "spamcomment":
    case "spamlink":
      return `Previously marked as spam by ${actor}`;
    case "approvecomment":
    case "approvelink":
      return `Previously approved by ${actor}`;
    default:
      return `Previously actioned (${priorAction.action}) by ${actor}`;
  }
}

/**
 * Format exploratory previousBody metadata for Update events without logging raw user text
 * @param event A Submit or Update trigger event
 * @returns Debug suffix describing previousBody availability, or empty string
 */
function formatPreviousBodyDebug(event: PostSubmit | PostUpdate | CommentSubmit | CommentUpdate): string {
  if (!("previousBody" in event)) {
    return "";
  }
  const prev = event.previousBody;
  if (!prev) {
    return " (previousBody: empty)";
  }
  if (isRedactedContent(prev)) {
    return " (previousBody: redacted)";
  }
  return ` (previousBody: ${prev.length} chars)`;
}

/**
 * Check whether text is a Reddit Admin removal placeholder (with or without inner whitespace)
 * @param text Optional text string
 * @returns True if text matches a Reddit removal placeholder
 */
export function isRemovedByReddit(text?: string): boolean {
  return Boolean(text && REMOVED_BY_REDDIT_REGEX.test(text.trim()));
}

/**
 * Check whether text is a redacted, removed, or deleted placeholder
 * @param text Optional text string
 * @returns True if text matches any redacted/deleted/removed placeholder
 */
export function isRedactedContent(text?: string): boolean {
  if (!text) {
    return false;
  }
  const trimmed = text.trim();
  return REMOVED_BY_REDDIT_REGEX.test(trimmed) || REDACTED_CONTENT_REGEX.test(trimmed);
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
