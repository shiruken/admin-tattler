import { describe, expect, it, vi, beforeEach } from "vitest";
import { cacheComment, cacheModerators, cachePost, checkModAction, formatRemovedFallback } from "./handlers.js";
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

    it("throws if missing moderator", async () => {
      const mockContext = {} as TriggerContext;
      await expect(
        checkModAction({ action: "removelink" } as ModAction, mockContext)
      ).rejects.toThrow("Missing `moderator` from ModActionTrigger event");
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

    it("updates cached modlist on modlist change action", async () => {
      async function* getModsGen() {
        yield { username: "newmod" };
      }

      const redisSet = vi.fn().mockResolvedValue("OK");
      const mockContext = {
        settings: {
          getAll: vi.fn().mockResolvedValue(baseSettings),
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
          get: vi.fn().mockResolvedValue("currentmod"),
        },
      } as unknown as TriggerContext;

      const event: ModAction = {
        action: "addmoderator",
        moderator: { name: "currentmod" },
        subreddit: { id: "t5_test", name: "testsub" },
      } as unknown as ModAction;

      await checkModAction(event, mockContext);
      expect(redisSet).toHaveBeenCalledWith("mods", "newmod", {
        expiration: expect.any(Date),
      });
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
      expect(modmailArgs.bodyMarkdown).toContain("u/shiruken");
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
      expect(modmailArgs.subject).toBe("Admin Action Detected");
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
        `**Comment:**\n> [ Removed by Reddit ] (Submitted ${expectedDate}, not cached)`
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
        `**Title:**\n> [ Removed by Reddit ] (Submitted 2024-05-12, exceeds 30-day cache)`
      );
      expect(modmailArgs.bodyMarkdown).toContain(
        `**Body:**\n> [ Removed by Reddit ]`
      );
      // Ensure the note is not duplicated on the body
      expect(modmailArgs.bodyMarkdown).not.toContain(
        `**Body:**\n> [ Removed by Reddit ] (Submitted 2024-05-12`
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
      expect(modmailArgs.bodyMarkdown).toContain(`**Title:**\n> Intact Post Title`);
      expect(modmailArgs.bodyMarkdown).toContain(
        `**Body:**\n> [ Removed by Reddit ] (Submitted ${expectedDate}, not cached)`
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
