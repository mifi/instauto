# instauto

instauto is an Instagram automation/bot library written in modern, clean javascript using Google's Puppeteer. Goal is to be very easy to set up, use, and extend, and obey instagram's limits. Heavily inspired by [InstaPy](https://github.com/CharlesCCC/InstaPy), but I thought it was way too heavy and hard to setup.

## Setup

- First install [Node.js](https://nodejs.org/en/) 8 or newer.

- Create a new directory with a file like [example.js](https://github.com/mifi/instauto/blob/master/example.js)

- Adjust your `example.js` to your needs. If you want to see how it would work without doing any actual actions, use the `dryRun: true` option.

- Open a terminal in the directory

- Run `npm install puppeteer instauto`

- Run `node example`

You can run this code for example once every day using cron or pm2 or similar

See [index.js](https://github.com/mifi/instauto/blob/master/index.js) for available options.

## Supported functionality

- Follow the followers of some particular users. (e.g. celebrities.) Parameters like max/min ratio for followers/following can be set.

- Unfollow users that don't follow us back. Will not unfollow any users that we recently followed.

- Unfollow auto followed users (also those following us back) after a certain number of days.

- The code automatically prevents breaching 100 follow/unfollows per hour or 700 per 24hr, to prevent bans. This can be configured.

See [example.js](https://github.com/mifi/instauto/blob/master/example.js) for example of features

## Tips
- Run this on a machine with a non-cloud IP to avoid being banned
