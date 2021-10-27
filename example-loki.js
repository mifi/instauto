'use strict';

const puppeteer = require('puppeteer'); // eslint-disable-line import/no-extraneous-dependencies
const loki = require('lokijs');
const { Instauto, LokiDbAdapter } = require('instauto'); // eslint-disable-line import/no-unresolved
const fs = require('fs');
const path = require('path');

const options = {
	cookiesPath: './cookies.json',

	username: 'manon.deplanche',
	password: 'Manolo1*',

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

	// NOTE: The dontUnfollowUntilTimeElapsed option is ONLY for the unfollowNonMutualFollowers function
	// This specifies the time during which the bot should not touch users that it has previously followed (in milliseconds)
	// After this time has passed, it will be able to unfollow them again.
	// TODO should remove this option from here
	dontUnfollowUntilTimeElapsed: 3 * 24 * 60 * 60 * 1000,

	// Usernames that we should not touch, e.g. your friends and actual followings
	excludeUsers: [],

	// If true, will not do any actions (defaults to true)
	dryRun: false,
};

async function getDb() {
	const dbPath = path.join(__dirname, 'test.json');
	if (!fs.existsSync(dbPath)) {
		fs.writeFileSync(dbPath, '{}');
	}
	let isDbReady = false;
	const db = new loki(dbPath, {
		autoload: true,
		autosave: true,
		autoloadCallback: () => {
			isDbReady = true;
		},
		autosaveInterval: 1000,
		env: 'NODEJS'
	});

	do {
		await new Promise((resolve) => setTimeout(resolve, 1000));
	} while (!isDbReady);

	return db;
}

(async() => {
	let browser;

	try {
		browser = await puppeteer.launch({ headless: false });

		const db = await getDb();
		const instautoDb = new LokiDbAdapter(db);
		const instauto = await Instauto(instautoDb, browser, options);

		// This can be used to unfollow people:
		// Will unfollow auto-followed AND manually followed accounts who are not following us back, after some time has passed
		// The time is specified by config option dontUnfollowUntilTimeElapsed
		// await instauto.unfollowNonMutualFollowers();
		// await instauto.sleep(10 * 60 * 1000);

		// Unfollow previously auto-followed users (regardless of whether or not they are following us back)
		// after a certain amount of days (2 weeks)
		// Leave room to do following after this too (unfollow 2/3 of maxFollowsPerDay)
		const unfollowedCount = await instauto.unfollowOldFollowed({
			ageInDays: 14,
			limit: options.maxFollowsPerDay * (2 / 3)
		});

		if (unfollowedCount > 0) await instauto.sleep(10 * 60 * 1000);

		// List of usernames that we should follow the followers of, can be celebrities etc.
		const usersToFollowFollowersOf = ['lostleblanc', 'sam_kolder'];

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
