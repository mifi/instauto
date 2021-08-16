const puppeteer = require("puppeteer"); // eslint-disable-line import/no-extraneous-dependencies

// const Instauto2 = require("instauto"); // eslint-disable-line import/no-unresolved

const Instauto = require("./index");

const options = {
  cookiesPath: "./cookies.json",

  username: "your ig username",
  password: "***",

  // Global limit that prevents follow or unfollows (total) to exceed this number over a sliding window of one hour:
  maxFollowsPerHour: 20,
  // Global limit that prevents follow or unfollows (total) to exceed this number over a sliding window of one day:
  maxFollowsPerDay: 150,
  // (NOTE setting the above parameters too high will cause temp ban/throttle)

  maxLikesPerDay: 50,

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
    browser = await puppeteer.launch({ headless: true });

    // Create a database where state will be loaded/saved to
    const instautoDb = await Instauto.JSONDB({
     followedDbPath: './followed.json',
      // Will store all unfollowed users here
      unfollowedDbPath: './unfollowed.json',
      // Will store all likes here
      likedPhotosDbPath: './liked-photos.json',
      // Will store all follow request here
      currentFollowRequestDbPath: "./current-follow-request.json",
    });

    const instauto = await Instauto(instautoDb, browser, options);

    await instauto.getCurrentFollowRequests();

    await instauto.sleep(10 * 60 * 1000);

    await instauto;

    await instauto.sleep(30000);
  } catch (err) {
    console.error(err);
  } finally {
    console.log("Closing browser");
    if (browser) await browser.close();
  }
})();
