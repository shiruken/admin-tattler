import { OnTriggerEvent, TriggerContext } from "@devvit/public-api";
import { CommentSubmit, CommentUpdate, PostSubmit, PostUpdate } from '@devvit/protos';

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
export async function getCachedModerators(context: TriggerContext): Promise<string[]> {
  const moderators = await context.redis.get("mods");
  if (!moderators) {
    throw new Error('Cached modlist is empty');
  }
  return moderators.split(","); // Parse string representation of array
}

/**
 * CachedPostData
 * @typeParam title: Post title text
 * @typeParam body: Post body text
 * @typeParam body: Post url
 */
interface CachedPostData {
  title: string,
  body: string,
  url: string
};

/**
 * Cache post text
 * @param event An OnTriggerEvent object
 * @param context A TriggerContext object
 */
export async function cachePost(event: OnTriggerEvent<PostSubmit | PostUpdate>, context: TriggerContext) {
  const post = event.post;
  if (post && post.title) {
    const data: CachedPostData = {
      title: post.title,
      body: post.selftext,
      url: post.url
    };
    await context.redis.set(post.id, JSON.stringify(data));
    await context.redis.expire(post.id, 60*60*24*14); // 14 days
  }
}

/**
 * Get cached post text
 * @param comment_id A post thing id (including t3_ prefix)
 * @param context A TriggerContext object
 * @returns A Promise that resolves to a {@link CachedPostData} object containing the cached post text
 */
export async function getCachedPost(post_id: string, context: TriggerContext): Promise<CachedPostData | undefined> {
  const value = await context.redis.get(post_id);
  let cachedPost: CachedPostData | undefined = undefined;
  if (value) {
    cachedPost = JSON.parse(value);
  }
  return cachedPost;
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
 * @param comment_id A comment thing id (including t1_ prefix)
 * @param context A TriggerContext object
 * @returns A Promise that resolves to the cached comment text
 */
export async function getCachedComment(comment_id: string, context: TriggerContext): Promise<string | undefined> {
  const cachedComment = await context.redis.get(comment_id);
  return cachedComment;
}
