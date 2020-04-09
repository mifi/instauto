'use strict';

const assert = require('assert');
const fs = require('fs-extra');
const keyBy = require('lodash/keyBy');
const UserAgent = require('user-agents');

// NOTE duplicated in page
function shuffleArray(arrayIn) {
  const array = [...arrayIn];
  for (let i = array.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]]; // eslint-disable-line no-param-reassign
  }
  return array;
}

const dayMs = 24 * 60 * 60 * 1000;
const hourMs = 60 * 60 * 1000;

module.exports = async (browser, options) => {
  const {
    instagramBaseUrl = 'https://www.instagram.com',
    cookiesPath,
    followedDbPath,
    unfollowedDbPath,
    likesDbPath,

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

    logger = console,
  } = options;

  let myUsername = myUsernameIn;

  assert(cookiesPath);
  assert(followedDbPath);
  assert(unfollowedDbPath);
  assert(likesDbPath);

  // State
  let page;

  // DB state
  let prevFollowedUsers = {};
  let prevUnfollowedUsers = {};
  let prevLikes = [];


  async function tryLoadDb() {
    try {
      prevFollowedUsers = keyBy(JSON.parse(await fs.readFile(followedDbPath)), 'username');
    } catch (err) {
      logger.warn('No followed database found');
    }
    try {
      prevUnfollowedUsers = keyBy(JSON.parse(await fs.readFile(unfollowedDbPath)), 'username');
    } catch (err) {
      logger.warn('No unfollowed database found');
    }
    try {
      prevLikes = JSON.parse(await fs.readFile(likesDbPath));
    } catch (err) {
      logger.warn('No likes database found');
    }
  }

  async function trySaveDb() {
    try {
      await fs.writeFile(followedDbPath, JSON.stringify(Object.values(prevFollowedUsers)));
      await fs.writeFile(unfollowedDbPath, JSON.stringify(Object.values(prevUnfollowedUsers)));
      await fs.writeFile(likesDbPath, JSON.stringify(prevLikes));
    } catch (err) {
      logger.error('Failed to save database');
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
    logger.log('Sleeping', msWithDev / 1000, 'sec');
    return new Promise(resolve => setTimeout(resolve, msWithDev));
  };

  async function addFollowedUser(user) {
    prevFollowedUsers[user.username] = user;
    await trySaveDb();
  }

  async function addUnfollowedUser(user) {
    prevUnfollowedUsers[user.username] = user;
    await trySaveDb();
  }

  async function onImageLiked() {
    prevLikes.push({ time: new Date().getTime() });
    await trySaveDb();
  }

  function getNumFollowedUsersThisTimeUnit(timeUnit) {
    const now = new Date().getTime();

    return Object.values(prevFollowedUsers).filter(u => now - u.time < timeUnit).length
      + Object.values(prevUnfollowedUsers).filter(u =>
        !u.noActionTaken && now - u.time < timeUnit).length;
  }

  function hasReachedFollowedUserDayLimit() {
    return getNumFollowedUsersThisTimeUnit(dayMs) >= maxFollowsPerDay;
  }

  function hasReachedFollowedUserHourLimit() {
    return getNumFollowedUsersThisTimeUnit(hourMs) >= maxFollowsPerHour;
  }

  function getNumLikesThisTimeUnit(timeUnit) {
    const now = new Date().getTime();
    return prevLikes.filter(u => now - u.time < timeUnit).length
  }

  function hasReachedDailyLikesLimit() {
    return getNumLikesThisTimeUnit(dayMs) >= maxLikesPerDay;
  }

  function haveRecentlyFollowedUser(username) {
    const followedUserEntry = prevFollowedUsers[username];
    if (!followedUserEntry) return false; // We did not previously follow this user, so don't know
    return new Date().getTime() - followedUserEntry.time < dontUnfollowUntilTimeElapsed;
  }

  async function navigateToUser(username) {
    logger.log(`Navigating to user ${username}`);
    const response = await page.goto(`${instagramBaseUrl}/${encodeURIComponent(username)}`);
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

  async function isActionBlocked() {
    const elementHandles = await page.$x('//*[contains(text(), "Action Blocked")]');
    return elementHandles.length > 0;
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
    const elementHandles = await page.$x(`//header//button[text()='Follow']`);
    if (elementHandles.length > 0) return elementHandles[0];

    const elementHandles2 = await page.$x(`//header//button[text()='Follow Back']`);
    if (elementHandles2.length > 0) return elementHandles2[0];
  }

  async function findUnfollowButton() {
    const elementHandles = await page.$x(`//header//button[text()='Following']`);
    if (elementHandles.length > 0) return elementHandles[0];

    const elementHandles2 = await page.$x(`//header//button[text()='Requested']`);
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
    if (!elementHandle) throw new Error('Follow button not found');

    logger.log(`Following user ${username}`);

    if (!dryRun) {
      await elementHandle.click();
      await sleep(5000);

      await checkActionBlocked();

      const elementHandle2 = await findUnfollowButton();
      if (!elementHandle2) logger.log('Failed to follow user (button did not change state)');

      await addFollowedUser({ username, time: new Date().getTime() });
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

      await addUnfollowedUser(res);
    }

    await sleep(1000);

    return res;
  }

  const isLoggedIn = async () => (await page.$x('//nav')).length === 2;

  async function getPageJson() {
    return JSON.parse(await (await (await page.$('pre')).getProperty('textContent')).jsonValue());
  }

  async function getCurrentUser() {
    return page.evaluate(() => {
      return window._sharedData.entry_data.ProfilePage[0].graphql.user; // eslint-disable-line no-undef,no-underscore-dangle,max-len
      // return JSON.parse(Array.from(document.getElementsByTagName('script')).find(el => el.innerHTML.startsWith('window.__additionalDataLoaded(\'feed\',')).innerHTML.replace(/^window.__additionalDataLoaded\('feed',({.*})\);$/, '$1'));
      // return JSON.parse(Array.from(document.getElementsByTagName('script')).find(el => el.innerHTML.startsWith('window._sharedData')).innerHTML.replace(/^window._sharedData ?= ?({.*});$/, '$1'));
      // Array.from(document.getElementsByTagName('a')).find(el => el.attributes?.href?.value.includes(`${username}/followers`)).innerText
    });
  }

  async function getFollowersOrFollowing({
    userId, getFollowers = false, maxPages, shouldProceed: shouldProceedArg,
  }) {
    const graphqlUrl = `${instagramBaseUrl}/graphql/query`;
    const followersUrl = `${graphqlUrl}/?query_hash=37479f2b8209594dde7facb0d904896a`;
    const followingUrl = `${graphqlUrl}/?query_hash=58712303d941c6855d4e888c5f0cd22f`;

    const graphqlVariables = {
      id: userId,
      first: 50,
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
      const url = `${getFollowers ? followersUrl : followingUrl}&variables=${JSON.stringify(graphqlVariables)}`;
      // logger.log(url);
      await page.goto(url);
      const json = await getPageJson();

      const subPropName = getFollowers ? 'edge_followed_by' : 'edge_follow';

      const pageInfo = json.data.user[subPropName].page_info;
      const { edges } = json.data.user[subPropName];

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

  async function likeCurrentUserImagesPageCode({ likeImagesMin, likeImagesMax }) {
    const allImages = Array.from(document.getElementsByTagName('a')).filter(el => /instagram.com\/p\//.test(el.href));

    function shuffleArray(arrayIn) {
      const array = [...arrayIn];
      for (let i = array.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]]; // eslint-disable-line no-param-reassign
      }
      return array;
    }

    const imagesShuffled = shuffleArray(allImages);

    const numImagesToLike = Math.floor(Math.random() * (likeImagesMax + 1 - likeImagesMin) + likeImagesMin);
    
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
    
      function findClickableParent(el) {
        let elAt = el;
        while (elAt) {
          if (elAt.click) {
            return elAt;
          }
          elAt = elAt.parentElement;
        }
      }
    
      const foundClickable = findClickableParent(likeButtonChild);
    
      if (!foundClickable) throw new Error('Like button not found');
    
      foundClickable.click();

      window.instautoOnImageLiked();
    
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

  async function likeCurrentUserImages({ likeImagesMin, likeImagesMax } = {}) {
    if (!likeImagesMin || !likeImagesMax || likeImagesMax < likeImagesMin || likeImagesMin < 1) throw new Error('Invalid arguments');

    try {
      await page.exposeFunction('instautoSleep', sleep);
      await page.exposeFunction('instautoLog', (...args) => console.log(...args));
      await page.exposeFunction('instautoOnImageLiked', onImageLiked);
    } catch (err) {
      // Ignore already exists error
    }

    await page.evaluate(likeCurrentUserImagesPageCode, { likeImagesMin, likeImagesMax });
  }

  async function followUserFollowers(username, {
    maxFollowsPerUser = 5, skipPrivate = false, enableLikeImages, likeImagesMin, likeImagesMax,
  } = {}) {
    logger.log(`Following up to ${maxFollowsPerUser} followers of ${username}`);

    if (hasReachedFollowedUserDayLimit()) {
      logger.log('Have reached daily follow rate limit, stopping');
      return;
    }
    if (hasReachedFollowedUserHourLimit()) {
      logger.log('Have reached hourly follow rate limit, sleeping 10 min');
      await sleep(10 * 60 * 1000);
    }

    let numFollowedForThisUser = 0;

    await navigateToUser(username);

    // Check if we have more than enough users that are not previously followed
    const shouldProceed = usersSoFar => (
      usersSoFar.filter(u => !prevFollowedUsers[u]).length < maxFollowsPerUser + 5 // 5 is just a margin
    );
    const userData = await getCurrentUser();
    let followers = await getFollowersOrFollowing({
      userId: userData.id,
      getFollowers: true,
      shouldProceed,
    });

    logger.log('Followers', followers);

    // Filter again
    followers = followers.filter(f => !prevFollowedUsers[f]);

    for (const follower of followers) {
      try {
        if (numFollowedForThisUser >= maxFollowsPerUser) {
          logger.log('Have reached followed limit for this user, stopping');
          return;
        }

        await navigateToUser(follower);

        const graphqlUser = await getCurrentUser();
        const followedByCount = graphqlUser.edge_followed_by.count;
        const followsCount = graphqlUser.edge_follow.count;
        const isPrivate = graphqlUser.is_private;

        logger.log('followedByCount:', followedByCount, 'followsCount:', followsCount);

        const ratio = followedByCount / (followsCount || 1);

        if (isPrivate && skipPrivate) {
          logger.log('User is private, skipping');
        } else if (
          (followUserMaxFollowers != null && followedByCount > followUserMaxFollowers) ||
          (followUserMaxFollowing != null && followsCount > followUserMaxFollowing) ||
          (followUserMinFollowers != null && followedByCount < followUserMinFollowers) ||
          (followUserMinFollowing != null && followsCount < followUserMinFollowing)
        ) {
          logger.log('User has too many or too few followers or following, skipping');
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
              await likeCurrentUserImages({ likeImagesMin, likeImagesMax });
            } catch (err) {
              logger.error(`Failed to follow user's images ${follower}`, err);
            }
          }
  
          await sleep(20000);
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

    // If max is set to lower than the user list, slice off
    const usersToFollowFollowersOfSliced = shuffleArray(usersToFollowFollowersOf).slice(0, maxFollowsTotal);

    // Round up or we risk following none
    const maxFollowsPerUser = Math.floor(maxFollowsTotal / usersToFollowFollowersOfSliced.length) + 1;

    for (const username of usersToFollowFollowersOfSliced) {
      try {
        await followUserFollowers(username, { maxFollowsPerUser, skipPrivate, enableLikeImages, likeImagesMin, likeImagesMax });

        if (hasReachedFollowedUserDayLimit()) {
          logger.log('Have reached daily follow rate limit, exiting loop');
          return;
        }

        await sleep(10 * 60 * 1000);
      } catch (err) {
        console.error('Failed to follow user followers, continuing', err);
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
          await addUnfollowedUser({ username, time: new Date().getTime(), noActionTaken: true });
          await sleep(3000);
        } else {
          const { noActionTaken } = await unfollowCurrentUser(username);

          if (noActionTaken) {
            await sleep(3000);
          } else {
            await sleep(15000);
            j += 1;

            if (j % 10 === 0) {
              logger.log('Have unfollowed 10 users since last sleep. Sleeping');
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

        if (hasReachedFollowedUserDayLimit()) {
          logger.log('Have reached daily unfollow rate limit, stopping');
          return;
        }
        if (hasReachedFollowedUserHourLimit()) {
          logger.log('Have reached hourly unfollow rate limit, sleeping 10 min');
          await sleep(10 * 60 * 1000);
        }
      } catch (err) {
        logger.error('Failed to unfollow, continuing with next', err);
      }
    }
  }

  async function unfollowNonMutualFollowers({ limit } = {}) {
    logger.log('Unfollowing non-mutual followers...');
    await navigateToUser(myUsername);
    const userData = await getCurrentUser();

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
    await navigateToUser(myUsername);
    const userData = await getCurrentUser();

    const allFollowing = await getFollowersOrFollowing({
      userId: userData.id,
      getFollowers: false,
    });
    // logger.log('allFollowing', allFollowing);

    const usersToUnfollow = allFollowing.filter((u) => {
      if (prevFollowedUsers[u]) return false;
      if (excludeUsers.includes(u)) return false; // User is excluded by exclude list
      return true;
    });

    logger.log('usersToUnfollow', JSON.stringify(usersToUnfollow));

    await safelyUnfollowUserList(usersToUnfollow, limit);
  }

  async function unfollowOldFollowed({ ageInDays, limit } = {}) {
    assert(ageInDays);

    logger.log(`Unfollowing currently followed users who were auto-followed more than ${ageInDays} days ago...`);

    await navigateToUser(myUsername);
    // await page.goto(`${instagramBaseUrl}/${myUsername}`);
    const userData = await getCurrentUser();

    const allFollowing = await getFollowersOrFollowing({
      userId: userData.id,
      getFollowers: false,
    });
    // logger.log('allFollowing', allFollowing);

    const usersToUnfollow = allFollowing.filter(u =>
      prevFollowedUsers[u] &&
      !excludeUsers.includes(u) &&
      (new Date().getTime() - prevFollowedUsers[u].time) / (1000 * 60 * 60 * 24) > ageInDays)
      .slice(0, limit);

    logger.log('usersToUnfollow', JSON.stringify(usersToUnfollow));

    await safelyUnfollowUserList(usersToUnfollow, limit);

    return usersToUnfollow.length;
  }

  async function listManuallyFollowedUsers() {
    await navigateToUser(myUsername);
    const userData = await getCurrentUser();

    const allFollowing = await getFollowersOrFollowing({
      userId: userData.id,
      getFollowers: false,
    });

    return allFollowing.filter(u =>
      !prevFollowedUsers[u] && !excludeUsers.includes(u));
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

  await tryLoadDb();

  // logger.log('prevFollowedUsers', prevFollowedUsers);

  // Not sure if we can set cookies before having gone to a page
  await page.goto(`${instagramBaseUrl}/`);
  await sleep(1000);
  logger.log('Setting language to english');
  await page.setCookie({
    name: 'ig_lang',
    value: 'en',
    path: '/',
  });
  await sleep(1000);
  await page.goto(`${instagramBaseUrl}/`);
  await sleep(3000);

  if (!(await isLoggedIn())) {
    if (!myUsername || !password) {
      await tryDeleteCookies();
      throw new Error('No longer logged in. Deleting cookies and aborting. Need to provide username/password');
    }

    try {
      await page.click('a[href="/accounts/login/?source=auth_switcher"]');
      await sleep(1000);
    } catch (err) {
      logger.error('Login page button not found, assuming we have login form');
    }

    // Mobile version https://github.com/mifi/SimpleInstaBot/issues/7
    try {
      const elementHandles = await page.$x('//button[contains(text(), "Log In")]');
      if (elementHandles.length === 1) {
        elementHandles[0].click();
        await sleep(1000);
      }
    } catch (err) {
      logger.error('Failed to click login form button');
    }

    await page.type('input[name="username"]', myUsername, { delay: 50 });
    await sleep(1000);
    await page.type('input[name="password"]', password, { delay: 50 });
    await sleep(1000);

    const loginButton = (await page.$x("//button[.//text() = 'Log In']"))[0];
    await loginButton.click();
  }

  await sleep(3000);

  // Mobile version https://github.com/mifi/SimpleInstaBot/issues/7
  async function checkSaveLoginInfo() {
    const elementHandles = await page.$x('//button[contains(text(), "Save Info")]');
    if (elementHandles.length === 1) {
      elementHandles[0].click();
      await sleep(5000);
    }
  }

  await checkSaveLoginInfo();

  let warnedAboutLoginFail = false;
  while (!(await isLoggedIn())) {
    if (!warnedAboutLoginFail) logger.warn('WARNING: Login has not succeeded. This could be because of an incorrect username/password, or a "suspicious login attempt"-message. You need to manually complete the process.');
    warnedAboutLoginFail = true;
    await sleep(5000);
  }

  await checkSaveLoginInfo();

  await trySaveCookies();

  logger.log(`Have followed/unfollowed ${getNumFollowedUsersThisTimeUnit(hourMs)} in the last hour`);
  logger.log(`Have followed/unfollowed ${getNumFollowedUsersThisTimeUnit(dayMs)} in the last 24 hours`);
  logger.log(`Have liked ${getNumLikesThisTimeUnit(dayMs)} images in the last 24 hours`);

  try {
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
    safelyUnfollowUserList,
    getPage,
    followUsersFollowers,
    likeCurrentUserImages,
  };
};
