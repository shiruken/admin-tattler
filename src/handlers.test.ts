import { describe, expect, it, vi, beforeEach } from "vitest";
import { cacheComment, cacheModerators, cachePost, checkModAction, formatPriorModAction, formatRemovedFallback } from "./handlers.js";
import type { TriggerContext } from "@devvit/public-api";
import type { CommentSubmit, ModAction, PostSubmit } from "@devvit/protos";

describe("handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("ok", { status: 200 })));
  });

  describe("cachePost", () => {
    it("caches post title, body, and url to Redis with expiration", async () => {
      const redisSet = vi.fn().mockResolvedValue("OK");

      const mockContext = {
        redis: {
          set: redisSet,
        },
      } as unknown as TriggerContext;

      const event: PostSubmit = {
        post: {
          id: "t3_post123",
          title: "Test Post Title",
          selftext: "Test post body content",
          url: "https://reddit.com/r/test/comments/post123",
        },
      } as unknown as PostSubmit;

      await cachePost(event, mockContext);

      expect(redisSet).toHaveBeenCalledWith(
        "t3_post123",
        JSON.stringify({
          title: "Test Post Title",
          body: "Test post body content",
          url: "https://reddit.com/r/test/comments/post123",
        }),
        {
          expiration: expect.any(Date),
        }
      );
    });

    it("does nothing when post or title is missing", async () => {
      const redisSet = vi.fn();
      const mockContext = {
        redis: { set: redisSet },
      } as unknown as TriggerContext;

      await cachePost({} as PostSubmit, mockContext);
      expect(redisSet).not.toHaveBeenCalled();
    });

    it("does not cache post when title or selftext is redacted or deleted", async () => {
      const consoleDebug = vi.spyOn(console, "debug").mockImplementation(() => {});
      const redisSet = vi.fn();
      const mockContext = {
        redis: { set: redisSet },
      } as unknown as TriggerContext;

      await cachePost(
        { post: { id: "t3_p1", title: "[ Removed by Reddit ]", selftext: "text" } } as PostSubmit,
        mockContext
      );
      await cachePost(
        { post: { id: "t3_p2", title: "[deleted]", selftext: "text" } } as PostSubmit,
        mockContext
      );
      await cachePost(
        { post: { id: "t3_p3", title: "Valid Title", selftext: "[ Removed by Reddit ]" } } as PostSubmit,
        mockContext
      );
      await cachePost(
        { post: { id: "t3_p4", title: "[removed]", selftext: "text" } } as PostSubmit,
        mockContext
      );
      await cachePost(
        { post: { id: "t3_p5", title: "Valid Title", selftext: "[deleted]" } } as PostSubmit,
        mockContext
      );
      await cachePost(
        { post: { id: "t3_p6", title: "Valid Title", selftext: "[removed]" } } as PostSubmit,
        mockContext
      );
      await cachePost(
        { post: { id: "t3_p7", title: "Valid Title", selftext: "text", deleted: true } } as PostSubmit,
        mockContext
      );

      expect(redisSet).not.toHaveBeenCalled();
      expect(consoleDebug).toHaveBeenCalledWith("[cache] Skipped caching t3_p1: content is redacted or deleted");
      expect(consoleDebug).toHaveBeenCalledWith("[cache] Skipped caching t3_p2: content is redacted or deleted");
      expect(consoleDebug).toHaveBeenCalledWith("[cache] Skipped caching t3_p3: content is redacted or deleted");
      expect(consoleDebug).toHaveBeenCalledWith("[cache] Skipped caching t3_p4: content is redacted or deleted");
      expect(consoleDebug).toHaveBeenCalledWith("[cache] Skipped caching t3_p5: content is redacted or deleted");
      expect(consoleDebug).toHaveBeenCalledWith("[cache] Skipped caching t3_p6: content is redacted or deleted");
      expect(consoleDebug).toHaveBeenCalledWith("[cache] Skipped caching t3_p7: content is redacted or deleted");
      consoleDebug.mockRestore();
    });

    it("handles Redis write errors gracefully", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      const mockContext = {
        redis: {
          set: vi.fn().mockRejectedValue(new Error("Redis write failure")),
        },
      } as unknown as TriggerContext;

      const event: PostSubmit = {
        post: {
          id: "t3_err1",
          title: "Error Post",
        },
      } as unknown as PostSubmit;

      await cachePost(event, mockContext);
      expect(consoleError).toHaveBeenCalledWith("[cache] Error writing t3_err1 to Redis", expect.any(Error));
      consoleError.mockRestore();
    });
  });

  describe("cacheComment", () => {
    it("caches comment body to Redis with expiration", async () => {
      const redisSet = vi.fn().mockResolvedValue("OK");

      const mockContext = {
        redis: {
          set: redisSet,
        },
      } as unknown as TriggerContext;

      const event: CommentSubmit = {
        comment: {
          id: "t1_comm123",
          body: "This is a comment body",
        },
      } as unknown as CommentSubmit;

      await cacheComment(event, mockContext);

      expect(redisSet).toHaveBeenCalledWith("t1_comm123", "This is a comment body", {
        expiration: expect.any(Date),
      });
    });

    it("does nothing when comment or body is missing", async () => {
      const redisSet = vi.fn();
      const mockContext = {
        redis: { set: redisSet },
      } as unknown as TriggerContext;

      await cacheComment({} as CommentSubmit, mockContext);
      expect(redisSet).not.toHaveBeenCalled();
    });

    it("does not cache comment when body is redacted or deleted", async () => {
      const consoleDebug = vi.spyOn(console, "debug").mockImplementation(() => {});
      const redisSet = vi.fn();
      const mockContext = {
        redis: { set: redisSet },
      } as unknown as TriggerContext;

      await cacheComment(
        { comment: { id: "t1_c1", body: "[ Removed by Reddit ]" } } as CommentSubmit,
        mockContext
      );
      await cacheComment(
        { comment: { id: "t1_c2", body: "[deleted]" } } as CommentSubmit,
        mockContext
      );
      await cacheComment(
        { comment: { id: "t1_c3", body: "[removed]" } } as CommentSubmit,
        mockContext
      );
      await cacheComment(
        { comment: { id: "t1_c4", body: "Valid text", deleted: true } } as CommentSubmit,
        mockContext
      );

      expect(redisSet).not.toHaveBeenCalled();
      expect(consoleDebug).toHaveBeenCalledWith("[cache] Skipped caching t1_c1: content is redacted or deleted");
      expect(consoleDebug).toHaveBeenCalledWith("[cache] Skipped caching t1_c2: content is redacted or deleted");
      expect(consoleDebug).toHaveBeenCalledWith("[cache] Skipped caching t1_c3: content is redacted or deleted");
      expect(consoleDebug).toHaveBeenCalledWith("[cache] Skipped caching t1_c4: content is redacted or deleted");
      consoleDebug.mockRestore();
    });

    it("handles Redis write errors gracefully", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      const mockContext = {
        redis: {
          set: vi.fn().mockRejectedValue(new Error("Redis comment write error")),
        },
      } as unknown as TriggerContext;

      const event: CommentSubmit = {
        comment: {
          id: "t1_errcomm",
          body: "Failing comment body",
        },
      } as unknown as CommentSubmit;

      await cacheComment(event, mockContext);
      expect(consoleError).toHaveBeenCalledWith("[cache] Error writing t1_errcomm to Redis", expect.any(Error));
      consoleError.mockRestore();
    });
  });

  describe("cacheModerators", () => {
    it("fetches moderator usernames and stores them in Redis with 24-hour expiration", async () => {
      const redisSet = vi.fn().mockResolvedValue("OK");
      const mockModerators = [{ username: "mod1" }, { username: "mod2" }];

      async function* getModeratorsGen() {
        for (const mod of mockModerators) {
          yield mod;
        }
      }

      const mockContext = {
        reddit: {
          getCurrentSubreddit: vi.fn().mockResolvedValue({
            name: "testsubreddit",
            getModerators: vi.fn().mockReturnValue(getModeratorsGen()),
          }),
        },
        redis: {
          set: redisSet,
        },
      } as unknown as TriggerContext;

      const result = await cacheModerators(mockContext);

      expect(result).toEqual(["mod1", "mod2"]);
      expect(redisSet).toHaveBeenCalledWith("mods", "mod1,mod2", {
        expiration: expect.any(Date),
      });
    });

    it("throws when fetching moderators fails", async () => {
      const mockContext = {
        reddit: {
          getCurrentSubreddit: vi.fn().mockResolvedValue({
            name: "testsubreddit",
            getModerators: vi.fn().mockImplementation(() => {
              throw new Error("Network timeout");
            }),
          }),
        },
        redis: {
          set: vi.fn(),
        },
      } as unknown as TriggerContext;

      await expect(cacheModerators(mockContext)).rejects.toThrow(
        "Error fetching modlist for r/testsubreddit: Error: Network timeout"
      );
    });

    it("throws when fetched moderator list is empty", async () => {
      async function* emptyGen() {}

      const mockContext = {
        reddit: {
          getCurrentSubreddit: vi.fn().mockResolvedValue({
            name: "testsubreddit",
            getModerators: vi.fn().mockReturnValue(emptyGen()),
          }),
        },
        redis: {
          set: vi.fn(),
        },
      } as unknown as TriggerContext;

      await expect(cacheModerators(mockContext)).rejects.toThrow(
        "Fetched modlist for r/testsubreddit is empty, skipping cache update"
      );
    });

    it("logs an error if Redis write fails", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      async function* getModsGen() {
        yield { username: "mod1" };
      }

      const mockContext = {
        reddit: {
          getCurrentSubreddit: vi.fn().mockResolvedValue({
            name: "testsubreddit",
            getModerators: vi.fn().mockReturnValue(getModsGen()),
          }),
        },
        redis: {
          set: vi.fn().mockRejectedValue(new Error("Redis mod failure")),
        },
      } as unknown as TriggerContext;

      await cacheModerators(mockContext);
      expect(consoleError).toHaveBeenCalledWith("[modlist] Error writing moderators to Redis", expect.any(Error));
      consoleError.mockRestore();
    });
  });

  describe("checkModAction", () => {
    const baseSettings = {
      sendModmail: true,
      webhookURL: "https://discord.com/api/webhooks/123/xyz",
      excludeContext: false,
      addModNote: true,
    };

    it("throws if missing action", async () => {
      const mockContext = {} as TriggerContext;
      await expect(checkModAction({} as ModAction, mockContext)).rejects.toThrow(
        "Missing `action` from ModActionTrigger event"
      );
    });

    it("logs warning and returns early if missing moderator", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const mockContext = {} as TriggerContext;
      await checkModAction({ action: "removelink" } as ModAction, mockContext);
      expect(warnSpy).toHaveBeenCalledWith(
        "[action] Missing or empty moderator in removelink ModActionTrigger event; skipping"
      );
      warnSpy.mockRestore();
    });

    it("logs warning and returns early if moderator name is empty", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const mockContext = {} as TriggerContext;
      await checkModAction(
        { action: "removelink", moderator: { name: "" } } as unknown as ModAction,
        mockContext
      );
      expect(warnSpy).toHaveBeenCalledWith(
        "[action] Missing or empty moderator in removelink ModActionTrigger event; skipping"
      );
      warnSpy.mockRestore();
    });

    it("throws if missing subreddit", async () => {
      const mockContext = {} as TriggerContext;
      await expect(
        checkModAction(
          { action: "removelink", moderator: { name: "admin_user" } } as ModAction,
          mockContext
        )
      ).rejects.toThrow("Missing `subreddit` from ModActionTrigger event");
    });

    it("refreshes modlist when cache is empty or expired", async () => {
      async function* getModsGen() {
        yield { username: "autofetched_mod" };
      }
      const createModInboxConversation = vi.fn();
      const redisSet = vi.fn().mockResolvedValue("OK");
      const redisExpire = vi.fn().mockResolvedValue(1);

      const mockContext = {
        settings: {
          getAll: vi.fn().mockResolvedValue(baseSettings),
        },
        redis: {
          get: vi.fn().mockResolvedValue(null),
          set: redisSet,
          expire: redisExpire,
        },
        reddit: {
          getCurrentSubreddit: vi.fn().mockResolvedValue({
            name: "testsub",
            getModerators: vi.fn().mockReturnValue(getModsGen()),
          }),
          modMail: { createModInboxConversation },
        },
      } as unknown as TriggerContext;

      const event: ModAction = {
        action: "removelink",
        moderator: { name: "autofetched_mod" },
        subreddit: { id: "t5_test", name: "testsub" },
      } as unknown as ModAction;

      await checkModAction(event, mockContext);

      expect(redisSet).toHaveBeenCalledWith("mods", "autofetched_mod", {
        expiration: expect.any(Date),
      });
      expect(createModInboxConversation).not.toHaveBeenCalled();
    });

    it("performs live refresh when acting user is not in cached modlist and skips if confirmed", async () => {
      async function* getFreshModsGen() {
        yield { username: "existing_mod" };
        yield { username: "newly_added_mod" };
      }
      const createModInboxConversation = vi.fn();
      const redisSet = vi.fn().mockResolvedValue("OK");
      const redisExpire = vi.fn().mockResolvedValue(1);

      const mockContext = {
        settings: {
          getAll: vi.fn().mockResolvedValue(baseSettings),
        },
        redis: {
          get: vi.fn().mockResolvedValue("existing_mod"), // cached list is missing newly_added_mod
          set: redisSet,
          expire: redisExpire,
        },
        reddit: {
          getCurrentSubreddit: vi.fn().mockResolvedValue({
            name: "testsub",
            getModerators: vi.fn().mockReturnValue(getFreshModsGen()),
          }),
          modMail: { createModInboxConversation },
        },
      } as unknown as TriggerContext;

      const event: ModAction = {
        action: "removelink",
        moderator: { name: "newly_added_mod" },
        subreddit: { id: "t5_test", name: "testsub" },
      } as unknown as ModAction;

      await checkModAction(event, mockContext);

      // Verify fresh modlist was fetched and saved
      expect(redisSet).toHaveBeenCalledWith("mods", "existing_mod,newly_added_mod", {
        expiration: expect.any(Date),
      });
      // Verify no modmail alert sent because newly_added_mod was confirmed
      expect(createModInboxConversation).not.toHaveBeenCalled();
    });

    it("continues to alert if live modlist refresh throws an error", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      const createModInboxConversation = vi.fn().mockResolvedValue(undefined);

      const mockContext = {
        settings: {
          getAll: vi.fn().mockResolvedValue({
            sendModmail: true,
            webhookURL: "",
            excludeContext: false,
            addModNote: false,
          }),
        },
        redis: {
          get: vi.fn().mockResolvedValue("existing_mod"),
        },
        reddit: {
          getCurrentSubreddit: vi.fn().mockRejectedValue(new Error("Rate limit")),
          modMail: { createModInboxConversation },
        },
      } as unknown as TriggerContext;

      const event: ModAction = {
        action: "removelink",
        moderator: { name: "suspected_admin" },
        subreddit: { id: "t5_test", name: "testsub" },
        targetPost: { id: "t3_post1", title: "Target Post" },
      } as unknown as ModAction;

      await checkModAction(event, mockContext);

      expect(consoleError).toHaveBeenCalledWith("[action] Error performing live modlist refresh", expect.any(Error));
      expect(createModInboxConversation).toHaveBeenCalledTimes(1);
      consoleError.mockRestore();
    });

    it("matches moderator usernames case-insensitively", async () => {
      const createModInboxConversation = vi.fn();
      const mockContext = {
        settings: {
          getAll: vi.fn().mockResolvedValue(baseSettings),
        },
        redis: {
          get: vi.fn().mockResolvedValue("LocalMod,SuperMod"),
        },
        reddit: {
          modMail: { createModInboxConversation },
        },
      } as unknown as TriggerContext;

      const event: ModAction = {
        action: "removelink",
        moderator: { name: "localmod" }, // lowercase variant
        subreddit: { id: "t5_test", name: "testsub" },
      } as unknown as ModAction;

      await checkModAction(event, mockContext);
      expect(createModInboxConversation).not.toHaveBeenCalled();
    });

    it("updates cached modlist on modlist change action and reuses fresh modlist", async () => {
      async function* getModsGen() {
        yield { username: "currentmod" };
        yield { username: "newmod" };
      }

      const redisSet = vi.fn().mockResolvedValue("OK");
      const redisGet = vi.fn().mockResolvedValue("currentmod");
      const getAllSettings = vi.fn().mockResolvedValue(baseSettings);
      const mockContext = {
        settings: {
          getAll: getAllSettings,
        },
        reddit: {
          getCurrentSubreddit: vi.fn().mockResolvedValue({
            name: "testsub",
            getModerators: vi.fn().mockReturnValue(getModsGen()),
          }),
        },
        redis: {
          set: redisSet,
          expire: vi.fn().mockResolvedValue(1),
          get: redisGet,
        },
      } as unknown as TriggerContext;

      const event: ModAction = {
        action: "addmoderator",
        moderator: { name: "currentmod" },
        subreddit: { id: "t5_test", name: "testsub" },
      } as unknown as ModAction;

      await checkModAction(event, mockContext);
      expect(redisSet).toHaveBeenCalledWith("mods", "currentmod,newmod", {
        expiration: expect.any(Date),
      });
      // Reuses fresh modlist instead of reading from Redis again, and skips settings RPC for local mod
      expect(redisGet).not.toHaveBeenCalled();
      expect(getAllSettings).not.toHaveBeenCalled();
    });

    it("ignores actions performed by sub moderators", async () => {
      const createModInboxConversation = vi.fn();
      const mockContext = {
        settings: {
          getAll: vi.fn().mockResolvedValue(baseSettings),
        },
        redis: {
          get: vi.fn().mockImplementation((key: string) => {
            if (key === "mods") return Promise.resolve("localmod,supermod");
            return Promise.resolve(null);
          }),
          set: vi.fn().mockResolvedValue("OK"),
          expire: vi.fn().mockResolvedValue(1),
        },
        reddit: {
          modMail: { createModInboxConversation },
        },
      } as unknown as TriggerContext;

      const event: ModAction = {
        action: "removelink",
        moderator: { name: "localmod" },
        subreddit: { id: "t5_test", name: "testsub" },
      } as unknown as ModAction;

      await checkModAction(event, mockContext);
      expect(createModInboxConversation).not.toHaveBeenCalled();
    });

    it("simulates admin action for sub moderators during playtest in admin_tattler_dev", async () => {
      const createModInboxConversation = vi.fn().mockResolvedValue(undefined);
      const mockContext = {
        appVersion: "0.8.1.2",
        settings: {
          getAll: vi.fn().mockResolvedValue({
            sendModmail: true,
            webhookURL: "",
            excludeContext: false,
            addModNote: false,
          }),
        },
        redis: {
          get: vi.fn().mockImplementation((key: string) => {
            if (key === "mods") return Promise.resolve("shiruken,othermod");
            return Promise.resolve(null);
          }),
          set: vi.fn().mockResolvedValue("OK"),
          expire: vi.fn().mockResolvedValue(1),
        },
        reddit: {
          modMail: { createModInboxConversation },
        },
      } as unknown as TriggerContext;

      const event: ModAction = {
        action: "removelink",
        moderator: { name: "shiruken" },
        subreddit: { id: "t5_dev", name: "admin_tattler_dev" },
        targetPost: { id: "t3_pdev", title: "Test Playtest Post" },
      } as unknown as ModAction;

      await checkModAction(event, mockContext);
      expect(createModInboxConversation).toHaveBeenCalledTimes(1);
      const modmailArgs = createModInboxConversation.mock.calls[0][0];
      expect(modmailArgs.bodyMarkdown).toContain("**Anti-Evil Operations** has performed an action in r/admin_tattler_dev");
      expect(modmailArgs.bodyMarkdown).toContain("[**View Admin Modlog**](https://www.reddit.com/mod/admin_tattler_dev/log?moderatorNames=a)");
      expect(modmailArgs.bodyMarkdown).not.toContain("u/shiruken");
    });

    it("does not simulate admin action in admin_tattler_dev on production release version", async () => {
      const createModInboxConversation = vi.fn();
      const mockContext = {
        appVersion: "0.9.0",
        settings: {
          getAll: vi.fn().mockResolvedValue(baseSettings),
        },
        redis: {
          get: vi.fn().mockResolvedValue("shiruken,othermod"),
        },
        reddit: {
          modMail: { createModInboxConversation },
        },
      } as unknown as TriggerContext;

      const event: ModAction = {
        action: "removelink",
        moderator: { name: "shiruken" },
        subreddit: { id: "t5_dev", name: "admin_tattler_dev" },
      } as unknown as ModAction;

      await checkModAction(event, mockContext);
      expect(createModInboxConversation).not.toHaveBeenCalled();
    });

    it("does not simulate admin action on non-dev subreddit even with prerelease version", async () => {
      const createModInboxConversation = vi.fn();
      const mockContext = {
        appVersion: "0.8.2-0",
        settings: {
          getAll: vi.fn().mockResolvedValue(baseSettings),
        },
        redis: {
          get: vi.fn().mockResolvedValue("localmod"),
          set: vi.fn().mockResolvedValue("OK"),
          expire: vi.fn().mockResolvedValue(1),
        },
        reddit: {
          getCurrentSubreddit: vi.fn().mockResolvedValue({
            name: "testsub",
            getModerators: vi.fn().mockReturnValue((async function*() { yield { username: "localmod" }; })()),
          }),
          modMail: { createModInboxConversation },
        },
      } as unknown as TriggerContext;

      const event: ModAction = {
        action: "removelink",
        moderator: { name: "localmod" },
        subreddit: { id: "t5_live", name: "some_live_sub" },
      } as unknown as ModAction;

      await checkModAction(event, mockContext);
      expect(createModInboxConversation).not.toHaveBeenCalled();
    });

    it("ignores AutoModerator and reddit actions", async () => {
      const createModInboxConversation = vi.fn();
      const mockContext = {
        settings: {
          getAll: vi.fn().mockResolvedValue(baseSettings),
        },
        redis: {
          get: vi.fn().mockResolvedValue("localmod"),
          set: vi.fn().mockResolvedValue("OK"),
          expire: vi.fn().mockResolvedValue(1),
        },
        reddit: {
          getCurrentSubreddit: vi.fn().mockResolvedValue({
            name: "testsub",
            getModerators: vi.fn().mockReturnValue((async function*() { yield { username: "localmod" }; })()),
          }),
          modMail: { createModInboxConversation },
        },
      } as unknown as TriggerContext;

      await checkModAction(
        {
          action: "removelink",
          moderator: { name: "AutoModerator" },
          subreddit: { id: "t5_test", name: "testsub" },
        } as unknown as ModAction,
        mockContext
      );
      expect(createModInboxConversation).not.toHaveBeenCalled();

      await checkModAction(
        {
          action: "removelink",
          moderator: { name: "reddit" },
          subreddit: { id: "t5_test", name: "testsub" },
        } as unknown as ModAction,
        mockContext
      );
      expect(createModInboxConversation).not.toHaveBeenCalled();

      await checkModAction(
        {
          action: "removelink",
          moderator: { name: "Reddit" },
          subreddit: { id: "t5_test", name: "testsub" },
        } as unknown as ModAction,
        mockContext
      );
      expect(createModInboxConversation).not.toHaveBeenCalled();

      await checkModAction(
        {
          action: "removelink",
          moderator: { name: "automoderator" },
          subreddit: { id: "t5_test", name: "testsub" },
        } as unknown as ModAction,
        mockContext
      );
      expect(createModInboxConversation).not.toHaveBeenCalled();
    });

    it("ignores actions by [deleted] moderators", async () => {
      const createModInboxConversation = vi.fn();
      const mockContext = {
        settings: {
          getAll: vi.fn().mockResolvedValue(baseSettings),
        },
        redis: {
          get: vi.fn().mockResolvedValue("localmod"),
          set: vi.fn().mockResolvedValue("OK"),
          expire: vi.fn().mockResolvedValue(1),
        },
        reddit: {
          getCurrentSubreddit: vi.fn().mockResolvedValue({
            name: "testsub",
            getModerators: vi.fn().mockReturnValue((async function*() { yield { username: "localmod" }; })()),
          }),
          modMail: { createModInboxConversation },
        },
      } as unknown as TriggerContext;

      const event: ModAction = {
        action: "removelink",
        moderator: { name: "[deleted]" },
        subreddit: { id: "t5_test", name: "testsub" },
      } as unknown as ModAction;

      await checkModAction(event, mockContext);
      expect(createModInboxConversation).not.toHaveBeenCalled();
    });

    it("ignores moderator removing themselves", async () => {
      async function* getModsGen() {
        yield { username: "other_mod" };
      }
      const createModInboxConversation = vi.fn();
      const mockContext = {
        settings: {
          getAll: vi.fn().mockResolvedValue(baseSettings),
        },
        redis: {
          get: vi.fn().mockResolvedValue("other_mod"),
          set: vi.fn().mockResolvedValue("OK"),
          expire: vi.fn().mockResolvedValue(1),
        },
        reddit: {
          getCurrentSubreddit: vi.fn().mockResolvedValue({
            name: "testsub",
            getModerators: vi.fn().mockReturnValue(getModsGen()),
          }),
          modMail: { createModInboxConversation },
        },
      } as unknown as TriggerContext;

      const event: ModAction = {
        action: "removemoderator",
        moderator: { name: "departing_mod" },
        targetUser: { id: "t2_dep", name: "departing_mod" },
        subreddit: { id: "t5_test", name: "testsub" },
      } as unknown as ModAction;

      await checkModAction(event, mockContext);
      expect(createModInboxConversation).not.toHaveBeenCalled();
    });

    it("notifies via modmail and webhooks when an admin post removal occurs", async () => {
      const createModInboxConversation = vi.fn().mockResolvedValue(undefined);
      const addModNote = vi.fn().mockResolvedValue(undefined);
      const getBannedUsers = vi.fn().mockResolvedValue({
        all: vi.fn().mockResolvedValue([]),
      });

      const mockContext = {
        settings: {
          getAll: vi.fn().mockResolvedValue({
            sendModmail: true,
            webhookURL: "https://discord.com/api/webhooks/123/xyz",
            excludeContext: false,
            addModNote: true,
          }),
        },
        redis: {
          get: vi.fn().mockImplementation((key: string) => {
            if (key === "mods") return Promise.resolve("localmod");
            if (key === "t3_post999")
              return Promise.resolve(
                JSON.stringify({
                  title: "Original Post Title",
                  body: "Original Post Body\n\nParagraph Two",
                  url: "https://example.com/original",
                })
              );
            return Promise.resolve(null);
          }),
          set: vi.fn().mockResolvedValue("OK"),
          expire: vi.fn().mockResolvedValue(1),
        },
        reddit: {
          getCurrentSubreddit: vi.fn().mockResolvedValue({
            name: "testsub",
            getModerators: vi.fn().mockReturnValue((async function*() { yield { username: "localmod" }; })()),
          }),
          modMail: { createModInboxConversation },
          addModNote,
          getBannedUsers,
        },
      } as unknown as TriggerContext;

      const event: ModAction = {
        action: "removelink",
        moderator: { name: "admin_colin" },
        subreddit: { id: "t5_testsub", name: "testsub" },
        targetPost: {
          id: "t3_post999",
          title: "[ Removed by Reddit ]",
          permalink: "/r/testsub/comments/post999",
          createdAt: Date.now() - 40 * 24 * 60 * 60 * 1000,
        },
        targetUser: {
          id: "t2_user999",
          name: "troublemaker",
        },
      } as unknown as ModAction;

      await checkModAction(event, mockContext);

      // Verify modmail sent
      expect(createModInboxConversation).toHaveBeenCalledTimes(1);
      const modmailArgs = createModInboxConversation.mock.calls[0][0];
      expect(modmailArgs.subredditId).toBe("t5_testsub");
      expect(modmailArgs.subject).toBe("Admin Action Detected: removelink");
      expect(modmailArgs.bodyMarkdown).toContain("u/admin_colin");
      expect(modmailArgs.bodyMarkdown).toContain("Original Post Title");
      expect(modmailArgs.bodyMarkdown).toContain("Original Post Body");
      expect(modmailArgs.bodyMarkdown).toContain(
        "Notification generated by [Admin Tattler](https://developers.reddit.com/apps/admin-tattler). Configure settings [here](https://developers.reddit.com/r/testsub/apps/admin-tattler)."
      );

      // Verify Discord webhook fetch called
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "https://discord.com/api/webhooks/123/xyz",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: expect.stringContaining("https://raw.githubusercontent.com/shiruken/admin-tattler/main/assets/icon.png"),
        })
      );

      // Verify mod note added
      expect(addModNote).toHaveBeenCalledWith({
        subreddit: "testsub",
        user: "troublemaker",
        redditId: "t3_post999",
        label: "ABUSE_WARNING",
        note: "Admin Removal",
      });
    });

    it("handles comment removals, cached comment retrieval, and Slack webhooks", async () => {
      const createModInboxConversation = vi.fn().mockResolvedValue(undefined);
      const addModNote = vi.fn().mockResolvedValue(undefined);
      const getBannedUsers = vi.fn().mockResolvedValue({
        all: vi.fn().mockResolvedValue([{ username: "spammer" }]),
      });

      const mockContext = {
        settings: {
          getAll: vi.fn().mockResolvedValue({
            sendModmail: true,
            webhookURL: "https://hooks.slack.com/services/T00/B00/X",
            excludeContext: false,
            addModNote: true,
          }),
        },
        redis: {
          get: vi.fn().mockImplementation((key: string) => {
            if (key === "mods") return Promise.resolve("localmod");
            if (key === "t1_comm999") return Promise.resolve("Cached comment text from Redis");
            return Promise.resolve(null);
          }),
          set: vi.fn().mockResolvedValue("OK"),
          expire: vi.fn().mockResolvedValue(1),
        },
        reddit: {
          getCurrentSubreddit: vi.fn().mockResolvedValue({
            name: "testsub",
            getModerators: vi.fn().mockReturnValue((async function*() { yield { username: "localmod" }; })()),
          }),
          modMail: { createModInboxConversation },
          addModNote,
          getBannedUsers,
        },
      } as unknown as TriggerContext;

      // 40 days ago (older than 30-day cache duration)
      const oldTimestamp = Date.now() - 40 * 24 * 60 * 60 * 1000;

      const event: ModAction = {
        action: "removecomment",
        moderator: { name: "[ Redacted ]" },
        subreddit: { id: "testsub", name: "testsub" }, // test prefixing t5_
        targetComment: {
          id: "t1_comm999",
          body: "[ Removed by Reddit ]",
          permalink: "/r/testsub/comments/123/_/comm999",
          createdAt: oldTimestamp,
        },
        targetUser: {
          id: "t2_spammer",
          name: "spammer",
        },
      } as unknown as ModAction;

      await checkModAction(event, mockContext);

      // Modmail check
      expect(createModInboxConversation).toHaveBeenCalledTimes(1);
      const modmailArgs = createModInboxConversation.mock.calls[0][0];
      expect(modmailArgs.subredditId).toBe("t5_testsub");
      expect(modmailArgs.bodyMarkdown).toContain("Anti-Evil Operations");
      expect(modmailArgs.bodyMarkdown).toContain("Cached comment text from Redis");
      expect(modmailArgs.bodyMarkdown).toContain("Banned in r/testsub");
      expect(modmailArgs.bodyMarkdown).not.toContain("Content Date:");

      // Slack webhook check
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "https://hooks.slack.com/services/T00/B00/X",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining("Anti-Evil Operations"),
        })
      );

      // Mod note check for [ Redacted ] -> Anti-Evil Operations
      expect(addModNote).toHaveBeenCalledWith({
        subreddit: "testsub",
        user: "spammer",
        redditId: "t1_comm999",
        label: "ABUSE_WARNING",
        note: "Anti-Evil Operations Removal",
      });
    });

    it("handles post with direct link url and selftext without caching", async () => {
      const createModInboxConversation = vi.fn().mockResolvedValue(undefined);
      const mockContext = {
        settings: {
          getAll: vi.fn().mockResolvedValue({
            sendModmail: true,
            webhookURL: "",
            excludeContext: false,
            addModNote: false,
          }),
        },
        redis: {
          get: vi.fn().mockResolvedValue("localmod"),
          set: vi.fn().mockResolvedValue("OK"),
          expire: vi.fn().mockResolvedValue(1),
        },
        reddit: {
          getCurrentSubreddit: vi.fn().mockResolvedValue({
            name: "testsub",
            getModerators: vi.fn().mockReturnValue((async function*() { yield { username: "localmod" }; })()),
          }),
          modMail: { createModInboxConversation },
        },
      } as unknown as TriggerContext;

      const event: ModAction = {
        action: "spamlink",
        moderator: { name: "Reddit Legal" },
        subreddit: { id: "t5_sub", name: "sub" },
        targetPost: {
          id: "t3_linkpost",
          title: "Direct Link Post",
          url: "https://external-news.com/article",
          selftext: "Direct self text here",
        },
      } as unknown as ModAction;

      await checkModAction(event, mockContext);
      expect(createModInboxConversation).toHaveBeenCalledTimes(1);
      const modmailArgs = createModInboxConversation.mock.calls[0][0];
      expect(modmailArgs.bodyMarkdown).toContain("Direct Link Post");
      expect(modmailArgs.bodyMarkdown).toContain("https://external-news.com/article");
      expect(modmailArgs.bodyMarkdown).toContain("Direct self text here");
    });

    it("handles removed post when Redis has invalid JSON or no cached post", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      const createModInboxConversation = vi.fn().mockResolvedValue(undefined);

      // Test with invalid JSON in Redis
      const mockContextInvalidJson = {
        settings: {
          getAll: vi.fn().mockResolvedValue(baseSettings),
        },
        redis: {
          get: vi.fn().mockImplementation((key: string) => {
            if (key === "mods") return Promise.resolve("localmod");
            if (key === "t3_invalid") return Promise.resolve("not-valid-json{{{");
            return Promise.resolve(null);
          }),
          set: vi.fn().mockResolvedValue("OK"),
          expire: vi.fn().mockResolvedValue(1),
        },
        reddit: {
          getCurrentSubreddit: vi.fn().mockResolvedValue({
            name: "testsub",
            getModerators: vi.fn().mockReturnValue((async function*() { yield { username: "localmod" }; })()),
          }),
          modMail: { createModInboxConversation },
        },
      } as unknown as TriggerContext;

      const eventInvalid: ModAction = {
        action: "removelink",
        moderator: { name: "Anti-Evil Operations" },
        subreddit: { id: "t5_sub", name: "sub" },
        targetPost: {
          id: "t3_invalid",
          title: "[ Removed by Reddit ]",
        },
      } as unknown as ModAction;

      await checkModAction(eventInvalid, mockContextInvalidJson);
      expect(consoleError).toHaveBeenCalledWith("[cache] Error parsing JSON for t3_invalid", expect.any(Error));

      // Test when post is not found in Redis
      const mockContextNotFound = {
        settings: {
          getAll: vi.fn().mockResolvedValue(baseSettings),
        },
        redis: {
          get: vi.fn().mockImplementation((key: string) => {
            if (key === "mods") return Promise.resolve("localmod");
            return Promise.resolve(null);
          }),
          set: vi.fn().mockResolvedValue("OK"),
          expire: vi.fn().mockResolvedValue(1),
        },
        reddit: {
          getCurrentSubreddit: vi.fn().mockResolvedValue({
            name: "testsub",
            getModerators: vi.fn().mockReturnValue((async function*() { yield { username: "localmod" }; })()),
          }),
          modMail: { createModInboxConversation },
        },
      } as unknown as TriggerContext;

      const eventNotFound: ModAction = {
        action: "removelink",
        moderator: { name: "Anti-Evil Operations" },
        subreddit: { id: "t5_sub", name: "sub" },
        targetPost: {
          id: "t3_notfound",
          title: "[ Removed by Reddit ]",
        },
      } as unknown as ModAction;

      await checkModAction(eventNotFound, mockContextNotFound);
      consoleError.mockRestore();
    });

    it("handles removed comment when not found in Redis", async () => {
      const createModInboxConversation = vi.fn().mockResolvedValue(undefined);
      const mockContext = {
        settings: {
          getAll: vi.fn().mockResolvedValue(baseSettings),
        },
        redis: {
          get: vi.fn().mockImplementation((key: string) => {
            if (key === "mods") return Promise.resolve("localmod");
            return Promise.resolve(null);
          }),
          set: vi.fn().mockResolvedValue("OK"),
          expire: vi.fn().mockResolvedValue(1),
        },
        reddit: {
          getCurrentSubreddit: vi.fn().mockResolvedValue({
            name: "testsub",
            getModerators: vi.fn().mockReturnValue((async function*() { yield { username: "localmod" }; })()),
          }),
          modMail: { createModInboxConversation },
        },
      } as unknown as TriggerContext;

      const event: ModAction = {
        action: "removecomment",
        moderator: { name: "Anti-Evil Operations" },
        subreddit: { id: "t5_sub", name: "sub" },
        targetComment: {
          id: "t1_notfound",
          body: "[ Removed by Reddit ]",
        },
      } as unknown as ModAction;

      await checkModAction(event, mockContext);
      expect(createModInboxConversation).toHaveBeenCalledTimes(1);
    });

    it("handles errors during modmail, webhook, and mod note dispatch gracefully", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

      const mockContext = {
        settings: {
          getAll: vi.fn().mockResolvedValue({
            sendModmail: true,
            webhookURL: "https://hooks.slack.com/services/fail",
            excludeContext: false,
            addModNote: true,
          }),
        },
        redis: {
          get: vi.fn().mockResolvedValue("localmod"),
          set: vi.fn().mockResolvedValue("OK"),
          expire: vi.fn().mockResolvedValue(1),
        },
        reddit: {
          getCurrentSubreddit: vi.fn().mockResolvedValue({
            name: "testsub",
            getModerators: vi.fn().mockReturnValue((async function*() { yield { username: "localmod" }; })()),
          }),
          modMail: {
            createModInboxConversation: vi.fn().mockRejectedValue(new Error("Modmail API fail")),
          },
          addModNote: vi.fn().mockRejectedValue(new Error("Mod note API fail")),
          getBannedUsers: vi.fn().mockResolvedValue({
            all: vi.fn().mockResolvedValue([]),
          }),
        },
      } as unknown as TriggerContext;

      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Slack webhook fetch fail")));

      const event: ModAction = {
        action: "removelink",
        moderator: { name: "admin_tester" },
        subreddit: { id: "t5_testsub", name: "testsub" },
        targetPost: { id: "t3_p1", title: "Test" },
        targetUser: { id: "t2_u1", name: "user1" },
      } as unknown as ModAction;

      await checkModAction(event, mockContext);

      expect(consoleError).toHaveBeenCalledWith(
        "[notify] Error sending modmail about removelink by admin_tester",
        expect.any(Error)
      );
      expect(consoleError).toHaveBeenCalledWith(
        "[notify] Error sending Slack message about removelink by admin_tester",
        expect.any(Error)
      );
      expect(consoleError).toHaveBeenCalledWith("[notify] Error adding mod note to t3_p1", expect.any(Error));

      consoleError.mockRestore();
    });

    it("handles Discord webhook fetch error gracefully", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

      const mockContext = {
        settings: {
          getAll: vi.fn().mockResolvedValue({
            sendModmail: false,
            webhookURL: "https://discord.com/api/webhooks/fail",
            excludeContext: false,
            addModNote: false,
          }),
        },
        redis: {
          get: vi.fn().mockResolvedValue("localmod"),
          set: vi.fn().mockResolvedValue("OK"),
          expire: vi.fn().mockResolvedValue(1),
        },
        reddit: {
          getCurrentSubreddit: vi.fn().mockResolvedValue({
            name: "testsub",
            getModerators: vi.fn().mockReturnValue((async function*() { yield { username: "localmod" }; })()),
          }),
        },
      } as unknown as TriggerContext;

      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Discord network error")));

      const event: ModAction = {
        action: "removelink",
        moderator: { name: "admin_tester" },
        subreddit: { id: "t5_testsub", name: "testsub" },
      } as unknown as ModAction;

      await checkModAction(event, mockContext);
      expect(consoleError).toHaveBeenCalledWith(
        "[notify] Error sending Discord message about removelink by admin_tester",
        expect.any(Error)
      );
      consoleError.mockRestore();
    });

    it("formats uncached removed comment within 30 days with submission date", async () => {
      const createModInboxConversation = vi.fn().mockResolvedValue(undefined);
      const recentTimestamp = new Date("2026-11-15T12:00:00Z").getTime();

      const mockContext = {
        settings: {
          getAll: vi.fn().mockResolvedValue(baseSettings),
        },
        redis: {
          get: vi.fn().mockImplementation((key: string) => {
            if (key === "mods") return Promise.resolve("localmod");
            return Promise.resolve(null);
          }),
          set: vi.fn().mockResolvedValue("OK"),
        },
        reddit: {
          getCurrentSubreddit: vi.fn().mockResolvedValue({
            name: "testsub",
            getModerators: vi.fn().mockReturnValue((async function*() { yield { username: "localmod" }; })()),
          }),
          modMail: { createModInboxConversation },
        },
      } as unknown as TriggerContext;

      const event: ModAction = {
        action: "removecomment",
        moderator: { name: "Anti-Evil Operations" },
        subreddit: { id: "t5_testsub", name: "testsub" },
        targetComment: {
          id: "t1_recent_uncached",
          body: "[ Removed by Reddit ]",
          createdAt: recentTimestamp,
        },
      } as unknown as ModAction;

      await checkModAction(event, mockContext);
      const modmailArgs = createModInboxConversation.mock.calls[0][0];
      const expectedDate = new Date(recentTimestamp).toLocaleDateString("fr-CA");
      expect(modmailArgs.bodyMarkdown).toContain(
        `* **Comment:** [ Removed by Reddit ] (Submitted ${expectedDate}, not cached)`
      );
    });

    it("formats uncached removed post with both title and body removed", async () => {
      const createModInboxConversation = vi.fn().mockResolvedValue(undefined);
      const oldTimestamp = new Date("2024-05-12T12:00:00Z").getTime();

      const mockContext = {
        settings: {
          getAll: vi.fn().mockResolvedValue(baseSettings),
        },
        redis: {
          get: vi.fn().mockImplementation((key: string) => {
            if (key === "mods") return Promise.resolve("localmod");
            return Promise.resolve(null);
          }),
          set: vi.fn().mockResolvedValue("OK"),
        },
        reddit: {
          getCurrentSubreddit: vi.fn().mockResolvedValue({
            name: "testsub",
            getModerators: vi.fn().mockReturnValue((async function*() { yield { username: "localmod" }; })()),
          }),
          modMail: { createModInboxConversation },
        },
      } as unknown as TriggerContext;

      const event: ModAction = {
        action: "removelink",
        moderator: { name: "Reddit Legal" },
        subreddit: { id: "t5_testsub", name: "testsub" },
        targetPost: {
          id: "t3_old_uncached",
          title: "[ Removed by Reddit ]",
          selftext: "[ Removed by Reddit ]",
          createdAt: oldTimestamp,
        },
      } as unknown as ModAction;

      await checkModAction(event, mockContext);
      const modmailArgs = createModInboxConversation.mock.calls[0][0];
      expect(modmailArgs.bodyMarkdown).toContain(
        `* **Title:** [ Removed by Reddit ] (Submitted 2024-05-12, exceeds 30-day cache)`
      );
      expect(modmailArgs.bodyMarkdown).toContain(
        `* **Body:** [ Removed by Reddit ]`
      );
      // Ensure the note is not duplicated on the body
      expect(modmailArgs.bodyMarkdown).not.toContain(
        `* **Body:** [ Removed by Reddit ] (Submitted 2024-05-12`
      );
    });

    it("formats uncached removed post when only body was removed", async () => {
      const createModInboxConversation = vi.fn().mockResolvedValue(undefined);
      const recentTimestamp = new Date("2026-11-16T12:00:00Z").getTime();

      const mockContext = {
        settings: {
          getAll: vi.fn().mockResolvedValue(baseSettings),
        },
        redis: {
          get: vi.fn().mockImplementation((key: string) => {
            if (key === "mods") return Promise.resolve("localmod");
            return Promise.resolve(null);
          }),
          set: vi.fn().mockResolvedValue("OK"),
        },
        reddit: {
          getCurrentSubreddit: vi.fn().mockResolvedValue({
            name: "testsub",
            getModerators: vi.fn().mockReturnValue((async function*() { yield { username: "localmod" }; })()),
          }),
          modMail: { createModInboxConversation },
        },
      } as unknown as TriggerContext;

      const event: ModAction = {
        action: "removelink",
        moderator: { name: "Anti-Evil Operations" },
        subreddit: { id: "t5_testsub", name: "testsub" },
        targetPost: {
          id: "t3_body_only_removed",
          title: "Intact Post Title",
          selftext: "[ Removed by Reddit ]",
          createdAt: recentTimestamp,
        },
      } as unknown as ModAction;

      await checkModAction(event, mockContext);
      const modmailArgs = createModInboxConversation.mock.calls[0][0];
      const expectedDate = new Date(recentTimestamp).toLocaleDateString("fr-CA");
      expect(modmailArgs.bodyMarkdown).toContain(`* **Title:** Intact Post Title`);
      expect(modmailArgs.bodyMarkdown).toContain(
        `* **Body:** [ Removed by Reddit ] (Submitted ${expectedDate}, not cached)`
      );
    });

    it("retries fetching cached post when created recently and uncached on first lookup", async () => {
      vi.useFakeTimers();
      try {
        const createModInboxConversation = vi.fn().mockResolvedValue(undefined);
        let postFetchCount = 0;

        const mockContext = {
          settings: {
            getAll: vi.fn().mockResolvedValue(baseSettings),
          },
          redis: {
            get: vi.fn().mockImplementation((key: string) => {
              if (key === "mods") return Promise.resolve("localmod");
              if (key === "t3_race_post") {
                postFetchCount++;
                if (postFetchCount === 1) return Promise.resolve(null);
                return Promise.resolve(
                  JSON.stringify({
                    title: "Retried Post Title",
                    body: "Retried Post Body",
                  })
                );
              }
              return Promise.resolve(null);
            }),
            set: vi.fn().mockResolvedValue("OK"),
          },
          reddit: {
            getCurrentSubreddit: vi.fn().mockResolvedValue({
              name: "testsub",
              getModerators: vi.fn().mockReturnValue((async function*() { yield { username: "localmod" }; })()),
            }),
            modMail: { createModInboxConversation },
          },
        } as unknown as TriggerContext;

        const event: ModAction = {
          action: "removelink",
          moderator: { name: "Anti-Evil Operations" },
          subreddit: { id: "t5_testsub", name: "testsub" },
          targetPost: {
            id: "t3_race_post",
            title: "[ Removed by Reddit ]",
            selftext: "[ Removed by Reddit ]",
            createdAt: Date.now() - 2000,
          },
        } as unknown as ModAction;

        const actionPromise = checkModAction(event, mockContext);
        await vi.advanceTimersByTimeAsync(1000);
        await actionPromise;

        expect(postFetchCount).toBe(2);
        const modmailArgs = createModInboxConversation.mock.calls[0][0];
        expect(modmailArgs.bodyMarkdown).toContain("Retried Post Title");
        expect(modmailArgs.bodyMarkdown).toContain("Retried Post Body");
        expect(modmailArgs.bodyMarkdown).toContain("Title (Cached)");
        expect(modmailArgs.bodyMarkdown).toContain("Body (Cached)");
      } finally {
        vi.useRealTimers();
      }
    });

    it("retries fetching cached comment when created recently and uncached on first lookup", async () => {
      vi.useFakeTimers();
      try {
        const createModInboxConversation = vi.fn().mockResolvedValue(undefined);
        let commentFetchCount = 0;

        const mockContext = {
          settings: {
            getAll: vi.fn().mockResolvedValue(baseSettings),
          },
          redis: {
            get: vi.fn().mockImplementation((key: string) => {
              if (key === "mods") return Promise.resolve("localmod");
              if (key === "t1_race_comm") {
                commentFetchCount++;
                if (commentFetchCount === 1) return Promise.resolve(null);
                return Promise.resolve("Retried Comment Body");
              }
              return Promise.resolve(null);
            }),
            set: vi.fn().mockResolvedValue("OK"),
          },
          reddit: {
            getCurrentSubreddit: vi.fn().mockResolvedValue({
              name: "testsub",
              getModerators: vi.fn().mockReturnValue((async function*() { yield { username: "localmod" }; })()),
            }),
            modMail: { createModInboxConversation },
          },
        } as unknown as TriggerContext;

        const event: ModAction = {
          action: "removecomment",
          moderator: { name: "Anti-Evil Operations" },
          subreddit: { id: "t5_testsub", name: "testsub" },
          targetComment: {
            id: "t1_race_comm",
            body: "[ Removed by Reddit ]",
            createdAt: Date.now() - 1500,
          },
        } as unknown as ModAction;

        const actionPromise = checkModAction(event, mockContext);
        await vi.advanceTimersByTimeAsync(1000);
        await actionPromise;

        expect(commentFetchCount).toBe(2);
        const modmailArgs = createModInboxConversation.mock.calls[0][0];
        expect(modmailArgs.bodyMarkdown).toContain("Retried Comment Body");
        expect(modmailArgs.bodyMarkdown).toContain("Comment (Cached)");
      } finally {
        vi.useRealTimers();
      }
    });

    it("handles Redis read errors in getCachedPost gracefully and falls back to un-cached formatting", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const createModInboxConversation = vi.fn().mockResolvedValue(undefined);
      const recentTimestamp = new Date("2026-11-16T12:00:00Z").getTime();

      const mockContext = {
        settings: {
          getAll: vi.fn().mockResolvedValue(baseSettings),
        },
        redis: {
          get: vi.fn().mockImplementation((key: string) => {
            if (key === "mods") return Promise.resolve("localmod");
            if (key === "t3_err_post") return Promise.reject(new Error("Redis connection failure"));
            return Promise.resolve(null);
          }),
          set: vi.fn().mockResolvedValue("OK"),
        },
        reddit: {
          getCurrentSubreddit: vi.fn().mockResolvedValue({
            name: "testsub",
            getModerators: vi.fn().mockReturnValue((async function*() { yield { username: "localmod" }; })()),
          }),
          modMail: { createModInboxConversation },
        },
      } as unknown as TriggerContext;

      const event: ModAction = {
        action: "removelink",
        moderator: { name: "Anti-Evil Operations" },
        subreddit: { id: "t5_testsub", name: "testsub" },
        targetPost: {
          id: "t3_err_post",
          title: "[ Removed by Reddit ]",
          createdAt: recentTimestamp,
        },
      } as unknown as ModAction;

      await checkModAction(event, mockContext);
      expect(errorSpy).toHaveBeenCalledWith(
        "[cache] Error fetching cached post data for t3_err_post",
        expect.any(Error)
      );
      const modmailArgs = createModInboxConversation.mock.calls[0][0];
      expect(modmailArgs.bodyMarkdown).toContain("[ Removed by Reddit ] (Submitted 2026-11-16, not cached)");
      errorSpy.mockRestore();
    });

    it("handles Redis read errors in getCachedComment gracefully and falls back to un-cached formatting", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const createModInboxConversation = vi.fn().mockResolvedValue(undefined);
      const recentTimestamp = new Date("2026-11-16T12:00:00Z").getTime();

      const mockContext = {
        settings: {
          getAll: vi.fn().mockResolvedValue(baseSettings),
        },
        redis: {
          get: vi.fn().mockImplementation((key: string) => {
            if (key === "mods") return Promise.resolve("localmod");
            if (key === "t1_err_comm") return Promise.reject(new Error("Redis connection failure"));
            return Promise.resolve(null);
          }),
          set: vi.fn().mockResolvedValue("OK"),
        },
        reddit: {
          getCurrentSubreddit: vi.fn().mockResolvedValue({
            name: "testsub",
            getModerators: vi.fn().mockReturnValue((async function*() { yield { username: "localmod" }; })()),
          }),
          modMail: { createModInboxConversation },
        },
      } as unknown as TriggerContext;

      const event: ModAction = {
        action: "removecomment",
        moderator: { name: "Anti-Evil Operations" },
        subreddit: { id: "t5_testsub", name: "testsub" },
        targetComment: {
          id: "t1_err_comm",
          body: "[ Removed by Reddit ]",
          createdAt: recentTimestamp,
        },
      } as unknown as ModAction;

      await checkModAction(event, mockContext);
      expect(errorSpy).toHaveBeenCalledWith(
        "[cache] Error fetching cached comment data for t1_err_comm",
        expect.any(Error)
      );
      const modmailArgs = createModInboxConversation.mock.calls[0][0];
      expect(modmailArgs.bodyMarkdown).toContain("[ Removed by Reddit ] (Submitted 2026-11-16, not cached)");
      errorSpy.mockRestore();
    });

    it("handles Redis read errors in getCachedModerators gracefully and refreshes modlist from API", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const createModInboxConversation = vi.fn().mockResolvedValue(undefined);

      const mockContext = {
        settings: {
          getAll: vi.fn().mockResolvedValue(baseSettings),
        },
        redis: {
          get: vi.fn().mockImplementation((key: string) => {
            if (key === "mods") return Promise.reject(new Error("Redis modlist read timeout"));
            return Promise.resolve(null);
          }),
          set: vi.fn().mockResolvedValue("OK"),
        },
        reddit: {
          getCurrentSubreddit: vi.fn().mockResolvedValue({
            name: "testsub",
            getModerators: vi.fn().mockReturnValue((async function*() { yield { username: "localmod" }; })()),
          }),
          modMail: { createModInboxConversation },
        },
      } as unknown as TriggerContext;

      const event: ModAction = {
        action: "removelink",
        moderator: { name: "localmod" },
        subreddit: { id: "t5_testsub", name: "testsub" },
        targetPost: {
          id: "t3_post_mod_action",
          title: "Some Title",
        },
      } as unknown as ModAction;

      await checkModAction(event, mockContext);
      expect(errorSpy).toHaveBeenCalledWith(
        "[modlist] Error fetching cached modlist from Redis",
        expect.any(Error)
      );
      // Because localmod was fetched live from API, the action was ignored and no modmail sent
      expect(createModInboxConversation).not.toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    it("preserves unredacted post body when only title is removed and cache contains a body", async () => {
      const createModInboxConversation = vi.fn().mockResolvedValue(undefined);

      const mockContext = {
        settings: {
          getAll: vi.fn().mockResolvedValue(baseSettings),
        },
        redis: {
          get: vi.fn().mockImplementation((key: string) => {
            if (key === "mods") return Promise.resolve("localmod");
            if (key === "t3_partial_post") {
              return Promise.resolve(
                JSON.stringify({
                  title: "Original Post Title",
                  body: "Cached Post Body That Should Not Overwrite Live Body",
                })
              );
            }
            return Promise.resolve(null);
          }),
          set: vi.fn().mockResolvedValue("OK"),
        },
        reddit: {
          getCurrentSubreddit: vi.fn().mockResolvedValue({
            name: "testsub",
            getModerators: vi.fn().mockReturnValue((async function*() { yield { username: "localmod" }; })()),
          }),
          modMail: { createModInboxConversation },
        },
      } as unknown as TriggerContext;

      const event: ModAction = {
        action: "removelink",
        moderator: { name: "Anti-Evil Operations" },
        subreddit: { id: "t5_testsub", name: "testsub" },
        targetPost: {
          id: "t3_partial_post",
          title: "[ Removed by Reddit ]",
          selftext: "Live Intact Post Body From Event",
        },
      } as unknown as ModAction;

      await checkModAction(event, mockContext);
      const modmailArgs = createModInboxConversation.mock.calls[0][0];
      expect(modmailArgs.bodyMarkdown).toContain("Original Post Title");
      expect(modmailArgs.bodyMarkdown).toContain("Title (Cached)");
      expect(modmailArgs.bodyMarkdown).toContain("Live Intact Post Body From Event");
      expect(modmailArgs.bodyMarkdown).not.toContain("Body (Cached)");
      expect(modmailArgs.bodyMarkdown).not.toContain("Cached Post Body That Should Not Overwrite Live Body");
    });

    it("sets Discord embed field name to URL (Cached) when cached URL is used", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));

      const mockContext = {
        settings: {
          getAll: vi.fn().mockResolvedValue({
            sendModmail: false,
            webhookURL: "https://discord.com/api/webhooks/123/xyz",
            excludeContext: false,
            addModNote: false,
          }),
        },
        redis: {
          get: vi.fn().mockImplementation((key: string) => {
            if (key === "mods") return Promise.resolve("localmod");
            if (key === "t3_url_post") {
              return Promise.resolve(
                JSON.stringify({
                  title: "Post With External URL",
                  url: "https://news.ycombinator.com",
                })
              );
            }
            return Promise.resolve(null);
          }),
          set: vi.fn().mockResolvedValue("OK"),
        },
        reddit: {
          getCurrentSubreddit: vi.fn().mockResolvedValue({
            name: "testsub",
            getModerators: vi.fn().mockReturnValue((async function*() { yield { username: "localmod" }; })()),
          }),
        },
      } as unknown as TriggerContext;

      const event: ModAction = {
        action: "removelink",
        moderator: { name: "Anti-Evil Operations" },
        subreddit: { id: "t5_testsub", name: "testsub" },
        targetPost: {
          id: "t3_url_post",
          title: "[ Removed by Reddit ]",
          // url omitted in event
        },
      } as unknown as ModAction;

      await checkModAction(event, mockContext);
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://discord.com/api/webhooks/123/xyz",
        expect.objectContaining({
          body: expect.stringMatching(/"name":"URL \(Cached\)","value":"https:\/\/news\.ycombinator\.com"/),
        })
      );
      fetchSpy.mockRestore();
    });

    it("deduplicates mod actions when event.id matches a recently processed action", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
      const createModInboxConversation = vi.fn().mockResolvedValue(undefined);
      let dedupSetCount = 0;

      const mockContext = {
        settings: {
          getAll: vi.fn().mockResolvedValue(baseSettings),
        },
        redis: {
          get: vi.fn().mockImplementation((key: string) => {
            if (key === "mods") return Promise.resolve("localmod");
            return Promise.resolve(null);
          }),
          set: vi.fn().mockImplementation((key: string) => {
            if (key.startsWith("dedup:action:")) {
              dedupSetCount++;
              // First call succeeds ("OK"), second call fails (null/undefined)
              return dedupSetCount === 1 ? Promise.resolve("OK") : Promise.resolve(undefined);
            }
            return Promise.resolve("OK");
          }),
        },
        reddit: {
          getCurrentSubreddit: vi.fn().mockResolvedValue({
            name: "testsub",
            getModerators: vi.fn().mockReturnValue((async function*() { yield { username: "localmod" }; })()),
          }),
          modMail: { createModInboxConversation },
        },
      } as unknown as TriggerContext;

      const event: ModAction = {
        id: "ModAction_unique123",
        action: "removelink",
        moderator: { name: "Anti-Evil Operations" },
        subreddit: { id: "t5_testsub", name: "testsub" },
        targetPost: {
          id: "t3_post_dedup",
          title: "Some Title",
        },
      } as unknown as ModAction;

      // First run: should process and send modmail
      await checkModAction(event, mockContext);
      expect(createModInboxConversation).toHaveBeenCalledTimes(1);
      expect(mockContext.redis.set).toHaveBeenCalledWith(
        "dedup:action:id:ModAction_unique123",
        "1",
        expect.objectContaining({ nx: true, expiration: expect.any(Date) })
      );
      expect(debugSpy).toHaveBeenCalledWith(
        "[action] Stored deduplication key dedup:action:id:ModAction_unique123"
      );

      // Second run (duplicate trigger): should be ignored
      await checkModAction(event, mockContext);
      expect(createModInboxConversation).toHaveBeenCalledTimes(1); // Still 1, not 2
      expect(logSpy).toHaveBeenCalledWith(
        "[action] Ignored duplicate removelink action (dedup:action:id:ModAction_unique123)"
      );
      debugSpy.mockRestore();
      logSpy.mockRestore();
    });

    it("deduplicates mod actions using fallback composite key when event.id is missing", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const createModInboxConversation = vi.fn().mockResolvedValue(undefined);
      let dedupSetCount = 0;
      const actionDate = new Date("2026-11-18T12:00:00Z");

      const mockContext = {
        settings: {
          getAll: vi.fn().mockResolvedValue(baseSettings),
        },
        redis: {
          get: vi.fn().mockImplementation((key: string) => {
            if (key === "mods") return Promise.resolve("localmod");
            return Promise.resolve(null);
          }),
          set: vi.fn().mockImplementation((key: string) => {
            if (key.startsWith("dedup:action:")) {
              dedupSetCount++;
              return dedupSetCount === 1 ? Promise.resolve("OK") : Promise.resolve("");
            }
            return Promise.resolve("OK");
          }),
        },
        reddit: {
          getCurrentSubreddit: vi.fn().mockResolvedValue({
            name: "testsub",
            getModerators: vi.fn().mockReturnValue((async function*() { yield { username: "localmod" }; })()),
          }),
          modMail: { createModInboxConversation },
        },
      } as unknown as TriggerContext;

      const event: ModAction = {
        action: "removecomment",
        actionedAt: actionDate,
        moderator: { name: "Anti-Evil Operations" },
        subreddit: { id: "t5_testsub", name: "testsub" },
        targetComment: {
          id: "t1_comm_dedup",
          body: "Comment Body",
        },
      } as unknown as ModAction;

      const expectedKey = `dedup:action:removecomment:t1_comm_dedup:${actionDate.getTime()}`;

      // First run: should process
      await checkModAction(event, mockContext);
      expect(createModInboxConversation).toHaveBeenCalledTimes(1);
      expect(mockContext.redis.set).toHaveBeenCalledWith(
        expectedKey,
        "1",
        expect.objectContaining({ nx: true, expiration: expect.any(Date) })
      );

      // Second run (duplicate trigger): should be ignored
      await checkModAction(event, mockContext);
      expect(createModInboxConversation).toHaveBeenCalledTimes(1);
      expect(logSpy).toHaveBeenCalledWith(
        `[action] Ignored duplicate removecomment action (${expectedKey})`
      );
      logSpy.mockRestore();
    });

    it("continues to alert if Redis error occurs during deduplication check (fails open)", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const createModInboxConversation = vi.fn().mockResolvedValue(undefined);

      const mockContext = {
        settings: {
          getAll: vi.fn().mockResolvedValue(baseSettings),
        },
        redis: {
          get: vi.fn().mockImplementation((key: string) => {
            if (key === "mods") return Promise.resolve("localmod");
            return Promise.resolve(null);
          }),
          set: vi.fn().mockImplementation((key: string) => {
            if (key.startsWith("dedup:action:")) {
              return Promise.reject(new Error("Redis dedup connection timeout"));
            }
            return Promise.resolve("OK");
          }),
        },
        reddit: {
          getCurrentSubreddit: vi.fn().mockResolvedValue({
            name: "testsub",
            getModerators: vi.fn().mockReturnValue((async function*() { yield { username: "localmod" }; })()),
          }),
          modMail: { createModInboxConversation },
        },
      } as unknown as TriggerContext;

      const event: ModAction = {
        id: "ModAction_failopen",
        action: "removelink",
        moderator: { name: "Anti-Evil Operations" },
        subreddit: { id: "t5_testsub", name: "testsub" },
        targetPost: {
          id: "t3_post_failopen",
          title: "Fail Open Title",
        },
      } as unknown as ModAction;

      await checkModAction(event, mockContext);
      expect(errorSpy).toHaveBeenCalledWith(
        "[action] Error checking action deduplication for dedup:action:id:ModAction_failopen",
        expect.any(Error)
      );
      // Alerts should still be sent even if Redis deduplication failed
      expect(createModInboxConversation).toHaveBeenCalledTimes(1);
      errorSpy.mockRestore();
    });

    it("continues to alert and logs error if getBannedUsers throws an error", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const createModInboxConversation = vi.fn().mockResolvedValue(undefined);

      const mockContext = {
        settings: {
          getAll: vi.fn().mockResolvedValue(baseSettings),
        },
        redis: {
          get: vi.fn().mockImplementation((key: string) => {
            if (key === "mods") return Promise.resolve("localmod");
            return Promise.resolve(null);
          }),
          set: vi.fn().mockResolvedValue("OK"),
        },
        reddit: {
          getCurrentSubreddit: vi.fn().mockResolvedValue({
            name: "testsub",
            getModerators: vi.fn().mockReturnValue((async function*() { yield { username: "localmod" }; })()),
          }),
          getBannedUsers: vi.fn().mockRejectedValue(new Error("Reddit ban API timeout")),
          modMail: { createModInboxConversation },
        },
      } as unknown as TriggerContext;

      const event: ModAction = {
        id: "ModAction_banned_err",
        action: "banuser",
        moderator: { name: "Anti-Evil Operations" },
        subreddit: { id: "t5_testsub", name: "testsub" },
        targetUser: { id: "t2_targetuser", name: "baduser" },
      } as unknown as ModAction;

      await checkModAction(event, mockContext);

      expect(errorSpy).toHaveBeenCalledWith(
        "[action] Error checking ban status for u/baduser",
        expect.any(Error)
      );
      expect(createModInboxConversation).toHaveBeenCalledTimes(1);
      // Verify message contains target user without the "(Banned in r/testsub)" tag
      expect(createModInboxConversation).toHaveBeenCalledWith(
        expect.objectContaining({
          bodyMarkdown: expect.stringContaining("* **Target User:** u/baduser\n"),
        })
      );
      errorSpy.mockRestore();
    });

    it("falls back to context.subredditId when event.subreddit.id is missing or needs t5_ prefix", async () => {
      const createModInboxConversation = vi.fn().mockResolvedValue(undefined);

      const mockContext = {
        subredditId: "context_sub_id",
        settings: {
          getAll: vi.fn().mockResolvedValue(baseSettings),
        },
        redis: {
          get: vi.fn().mockImplementation((key: string) => {
            if (key === "mods") return Promise.resolve("localmod");
            return Promise.resolve(null);
          }),
          set: vi.fn().mockResolvedValue("OK"),
        },
        reddit: {
          getCurrentSubreddit: vi.fn().mockResolvedValue({
            name: "testsub",
            getModerators: vi.fn().mockReturnValue((async function*() { yield { username: "localmod" }; })()),
          }),
          modMail: { createModInboxConversation },
        },
      } as unknown as TriggerContext;

      const event: ModAction = {
        id: "ModAction_no_sub_id",
        action: "removelink",
        moderator: { name: "Anti-Evil Operations" },
        subreddit: { name: "testsub" }, // No id
        targetPost: { id: "t3_post_no_sub_id", title: "Test" },
      } as unknown as ModAction;

      await checkModAction(event, mockContext);

      expect(createModInboxConversation).toHaveBeenCalledWith(
        expect.objectContaining({
          subredditId: "t5_context_sub_id",
        })
      );
    });

    it("ignores admin actions cleanly when all reporting routes and mod notes are disabled", async () => {
      const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
      const createModInboxConversation = vi.fn().mockResolvedValue(undefined);
      const redisSet = vi.fn().mockResolvedValue("OK");

      const mockContext = {
        settings: {
          getAll: vi.fn().mockResolvedValue({
            sendModmail: false,
            webhookURL: "",
            excludeContext: false,
            addModNote: false,
          }),
        },
        redis: {
          get: vi.fn().mockResolvedValue("localmod"),
          set: redisSet,
        },
        reddit: {
          getCurrentSubreddit: vi.fn().mockResolvedValue({
            name: "testsub",
            getModerators: vi.fn().mockReturnValue((async function*() { yield { username: "localmod" }; })()),
          }),
          modMail: { createModInboxConversation },
        },
      } as unknown as TriggerContext;

      const event: ModAction = {
        id: "ModAction_disabled_routes",
        action: "removelink",
        moderator: { name: "Anti-Evil Operations" },
        subreddit: { id: "t5_testsub", name: "testsub" },
        targetPost: { id: "t3_post_disabled", title: "Test" },
      } as unknown as ModAction;

      await checkModAction(event, mockContext);

      expect(debugSpy).toHaveBeenCalledWith(
        "[action] Ignored removelink by Anti-Evil Operations: all reporting routes and mod notes are disabled"
      );
      expect(createModInboxConversation).not.toHaveBeenCalled();
      expect(redisSet).not.toHaveBeenCalled();
      debugSpy.mockRestore();
    });

    it("adds mod note when addModNote is true even if all reporting routes are disabled", async () => {
      const createModInboxConversation = vi.fn().mockResolvedValue(undefined);
      const addModNote = vi.fn().mockResolvedValue(undefined);
      const redisSet = vi.fn().mockResolvedValue("OK");

      const mockContext = {
        settings: {
          getAll: vi.fn().mockResolvedValue({
            sendModmail: false,
            webhookURL: "",
            excludeContext: false,
            addModNote: true,
          }),
        },
        redis: {
          get: vi.fn().mockImplementation((key: string) => {
            if (key === "mods") return Promise.resolve("localmod");
            return Promise.resolve(null);
          }),
          set: redisSet,
        },
        reddit: {
          getCurrentSubreddit: vi.fn().mockResolvedValue({
            name: "testsub",
            getModerators: vi.fn().mockReturnValue((async function*() { yield { username: "localmod" }; })()),
          }),
          getBannedUsers: vi.fn().mockResolvedValue({ all: vi.fn().mockResolvedValue([]) }),
          modMail: { createModInboxConversation },
          addModNote,
        },
      } as unknown as TriggerContext;

      const event: ModAction = {
        id: "ModAction_modnote_only",
        action: "removelink",
        moderator: { name: "Anti-Evil Operations" },
        subreddit: { id: "t5_testsub", name: "testsub" },
        targetUser: { id: "t2_targetuser", name: "spammer" },
        targetPost: { id: "t3_post_modnote_only", title: "Test Spam" },
      } as unknown as ModAction;

      await checkModAction(event, mockContext);

      expect(addModNote).toHaveBeenCalledWith(
        expect.objectContaining({
          subreddit: "testsub",
          user: "spammer",
          redditId: "t3_post_modnote_only",
          note: "Anti-Evil Operations Removal",
        })
      );
      expect(createModInboxConversation).not.toHaveBeenCalled();
    });

    it("updates cached modlist on modlist change even when all reporting routes are disabled", async () => {
      const redisSet = vi.fn().mockResolvedValue("OK");

      const mockContext = {
        settings: {
          getAll: vi.fn().mockResolvedValue({
            sendModmail: false,
            webhookURL: "",
            excludeContext: false,
            addModNote: false,
          }),
        },
        redis: {
          get: vi.fn().mockResolvedValue("localmod"),
          set: redisSet,
        },
        reddit: {
          getCurrentSubreddit: vi.fn().mockResolvedValue({
            name: "testsub",
            getModerators: vi.fn().mockReturnValue((async function*() {
              yield { username: "localmod" };
              yield { username: "newmod" };
            })()),
          }),
        },
      } as unknown as TriggerContext;

      const event: ModAction = {
        action: "addmoderator",
        moderator: { name: "localmod" },
        targetUser: { id: "t2_newmod", name: "newmod" },
        subreddit: { id: "t5_testsub", name: "testsub" },
      } as unknown as ModAction;

      await checkModAction(event, mockContext);

      // Verify modlist was refreshed and written to Redis
      expect(redisSet).toHaveBeenCalledWith(
        "mods",
        "localmod,newmod",
        expect.objectContaining({ expiration: expect.any(Date) })
      );
    });

    it("ignores unsticky action when targetComment.deleted is true in event payload", async () => {
      const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
      const createModInboxConversation = vi.fn().mockResolvedValue(undefined);
      const getCommentById = vi.fn();

      const mockContext = {
        settings: {
          getAll: vi.fn().mockResolvedValue(baseSettings),
        },
        redis: {
          get: vi.fn().mockResolvedValue("localmod"),
          set: vi.fn().mockResolvedValue("OK"),
        },
        reddit: {
          getCommentById,
          modMail: { createModInboxConversation },
        },
      } as unknown as TriggerContext;

      const event: ModAction = {
        id: "ModAction_unsticky_proto_deleted",
        action: "unsticky",
        moderator: { name: "Anti-Evil Operations" },
        subreddit: { id: "t5_testsub", name: "testsub" },
        targetComment: {
          id: "t1_deleted_sticky",
          body: "Original sticky text",
          deleted: true,
        },
      } as unknown as ModAction;

      await checkModAction(event, mockContext);

      expect(getCommentById).not.toHaveBeenCalled();
      expect(createModInboxConversation).not.toHaveBeenCalled();
      expect(debugSpy).toHaveBeenCalledWith(
        "[action] Ignored unsticky on deleted content (t1_deleted_sticky)"
      );
      debugSpy.mockRestore();
    });

    it("ignores unsticky action when live getCommentById shows deleted comment despite intact event payload", async () => {
      const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
      const createModInboxConversation = vi.fn().mockResolvedValue(undefined);
      const getCommentById = vi.fn().mockResolvedValue({
        authorName: "[deleted]",
        body: "[deleted]",
        removed: false,
      });

      const mockContext = {
        settings: {
          getAll: vi.fn().mockResolvedValue(baseSettings),
        },
        redis: {
          get: vi.fn().mockResolvedValue("localmod"),
          set: vi.fn().mockResolvedValue("OK"),
        },
        reddit: {
          getCommentById,
          modMail: { createModInboxConversation },
        },
      } as unknown as TriggerContext;

      const event: ModAction = {
        id: "ModAction_unsticky_live_deleted_comment",
        action: "unsticky",
        moderator: { name: "Anti-Evil Operations" },
        subreddit: { id: "t5_testsub", name: "testsub" },
        targetUser: { id: "t2_bot", name: "only-flairs" },
        targetComment: {
          id: "t1_phwbv0n",
          body: "Commenting on this post is currently restricted...",
          deleted: false,
        },
      } as unknown as ModAction;

      await checkModAction(event, mockContext);

      expect(getCommentById).toHaveBeenCalledWith("t1_phwbv0n");
      expect(createModInboxConversation).not.toHaveBeenCalled();
      expect(debugSpy).toHaveBeenCalledWith(
        "[action] Ignored unsticky on deleted content (t1_phwbv0n)"
      );
      debugSpy.mockRestore();
    });

    it("ignores unsticky action when live getCommentById throws not found", async () => {
      const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
      const createModInboxConversation = vi.fn().mockResolvedValue(undefined);
      const getCommentById = vi.fn().mockRejectedValue(new Error("not found"));

      const mockContext = {
        settings: {
          getAll: vi.fn().mockResolvedValue(baseSettings),
        },
        redis: {
          get: vi.fn().mockResolvedValue("localmod"),
          set: vi.fn().mockResolvedValue("OK"),
        },
        reddit: {
          getCommentById,
          modMail: { createModInboxConversation },
        },
      } as unknown as TriggerContext;

      const event: ModAction = {
        id: "ModAction_unsticky_not_found_comment",
        action: "unsticky",
        moderator: { name: "Anti-Evil Operations" },
        subreddit: { id: "t5_testsub", name: "testsub" },
        targetComment: {
          id: "t1_gone",
          body: "Some text",
          deleted: false,
        },
      } as unknown as ModAction;

      await checkModAction(event, mockContext);

      expect(createModInboxConversation).not.toHaveBeenCalled();
      expect(debugSpy).toHaveBeenCalledWith(
        "[action] Ignored unsticky on deleted content (t1_gone)"
      );
      debugSpy.mockRestore();
    });

    it("alerts on unsticky when live getCommentById confirms comment is still live", async () => {
      const createModInboxConversation = vi.fn().mockResolvedValue(undefined);
      const getCommentById = vi.fn().mockResolvedValue({
        authorName: "some_mod",
        body: "Active sticky comment",
        removed: false,
      });

      const mockContext = {
        settings: {
          getAll: vi.fn().mockResolvedValue(baseSettings),
        },
        redis: {
          get: vi.fn().mockResolvedValue("localmod"),
          set: vi.fn().mockResolvedValue("OK"),
        },
        reddit: {
          getCommentById,
          modMail: { createModInboxConversation },
        },
      } as unknown as TriggerContext;

      const event: ModAction = {
        id: "ModAction_unsticky_live_comment",
        action: "unsticky",
        moderator: { name: "Anti-Evil Operations" },
        subreddit: { id: "t5_testsub", name: "testsub" },
        targetComment: {
          id: "t1_live_sticky",
          body: "Active sticky comment",
          deleted: false,
        },
      } as unknown as ModAction;

      await checkModAction(event, mockContext);

      expect(getCommentById).toHaveBeenCalledWith("t1_live_sticky");
      expect(createModInboxConversation).toHaveBeenCalledTimes(1);
    });

    it("fails open and alerts on unsticky if getCommentById throws a transient API error", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const createModInboxConversation = vi.fn().mockResolvedValue(undefined);
      const getCommentById = vi.fn().mockRejectedValue(new Error("503 Service Unavailable"));

      const mockContext = {
        settings: {
          getAll: vi.fn().mockResolvedValue(baseSettings),
        },
        redis: {
          get: vi.fn().mockResolvedValue("localmod"),
          set: vi.fn().mockResolvedValue("OK"),
        },
        reddit: {
          getCommentById,
          modMail: { createModInboxConversation },
        },
      } as unknown as TriggerContext;

      const event: ModAction = {
        id: "ModAction_unsticky_comment_api_err",
        action: "unsticky",
        moderator: { name: "Anti-Evil Operations" },
        subreddit: { id: "t5_testsub", name: "testsub" },
        targetComment: {
          id: "t1_err_sticky",
          body: "Some text",
          deleted: false,
        },
      } as unknown as ModAction;

      await checkModAction(event, mockContext);

      expect(errorSpy).toHaveBeenCalledWith(
        "[action] Error checking deletion status for t1_err_sticky",
        expect.any(Error)
      );
      expect(createModInboxConversation).toHaveBeenCalledTimes(1);
      errorSpy.mockRestore();
    });

    it("ignores unsticky action on deleted post via live getPostById and handles no post / API errors", async () => {
      const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const createModInboxConversation = vi.fn().mockResolvedValue(undefined);
      const getPostById = vi
        .fn()
        .mockResolvedValueOnce({
          authorName: "[deleted]",
          body: "[deleted]",
          title: "Old Sticky Post",
          removed: false,
        })
        .mockRejectedValueOnce(new Error("no post t3_purged_post"))
        .mockRejectedValueOnce(new Error("500 Internal Server Error"));

      const mockContext = {
        settings: {
          getAll: vi.fn().mockResolvedValue(baseSettings),
        },
        redis: {
          get: vi.fn().mockResolvedValue("localmod"),
          set: vi.fn().mockResolvedValue("OK"),
        },
        reddit: {
          getPostById,
          modMail: { createModInboxConversation },
        },
      } as unknown as TriggerContext;

      // 1. Live post shows deleted author/body -> ignored
      await checkModAction(
        {
          id: "ModAction_unsticky_post_1",
          action: "unsticky",
          moderator: { name: "Anti-Evil Operations" },
          subreddit: { id: "t5_testsub", name: "testsub" },
          targetPost: { id: "t3_del_post", title: "Old Sticky Post", deleted: false },
        } as unknown as ModAction,
        mockContext
      );
      expect(createModInboxConversation).not.toHaveBeenCalled();
      expect(debugSpy).toHaveBeenCalledWith(
        "[action] Ignored unsticky on deleted content (t3_del_post)"
      );

      // 2. Post not found ("no post ...") -> ignored
      await checkModAction(
        {
          id: "ModAction_unsticky_post_2",
          action: "unsticky",
          moderator: { name: "Anti-Evil Operations" },
          subreddit: { id: "t5_testsub", name: "testsub" },
          targetPost: { id: "t3_purged_post", title: "Purged Post", deleted: false },
        } as unknown as ModAction,
        mockContext
      );
      expect(createModInboxConversation).not.toHaveBeenCalled();

      // 3. Transient API error -> fails open and alerts
      await checkModAction(
        {
          id: "ModAction_unsticky_post_3",
          action: "unsticky",
          moderator: { name: "Anti-Evil Operations" },
          subreddit: { id: "t5_testsub", name: "testsub" },
          targetPost: { id: "t3_err_post", title: "Error Post", deleted: false },
        } as unknown as ModAction,
        mockContext
      );
      expect(errorSpy).toHaveBeenCalledWith(
        "[action] Error checking deletion status for t3_err_post",
        expect.any(Error)
      );
      expect(createModInboxConversation).toHaveBeenCalledTimes(1);

      // 4. Unsticky with neither targetComment nor targetPost -> alerts
      await checkModAction(
        {
          id: "ModAction_unsticky_no_target",
          action: "unsticky",
          moderator: { name: "Anti-Evil Operations" },
          subreddit: { id: "t5_testsub", name: "testsub" },
        } as unknown as ModAction,
        mockContext
      );
      expect(createModInboxConversation).toHaveBeenCalledTimes(2);

      debugSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it("logs error when Slack or Discord webhook returns a non-OK HTTP status", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const makeContext = (webhookURL: string) =>
        ({
          settings: {
            getAll: vi.fn().mockResolvedValue({
              sendModmail: false,
              webhookURL,
              excludeContext: false,
              addModNote: false,
            }),
          },
          redis: {
            get: vi.fn().mockResolvedValue("localmod"),
            set: vi.fn().mockResolvedValue("OK"),
          },
          reddit: {},
        }) as unknown as TriggerContext;

      // Slack 400 Bad Request
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response("invalid_blocks", { status: 400, statusText: "Bad Request" }))
      );
      await checkModAction(
        {
          id: "ModAction_slack_400",
          action: "removelink",
          moderator: { name: "Anti-Evil Operations" },
          subreddit: { id: "t5_testsub", name: "testsub" },
          targetPost: { id: "t3_slack400", title: "Test" },
        } as unknown as ModAction,
        makeContext("https://hooks.slack.com/services/T00/B00/X")
      );
      expect(errorSpy).toHaveBeenCalledWith(
        "[notify] Error sending Slack message about removelink by Anti-Evil Operations",
        expect.objectContaining({ message: "HTTP 400 Bad Request" })
      );
      expect(logSpy).not.toHaveBeenCalledWith(
        "[notify] Sent Slack message about removelink by Anti-Evil Operations"
      );

      // Discord 429 Too Many Requests
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response("rate limited", { status: 429, statusText: "Too Many Requests" }))
      );
      await checkModAction(
        {
          id: "ModAction_discord_429",
          action: "removelink",
          moderator: { name: "Anti-Evil Operations" },
          subreddit: { id: "t5_testsub", name: "testsub" },
          targetPost: { id: "t3_disc429", title: "Test" },
        } as unknown as ModAction,
        makeContext("https://discord.com/api/webhooks/123/xyz")
      );
      expect(errorSpy).toHaveBeenCalledWith(
        "[notify] Error sending Discord message about removelink by Anti-Evil Operations",
        expect.objectContaining({ message: "HTTP 429 Too Many Requests" })
      );
      expect(logSpy).not.toHaveBeenCalledWith(
        "[notify] Sent Discord message about removelink by Anti-Evil Operations"
      );

      errorSpy.mockRestore();
      logSpy.mockRestore();
    });

    it("caps Slack context block text to 3000 chars and Discord URL field to 1024 chars", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      const longUrl = "https://example.com/" + "a".repeat(1200);
      const longTitle = "T".repeat(300);
      const longBody = "B".repeat(2600);

      const makeContext = (webhookURL: string) =>
        ({
          settings: {
            getAll: vi.fn().mockResolvedValue({
              sendModmail: false,
              webhookURL,
              excludeContext: false,
              addModNote: false,
            }),
          },
          redis: {
            get: vi.fn().mockResolvedValue("localmod"),
            set: vi.fn().mockResolvedValue("OK"),
          },
          reddit: {},
        }) as unknown as TriggerContext;

      // Slack
      await checkModAction(
        {
          id: "ModAction_slack_cap",
          action: "removelink",
          moderator: { name: "Anti-Evil Operations" },
          subreddit: { id: "t5_testsub", name: "testsub" },
          targetPost: {
            id: "t3_slack_cap",
            permalink: "/r/testsub/comments/slack_cap/test/",
            url: longUrl,
            title: longTitle,
            selftext: longBody,
          },
        } as unknown as ModAction,
        makeContext("https://hooks.slack.com/services/T00/B00/X")
      );
      const slackCall = fetchMock.mock.calls[0];
      expect(slackCall[1].headers).toEqual({ "Content-Type": "application/json" });
      const slackBody = JSON.parse(slackCall[1].body);
      expect(slackBody.attachments[0].blocks[0].elements[0].text.length).toBeLessThanOrEqual(3000);

      // Discord
      await checkModAction(
        {
          id: "ModAction_discord_cap",
          action: "removelink",
          moderator: { name: "Anti-Evil Operations" },
          subreddit: { id: "t5_testsub", name: "testsub" },
          targetPost: {
            id: "t3_discord_cap",
            url: longUrl,
            title: longTitle,
            selftext: longBody,
          },
        } as unknown as ModAction,
        makeContext("https://discord.com/api/webhooks/123/xyz")
      );
      const discordBody = JSON.parse(fetchMock.mock.calls[1][1].body);
      const urlField = discordBody.embeds[0].fields.find((f: { name: string }) => f.name === "URL");
      expect(urlField.value.length).toBe(1024);
    });

    it("continues to alert if cacheModerators fails during a modlist change action by an Admin", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const createModInboxConversation = vi.fn().mockResolvedValue(undefined);

      const mockContext = {
        settings: {
          getAll: vi.fn().mockResolvedValue(baseSettings),
        },
        redis: {
          get: vi.fn().mockResolvedValue("localmod"),
          set: vi.fn().mockResolvedValue("OK"),
        },
        reddit: {
          getCurrentSubreddit: vi.fn().mockRejectedValue(new Error("Reddit API 500")),
          getBannedUsers: vi.fn().mockResolvedValue({ all: vi.fn().mockResolvedValue([]) }),
          modMail: { createModInboxConversation },
        },
      } as unknown as TriggerContext;

      const event: ModAction = {
        id: "ModAction_admin_addmod_err",
        action: "addmoderator",
        moderator: { name: "Anti-Evil Operations" },
        targetUser: { id: "t2_newadminmod", name: "newadminmod" },
        subreddit: { id: "t5_testsub", name: "testsub" },
      } as unknown as ModAction;

      await checkModAction(event, mockContext);

      expect(errorSpy).toHaveBeenCalledWith(
        "[modlist] Error updating cached modlist on addmoderator",
        expect.any(Error)
      );
      expect(createModInboxConversation).toHaveBeenCalledTimes(1);
      errorSpy.mockRestore();
    });

    it("does not fetch settings for ignored AutoModerator, reddit, [deleted], or local moderator actions", async () => {
      const getAllSettings = vi.fn().mockResolvedValue(baseSettings);
      const mockContext = {
        settings: { getAll: getAllSettings },
        redis: {
          get: vi.fn().mockResolvedValue("localmod"),
          set: vi.fn().mockResolvedValue("OK"),
        },
        reddit: {},
      } as unknown as TriggerContext;

      for (const name of ["AutoModerator", "reddit", "[deleted]", "localmod"]) {
        await checkModAction(
          {
            action: "removecomment",
            moderator: { name },
            subreddit: { id: "t5_testsub", name: "testsub" },
          } as unknown as ModAction,
          mockContext
        );
      }

      expect(getAllSettings).not.toHaveBeenCalled();
    });

    it("avoids redundant live modlist refresh when a named Admin performs a modlist change action", async () => {
      const getCurrentSubreddit = vi.fn().mockResolvedValue({
        name: "testsub",
        getModerators: vi.fn().mockReturnValue((async function* () { yield { username: "localmod" }; })()),
      });
      const createModInboxConversation = vi.fn().mockResolvedValue(undefined);
      const redisGet = vi.fn();

      const mockContext = {
        settings: { getAll: vi.fn().mockResolvedValue(baseSettings) },
        redis: {
          get: redisGet,
          set: vi.fn().mockResolvedValue("OK"),
        },
        reddit: {
          getCurrentSubreddit,
          getBannedUsers: vi.fn().mockResolvedValue({ all: vi.fn().mockResolvedValue([]) }),
          modMail: { createModInboxConversation },
        },
      } as unknown as TriggerContext;

      await checkModAction(
        {
          id: "ModAction_named_admin_addmod",
          action: "addmoderator",
          moderator: { name: "spez" },
          targetUser: { id: "t2_other", name: "newmod" },
          subreddit: { id: "t5_testsub", name: "testsub" },
        } as unknown as ModAction,
        mockContext
      );

      // Fetched modlist once on addmoderator; neither re-read from Redis nor refreshed a second time
      expect(getCurrentSubreddit).toHaveBeenCalledTimes(1);
      expect(redisGet).not.toHaveBeenCalled();
      expect(createModInboxConversation).toHaveBeenCalledTimes(1);
    });

    it("archives modmail conversation when archiveModmail is enabled and handles archive errors gracefully", async () => {
      const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const createModInboxConversation = vi
        .fn()
        .mockResolvedValueOnce("conv_123")
        .mockResolvedValueOnce("conv_456")
        .mockResolvedValueOnce("conv_789");
      const archiveConversation = vi
        .fn()
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(new Error("Archive permission error"));

      const makeContext = (archiveModmail: boolean) =>
        ({
          settings: {
            getAll: vi.fn().mockResolvedValue({
              ...baseSettings,
              webhookURL: "",
              addModNote: false,
              archiveModmail,
            }),
          },
          redis: {
            get: vi.fn().mockResolvedValue("localmod"),
            set: vi.fn().mockResolvedValue("OK"),
          },
          reddit: {
            modMail: { createModInboxConversation, archiveConversation },
          },
        }) as unknown as TriggerContext;

      // 1. archiveModmail: true -> archives conversation
      await checkModAction(
        {
          id: "ModAction_archive_1",
          action: "removelink",
          moderator: { name: "Anti-Evil Operations" },
          subreddit: { id: "t5_testsub", name: "testsub" },
          targetPost: { id: "t3_arch1", title: "Test 1" },
        } as unknown as ModAction,
        makeContext(true)
      );
      expect(archiveConversation).toHaveBeenCalledWith("conv_123");
      expect(debugSpy).toHaveBeenCalledWith("[notify] Archived modmail conversation conv_123");

      // 2. archiveModmail: true, archiveConversation throws -> logs error gracefully
      await checkModAction(
        {
          id: "ModAction_archive_2",
          action: "removelink",
          moderator: { name: "Anti-Evil Operations" },
          subreddit: { id: "t5_testsub", name: "testsub" },
          targetPost: { id: "t3_arch2", title: "Test 2" },
        } as unknown as ModAction,
        makeContext(true)
      );
      expect(archiveConversation).toHaveBeenCalledWith("conv_456");
      expect(errorSpy).toHaveBeenCalledWith(
        "[notify] Error archiving modmail conversation conv_456",
        expect.any(Error)
      );

      // 3. archiveModmail: false -> does not archive
      await checkModAction(
        {
          id: "ModAction_archive_3",
          action: "removelink",
          moderator: { name: "Anti-Evil Operations" },
          subreddit: { id: "t5_testsub", name: "testsub" },
          targetPost: { id: "t3_arch3", title: "Test 3" },
        } as unknown as ModAction,
        makeContext(false)
      );
      expect(archiveConversation).toHaveBeenCalledTimes(2);

      debugSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it("prepends [Notification] to Modmail subject when modmailNotification is enabled", async () => {
      const createModInboxConversation = vi.fn().mockResolvedValue("conv_notif");
      const archiveConversation = vi.fn().mockResolvedValue({});

      const mockContext = {
        settings: {
          getAll: vi.fn().mockResolvedValue({
            sendModmail: true,
            modmailNotification: true,
            archiveModmail: true,
            webhookURL: "",
            excludeContext: false,
            addModNote: false,
          }),
        },
        redis: {
          get: vi.fn().mockResolvedValue("localmod"),
          set: vi.fn().mockResolvedValue("OK"),
        },
        reddit: {
          modMail: {
            createModInboxConversation,
            archiveConversation,
          },
        },
      } as unknown as TriggerContext;

      await checkModAction(
        {
          id: "ModAction_notif_folder",
          action: "removecomment",
          moderator: { name: "Anti-Evil Operations" },
          subreddit: { id: "t5_testsub", name: "testsub" },
          targetComment: { id: "t1_notif1", body: "Test comment" },
        } as unknown as ModAction,
        mockContext
      );

      expect(createModInboxConversation).toHaveBeenCalledTimes(1);
      expect(createModInboxConversation).toHaveBeenCalledWith(
        expect.objectContaining({
          subredditId: "t5_testsub",
          subject: "[Notification] Admin Action Detected: removecomment",
        })
      );
      expect(archiveConversation).toHaveBeenCalledWith("conv_notif");
    });

    it("dispatches to multiple comma-separated Slack and Discord webhooks", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      const mockContext = {
        settings: {
          getAll: vi.fn().mockResolvedValue({
            sendModmail: false,
            modmailNotification: false,
            archiveModmail: false,
            webhookURL:
              " https://hooks.slack.com/services/T1/B1/X , https://discord.com/api/webhooks/1/a, https://discord.com/api/webhooks/2/b , https://hooks.slack.com/services/T1/B1/X ",
            excludeContext: false,
            addModNote: false,
          }),
        },
        redis: {
          get: vi.fn().mockResolvedValue("localmod"),
          set: vi.fn().mockResolvedValue("OK"),
        },
        reddit: {},
      } as unknown as TriggerContext;

      await checkModAction(
        {
          id: "ModAction_multi_webhook",
          action: "removelink",
          moderator: { name: "Anti-Evil Operations" },
          subreddit: { id: "t5_testsub", name: "testsub" },
          targetPost: { id: "t3_multi", title: "Multi Webhook Post" },
        } as unknown as ModAction,
        mockContext
      );

      // 1 deduplicated Slack webhook + 2 distinct Discord webhooks = 3 calls
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(fetchMock.mock.calls[0][0]).toBe("https://hooks.slack.com/services/T1/B1/X");
      expect(fetchMock.mock.calls[1][0]).toBe("https://discord.com/api/webhooks/1/a");
      expect(fetchMock.mock.calls[2][0]).toBe("https://discord.com/api/webhooks/2/b");
    });

    it("caches prior content actions by local mods, AutoModerator, and reddit, and includes the latest in Admin notifications", async () => {
      const store = new Map<string, string>([["mods", "localmod"]]);
      const redisGet = vi.fn().mockImplementation(async (key: string) => store.get(key));
      const redisSet = vi.fn().mockImplementation(async (key: string, value: string, opts?: { nx?: boolean }) => {
        if (opts?.nx && store.has(key)) return undefined;
        store.set(key, value);
        return "OK";
      });
      const createModInboxConversation = vi.fn().mockResolvedValue("conv_prior");
      const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      const mockContext = {
        settings: {
          getAll: vi.fn().mockResolvedValue({
            sendModmail: true,
            modmailNotification: false,
            archiveModmail: false,
            webhookURL: "https://hooks.slack.com/services/T1/B1/X, https://discord.com/api/webhooks/1/a",
            excludeContext: false,
            addModNote: false,
          }),
        },
        redis: {
          get: redisGet,
          set: redisSet,
        },
        reddit: {
          modMail: {
            createModInboxConversation,
          },
        },
      } as unknown as TriggerContext;

      // 1. AutoModerator removes a comment -> cached under modaction:t1_prior1
      await checkModAction(
        {
          action: "removecomment",
          moderator: { name: "AutoModerator" },
          subreddit: { id: "t5_testsub", name: "testsub" },
          targetComment: { id: "t1_prior1", body: "Comment body" },
        } as unknown as ModAction,
        mockContext
      );
      expect(store.get("modaction:t1_prior1")).toBe(
        JSON.stringify({ action: "removecomment", moderator: "AutoModerator" })
      );

      // 2. Local mod approves the same comment -> overwrites modaction:t1_prior1 with latest action
      await checkModAction(
        {
          action: "approvecomment",
          moderator: { name: "localmod" },
          subreddit: { id: "t5_testsub", name: "testsub" },
          targetComment: { id: "t1_prior1", body: "Comment body" },
        } as unknown as ModAction,
        mockContext
      );
      expect(store.get("modaction:t1_prior1")).toBe(
        JSON.stringify({ action: "approvecomment", moderator: "localmod" })
      );

      // 3. reddit removes a post -> cached under modaction:t3_prior2
      await checkModAction(
        {
          action: "removelink",
          moderator: { name: "reddit" },
          subreddit: { id: "t5_testsub", name: "testsub" },
          targetPost: { id: "t3_prior2", title: "Post title" },
        } as unknown as ModAction,
        mockContext
      );
      expect(store.get("modaction:t3_prior2")).toBe(
        JSON.stringify({ action: "removelink", moderator: "reddit" })
      );

      // 4. Non-content local mod action (e.g. lock) is NOT cached
      await checkModAction(
        {
          action: "lock",
          moderator: { name: "localmod" },
          subreddit: { id: "t5_testsub", name: "testsub" },
          targetPost: { id: "t3_lockonly", title: "Locked post" },
        } as unknown as ModAction,
        mockContext
      );
      expect(store.has("modaction:t3_lockonly")).toBe(false);

      // 5. AEO removes the comment -> Modmail, Slack, and Discord all include "(Previously approved by u/localmod)"
      await checkModAction(
        {
          id: "ModAction_prior_aeo",
          action: "removecomment",
          moderator: { name: "Anti-Evil Operations" },
          subreddit: { id: "t5_testsub", name: "testsub" },
          targetComment: { id: "t1_prior1", body: "Comment body" },
        } as unknown as ModAction,
        mockContext
      );

      expect(createModInboxConversation).toHaveBeenCalledTimes(1);
      expect(createModInboxConversation.mock.calls[0][0].bodyMarkdown).toContain(
        "* **Action:** `removecomment` (Previously approved by u/localmod)"
      );

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const slackBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(slackBody.attachments[0].blocks[0].elements[0].text).toContain(
        "*Action:* `removecomment` (Previously approved by u/localmod)"
      );

      const discordBody = JSON.parse(fetchMock.mock.calls[1][1].body as string);
      expect(discordBody.embeds[0].fields[0]).toEqual({
        name: "Action",
        value: "`removecomment` (Previously approved by u/localmod)",
      });

      // 6. AEO removes the post previously removed by reddit -> shows "(Previously removed by reddit)"
      await checkModAction(
        {
          id: "ModAction_prior_reddit",
          action: "removelink",
          moderator: { name: "Anti-Evil Operations" },
          subreddit: { id: "t5_testsub", name: "testsub" },
          targetPost: { id: "t3_prior2", title: "Post title" },
        } as unknown as ModAction,
        mockContext
      );

      expect(createModInboxConversation).toHaveBeenCalledTimes(2);
      expect(createModInboxConversation.mock.calls[1][0].bodyMarkdown).toContain(
        "* **Action:** `removelink` (Previously removed by reddit)"
      );
    });

    it("caches prior mod action after live modlist refresh and handles Redis errors gracefully", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const redisSet = vi
        .fn()
        .mockResolvedValueOnce("OK") // cacheModerators("mods", ...)
        .mockRejectedValueOnce(new Error("Redis write failed")); // cacheModAction("modaction:t1_newmod", ...)

      const refreshContext = {
        settings: { getAll: vi.fn() },
        redis: {
          get: vi.fn().mockResolvedValue("oldmod"),
          set: redisSet,
        },
        reddit: {
          getCurrentSubreddit: vi.fn().mockResolvedValue({
            name: "testsub",
            getModerators: vi.fn().mockReturnValue(
              (async function* () {
                yield { username: "oldmod" };
                yield { username: "freshmod" };
              })()
            ),
          }),
        },
      } as unknown as TriggerContext;

      await checkModAction(
        {
          action: "removecomment",
          moderator: { name: "freshmod" },
          subreddit: { id: "t5_testsub", name: "testsub" },
          targetComment: { id: "t1_newmod", body: "Comment" },
        } as unknown as ModAction,
        refreshContext
      );

      expect(redisSet).toHaveBeenCalledWith(
        "modaction:t1_newmod",
        JSON.stringify({ action: "removecomment", moderator: "freshmod" }),
        expect.objectContaining({ expiration: expect.any(Date) })
      );
      expect(errorSpy).toHaveBeenCalledWith(
        "[cache] Error writing modaction:t1_newmod to Redis",
        expect.any(Error)
      );

      // Also verify getCachedModAction handles Redis read errors and returns gracefully
      const createModInboxConversation = vi.fn().mockResolvedValue("conv_err");
      const readErrContext = {
        settings: {
          getAll: vi.fn().mockResolvedValue({
            sendModmail: true,
            modmailNotification: false,
            archiveModmail: false,
            webhookURL: "",
            excludeContext: false,
            addModNote: false,
          }),
        },
        redis: {
          get: vi.fn().mockImplementation(async (key: string) => {
            if (key === "mods") return "localmod";
            if (key === "modaction:t1_readerr") throw new Error("Redis read failed");
            return undefined;
          }),
          set: vi.fn().mockResolvedValue("OK"),
        },
        reddit: {
          modMail: {
            createModInboxConversation,
          },
        },
      } as unknown as TriggerContext;

      await checkModAction(
        {
          id: "ModAction_prior_readerr",
          action: "removecomment",
          moderator: { name: "Anti-Evil Operations" },
          subreddit: { id: "t5_testsub", name: "testsub" },
          targetComment: { id: "t1_readerr", body: "Comment" },
        } as unknown as ModAction,
        readErrContext
      );

      expect(errorSpy).toHaveBeenCalledWith(
        "[cache] Error fetching cached mod action for t1_readerr",
        expect.any(Error)
      );
      expect(createModInboxConversation).toHaveBeenCalledTimes(1);
      expect(createModInboxConversation.mock.calls[0][0].bodyMarkdown).toContain(
        "* **Action:** `removecomment`\n"
      );

      errorSpy.mockRestore();
    });

    it("matches target ID to action type, ignores subsequent out-of-order mod actions, and skips lookup in addModNote-only mode", async () => {
      const store = new Map<string, string>([["mods", "localmod"]]);
      const redisGet = vi.fn().mockImplementation(async (key: string) => store.get(key));
      const redisSet = vi.fn().mockImplementation(async (key: string, value: string, opts?: { nx?: boolean }) => {
        if (opts?.nx && store.has(key)) return undefined;
        store.set(key, value);
        return "OK";
      });
      const createModInboxConversation = vi.fn().mockResolvedValue("conv_ts");
      const addModNote = vi.fn().mockResolvedValue({});

      const mockContext = {
        settings: {
          getAll: vi.fn().mockResolvedValue({
            sendModmail: true,
            modmailNotification: false,
            archiveModmail: false,
            webhookURL: "",
            excludeContext: false,
            addModNote: false,
          }),
        },
        redis: {
          get: redisGet,
          set: redisSet,
        },
        reddit: {
          modMail: {
            createModInboxConversation,
          },
          addModNote,
        },
      } as unknown as TriggerContext;

      // 1. removecomment missing targetComment.id (even with targetPost.id set) does NOT pollute parent post cache
      await checkModAction(
        {
          action: "removecomment",
          moderator: { name: "AutoModerator" },
          subreddit: { id: "t5_testsub", name: "testsub" },
          targetPost: { id: "t3_parent_only", title: "Parent post" },
          targetComment: { id: "" },
        } as unknown as ModAction,
        mockContext
      );
      expect(store.has("modaction:t3_parent_only")).toBe(false);

      // 2. removelink with empty proto3 targetComment.id ("") still caches under targetPost.id with timestamp
      const modTime = new Date("2026-11-20T10:00:05.000Z");
      await checkModAction(
        {
          action: "removelink",
          actionedAt: modTime,
          moderator: { name: "localmod" },
          subreddit: { id: "t5_testsub", name: "testsub" },
          targetPost: { id: "t3_post_ts", title: "Post" },
          targetComment: { id: "" },
        } as unknown as ModAction,
        mockContext
      );
      expect(store.get("modaction:t3_post_ts")).toBe(
        JSON.stringify({ action: "removelink", moderator: "localmod", timestamp: modTime.getTime() })
      );

      // 3. Admin action that actually happened EARLIER than the cached mod action (out-of-order delivery) omits "Previously ..."
      await checkModAction(
        {
          id: "ModAction_earlier_admin",
          action: "removelink",
          actionedAt: new Date("2026-11-20T10:00:00.000Z"),
          moderator: { name: "Anti-Evil Operations" },
          subreddit: { id: "t5_testsub", name: "testsub" },
          targetPost: { id: "t3_post_ts", title: "Post" },
        } as unknown as ModAction,
        mockContext
      );
      expect(createModInboxConversation).toHaveBeenCalledTimes(1);
      expect(createModInboxConversation.mock.calls[0][0].bodyMarkdown).toContain(
        "* **Action:** `removelink`\n"
      );
      expect(createModInboxConversation.mock.calls[0][0].bodyMarkdown).not.toContain("Previously");

      // 4. Admin action that happened LATER than the cached mod action DOES include "Previously ..."
      await checkModAction(
        {
          id: "ModAction_later_admin",
          action: "removelink",
          actionedAt: new Date("2026-11-20T10:00:10.000Z"),
          moderator: { name: "Anti-Evil Operations" },
          subreddit: { id: "t5_testsub", name: "testsub" },
          targetPost: { id: "t3_post_ts", title: "Post" },
        } as unknown as ModAction,
        mockContext
      );
      expect(createModInboxConversation).toHaveBeenCalledTimes(2);
      expect(createModInboxConversation.mock.calls[1][0].bodyMarkdown).toContain(
        "* **Action:** `removelink` (Previously removed by u/localmod)"
      );

      // 5. addModNote-only mode (no Modmail or webhooks) skips modaction Redis lookup
      redisGet.mockClear();
      const modNoteOnlyContext = {
        ...mockContext,
        settings: {
          getAll: vi.fn().mockResolvedValue({
            sendModmail: false,
            modmailNotification: false,
            archiveModmail: false,
            webhookURL: "",
            excludeContext: false,
            addModNote: true,
          }),
        },
        reddit: {
          addModNote,
          getBannedUsers: vi.fn().mockResolvedValue({ all: vi.fn().mockResolvedValue([]) }),
        },
      } as unknown as TriggerContext;

      await checkModAction(
        {
          id: "ModAction_modnote_only",
          action: "removelink",
          moderator: { name: "Anti-Evil Operations" },
          subreddit: { id: "t5_testsub", name: "testsub" },
          targetPost: { id: "t3_post_ts", title: "Post" },
          targetUser: { name: "baduser" },
        } as unknown as ModAction,
        modNoteOnlyContext
      );
      expect(redisGet).not.toHaveBeenCalledWith("modaction:t3_post_ts");
      expect(addModNote).toHaveBeenCalledTimes(1);
    });
  });

  describe("formatPriorModAction", () => {
    it("formats removal, spam, approval, and fallback actions for mods, AutoModerator, and reddit", () => {
      expect(formatPriorModAction({ action: "removecomment", moderator: "AutoModerator" })).toBe(
        "Previously removed by u/AutoModerator"
      );
      expect(formatPriorModAction({ action: "removelink", moderator: "reddit" })).toBe(
        "Previously removed by reddit"
      );
      expect(formatPriorModAction({ action: "spamcomment", moderator: "localmod" })).toBe(
        "Previously marked as spam by u/localmod"
      );
      expect(formatPriorModAction({ action: "spamlink", moderator: "localmod" })).toBe(
        "Previously marked as spam by u/localmod"
      );
      expect(formatPriorModAction({ action: "approvecomment", moderator: "localmod" })).toBe(
        "Previously approved by u/localmod"
      );
      expect(formatPriorModAction({ action: "approvelink", moderator: "localmod" })).toBe(
        "Previously approved by u/localmod"
      );
      expect(formatPriorModAction({ action: "lock", moderator: "localmod" })).toBe(
        "Previously actioned (lock) by u/localmod"
      );
    });
  });

  describe("formatRemovedFallback", () => {
    it("formats fallback for submissions older than 30 days", () => {
      const oldTime = Date.now() - 45 * 24 * 60 * 60 * 1000;
      const expectedDate = new Date(oldTime).toLocaleDateString("fr-CA");
      expect(formatRemovedFallback(oldTime)).toBe(
        `[ Removed by Reddit ] (Submitted ${expectedDate}, exceeds 30-day cache)`
      );
    });

    it("formats fallback for submissions within 30 days", () => {
      const recentTime = Date.now() - 5 * 24 * 60 * 60 * 1000;
      const expectedDate = new Date(recentTime).toLocaleDateString("fr-CA");
      expect(formatRemovedFallback(recentTime)).toBe(
        `[ Removed by Reddit ] (Submitted ${expectedDate}, not cached)`
      );
    });

    it("formats fallback when createdAt is undefined", () => {
      expect(formatRemovedFallback(undefined)).toBe("[ Removed by Reddit ] (Not cached)");
    });
  });
});
