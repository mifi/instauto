'use strict';

const assert = require('assert');
const fs = require('fs-extra');
const keyBy = require('lodash/keyBy');

module.exports = async (browser, options) => {
  const {
    instagramBaseUrl = 'https://www.instagram.com',
    cookiesPath,
    followedDbPath,
    unfollowedDbPath,

    username: myUsername,
    password,

    maxFollowsPerHour = 100,
    maxFollowsPerDay = 700,

    followUserRatioMin = 0.2,
    followUserRatioMax = 4.0,

    dontUnfollowUntilTimeElapsed = 3 * 24 * 60 * 60 * 1000,

    excludeUsers = [],

    dryRun = true,
  } = options;

  assert(myUsername);
  assert(password);

  assert(cookiesPath);
  assert(followedDbPath);
  assert(unfollowedDbPath);

  // State
  let page;
  let followedUsers = [];
  let unfollowedUsers = {};


  async function tryLoadDb() {
    try {
      followedUsers = JSON.parse(await fs.readFile(followedDbPath));
    } catch (err) {
      console.error('Failed to load followed db');
    }
    try {
      unfollowedUsers = keyBy(JSON.parse(await fs.readFile(unfollowedDbPath)), 'username');
    } catch (err) {
      console.error('Failed to load unfollowed db');
    }
  }

  async function trySaveDb() {
    try {
      await fs.writeFile(followedDbPath, JSON.stringify(followedUsers));
      await fs.writeFile(unfollowedDbPath, JSON.stringify(Object.values(unfollowedUsers)));
    } catch (err) {
      console.error('Failed to save db');
    }
  }


  async function tryLoadCookies() {
    try {
      const cookies = JSON.parse(await fs.readFile(cookiesPath));
      for (const cookie of cookies) {
        await page.setCookie(cookie);
      }
    } catch (err) {
      console.error('Failed to load cookies');
    }
  }

  async function trySaveCookies() {
    try {
      const cookies = await page.cookies();

      await fs.writeFile(cookiesPath, JSON.stringify(cookies, null, 2));
    } catch (err) {
      console.error('Failed to save cookies');
    }
  }

  const sleep = (ms, dev = 1) =>
    new Promise(resolve => setTimeout(resolve, ((Math.random() * dev) + 1) * ms));

  async function addFollowedUser(user) {
    followedUsers.push(user);
    await trySaveDb();
  }

  async function addUnfollowedUser(user) {
    unfollowedUsers[user.username] = user;
    await trySaveDb();
  }

  function getNumFollowedUsersThisTimeUnit(timeUnit) {
    const now = new Date().getTime();

    return followedUsers.filter(u => now - u.time < timeUnit).length
      + Object.values(unfollowedUsers).filter(u => now - u.time < timeUnit).length;
  }

  function hasReachedFollowedUserRateLimit() {
    return getNumFollowedUsersThisTimeUnit(60 * 60 * 1000) >= maxFollowsPerHour
    || getNumFollowedUsersThisTimeUnit(24 * 60 * 60 * 1000) >= maxFollowsPerDay;
  }

  function haveRecentlyFollowedUser(username) {
    const followedUserEntry = followedUsers.find(u => u.username === username);
    if (!followedUserEntry) return false; // We did not previously follow this user, so don't know
    return new Date().getTime() - followedUserEntry.time < dontUnfollowUntilTimeElapsed;
  }

  async function navigateToUser(username) {
    console.log(`Navigating to user ${username}`);
    const response = await page.goto(`${instagramBaseUrl}/${encodeURIComponent(username)}`);
    await sleep(1000);
    const okStatus = response.status === '200';
    if (!okStatus) console.log(`Navigate to user returned status ${response.status}`);
    return okStatus;
  }

  async function findFollowUnfollowButton({ follow = false }) {
    const elementHandles = await page.$x(`//button[text()='${follow ? 'Follow' : 'Following'}']`);
    if (elementHandles.length !== 1) {
      return undefined;
    }
    return elementHandles[0];
  }

  async function findUnfollowConfirmButton() {
    const elementHandles = await page.$x("//button[text()='Unfollow']");
    return elementHandles[0];
  }

  // NOTE: assumes we are on this page
  async function followCurrentUser(username) {
    const elementHandle = await findFollowUnfollowButton({ follow: true });
    if (!elementHandle) throw new Error('Follow button not found');

    console.log(`Following user ${username}`);

    if (!dryRun) {
      await elementHandle.click();
      await sleep(5000);

      const elementHandle2 = await findFollowUnfollowButton({ follow: false });
      if (!elementHandle2) throw new Error('Failed to follow user (not in state followed)');

      await addFollowedUser({ username, time: new Date().getTime() });
    }

    await sleep(1000);
  }

  // See https://github.com/timgrossmann/InstaPy/pull/2345
  // https://github.com/timgrossmann/InstaPy/issues/2355
  async function unfollowCurrentUser(username) {
    console.log(`Unfollowing user ${username}`);

    const elementHandle = await findFollowUnfollowButton({ follow: false });
    if (!elementHandle) {
      const elementHandle2 = await findFollowUnfollowButton({ follow: true });
      if (elementHandle2) {
        console.log('User has been unfollowed already');
      } else {
        throw new Error('Failed to find follow/unfollow button');
      }
    } else if (!dryRun) {
      await elementHandle.click();
      await sleep(1000);
      const confirmHandle = await findUnfollowConfirmButton();
      if (confirmHandle) confirmHandle.click();

      await sleep(5000);

      await findFollowUnfollowButton({ follow: true }); // Check that it has changed value
      await addUnfollowedUser({ username, time: new Date().getTime() });
    }

    await sleep(1000);
  }

  const isLoggedIn = async () => (await page.$x('//nav')).length === 2;

  async function getPageJson() {
    return JSON.parse(await (await (await page.$('pre')).getProperty('textContent')).jsonValue());
  }

  async function getCurrentUser() {
    return page.evaluate(() => // eslint-disable-line no-loop-func
      window._sharedData.entry_data.ProfilePage[0].graphql.user); // eslint-disable-line no-undef,no-underscore-dangle,max-len
  }

  async function getFollowersOrFollowing({ userId, getFollowers = false, maxPages }) {
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

    const shouldProceed = () => hasNextPage && (maxPages == null || i < maxPages);

    while (shouldProceed()) {
      const url = `${getFollowers ? followersUrl : followingUrl}&variables=${JSON.stringify(graphqlVariables)}`;
      // console.log(url);
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
        console.log(`Has more pages (current ${i})`);
        // await sleep(300);
      }
    }

    return outUsers;
  }

  async function followUserFollowers(username, {
    maxFollowsPerUser = 5, skipPrivate = false,
  } = {}) {
    if (hasReachedFollowedUserRateLimit()) {
      console.log('Have reached follow/unfollow rate limit, stopping');
      return;
    }

    console.log(`Following the followers of ${username}`);

    let numFollowedForThisUser = 0;

    await navigateToUser(username);

    const userData = await getCurrentUser();
    let followers = await getFollowersOrFollowing({
      userId: userData.id,
      getFollowers: true,
      maxPages: 1,
    });

    console.log('Followers', followers);

    followers = followers.filter(f => !followedUsers.find(fu => fu.username === f));

    for (const follower of followers) {
      try {
        if (numFollowedForThisUser >= maxFollowsPerUser) {
          console.log('Have reached followed limit for this user, stopping');
          return;
        }

        await navigateToUser(follower);

        const graphqlUser = await getCurrentUser();
        const followedByCount = graphqlUser.edge_followed_by.count;
        const followsCount = graphqlUser.edge_follow.count;
        const isPrivate = graphqlUser.is_private;

        console.log({ followedByCount, followsCount });

        const ratio = followedByCount / (followsCount || 1);

        if (isPrivate && skipPrivate) {
          console.log('User is private, skipping');
        } else if (ratio > followUserRatioMax || ratio < followUserRatioMin) {
          console.log('User has too many followers compared to follows or opposite, skipping');
        } else {
          await followCurrentUser(follower);
          numFollowedForThisUser += 1;
          await sleep(20000);
        }
      } catch (err) {
        console.error(`Failed to process follower ${follower}`, err);
        await sleep(20000);
      }
    }
  }

  async function safelyUnfollowUserList(usersToUnfollow, limit) {
    console.log(`Unfollowing ${usersToUnfollow.length} users`);

    let i = 0;
    for (const username of usersToUnfollow) {
      if (hasReachedFollowedUserRateLimit()) {
        console.log('Have reached follow/unfollow rate limit, stopping');
        return;
      }

      if (i !== 0 && i % 10 === 0) {
        console.log('Have unfollowed 10 users since last sleep. Sleeping');
        await sleep(10 * 60 * 1000, 0.1);
      }

      if (await navigateToUser(username)) {
        await unfollowCurrentUser(username);
      } else {
        // User not found
        await addUnfollowedUser({ username, time: new Date().getTime() });
      }

      i += 1;
      console.log(`Have now unfollowed ${i} users of total ${usersToUnfollow.length}`);
      await sleep(15000);

      if (limit && i >= limit) {
        console.log(`Have unfollowed limit of ${limit}, stopping`);
        return;
      }
    }
  }

  async function unfollowNonMutualFollowers({ limit } = {}) {
    console.log('Unfollowing non-mutual followers...');
    await page.goto(`${instagramBaseUrl}/${myUsername}`);
    const userData = await getCurrentUser();

    const allFollowers = await getFollowersOrFollowing({
      userId: userData.id,
      getFollowers: true,
    });
    console.log({ allFollowers });
    const allFollowing = await getFollowersOrFollowing({
      userId: userData.id,
      getFollowers: false,
    });
    console.log({ allFollowing });

    const usersToUnfollow = allFollowing.filter((u) => {
      if (allFollowers.includes(u)) return false; // Follows us
      if (excludeUsers.includes(u)) return false; // User is excluded by exclude list
      if (haveRecentlyFollowedUser(u)) {
        console.log(`Have recently followed user ${u}, skipping`);
        return false;
      }
      return true;
    });

    console.log({ usersToUnfollow });

    await safelyUnfollowUserList(usersToUnfollow, limit);
  }

  async function unfollowOldFollowed({ ageInDays, limit } = {}) {
    assert(ageInDays);

    console.log(`Unfollowing auto-followed users more than ${ageInDays} days ago...`);

    const usersToUnfollow = followedUsers.filter(fu =>
      !unfollowedUsers[fu.username] &&
      (new Date().getTime() - fu.time) / (1000 * 60 * 60 * 24) > ageInDays)
      .slice(0, limit)
      .map(u => u.username);

    console.log({ usersToUnfollow });

    await safelyUnfollowUserList(usersToUnfollow, limit);
  }

  page = await browser.newPage();
  await page.setUserAgent('Chrome');

  await tryLoadCookies();
  await tryLoadDb();

  console.log({ followedUsers });

  await page.goto(`${instagramBaseUrl}/`);
  await sleep(1000);

  if (!(await isLoggedIn())) {
    await page.click('a[href="/accounts/login/"]');
    await sleep(1000);
    await page.type('input[name="username"]', myUsername, { delay: 50 });
    await sleep(1000);
    await page.type('input[name="password"]', password, { delay: 50 });
    await sleep(1000);
    const loginButton = (await page.$x("//button[contains(text(), 'Log in')]"))[0];
    await loginButton.click();
  }

  await sleep(3000);

  assert(await isLoggedIn());

  await trySaveCookies();

  console.log(`Have followed/unfollowed ${getNumFollowedUsersThisTimeUnit(60 * 60 * 1000)} in the last hour`);
  console.log(`Have followed/unfollowed ${getNumFollowedUsersThisTimeUnit(24 * 60 * 60 * 1000)} in the last 24 hours`);

  return {
    followUserFollowers,
    unfollowNonMutualFollowers,
    unfollowOldFollowed,
    sleep,
  };
};
