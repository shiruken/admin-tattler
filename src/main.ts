import { Devvit } from '@devvit/public-api';
import { settings } from './settings.js';
import { checkModAction, cachePost, cacheComment, cacheModerators } from './handlers.js';

Devvit.configure({
  redditAPI: true,
  http: true,
  redis: true
});

Devvit.addSettings(settings);

// Watch for Admin actions
Devvit.addTrigger({
  event: 'ModAction',
  onEvent: checkModAction,
});

// Cache text of new and edited posts
Devvit.addTrigger({
  events: ['PostSubmit', 'PostUpdate'],
  onEvent: cachePost,
});

// Cache text of new and edited comments
Devvit.addTrigger({
  events: ['CommentSubmit', 'CommentUpdate'],
  onEvent: cacheComment,
});

// Cache modlist during app install or upgrade
Devvit.addTrigger({
  events: ['AppInstall', 'AppUpgrade'],
  onEvent: async (event, context) => {
    console.log(`Updating cached modlist on ${event.type}`);
    await cacheModerators(context);
  },
});

export default Devvit;
