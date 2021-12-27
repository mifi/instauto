'use strict';

const assert = require('assert');
const fs = require('fs-extra');
const { join } = require('path');
const UserAgent = require('user-agents');
const JSONDB = require('./db');

// NOTE duplicated inside puppeteer page
function shuffleArray(arrayIn) {
  const array = [...arrayIn];
  for (let i = array.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]]; // eslint-disable-line no-param-reassign
  }
  return array;
}

const botWorkShiftHours = 16;

const dayMs = 24 * 60 * 60 * 1000;
const hourMs = 60 * 60 * 1000;

const Instauto = async (db, browser, options) => {
  const {
    instagramBaseUrl = 'https://www.instagram.com',
    cookiesPath,

    username: myUsernameIn,
    password,
    enableCookies = true,

    randomizeUserAgent = true,
    userAgent,

    maxFollowsPerHour = 20,
    maxFollowsPerDay = 150,

    maxLikesPerDay = 50,

    followUserRatioMin = 0.2,
    followUserRatioMax = 4.0,
    followUserMaxFollowers = null,
    followUserMaxFollowing = null,
    followUserMinFollowers = null,
    followUserMinFollowing = null,

    dontUnfollowUntilTimeElapsed = 3 * 24 * 60 * 60 * 1000,

    excludeUsers = [],

    dryRun = true,

    screenshotOnError = false,
    screenshotsPath = '.',

    logger = console,
  } = options;

  let myUsername = myUsernameIn;

  assert(cookiesPath);
  assert(db);

  assert(maxFollowsPerHour * botWorkShiftHours >= maxFollowsPerDay, 'Max follows per hour too low compared to max follows per day');

  const {
    addPrevFollowedUser, getPrevFollowedUser, addPrevUnfollowedUser, getLikedPhotosLastTimeUnit,
    getPrevUnfollowedUsers, getPrevFollowedUsers, addLikedPhoto,
  } = db;

  const getNumLikesThisTimeUnit = (time) => getLikedPhotosLastTimeUnit(time).length;

  // State
  let page;
  let graphqlUserMissing = false;

  async function takeScreenshot() {
    if (!screenshotOnError) return;
    try {
      const fileName = `${new Date().getTime()}.jpg`;
      logger.log('Taking screenshot', fileName);
      await page.screenshot({ path: join(screenshotsPath, fileName), type: 'jpeg', quality: 30 });
    } catch (err) {
      logger.error('Failed to take screenshot', err);
    }
  }

  async function tryLoadCookies() {
    try {
      const cookies = JSON.parse(await fs.readFile(cookiesPath));
      for (const cookie of cookies) {
        if (cookie.name !== 'ig_lang') await page.setCookie(cookie);
      }
    } catch (err) {
      logger.error('No cookies found');
    }
  }

  async function trySaveCookies() {
    try {
      logger.log('Saving cookies');
      const cookies = await page.cookies();

      await fs.writeFile(cookiesPath, JSON.stringify(cookies, null, 2));
    } catch (err) {
      logger.error('Failed to save cookies');
    }
  }

  async function tryDeleteCookies() {
    try {
      logger.log('Deleting cookies');
      await fs.unlink(cookiesPath);
    } catch (err) {
      logger.error('No cookies to delete');
    }
  }

  const sleep = (ms, dev = 1) => {
    const msWithDev = ((Math.random() * dev) + 1) * ms;
    logger.log('Waiting', Math.round(msWithDev / 1000), 'sec');
    return new Promise(resolve => setTimeout(resolve, msWithDev));
  };

  async function onImageLiked({ username, href }) {
    await addLikedPhoto({ username, href, time: new Date().getTime() });
  }

  function getNumFollowedUsersThisTimeUnit(timeUnit) {
    const now = new Date().getTime();

    return getPrevFollowedUsers().filter(u => now - u.time < timeUnit).length
      + getPrevUnfollowedUsers().filter(u => !u.noActionTaken && now - u.time < timeUnit).length;
  }

  async function checkReachedFollowedUserDayLimit() {
    const reachedFollowedUserDayLimit = getNumFollowedUsersThisTimeUnit(dayMs) >= maxFollowsPerDay;
    if (reachedFollowedUserDayLimit) {
      logger.log('Have reached daily follow/unfollow limit, waiting 10 min');
      await sleep(10 * 60 * 1000);
    }
  }

  async function checkReachedFollowedUserHourLimit() {
    const hasReachedFollowedUserHourLimit = getNumFollowedUsersThisTimeUnit(hourMs) >= maxFollowsPerHour;
    if (hasReachedFollowedUserHourLimit) {
      logger.log('Have reached hourly follow rate limit, pausing 10 min');
      await sleep(10 * 60 * 1000);
    }
  }

  async function throttle() {
    await checkReachedFollowedUserDayLimit();
    await checkReachedFollowedUserHourLimit();
  }

  function hasReachedDailyLikesLimit() {
    return getNumLikesThisTimeUnit(dayMs) >= maxLikesPerDay;
  }

  function haveRecentlyFollowedUser(username) {
    const followedUserEntry = getPrevFollowedUser(username);
    if (!followedUserEntry) return false; // We did not previously follow this user, so don't know
    return new Date().getTime() - followedUserEntry.time < dontUnfollowUntilTimeElapsed;
  }

  async function safeGoto(url) {
    logger.log(`Goto ${url}`);
    const response = await page.goto(url);
    await sleep(1000);
    const status = response.status();
    if (status === 200) {
      return true;
    } else if (status === 404) {
      logger.log('User not found');
      return false;
    } else if (status === 429) {
      logger.error('Got 429 Too Many Requests, waiting...');
      await sleep(60 * 60 * 1000);
      throw new Error('Aborted operation due to too many requests'); // TODO retry instead
    }
    throw new Error(`Navigate to user returned status ${response.status()}`);
  }

  async function navigateToUser(username) {
    logger.log(`Navigating to user ${username}`);
    return safeGoto(`${instagramBaseUrl}/${encodeURIComponent(username)}`);
  }

  async function getPageJson() {
    return JSON.parse(await (await (await page.$('pre')).getProperty('textContent')).jsonValue());
  }

  async function navigateToUserAndGetData(username) {
    // https://github.com/mifi/SimpleInstaBot/issues/36
    if (graphqlUserMissing) {
      // https://stackoverflow.com/questions/37593025/instagram-api-get-the-userid
      // https://stackoverflow.com/questions/17373886/how-can-i-get-a-users-media-from-instagram-without-authenticating-as-a-user
      const found = await safeGoto(`${instagramBaseUrl}/${encodeURIComponent(username)}?__a=1`);
      if (!found) throw new Error('User not found');

      const json = await getPageJson();

      const { user } = json.graphql;

      await navigateToUser(username);
      return user;
    }

    await navigateToUser(username);

    // eslint-disable-next-line no-underscore-dangle
    const sharedData = await page.evaluate(() => window._sharedData);
    try {
      // eslint-disable-next-line prefer-destructuring
      return sharedData.entry_data.ProfilePage[0].graphql.user;

      // JSON.parse(Array.from(document.getElementsByTagName('script')).find(el => el.innerHTML.startsWith('window.__additionalDataLoaded(\'feed\',')).innerHTML.replace(/^window.__additionalDataLoaded\('feed',({.*})\);$/, '$1'));
      // JSON.parse(Array.from(document.getElementsByTagName('script')).find(el => el.innerHTML.startsWith('window._sharedData')).innerHTML.replace(/^window._sharedData ?= ?({.*});$/, '$1'));
      // Array.from(document.getElementsByTagName('a')).find(el => el.attributes?.href?.value.includes(`${username}/followers`)).innerText
    } catch (err) {
      logger.warn('Missing graphql in page, falling back to alternative method...');
      graphqlUserMissing = true; // Store as state so we don't have to do this every time from now on.
      return navigateToUserAndGetData(username); // Now try again with alternative method
    }
  }

  async function isActionBlocked() {
    if ((await page.$x('//*[contains(text(), "Action Blocked")]')).length > 0) return true;
    if ((await page.$x('//*[contains(text(), "Try Again Later")]')).length > 0) return true;
    return false;
  }

  async function checkActionBlocked() {
    if (await isActionBlocked()) {
      const hours = 3;
      logger.error(`Action Blocked, waiting ${hours} hours...`);
      await tryDeleteCookies();
      await sleep(hours * 60 * 60 * 1000);
      throw new Error('Aborted operation due to action blocked');
    }
  }

  async function findFollowButton() {
    const elementHandles = await page.$x("//header//button[text()='Follow']");
    if (elementHandles.length > 0) return elementHandles[0];

    const elementHandles2 = await page.$x("//header//button[text()='Follow Back']");
    if (elementHandles2.length > 0) return elementHandles2[0];

    return undefined;
  }

  async function findUnfollowButton() {
    const elementHandles = await page.$x("//header//button[text()='Following']");
    if (elementHandles.length > 0) return elementHandles[0];

    const elementHandles2 = await page.$x("//header//button[text()='Requested']");
    if (elementHandles2.length > 0) return elementHandles2[0];

    const elementHandles3 = await page.$x("//header//button[*//span[@aria-label='Following']]");
    if (elementHandles3.length > 0) return elementHandles3[0];

    return undefined;
  }

  async function findUnfollowConfirmButton() {
    const elementHandles = await page.$x("//button[text()='Unfollow']");
    return elementHandles[0];
  }

  // NOTE: assumes we are on this page
  async function followCurrentUser(username) {
    const elementHandle = await findFollowButton();

    if (!elementHandle) {
      if (await findUnfollowButton()) {
        logger.log('We are already following this user');
        await sleep(5000);
        return;
      }

      throw new Error('Follow button not found');
    }

    logger.log(`Following user ${username}`);

    if (!dryRun) {
      await elementHandle.click();
      await sleep(5000);

      await checkActionBlocked();

      const elementHandle2 = await findUnfollowButton();

      // Don't want to retry this user over and over in case there is an issue https://github.com/mifi/instauto/issues/33#issuecomment-723217177
      const entry = { username, time: new Date().getTime() };
      if (!elementHandle2) entry.failed = true;

      await addPrevFollowedUser(entry);

      if (!elementHandle2) {
        logger.log('Button did not change state - Sleeping');
        await sleep(60000);
        throw new Error('Button did not change state');
      }
    }

    await sleep(1000);
  }

  // See https://github.com/timgrossmann/InstaPy/pull/2345
  // https://github.com/timgrossmann/InstaPy/issues/2355
  async function unfollowCurrentUser(username) {
    logger.log(`Unfollowing user ${username}`);

    const res = { username, time: new Date().getTime() };

    const elementHandle = await findUnfollowButton();
    if (!elementHandle) {
      const elementHandle2 = await findFollowButton();
      if (elementHandle2) {
        logger.log('User has been unfollowed already');
        res.noActionTaken = true;
      } else {
        logger.log('Failed to find unfollow button');
        res.noActionTaken = true;
      }
    }

    if (!dryRun) {
      if (elementHandle) {
        await elementHandle.click();
        await sleep(1000);
        const confirmHandle = await findUnfollowConfirmButton();
        if (confirmHandle) await confirmHandle.click();

        await sleep(5000);

        await checkActionBlocked();

        const elementHandle2 = await findFollowButton();
        if (!elementHandle2) throw new Error('Unfollow button did not change state');
      }

      await addPrevUnfollowedUser(res);
    }

    await sleep(1000);

    return res;
  }

  const isLoggedIn = async () => (await page.$x('//*[@aria-label="Home"]')).length === 1;

  async function graphqlQueryUsers({ queryHash, getResponseProp, maxPages, shouldProceed: shouldProceedArg, graphqlVariables: graphqlVariablesIn }) {
    const graphqlUrl = `${instagramBaseUrl}/graphql/query/?query_hash=${queryHash}`;

    const graphqlVariables = {
      first: 50,
      ...graphqlVariablesIn,
    };

    const outUsers = [];

    let hasNextPage = true;
    let i = 0;

    const shouldProceed = () => {
      if (!hasNextPage) return false;
      const isBelowMaxPages = maxPages == null || i < maxPages;
      if (shouldProceedArg) return isBelowMaxPages && shouldProceedArg(outUsers);
      return isBelowMaxPages;
    };

    while (shouldProceed()) {
      const url = `${graphqlUrl}&variables=${JSON.stringify(graphqlVariables)}`;
      // logger.log(url);
      await page.goto(url);
      const json = await getPageJson();

      const subProp = getResponseProp(json);
      const pageInfo = subProp.page_info;
      const { edges } = subProp;

      edges.forEach(e => outUsers.push(e.node.username));

      graphqlVariables.after = pageInfo.end_cursor;
      hasNextPage = pageInfo.has_next_page;
      i += 1;

      if (shouldProceed()) {
        logger.log(`Has more pages (current ${i})`);
        // await sleep(300);
      }
    }

    return outUsers;
  }

  async function getFollowersOrFollowing({
    userId, getFollowers = false, maxPages, shouldProceed,
  }) {
    return graphqlQueryUsers({
      getResponseProp: (json) => json.data.user[getFollowers ? 'edge_followed_by' : 'edge_follow'],
      graphqlVariables: { id: userId },
      shouldProceed,
      maxPages,
      queryHash: getFollowers ? '37479f2b8209594dde7facb0d904896a' : '58712303d941c6855d4e888c5f0cd22f',
    });
  }

  async function getUsersWhoLikedContent({
    contentId, maxPages, shouldProceed,
  }) {
    return graphqlQueryUsers({
      getResponseProp: (json) => json.data.shortcode_media.edge_liked_by,
      graphqlVariables: {
        shortcode: contentId,
        include_reel: true,
      },
      shouldProceed,
      maxPages,
      queryHash: 'd5d763b1e2acf209d62d22d184488e57',
    });
  }

  /* eslint-disable no-undef */
  async function likeCurrentUserImagesPageCode({ dryRun: dryRunIn, likeImagesMin, likeImagesMax }) {
    const allImages = Array.from(document.getElementsByTagName('a')).filter(el => /instagram.com\/p\//.test(el.href));

    // eslint-disable-next-line no-shadow
    function shuffleArray(arrayIn) {
      const array = [...arrayIn];
      for (let i = array.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]]; // eslint-disable-line no-param-reassign
      }
      return array;
    }

    const imagesShuffled = shuffleArray(allImages);

    const numImagesToLike = Math.floor((Math.random() * ((likeImagesMax + 1) - likeImagesMin)) + likeImagesMin);

    instautoLog(`Liking ${numImagesToLike} image(s)`);

    const images = imagesShuffled.slice(0, numImagesToLike);

    if (images.length < 1) {
      instautoLog('No images to like');
      return;
    }

    for (const image of images) {
      image.click();

      await window.instautoSleep(3000);

      const dialog = document.querySelector('*[role=dialog]');

      if (!dialog) throw new Error('Dialog not found');

      const section = Array.from(dialog.querySelectorAll('section')).find(s => s.querySelectorAll('*[aria-label="Like"]')[0] && s.querySelectorAll('*[aria-label="Comment"]')[0]);

      if (!section) throw new Error('Like button section not found');

      const likeButtonChild = section.querySelectorAll('*[aria-label="Like"]')[0];

      if (!likeButtonChild) throw new Error('Like button not found (aria-label)');

      // eslint-disable-next-line no-inner-declarations
      function findClickableParent(el) {
        let elAt = el;
        while (elAt) {
          if (elAt.click) {
            return elAt;
          }
          elAt = elAt.parentElement;
        }
        return undefined;
      }

      const foundClickable = findClickableParent(likeButtonChild);

      if (!foundClickable) throw new Error('Like button not found');

      if (!dryRunIn) {
        foundClickable.click();

        window.instautoOnImageLiked(image.href);
      }

      await window.instautoSleep(3000);

      const closeButtonChild = document.querySelector('button [aria-label=Close]');

      if (!closeButtonChild) throw new Error('Close button not found (aria-label)');

      const closeButton = findClickableParent(closeButtonChild);

      if (!closeButton) throw new Error('Close button not found');

      closeButton.click();

      await window.instautoSleep(5000);
    }

    instautoLog('Done liking images');
  }
  /* eslint-enable no-undef */


  async function likeCurrentUserImages({ username, likeImagesMin, likeImagesMax } = {}) {
    if (!likeImagesMin || !likeImagesMax || likeImagesMax < likeImagesMin || likeImagesMin < 1) throw new Error('Invalid arguments');

    logger.log(`Liking ${likeImagesMin}-${likeImagesMax} user images`);
    try {
      await page.exposeFunction('instautoSleep', sleep);
      await page.exposeFunction('instautoLog', (...args) => console.log(...args));
      await page.exposeFunction('instautoOnImageLiked', (href) => onImageLiked({ username, href }));
    } catch (err) {
      // Ignore already exists error
    }

    await page.evaluate(likeCurrentUserImagesPageCode, { dryRun, likeImagesMin, likeImagesMax });
  }

  async function followUserFollowers(username, {
    maxFollowsPerUser = 5, skipPrivate = false, enableLikeImages, likeImagesMin, likeImagesMax,
  } = {}) {
    logger.log(`Following up to ${maxFollowsPerUser} followers of ${username}`);

    await throttle();

    let numFollowedForThisUser = 0;

    const userData = await navigateToUserAndGetData(username);

    // Check if we have more than enough users that are not previously followed
    const shouldProceed = usersSoFar => (
      usersSoFar.filter(u => !getPrevFollowedUser(u)).length < maxFollowsPerUser + 5 // 5 is just a margin
    );
    let followers = await getFollowersOrFollowing({
      userId: userData.id,
      getFollowers: true,
      shouldProceed,
    });

    logger.log('Followers', followers);

    // Filter again
    followers = followers.filter(f => !getPrevFollowedUser(f));

    for (const follower of followers) {
      try {
        if (numFollowedForThisUser >= maxFollowsPerUser) {
          logger.log('Have reached followed limit for this user, stopping');
          return;
        }

        const graphqlUser = await navigateToUserAndGetData(follower);

        const followedByCount = graphqlUser.edge_followed_by.count;
        const followsCount = graphqlUser.edge_follow.count;
        const isPrivate = graphqlUser.is_private;

        // logger.log('followedByCount:', followedByCount, 'followsCount:', followsCount);

        const ratio = followedByCount / (followsCount || 1);

        if (isPrivate && skipPrivate) {
          logger.log('User is private, skipping');
        } else if (
          (followUserMaxFollowers != null && followedByCount > followUserMaxFollowers) ||
          (followUserMaxFollowing != null && followsCount > followUserMaxFollowing) ||
          (followUserMinFollowers != null && followedByCount < followUserMinFollowers) ||
          (followUserMinFollowing != null && followsCount < followUserMinFollowing)
        ) {
          logger.log('User has too many or too few followers or following, skipping.', 'followedByCount:', followedByCount, 'followsCount:', followsCount);
        } else if (
          (followUserRatioMax != null && ratio > followUserRatioMax) ||
          (followUserRatioMin != null && ratio < followUserRatioMin)
        ) {
          logger.log('User has too many followers compared to follows or opposite, skipping');
        } else {
          await followCurrentUser(follower);
          numFollowedForThisUser += 1;

          await sleep(10000);

          if (!isPrivate && enableLikeImages && !hasReachedDailyLikesLimit()) {
            try {
              await likeCurrentUserImages({ username: follower, likeImagesMin, likeImagesMax });
            } catch (err) {
              logger.error(`Failed to follow user's images ${follower}`, err);
              await takeScreenshot();
            }
          }

          await sleep(20000);
          await throttle();
        }
      } catch (err) {
        logger.error(`Failed to process follower ${follower}`, err);
        await sleep(20000);
      }
    }
  }

  async function followUsersFollowers({ usersToFollowFollowersOf, maxFollowsTotal = 150, skipPrivate, enableLikeImages = false, likeImagesMin = 1, likeImagesMax = 2 }) {
    if (!maxFollowsTotal || maxFollowsTotal <= 2) {
      throw new Error(`Invalid parameter maxFollowsTotal ${maxFollowsTotal}`);
    }


    // If maxFollowsTotal turns out to be lower than the user list size, slice off the user list
    const usersToFollowFollowersOfSliced = shuffleArray(usersToFollowFollowersOf).slice(0, maxFollowsTotal);

    // Round up or we risk following none
    const maxFollowsPerUser = Math.floor(maxFollowsTotal / usersToFollowFollowersOfSliced.length) + 1;

    for (const username of usersToFollowFollowersOfSliced) {
      try {
        await followUserFollowers(username, { maxFollowsPerUser, skipPrivate, enableLikeImages, likeImagesMin, likeImagesMax });

        await sleep(10 * 60 * 1000);
        await throttle();
      } catch (err) {
        console.error('Failed to follow user followers, continuing', err);
        await takeScreenshot();
        await sleep(60 * 1000);
      }
    }
  }

  async function safelyUnfollowUserList(usersToUnfollow, limit) {
    logger.log(`Unfollowing ${usersToUnfollow.length} users`);

    let i = 0; // Number of people processed
    let j = 0; // Number of people actually unfollowed (button pressed)

    for (const username of usersToUnfollow) {
      try {
        const userFound = await navigateToUser(username);

        if (!userFound) {
          await addPrevUnfollowedUser({ username, time: new Date().getTime(), noActionTaken: true });
          await sleep(3000);
        } else {
          const { noActionTaken } = await unfollowCurrentUser(username);

          if (noActionTaken) {
            await sleep(3000);
          } else {
            await sleep(15000);
            j += 1;

            if (j % 10 === 0) {
              logger.log('Have unfollowed 10 users since last break. Taking a break');
              await sleep(10 * 60 * 1000, 0.1);
            }
          }
        }

        i += 1;
        logger.log(`Have now unfollowed ${i} users of total ${usersToUnfollow.length}`);

        if (limit && j >= limit) {
          logger.log(`Have unfollowed limit of ${limit}, stopping`);
          return;
        }

        await throttle();
      } catch (err) {
        logger.error('Failed to unfollow, continuing with next', err);
      }
    }
  }

  async function unfollowNonMutualFollowers({ limit } = {}) {
    logger.log('Unfollowing non-mutual followers...');
    const userData = await navigateToUserAndGetData(myUsername);

    const allFollowers = await getFollowersOrFollowing({
      userId: userData.id,
      getFollowers: true,
    });
    const allFollowing = await getFollowersOrFollowing({
      userId: userData.id,
      getFollowers: false,
    });
    // logger.log('allFollowers:', allFollowers, 'allFollowing:', allFollowing);

    const usersToUnfollow = allFollowing.filter((u) => {
      if (allFollowers.includes(u)) return false; // Follows us
      if (excludeUsers.includes(u)) return false; // User is excluded by exclude list
      if (haveRecentlyFollowedUser(u)) {
        logger.log(`Have recently followed user ${u}, skipping`);
        return false;
      }
      return true;
    });

    logger.log('usersToUnfollow', JSON.stringify(usersToUnfollow));

    await safelyUnfollowUserList(usersToUnfollow, limit);
  }

  async function unfollowAllUnknown({ limit } = {}) {
    logger.log('Unfollowing all except excludes and auto followed');
    const userData = await navigateToUserAndGetData(myUsername);

    const allFollowing = await getFollowersOrFollowing({
      userId: userData.id,
      getFollowers: false,
    });
    // logger.log('allFollowing', allFollowing);

    const usersToUnfollow = allFollowing.filter((u) => {
      if (getPrevFollowedUser(u)) return false;
      if (excludeUsers.includes(u)) return false; // User is excluded by exclude list
      return true;
    });

    logger.log('usersToUnfollow', JSON.stringify(usersToUnfollow));

    await safelyUnfollowUserList(usersToUnfollow, limit);
  }

  async function unfollowOldFollowed({ ageInDays, limit } = {}) {
    assert(ageInDays);

    logger.log(`Unfollowing currently followed users who were auto-followed more than ${ageInDays} days ago...`);

    const userData = await navigateToUserAndGetData(myUsername);

    const allFollowing = await getFollowersOrFollowing({
      userId: userData.id,
      getFollowers: false,
    });
    // logger.log('allFollowing', allFollowing);

    const usersToUnfollow = allFollowing.filter(u =>
      getPrevFollowedUser(u) &&
      !excludeUsers.includes(u) &&
      (new Date().getTime() - getPrevFollowedUser(u).time) / (1000 * 60 * 60 * 24) > ageInDays)
      .slice(0, limit);

    logger.log('usersToUnfollow', JSON.stringify(usersToUnfollow));

    await safelyUnfollowUserList(usersToUnfollow, limit);

    return usersToUnfollow.length;
  }

  async function listManuallyFollowedUsers() {
    const userData = await navigateToUserAndGetData(myUsername);

    const allFollowing = await getFollowersOrFollowing({
      userId: userData.id,
      getFollowers: false,
    });

    return allFollowing.filter(u =>
      !getPrevFollowedUser(u) && !excludeUsers.includes(u));
  }

  function getPage() {
    return page;
  }

  page = await browser.newPage();
  if (randomizeUserAgent) {
    const userAgentGenerated = new UserAgent({ deviceCategory: 'desktop' });
    await page.setUserAgent(userAgentGenerated.toString());
  }
  if (userAgent) await page.setUserAgent(userAgent);

  if (enableCookies) await tryLoadCookies();

  const goHome = async () => page.goto(`${instagramBaseUrl}/`);

  // https://github.com/mifi/SimpleInstaBot/issues/28
  async function setLang(short, long) {
    logger.log(`Setting language to ${long} (${short})`);

    // This doesn't seem to always work, hence why it's just a fallback now
    async function fallbackSetLang() {
      await goHome();
      await sleep(1000);

      await page.setCookie({
        name: 'ig_lang',
        value: short,
        path: '/',
      });
      await sleep(1000);
      await goHome();
      await sleep(3000);
    }

    try {
      await sleep(1000);
      await goHome();
      await sleep(3000);
      const elementHandles = await page.$x(`//select[//option[@value='${short}' and text()='${long}']]`);
      if (elementHandles.length < 1) throw new Error('Language selector not found');
      logger.log('Found language selector');

      // https://stackoverflow.com/questions/45864516/how-to-select-an-option-from-dropdown-select
      await page.evaluate((selectElem, short2) => {
        const optionElem = selectElem.querySelector(`option[value='${short2}']`);
        optionElem.selected = true;
        // eslint-disable-next-line no-undef
        const event = new Event('change', { bubbles: true });
        selectElem.dispatchEvent(event);
      }, elementHandles[0], short);
      logger.log('Selected language');

      await sleep(3000);
      await goHome();
      await sleep(1000);
    } catch (err) {
      logger.error('Failed to set language, trying fallback (cookie)', err);
      await fallbackSetLang();
    }
  }

  const setEnglishLang = async () => setLang('en', 'English');
  // const setEnglishLang = async () => setLang('de', 'Deutsch');

  async function tryPressButton(elementHandles, name) {
    try {
      if (elementHandles.length === 1) {
        logger.log(`Pressing button: ${name}`);
        elementHandles[0].click();
        await sleep(3000);
      }
    } catch (err) {
      logger.warn(`Failed to press button: ${name}`);
    }
  }

  await setEnglishLang();

  await tryPressButton(await page.$x('//button[contains(text(), "Accept")]'), 'Accept cookies dialog');

  if (!(await isLoggedIn())) {
    if (!myUsername || !password) {
      await tryDeleteCookies();
      throw new Error('No longer logged in. Deleting cookies and aborting. Need to provide username/password');
    }

    try {
      await page.click('a[href="/accounts/login/?source=auth_switcher"]');
      await sleep(1000);
    } catch (err) {
      logger.warn('Login page button not found, assuming we have login form');
    }

    // Mobile version https://github.com/mifi/SimpleInstaBot/issues/7
    await tryPressButton(await page.$x('//button[contains(text(), "Log In")]'), 'Login form button');

    await page.type('input[name="username"]', myUsername, { delay: 50 });
    await sleep(1000);
    await page.type('input[name="password"]', password, { delay: 50 });
    await sleep(1000);

    const loginButton = (await page.$x("//button[.//text() = 'Log In']"))[0];
    await loginButton.click();

    await sleep(6000);

    // Sometimes login button gets stuck with a spinner
    // https://github.com/mifi/SimpleInstaBot/issues/25
    if (!(await isLoggedIn())) {
      logger.log('Still not logged in, trying to reload loading page');
      await page.reload();
      await sleep(5000);
    }

    let warnedAboutLoginFail = false;
    while (!(await isLoggedIn())) {
      if (!warnedAboutLoginFail) logger.warn('WARNING: Login has not succeeded. This could be because of an incorrect username/password, or a "suspicious login attempt"-message. You need to manually complete the process, or if really logged in, click the Instagram logo in the top left to go to the Home page.');
      warnedAboutLoginFail = true;
      await sleep(5000);
    }

    // In case language gets reset after logging in
    await setEnglishLang();

    // Mobile version https://github.com/mifi/SimpleInstaBot/issues/7
    await tryPressButton(await page.$x('//button[contains(text(), "Save Info")]'), 'Login info dialog: Save Info');
    // May sometimes be "Save info" too? https://github.com/mifi/instauto/pull/70
    await tryPressButton(await page.$x('//button[contains(text(), "Save info")]'), 'Login info dialog: Save info');
  }

  await tryPressButton(await page.$x('//button[contains(text(), "Not Now")]'), 'Turn on Notifications dialog');

  await trySaveCookies();

  logger.log(`Have followed/unfollowed ${getNumFollowedUsersThisTimeUnit(hourMs)} in the last hour`);
  logger.log(`Have followed/unfollowed ${getNumFollowedUsersThisTimeUnit(dayMs)} in the last 24 hours`);
  logger.log(`Have liked ${getNumLikesThisTimeUnit(dayMs)} images in the last 24 hours`);

  try {
    // eslint-disable-next-line no-underscore-dangle
    const detectedUsername = await page.evaluate(() => window._sharedData.config.viewer.username);
    if (detectedUsername) myUsername = detectedUsername;
  } catch (err) {
    logger.error('Failed to detect username', err);
  }

  return {
    followUserFollowers,
    unfollowNonMutualFollowers,
    unfollowAllUnknown,
    unfollowOldFollowed,
    followCurrentUser,
    unfollowCurrentUser,
    sleep,
    listManuallyFollowedUsers,
    getFollowersOrFollowing,
    getUsersWhoLikedContent,
    safelyUnfollowUserList,
    getPage,
    followUsersFollowers,
  };
};

Instauto.JSONDB = JSONDB;

module.exports = Instauto;
