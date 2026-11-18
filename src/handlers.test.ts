import { describe, expect, it, vi, beforeEach } from "vitest";
import { cacheComment, cacheModerators, cachePost, checkModAction } from "./handlers.js";
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
      const redisExpire = vi.fn().mockResolvedValue(1);

      const mockContext = {
        redis: {
          set: redisSet,
          expire: redisExpire,
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
        })
      );
      expect(redisExpire).toHaveBeenCalledWith("t3_post123", 60 * 60 * 24 * 30);
    });

    it("does nothing when post or title is missing", async () => {
      const redisSet = vi.fn();
      const mockContext = {
        redis: { set: redisSet },
      } as unknown as TriggerContext;

      await cachePost({} as PostSubmit, mockContext);
      expect(redisSet).not.toHaveBeenCalled();
    });

    it("handles Redis write and expiration errors gracefully", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      const mockContext = {
        redis: {
          set: vi.fn().mockRejectedValue(new Error("Redis write failure")),
          expire: vi.fn().mockRejectedValue(new Error("Redis expire failure")),
        },
      } as unknown as TriggerContext;

      const event: PostSubmit = {
        post: {
          id: "t3_err1",
          title: "Error Post",
        },
      } as unknown as PostSubmit;

      await cachePost(event, mockContext);
      expect(consoleError).toHaveBeenCalledWith("Error writing t3_err1 to Redis", expect.any(Error));
      expect(consoleError).toHaveBeenCalledWith("Error setting expiration for t3_err1 in Redis", expect.any(Error));
      consoleError.mockRestore();
    });
  });

  describe("cacheComment", () => {
    it("caches comment body to Redis with expiration", async () => {
      const redisSet = vi.fn().mockResolvedValue("OK");
      const redisExpire = vi.fn().mockResolvedValue(1);

      const mockContext = {
        redis: {
          set: redisSet,
          expire: redisExpire,
        },
      } as unknown as TriggerContext;

      const event: CommentSubmit = {
        comment: {
          id: "t1_comm123",
          body: "This is a comment body",
        },
      } as unknown as CommentSubmit;

      await cacheComment(event, mockContext);

      expect(redisSet).toHaveBeenCalledWith("t1_comm123", "This is a comment body");
      expect(redisExpire).toHaveBeenCalledWith("t1_comm123", 60 * 60 * 24 * 30);
    });

    it("does nothing when comment or body is missing", async () => {
      const redisSet = vi.fn();
      const mockContext = {
        redis: { set: redisSet },
      } as unknown as TriggerContext;

      await cacheComment({} as CommentSubmit, mockContext);
      expect(redisSet).not.toHaveBeenCalled();
    });

    it("handles Redis write and expiration errors gracefully", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      const mockContext = {
        redis: {
          set: vi.fn().mockRejectedValue(new Error("Redis comment write error")),
          expire: vi.fn().mockRejectedValue(new Error("Redis comment expire error")),
        },
      } as unknown as TriggerContext;

      const event: CommentSubmit = {
        comment: {
          id: "t1_errcomm",
          body: "Failing comment body",
        },
      } as unknown as CommentSubmit;

      await cacheComment(event, mockContext);
      expect(consoleError).toHaveBeenCalledWith("Error writing t1_errcomm to Redis", expect.any(Error));
      expect(consoleError).toHaveBeenCalledWith("Error setting expiration for t1_errcomm in Redis", expect.any(Error));
      consoleError.mockRestore();
    });
  });

  describe("cacheModerators", () => {
    it("fetches moderator usernames and stores them in Redis", async () => {
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

      await cacheModerators(mockContext);

      expect(redisSet).toHaveBeenCalledWith("mods", "mod1,mod2");
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
      expect(consoleError).toHaveBeenCalledWith("Error writing moderators to Redis", expect.any(Error));
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

    it("throws if cached modlist is empty", async () => {
      const mockContext = {
        settings: {
          getAll: vi.fn().mockResolvedValue(baseSettings),
        },
        redis: {
          get: vi.fn().mockResolvedValue(null),
        },
      } as unknown as TriggerContext;

      const event: ModAction = {
        action: "removelink",
        moderator: { name: "admin_user" },
        subreddit: { id: "t5_test", name: "testsub" },
      } as unknown as ModAction;

      await expect(checkModAction(event, mockContext)).rejects.toThrow("Cached modlist is empty");
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
          get: vi.fn().mockResolvedValue("currentmod"),
        },
      } as unknown as TriggerContext;

      const event: ModAction = {
        action: "addmoderator",
        moderator: { name: "currentmod" },
        subreddit: { id: "t5_test", name: "testsub" },
      } as unknown as ModAction;

      await checkModAction(event, mockContext);
      expect(redisSet).toHaveBeenCalledWith("mods", "newmod");
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
        },
        reddit: {
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
        },
        reddit: {
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
        },
        reddit: {
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
                  body: "Original Post Body",
                  url: "https://example.com/original",
                })
              );
            return Promise.resolve(null);
          }),
        },
        reddit: {
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

      // Verify Discord webhook fetch called
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "https://discord.com/api/webhooks/123/xyz",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
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
        },
        reddit: {
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
      expect(modmailArgs.bodyMarkdown).toContain("Content Date:");

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
        },
        reddit: {
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
        },
        reddit: {
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
        "Error sending modmail about removelink by admin_tester",
        expect.any(Error)
      );
      expect(consoleError).toHaveBeenCalledWith(
        "Error sending Slack message about removelink by admin_tester",
        expect.any(Error)
      );
      expect(consoleError).toHaveBeenCalledWith("Error adding mod note to t3_p1", expect.any(Error));

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
        "Error sending Discord message about removelink by admin_tester",
        expect.any(Error)
      );
      consoleError.mockRestore();
    });
  });
});
