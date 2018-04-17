'use strict';

const assert = require('assert');
const fs = require('fs-extra');

module.exports = async (browser, options) => {
  const {
    instagramBaseUrl = 'https://www.instagram.com',
    cookiesPath,
    followedDbPath,

    username: myUsername,
    password,

    maxFollowsPerTimeUnit = 100,
    maxFollowsPerTimeSpan = 24 * 60 * 60 * 1000,
    followUserRatioMin = 0.2,
    followUserRatioMax = 4.0,

    dontUnfollowUntilTimespan = 3 * 24 * 60 * 60 * 1000,

    excludeUsers = [],

    dryRun = true,
  } = options;

  assert(myUsername);
  assert(password);

  // State
  let page;
  let followedUsers = [];


  async function tryLoadFollowedDb() {
    try {
      followedUsers = JSON.parse(await fs.readFile(followedDbPath));
    } catch (err) {
      console.error('Failed to load followed db');
    }
  }

  async function trySaveFollowedDb() {
    try {
      await fs.writeFile(followedDbPath, JSON.stringify(followedUsers, null, 2));
    } catch (err) {
      console.error('Failed to save folowed db');
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
    await trySaveFollowedDb();
  }

  function getFollowedUsersThisTimeUnit() {
    return followedUsers
      .filter(u => new Date().getTime() - u.time < maxFollowsPerTimeSpan);
  }

  function hasReachedFollowedUserRateLimit() {
    return getFollowedUsersThisTimeUnit().length >= maxFollowsPerTimeUnit;
  }

  function haveRecentlyFollowedUser(username) {
    const followedUserEntry = followedUsers.find(u => u.username === username);
    if (!followedUserEntry) return false; // We did not previously follow this user, so don't know
    return new Date().getTime() - followedUserEntry.time < dontUnfollowUntilTimespan;
  }

  async function navigateToUser(username) {
    console.log(`Navigating to user ${username}`);
    await page.goto(`${instagramBaseUrl}/${encodeURIComponent(username)}`);
    await sleep(1000);
  }

  async function findFollowUnfollowButton({ follow = false }) {
    const elementHandles = await page.$x(`//button[text()='${follow ? 'Follow' : 'Following'}']`);
    if (elementHandles.length !== 1) {
      throw new Error('Follow/unfollow button not found');
    }
    return elementHandles[0];
  }

  // NOTE: assumes we are on this page
  async function followCurrentUser(username) {
    const elementHandle = await findFollowUnfollowButton({ follow: true });

    console.log(`Following user ${username}`);

    if (!dryRun) {
      await elementHandle.click();
      await addFollowedUser({ username, time: new Date().getTime() });
    }

    await sleep(1000);
  }

  async function unfollowCurrentUser(username) {
    const elementHandle = await findFollowUnfollowButton({ follow: false });

    console.log(`Unfollowing user ${username}`);

    if (!dryRun) {
      await elementHandle.click();
    }

    await sleep(1000);
  }

  const isLoggedIn = async () => (await page.$x('//nav')).length === 2;

  async function openFollowersList(username) {
    await page.click(`a[href="/${encodeURIComponent(username)}/followers/"]`);
    await sleep(2000);
  }

  async function getCurrentUser() {
    return page.evaluate(() => // eslint-disable-line no-loop-func
      window._sharedData.entry_data.ProfilePage[0].graphql.user); // eslint-disable-line no-undef,no-underscore-dangle,max-len
  }

  async function followUserFollowers(username, {
    maxFollowsPerUser = 5, skipPrivate = false,
  } = {}) {
    if (hasReachedFollowedUserRateLimit()) {
      console.log('Have reached follow rate limit, stopping');
      return;
    }

    console.log(`Following the followers of ${username}`);

    let numFollowedForThisUser = 0;

    await navigateToUser(username);
    await openFollowersList(username);

    const handles = await page.$x("//div[./text()='Followers']/following-sibling::*[1]/*/*/*/*/*/*[position()=2]//a");
    let followers = [];

    for (const handle of handles) {
      const follower = await page.evaluate(e => e.innerText, handle);
      followers.push(follower);
    }
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

  async function getPageJson() {
    return JSON.parse(await (await (await page.$('pre')).getProperty('textContent')).jsonValue());
  }

  async function getFollowersOrFollowing({ userId, getFollowers = false }) {
    const graphqlUrl = `${instagramBaseUrl}/graphql/query`;
    const followersUrl = `${graphqlUrl}/?query_id=17851374694183129`;
    const followingUrl = `${graphqlUrl}/?query_id=17874545323001329`;

    const graphqlVariables = {
      id: userId,
      first: 100,
    };

    const outUsers = [];

    let hasNextPage = true;
    let i = 0;

    while (hasNextPage) {
      const url = `${getFollowers ? followersUrl : followingUrl}&variables=${JSON.stringify(graphqlVariables)}`;
      await page.goto(url);
      const json = await getPageJson();

      const subPropName = getFollowers ? 'edge_followed_by' : 'edge_follow';

      const pageInfo = json.data.user[subPropName].page_info;
      const { edges } = json.data.user[subPropName];

      edges.forEach(e => outUsers.push(e.node.username));

      graphqlVariables.after = pageInfo.end_cursor;
      hasNextPage = pageInfo.has_next_page;
      i += 1;
      if (hasNextPage) console.log(`Has more pages (current ${i})`);
    }

    return outUsers;
  }

  async function unfollowNonMutualFollowers() {
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

    console.log(`Unfollowing ${usersToUnfollow.length} users`);

    let i = 0;
    for (const username of usersToUnfollow) {
      if (i !== 0 && i % 10 === 0) {
        console.log('Have unfollowed 10 users since last sleep. Sleeping');
        await sleep(10 * 60 * 1000, 0.1);
      }

      await navigateToUser(username);
      await unfollowCurrentUser(username);

      i += 1;
      console.log(`Have now unfollowed ${i} users of total ${usersToUnfollow.length}`);
      await sleep(15000);
    }
  }


  page = await browser.newPage();
  await page.setUserAgent('Chrome');

  await tryLoadCookies();
  await tryLoadFollowedDb();

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

  console.log(`Have followed ${getFollowedUsersThisTimeUnit().length} in the last ${maxFollowsPerTimeSpan / (60 * 60 * 1000)} hours`);

  return {
    followUserFollowers,
    unfollowNonMutualFollowers,
    sleep,
  };
};
