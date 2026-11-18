# Admin Tattler

Get notified when the Reddit Admins action content in your subreddit. Supports Modmail, Slack, and Discord.

[https://developers.reddit.com/apps/admin-tattler](https://developers.reddit.com/apps/admin-tattler)

## Features

* Minimal setup requiring **zero** knowledge about AutoModerator or coding
* Notifications via Modmail, Slack, or Discord
* Includes *original* post or comment text even after getting `[ Removed by Reddit ]`
* Flag actioned users with a Mod Note

## Installation Settings

![Screenshot of Installation Settings](https://github.com/user-attachments/assets/75cd88e6-318f-4e53-81c5-e03d2d870d58)

* [Slack: Sending messages using Incoming Webhooks](https://api.slack.com/messaging/webhooks)
* [Discord: Intro to Webhooks](https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks)

## Notifications

### Modmail

![Screenshot of Modmail Message](https://github.com/user-attachments/assets/dd8bbfde-6911-4e66-b4da-46e853977a0c)

### Slack

![Screenshot of Slack Message](https://github.com/user-attachments/assets/c8e3c599-8c64-413d-8150-713a8f0caa00)

### Discord

![Screenshot of Discord Message](https://github.com/user-attachments/assets/18fecde7-0f95-41c8-965f-56ae7fd01855)

## Moderation Actions

### Add Note

Mod Notes can (optionally) be added to users whose content was removed by the Reddit Admins

![Screenshot of Mod Note added by Admin Tattler](https://github.com/user-attachments/assets/f3e84f6b-1e8f-4a7e-b72c-1245b21c3f12)

## Limitations

* This app does not account for actions taken by Admin accounts that get *added* to a subreddit's mod team.
* Notifications will be sent when temporary bans expire if the moderator responsible for the original ban has since left the mod team. This app is only aware of *current* moderators and cannot account for the delayed `unbanuser` action that gets scheduled for temporary bans.

## Recent Updates (v0.8)

* Improved moderator list synchronization to prevent false positive alerts *(New in v0.8.2)*
* Improved formatting and readability for Modmail notification messages *(New in v0.8.2)*
* Better handling of actions caused by `[deleted]` moderator accounts
* Extended post and comment cache duration to 30 days
* Indicate original content creation date on cache misses
* Flag banned users in notification messages
* Option to flag actioned users with a Mod Note

*[View full release history on GitHub](https://github.com/shiruken/admin-tattler/releases)*

## Links

* [Source Code](https://github.com/shiruken/admin-tattler)
* [Terms and Conditions](https://github.com/shiruken/admin-tattler/blob/main/TERMS.md)
* [Privacy Policy](https://github.com/shiruken/admin-tattler/blob/main/PRIVACY.md)
