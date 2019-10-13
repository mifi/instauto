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

  // Global limit that prevents follow or unfollows (total) to exceed this number over a sliding window of one hour:
  maxFollowsPerHour: 100,
  // Global limit that prevents follow or unfollows (total) to exceed this number over a sliding window of one day:
  maxFollowsPerDay: 700,
  // (NOTE setting the above parameters too high will cause temp ban/throttle)

  // Don't follow users that have a followers / following ratio less than this:
  followUserRatioMin: 0.2,
  // Don't follow users that have a followers / following ratio higher than this:
  followUserRatioMax: 4.0,
  // Don't follow users who have more followers than this:
  followUserMaxFollowers: null,
  // Don't follow users who have more people following them than this:
  followUserMaxFollowing: null,
  // Don't follow users who have less followers than this:
  followUserMinFollowers: null,
  // Don't follow users who have more people following them than this:
  followUserMinFollowing: null,

    dontUnfollowUntilTimeElapsed: 3 * 24 * 60 * 60 * 1000,

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

    // List of usernames that we should follow the followers of, can be celebrities etc.
    const usersToFollowFollowersOf = ['lostleblanc', 'sam_kolder'];

    // Now go through each of these and follow a certain amount of their followers
    for (const username of usersToFollowFollowersOf) {
      await instauto.followUserFollowers(username, { maxFollowsPerUser: 10 });
      await instauto.sleep(10 * 60 * 1000);
    }

    await instauto.sleep(10 * 60 * 1000);

    // This is used to unfollow people who have been automatically followed
    // but are not following us back, after some time has passed
    // (config parameter dontUnfollowUntilTimeElapsed)
    await instauto.unfollowNonMutualFollowers();

    await instauto.sleep(10 * 60 * 1000);

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
