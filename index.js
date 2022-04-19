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

  let findUnfollowButton_selectorsList = [
    "//header//button[text()='Following']",
    "//header//button[text()='Requested']",
    "//header//button[*//span[@aria-label='Following']]",
    "//header//button[*//*[name()='svg'][@aria-label='Following']]"
  ]

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

  const sleep = (ms, deviation = 1) => {
    let msWithDev = ((Math.random() * deviation) + 1) * ms;
    if (dryRun) msWithDev = Math.min(3000, msWithDev); // for dryRun, no need to wait so long
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
    if (getNumFollowedUsersThisTimeUnit(dayMs) >= maxFollowsPerDay) {
      logger.log('Have reached daily follow/unfollow limit, waiting 10 min');
      await sleep(10 * 60 * 1000);
    }
  }

  async function checkReachedFollowedUserHourLimit() {
    if (getNumFollowedUsersThisTimeUnit(hourMs) >= maxFollowsPerHour) {
      logger.log('Have reached hourly follow rate limit, pausing 10 min');
      await sleep(10 * 60 * 1000);
    }
  }

  async function checkReachedLikedUserDayLimit() {
    if (getNumLikesThisTimeUnit(dayMs) >= maxLikesPerDay) {
      logger.log('Have reached daily like rate limit, pausing 10 min');
      await sleep(10 * 60 * 1000);
    }
  }

  async function throttle() {
    await checkReachedFollowedUserDayLimit();
    await checkReachedFollowedUserHourLimit();
    await checkReachedLikedUserDayLimit();
  }

  function haveRecentlyFollowedUser(username) {
    const followedUserEntry = getPrevFollowedUser(username);
    if (!followedUserEntry) return false; // We did not previously follow this user, so don't know
    return new Date().getTime() - followedUserEntry.time < dontUnfollowUntilTimeElapsed;
  }

  async function gotoWithRetry(url) {
    for (let attempt = 0; ; attempt += 1) {
      logger.log(`Goto ${url}`);
      const response = await page.goto(url);
      await sleep(1000);
      const status = response.status();

      // https://www.reddit.com/r/Instagram/comments/kwrt0s/error_560/
      // https://github.com/mifi/instauto/issues/60
      if (![560, 429].includes(status) || attempt > 3) return status;

      logger.info(`Got ${status} - Retrying request later...`);
      if (status === 429) logger.warn('429 Too Many Requests could mean that Instagram suspects you\'re using a bot. You could try to use the Instagram Mobile app from the same IP for a few days first');
      await sleep((attempt + 1) * 30 * 60 * 1000);
    }
  }

  async function safeGotoUser(url, checkPageForUsername) {
    const status = await gotoWithRetry(url);
    if (status === 200) {
      if (checkPageForUsername != null) {
        // some pages return 200 but nothing there (I think deleted accounts)
        // https://github.com/mifi/SimpleInstaBot/issues/48
        // example: https://www.instagram.com/victorialarson__/
        // so we check if the page has the user's name on it
        return page.evaluate((username) => window.find(username), checkPageForUsername);
      }
      return true;
    }
    if (status === 404) {
      logger.log('User not found');
      return false;
    }
    throw new Error(`Navigate to user failed with status ${status}`);
  }

  async function navigateToUser(username) {
    const url = `${instagramBaseUrl}/${encodeURIComponent(username)}`;
    if (page.url().replace(/\/$/, '') === url.replace(/\/$/, '')) return true; // optimization: already on URL? (ignore trailing slash)
    // logger.log('navigating from', page.url(), 'to', url);
    logger.log(`Navigating to user ${username}`);
    return safeGotoUser(url, username);
  }

  async function navigateToUserWithCheck(username) {
    if (!(await navigateToUser(username))) throw new Error('User not found');
  }

  async function getPageJson() {
    return JSON.parse(await (await (await page.$('pre')).getProperty('textContent')).jsonValue());
  }

  async function navigateToUserAndGetData(username) {
    // https://github.com/mifi/SimpleInstaBot/issues/36
    if (graphqlUserMissing) {
      // https://stackoverflow.com/questions/37593025/instagram-api-get-the-userid
      // https://stackoverflow.com/questions/17373886/how-can-i-get-a-users-media-from-instagram-without-authenticating-as-a-user
      const found = await safeGotoUser(`${instagramBaseUrl}/${encodeURIComponent(username)}?__a=1`);
      if (!found) throw new Error('User not found');

      const json = await getPageJson();

      const { user } = json.graphql;

      await navigateToUserWithCheck(username);
      return user;
    }

    await navigateToUserWithCheck(username);

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

  // How to test xpaths in the browser:
  // document.evaluate("your xpath", document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null ).singleNodeValue
  async function findButtonWithText(text) {
    // todo escape text?

    // button seems to look like this now:
    // <button class="..."><div class="...">Follow</div></button>
    // https://sqa.stackexchange.com/questions/36918/xpath-text-buy-now-is-working-but-not-containstext-buy-now
    // https://github.com/mifi/SimpleInstaBot/issues/106
    let elementHandles = await page.$x(`//header//button[contains(.,'${text}')]`);
    if (elementHandles.length > 0) return elementHandles[0];

    // old button:
    elementHandles = await page.$x(`//header//button[text()='${text}']`);
    if (elementHandles.length > 0) return elementHandles[0];

    return undefined;
  }

  async function findFollowButton() {
    let button = await findButtonWithText('Follow');
    if (button) return button;

    button = await findButtonWithText('Follow Back');
    if (button) return button;

    return undefined;
  }


  /*
    update this part for new "loop" that permit user to add themself their own page selector
    please note that the page selector list is stored in: findUnfollowButton_selectorsList
  */
  async function findUnfollowButton() {
    for(let i = 0; i < this.findUnfollowButton_selectorsList.length; i++) {
      let elementHandles = await page.$x(this.findUnfollowButton_selectorsList[i]);
      if (elementHandles.length > 0) return elementHandles[0]; 
    }
    return undefined;
  }

  // added this function for custom follow button
  async function addCustomUnfollowButtonSelector(newString){
    this.findUnfollowButton_selectorsList.push(newString);
  }

  async function findUnfollowConfirmButton() {
    const elementHandles = await page.$x("//button[text()='Unfollow']");
    return elementHandles[0];
  }

  async function followUser(username) {
    await navigateToUserWithCheck(username);
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
        logger.log('Button did not change state - Sleeping 1 min');
        await sleep(60000);
        throw new Error('Button did not change state');
      }
    }

    await sleep(1000);
  }

  // See https://github.com/timgrossmann/InstaPy/pull/2345
  // https://github.com/timgrossmann/InstaPy/issues/2355
  async function unfollowUser(username) {
    await navigateToUserWithCheck(username);
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

  async function* graphqlQueryUsers({ queryHash, getResponseProp, graphqlVariables: graphqlVariablesIn }) {
    const graphqlUrl = `${instagramBaseUrl}/graphql/query/?query_hash=${queryHash}`;

    const graphqlVariables = {
      first: 50,
      ...graphqlVariablesIn,
    };

    const outUsers = [];

    let hasNextPage = true;
    let i = 0;

    while (hasNextPage) {
      const url = `${graphqlUrl}&variables=${JSON.stringify(graphqlVariables)}`;
      // logger.log(url);
      await page.goto(url);
      const json = await getPageJson();

      const subProp = getResponseProp(json);
      const pageInfo = subProp.page_info;
      const { edges } = subProp;

      const ret = [];
      edges.forEach(e => ret.push(e.node.username));

      graphqlVariables.after = pageInfo.end_cursor;
      hasNextPage = pageInfo.has_next_page;
      i += 1;

      if (hasNextPage) {
        logger.log(`Has more pages (current ${i})`);
        // await sleep(300);
      }

      yield ret;
    }

    return outUsers;
  }

  function getFollowersOrFollowingGenerator({ userId, getFollowers = false }) {
    return graphqlQueryUsers({
      getResponseProp: (json) => json.data.user[getFollowers ? 'edge_followed_by' : 'edge_follow'],
      graphqlVariables: { id: userId },
      queryHash: getFollowers ? '37479f2b8209594dde7facb0d904896a' : '58712303d941c6855d4e888c5f0cd22f',
    });
  }

  async function getFollowersOrFollowing({ userId, getFollowers = false }) {
    let users = [];
    for await (const usersBatch of getFollowersOrFollowingGenerator({ userId, getFollowers })) {
      users = [...users, ...usersBatch];
    }
    return users;
  }

  function getUsersWhoLikedContent({ contentId }) {
    return graphqlQueryUsers({
      getResponseProp: (json) => json.data.shortcode_media.edge_liked_by,
      graphqlVariables: {
        shortcode: contentId,
        include_reel: true,
      },
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


  async function likeUserImages({ username, likeImagesMin, likeImagesMax } = {}) {
    if (!likeImagesMin || !likeImagesMax || likeImagesMax < likeImagesMin || likeImagesMin < 1) throw new Error('Invalid arguments');

    await navigateToUserWithCheck(username);

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

  async function followUserRespectingRestrictions({ username, skipPrivate = false }) {
    if (getPrevFollowedUser(username)) {
      logger.log('Skipping already followed user', username);
      return false;
    }
    const graphqlUser = await navigateToUserAndGetData(username);

    const followedByCount = graphqlUser.edge_followed_by.count;
    const followsCount = graphqlUser.edge_follow.count;
    const isPrivate = graphqlUser.is_private;

    // logger.log('followedByCount:', followedByCount, 'followsCount:', followsCount);

    const ratio = followedByCount / (followsCount || 1);

    if (isPrivate && skipPrivate) {
      logger.log('User is private, skipping');
      return false;
    }
    if (
      (followUserMaxFollowers != null && followedByCount > followUserMaxFollowers) ||
      (followUserMaxFollowing != null && followsCount > followUserMaxFollowing) ||
      (followUserMinFollowers != null && followedByCount < followUserMinFollowers) ||
      (followUserMinFollowing != null && followsCount < followUserMinFollowing)
    ) {
      logger.log('User has too many or too few followers or following, skipping.', 'followedByCount:', followedByCount, 'followsCount:', followsCount);
      return false;
    }
    if (
      (followUserRatioMax != null && ratio > followUserRatioMax) ||
      (followUserRatioMin != null && ratio < followUserRatioMin)
    ) {
      logger.log('User has too many followers compared to follows or opposite, skipping');
      return false;
    }

    await followUser(username);

    await sleep(30000);
    await throttle();

    return true;
  }

  async function processUserFollowers(username, {
    maxFollowsPerUser = 5, skipPrivate = false, enableLikeImages, likeImagesMin, likeImagesMax,
  } = {}) {
    const enableFollow = maxFollowsPerUser > 0;

    if (enableFollow) logger.log(`Following up to ${maxFollowsPerUser} followers of ${username}`);
    if (enableLikeImages) logger.log(`Liking images of up to ${likeImagesMax} followers of ${username}`);

    await throttle();

    let numFollowedForThisUser = 0;

    const userData = await navigateToUserAndGetData(username);

    for await (const followersBatch of getFollowersOrFollowingGenerator({ userId: userData.id, getFollowers: true })) {
      logger.log('User followers batch', followersBatch);

      for (const follower of followersBatch) {
        await throttle();

        try {
          if (enableFollow && numFollowedForThisUser >= maxFollowsPerUser) {
            logger.log('Have reached followed limit for this user, stopping');
            return;
          }

          if (enableFollow) {
            if (await followUserRespectingRestrictions({ username: follower, skipPrivate })) {
              numFollowedForThisUser += 1;
            }
          }

          if (enableLikeImages) {
            // Note: throws error if user isPrivate
            await likeUserImages({ username: follower, likeImagesMin, likeImagesMax });
          }
        } catch (err) {
          logger.error(`Failed to process follower ${follower}`, err);
          await takeScreenshot();
          await sleep(20000);
        }
      }
    }
  }

  async function processUsersFollowers({ usersToFollowFollowersOf, maxFollowsTotal = 150, skipPrivate, enableFollow = true, enableLikeImages = false, likeImagesMin = 1, likeImagesMax = 2 }) {
    // If maxFollowsTotal turns out to be lower than the user list size, slice off the user list
    const usersToFollowFollowersOfSliced = shuffleArray(usersToFollowFollowersOf).slice(0, maxFollowsTotal);

    const maxFollowsPerUser = enableFollow && usersToFollowFollowersOfSliced.length > 0 ? Math.floor(maxFollowsTotal / usersToFollowFollowersOfSliced.length) : 0;

    if (maxFollowsPerUser === 0 && (!enableLikeImages || likeImagesMin < 1 || likeImagesMax < 1)) {
      logger.warn('Nothing to follow or like');
      return;
    }

    for (const username of usersToFollowFollowersOfSliced) {
      try {
        await processUserFollowers(username, { maxFollowsPerUser, skipPrivate, enableLikeImages, likeImagesMin, likeImagesMax });

        await sleep(10 * 60 * 1000);
        await throttle();
      } catch (err) {
        logger.error('Failed to process user followers, continuing', username, err);
        await takeScreenshot();
        await sleep(60 * 1000);
      }
    }
  }

  async function safelyUnfollowUserList(usersToUnfollow, limit, condition = () => true) {
    logger.log('Unfollowing users, up to limit', limit);

    let i = 0; // Number of people processed
    let j = 0; // Number of people actually unfollowed (button pressed)

    for await (const listOrUsername of usersToUnfollow) {
      // backward compatible:
      const list = Array.isArray(listOrUsername) ? listOrUsername : [listOrUsername];

      for (const username of list) {
        if (await condition(username)) {
          try {
            const userFound = await navigateToUser(username);

            if (!userFound) {
              await addPrevUnfollowedUser({ username, time: new Date().getTime(), noActionTaken: true });
              await sleep(3000);
            } else {
              const { noActionTaken } = await unfollowUser(username);

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
            logger.log(`Have now unfollowed (or tried to unfollow) ${i} users`);

            if (limit && j >= limit) {
              logger.log(`Have unfollowed limit of ${limit}, stopping`);
              return j;
            }

            await throttle();
          } catch (err) {
            logger.error('Failed to unfollow, continuing with next', err);
          }
        }
      }
    }

    return j;
  }

  async function safelyFollowUserList({ users, skipPrivate, limit }) {
    logger.log('Following users, up to limit', limit);

    for (const username of users) {
      await throttle();

      try {
        await followUserRespectingRestrictions({ username, skipPrivate });
      } catch (err) {
        logger.error(`Failed to follow user ${username}, continuing`, err);
        await takeScreenshot();
        await sleep(20000);
      }
    }
  }

  function getPage() {
    return page;
  }

  page = await browser.newPage();

  // https://github.com/mifi/SimpleInstaBot/issues/118#issuecomment-1067883091
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en' });

  if (randomizeUserAgent) {
    const userAgentGenerated = new UserAgent({ deviceCategory: 'desktop' });
    await page.setUserAgent(userAgentGenerated.toString());
  }
  if (userAgent) await page.setUserAgent(userAgent);

  if (enableCookies) await tryLoadCookies();

  const goHome = async () => page.goto(`${instagramBaseUrl}/?hl=en`);

  // https://github.com/mifi/SimpleInstaBot/issues/28
  async function setLang(short, long, assumeLoggedIn = false) {
    logger.log(`Setting language to ${long} (${short})`);

    try {
      await sleep(1000);

      // when logged in, we need to go to account in order to be able to check/set language
      // (need to see the footer)
      if (assumeLoggedIn) {
        await page.goto(`${instagramBaseUrl}/accounts/edit/`);
      } else {
        await goHome();
      }
      await sleep(3000);
      const elementHandles = await page.$x(`//select[//option[@value='${short}' and text()='${long}']]`);
      if (elementHandles.length < 1) throw new Error('Language selector not found');
      logger.log('Found language selector');

      // https://stackoverflow.com/questions/45864516/how-to-select-an-option-from-dropdown-select
      const alreadyEnglish = await page.evaluate((selectElem, short2) => {
        const optionElem = selectElem.querySelector(`option[value='${short2}']`);
        if (optionElem.selected) return true; // already selected?
        optionElem.selected = true;
        // eslint-disable-next-line no-undef
        const event = new Event('change', { bubbles: true });
        selectElem.dispatchEvent(event);
        return false;
      }, elementHandles[0], short);

      if (alreadyEnglish) {
        logger.log('Already English language');
        if (!assumeLoggedIn) {
          await goHome(); // because we were on the settings page
          await sleep(1000);
        }
        return;
      }

      logger.log('Selected language');
      await sleep(3000);
      await goHome();
      await sleep(1000);
    } catch (err) {
      logger.error('Failed to set language, trying fallback (cookie)', err);
      // This doesn't seem to always work, hence why it's just a fallback now
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
  }

  const setEnglishLang = async (assumeLoggedIn) => setLang('en', 'English', assumeLoggedIn);
  // const setEnglishLang = async (assumeLoggedIn) => setLang('de', 'Deutsch', assumeLoggedIn);

  async function tryPressButton(elementHandles, name, sleepMs = 3000) {
    try {
      if (elementHandles.length === 1) {
        logger.log(`Pressing button: ${name}`);
        elementHandles[0].click();
        await sleep(sleepMs);
      }
    } catch (err) {
      logger.warn(`Failed to press button: ${name}`);
    }
  }

  await setEnglishLang(false);

  await tryPressButton(await page.$x('//button[contains(text(), "Accept")]'), 'Accept cookies dialog');
  await tryPressButton(await page.$x('//button[contains(text(), "Only allow essential cookies")]'), 'Accept cookies dialog 2 button 1', 10000);
  await tryPressButton(await page.$x('//button[contains(text(), "Allow essential and optional cookies")]'), 'Accept cookies dialog 2 button 2', 10000);

  if (!(await isLoggedIn())) {
    if (!myUsername || !password) {
      await tryDeleteCookies();
      throw new Error('No longer logged in. Deleting cookies and aborting. Need to provide username/password');
    }

    try {
      await page.click('a[href="/accounts/login/?source=auth_switcher"]');
      await sleep(1000);
    } catch (err) {
      logger.info('No login page button, assuming we are on login form');
    }

    // Mobile version https://github.com/mifi/SimpleInstaBot/issues/7
    await tryPressButton(await page.$x('//button[contains(text(), "Log In")]'), 'Login form button');

    await page.type('input[name="username"]', myUsername, { delay: 50 });
    await sleep(1000);
    await page.type('input[name="password"]', password, { delay: 50 });
    await sleep(1000);

    for (;;) {
      const loginButton = (await page.$x("//button[.//text() = 'Log In']"))[0];
      if (loginButton) {
        await loginButton.click();
        break;
      }
      logger.warn('Login button not found. Maybe you can help me click it? And also report an issue on github with a screenshot of what you\'re seeing :)');
      await sleep(6000);
    }

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
    // https://github.com/mifi/SimpleInstaBot/issues/118
    await setEnglishLang(true);

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

  if (!myUsername) {
    throw new Error('Don\'t know what\'s my username');
  }

  const myUserData = await navigateToUserAndGetData(myUsername);
  const myUserId = myUserData.id;

  // --- END OF INITIALIZATION

  async function doesUserFollowMe(username) {
    try {
      logger.info('Checking if user', username, 'follows us');
      const userData = await navigateToUserAndGetData(username);
      const userId = userData.id;

      const elementHandles = await page.$x("//a[contains(.,' following')][contains(@href,'/following')]");
      if (elementHandles.length === 0) throw new Error('Following button not found');

      const [foundResponse] = await Promise.all([
        page.waitForResponse((response) => {
          const request = response.request();
          return request.method() === 'GET' && new RegExp(`instagram.com/api/v1/friendships/${userId}/following/`).test(request.url());
        }),
        elementHandles[0].click(),
        // page.waitForNavigation({ waitUntil: 'networkidle0' }),
      ]);

      const { users } = JSON.parse(await foundResponse.text());
      if (users.length < 2) throw new Error('Unable to find user follows list');
      // console.log(users, myUserId);
      return users.some((user) => String(user.pk) === String(myUserId) || user.username === myUsername); // If they follow us, we will show at the top of the list
    } catch (err) {
      logger.error('Failed to check if user follows us', err);
      return undefined;
    }
  }

  async function unfollowNonMutualFollowers({ limit } = {}) {
    logger.log(`Unfollowing non-mutual followers (limit ${limit})...`);

    /* const allFollowers = await getFollowersOrFollowing({
      userId: myUserId,
      getFollowers: true,
    }); */
    const allFollowingGenerator = getFollowersOrFollowingGenerator({
      userId: myUserId,
      getFollowers: false,
    });

    async function condition(username) {
      // if (allFollowers.includes(u)) return false; // Follows us
      if (excludeUsers.includes(username)) return false; // User is excluded by exclude list
      if (haveRecentlyFollowedUser(username)) {
        logger.log(`Have recently followed user ${username}, skipping`);
        return false;
      }

      const followsMe = await doesUserFollowMe(username);
      logger.info('User follows us?', followsMe);
      return followsMe === false;
    }

    await safelyUnfollowUserList(allFollowingGenerator, limit, condition);
  }

  async function unfollowAllUnknown({ limit } = {}) {
    logger.log('Unfollowing all except excludes and auto followed');

    const unfollowUsersGenerator = getFollowersOrFollowingGenerator({
      userId: myUserId,
      getFollowers: false,
    });

    function condition(username) {
      if (getPrevFollowedUser(username)) return false; // we followed this user, so it's not unknown
      if (excludeUsers.includes(username)) return false; // User is excluded by exclude list
      return true;
    }

    await safelyUnfollowUserList(unfollowUsersGenerator, limit, condition);
  }

  async function unfollowOldFollowed({ ageInDays, limit } = {}) {
    assert(ageInDays);

    logger.log(`Unfollowing currently followed users who were auto-followed more than ${ageInDays} days ago (limit ${limit})...`);

    const followingUsersGenerator = getFollowersOrFollowingGenerator({
      userId: myUserId,
      getFollowers: false,
    });

    function condition(username) {
      return getPrevFollowedUser(username) &&
        !excludeUsers.includes(username) &&
        (new Date().getTime() - getPrevFollowedUser(username).time) / (1000 * 60 * 60 * 24) > ageInDays;
    }

    return safelyUnfollowUserList(followingUsersGenerator, limit, condition);
  }

  async function listManuallyFollowedUsers() {
    const allFollowing = await getFollowersOrFollowing({
      userId: myUserId,
      getFollowers: false,
    });

    return allFollowing.filter(u =>
      !getPrevFollowedUser(u) && !excludeUsers.includes(u));
  }

  return {
    followUserFollowers: processUserFollowers,
    unfollowNonMutualFollowers,
    unfollowAllUnknown,
    unfollowOldFollowed,
    followUser,
    unfollowUser,
    likeUserImages,
    sleep,
    listManuallyFollowedUsers,
    getFollowersOrFollowing,
    getUsersWhoLikedContent,
    safelyUnfollowUserList,
    safelyFollowUserList,
    getPage,
    followUsersFollowers: processUsersFollowers,
    doesUserFollowMe,
  };
};

Instauto.JSONDB = JSONDB;

module.exports = Instauto;
