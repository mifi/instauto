'use strict';

const puppeteer = require('puppeteer'); // eslint-disable-line import/no-extraneous-dependencies

const Instauto = require('instauto'); // eslint-disable-line import/no-unresolved

const options = {
  cookiesPath: './cookies.json',
  // Will store a list of all users that have been followed before, to prevent future re-following.
  followedDbPath: './followed.json',
  // Will store all unfollowed users here
  unfollowedDbPath: './unfollowed.json',

  username: 'your-ig-username',
  password: 'your-ig-password',

  // Usernames that we should not touch, e.g. your friends and actual followings
  excludeUsers: [],

  // If true, will not do any actions (defaults to true)
  dryRun: false,
};

(async () => {
  let browser;

  try {
    browser = await puppeteer.launch({ headless: false });

    const instauto = await Instauto(browser, options);

    // This is used to unfollow people who have been automatically followed
    // but are not following us back, after some time has passed
    // (config parameter dontUnfollowUntilTimeElapsed)
    await instauto.unfollowNonMutualFollowers();

    // List of usernames that we should follow the followers of, can be celebrities etc.
    const usersToFollowFollowersOf = ['lostleblanc', 'sam_kolder'];

    // Now go through each of these and follow a certain amount of their followers
    for (const username of usersToFollowFollowersOf) {
      await instauto.followUserFollowers(username, { maxFollowsPerUser: 10 });
    }

    // Unfollow auto-followed users (regardless of whether they are following us)
    // after a certain amount of days
    await instauto.unfollowOldFollowed({ ageInDays: 60 });

    console.log('Done running');

    await instauto.sleep(30000);
  } catch (err) {
    console.error(err);
  } finally {
    console.log('Closing browser');
    if (browser) await browser.close();
  }
})();
