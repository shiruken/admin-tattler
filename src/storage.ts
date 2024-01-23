import { OnTriggerEvent, TriggerContext } from "@devvit/public-api";
import { CommentSubmit, CommentUpdate } from '@devvit/protos';

/**
 * Get array of cached moderator usernames from Redis
 * @param context A TriggerContext object
 * @returns A promise that resolves to an array of moderator usernames
 */
export async function getModerators(context: TriggerContext): Promise<string[]> {
  const moderators = await context.redis.get("mods");
  if (!moderators) {
    throw new Error('Cached modlist is empty');
  }
  return moderators.split(","); // Parse string representation of array
}

/**
 * Refresh cached subreddit modlist and write to Redis
 * @param context A TriggerContext object
 */
export async function refreshModerators(context: TriggerContext) {
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
 * Cache comment text
 * @param event An OnTriggerEvent object
 * @param context A TriggerContext object
 */
export async function cacheComment(event: OnTriggerEvent<CommentSubmit | CommentUpdate>, context: TriggerContext) {
  const comment = event.comment;
  if (comment && comment.body) {
    await context.redis.set(comment.id, comment.body);
    await context.redis.expire(comment.id, 60*60*24*14); // 14 days
  }
}

/**
 * Get cached comment text
 * @param comment_id Comment thing id (including t1_ prefix)
 * @param context A TriggerContext object
 */
export async function getCachedComment(comment_id: string, context: TriggerContext): Promise<string | undefined> {
  return await context.redis.get(comment_id);
}
