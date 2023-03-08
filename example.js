'use strict';

const puppeteer = require('puppeteer'); // eslint-disable-line import/no-extraneous-dependencies

const Instauto = require('.');
// or:
// const Instauto = require('instauto'); // eslint-disable-line import/no-unresolved

// Optional: Custom logger with timestamps
const log = (fn, ...args) => console[fn](new Date().toISOString(), ...args);
const logger = Object.fromEntries(['log', 'info', 'debug', 'error', 'trace', 'warn'].map((fn) => [fn, (...args) => log(fn, ...args)]));

const options = {
  cookiesPath: './cookies.json',

  username: process.env.INSTAGRAM_USERNAME,
  password: process.env.INSTAGRAM_PASSWORD,

  // Global limit that prevents follow or unfollows (total) to exceed this number over a sliding window of one hour:
  maxFollowsPerHour: process.env.MAX_FOLLOWS_PER_HOUR != null ? parseInt(process.env.MAX_FOLLOWS_PER_HOUR, 10) : 20,
  // Global limit that prevents follow or unfollows (total) to exceed this number over a sliding window of one day:
  maxFollowsPerDay: process.env.MAX_FOLLOWS_PER_DAY != null ? parseInt(process.env.MAX_FOLLOWS_PER_DAY, 10) : 150,
  // (NOTE setting the above parameters too high will cause temp ban/throttle)

  maxLikesPerDay: process.env.MAX_LIKES_PER_DAY != null ? parseInt(process.env.MAX_LIKES_PER_DAY, 10) : 30,

  // Don't follow users that have a followers / following ratio less than this:
  followUserRatioMin: process.env.FOLLOW_USER_RATIO_MIN != null ? parseFloat(process.env.FOLLOW_USER_RATIO_MIN) : 0.2,
  // Don't follow users that have a followers / following ratio higher than this:
  followUserRatioMax: process.env.FOLLOW_USER_RATIO_MAX != null ? parseFloat(process.env.FOLLOW_USER_RATIO_MAX) : 4.0,
  // Don't follow users who have more followers than this:
  followUserMaxFollowers: null,
  // Don't follow users who have more people following them than this:
  followUserMaxFollowing: null,
  // Don't follow users who have less followers than this:
  followUserMinFollowers: null,
  // Don't follow users who have more people following them than this:
  followUserMinFollowing: null,

  // Custom logic filter for user follow
  shouldFollowUser: null,
  /* Example to skip bussiness accounts
  shouldFollowUser: function (data) {
    console.log('isBusinessAccount:', data.isBusinessAccount);
    return !data.isBusinessAccount;
  }, */
  /* Example to skip accounts with 'crypto' & 'bitcoin' in their bio or username
  shouldFollowUser: function (data) {
    console.log('username:', data.username, 'biography:', data.biography);
    var keywords = ['crypto', 'bitcoin'];
    if (keywords.find(v => data.username.includes(v)) !== undefined || keywords.find(v => data.biography.includes(v)) !== undefined) {
      return false;
    }
    return true;
  }, */

  // Custom logic filter for liking media
  shouldLikeMedia: null,

  // NOTE: The dontUnfollowUntilTimeElapsed option is ONLY for the unfollowNonMutualFollowers function
  // This specifies the time during which the bot should not touch users that it has previously followed (in milliseconds)
  // After this time has passed, it will be able to unfollow them again.
  // TODO should remove this option from here
  dontUnfollowUntilTimeElapsed: 3 * 24 * 60 * 60 * 1000,

  // Usernames that we should not touch, e.g. your friends and actual followings
  excludeUsers: [],

  // If true, will not do any actions (defaults to true)
  dryRun: false,

  logger,
};

(async () => {
  let browser;

  try {
    browser = await puppeteer.launch({
      // set headless: false first if you need to debug and see how it works
      headless: true,

      args: [
        // Needed for docker
        '--no-sandbox',
        '--disable-setuid-sandbox',

        // If you need to proxy: (see also https://www.chromium.org/developers/design-documents/network-settings)
        // '--proxy-server=127.0.0.1:9876',
      ],
    });

    // Create a database where state will be loaded/saved to
    const instautoDb = await Instauto.JSONDB({
      // Will store a list of all users that have been followed before, to prevent future re-following.
      followedDbPath: './followed.json',
      // Will store all unfollowed users here
      unfollowedDbPath: './unfollowed.json',
      // Will store all likes here
      likedPhotosDbPath: './liked-photos.json',
    });

    const instauto = await Instauto(instautoDb, browser, options);

    // This can be used to unfollow people:
    // Will unfollow auto-followed AND manually followed accounts who are not following us back, after some time has passed
    // The time is specified by config option dontUnfollowUntilTimeElapsed
    // await instauto.unfollowNonMutualFollowers();
    // await instauto.sleep(10 * 60 * 1000);

    // Unfollow previously auto-followed users (regardless of whether or not they are following us back)
    // after a certain amount of days (2 weeks)
    // Leave room to do following after this too (unfollow 2/3 of maxFollowsPerDay)
    const unfollowedCount = await instauto.unfollowOldFollowed({ ageInDays: 14, limit: options.maxFollowsPerDay * (2 / 3) });

    if (unfollowedCount > 0) await instauto.sleep(10 * 60 * 1000);

    // List of usernames that we should follow the followers of, can be celebrities etc.
    const usersToFollowFollowersOf = process.env.USERS_TO_FOLLOW != null ? process.env.USERS_TO_FOLLOW.split(',') : [];

    // Now go through each of these and follow a certain amount of their followers
    await instauto.followUsersFollowers({
      usersToFollowFollowersOf,
      maxFollowsTotal: options.maxFollowsPerDay - unfollowedCount,
      skipPrivate: true,
      enableLikeImages: true,
      likeImagesMax: 3,
    });

    await instauto.sleep(10 * 60 * 1000);

    console.log('Done running');

    await instauto.sleep(30000);
  } catch (err) {
    console.error(err);
  } finally {
    console.log('Closing browser');
    if (browser) await browser.close();
  }
})();
