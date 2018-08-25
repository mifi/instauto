# instauto

instauto is an Instagram automation library written in modern, clean javascript using Google's Puppeteer. Goal is to be very easy to set up, use, and extend. Heavily inspired by [InstaPy](https://github.com/CharlesCCC/InstaPy).

## Setup

- First install [Node.js](https://nodejs.org/en/) 8 or newer.

- Create a new directory with a file like [example.js](https://github.com/mifi/instauto/blob/master/example.js)

- Adjust your `example.js` to your needs. If you want to see how it would work without doing any actual actions, use the `dryRun: true` option.

- Open a terminal in the directory

- Run cmd `npm install puppeteer instauto`

## Usage

- In the directory with `example.js`, run `node example`

- You can run this code for example every day using cron or pm2 or similar

## Tips
- Run this on a machine with a non-cloud IP to avoid being banned

## Supported functionality

- Follow the followers of some particular users. Parameters like max/min ratio for followers/following can be set.

- Unfollow users that don't follow us back. Will not unfollow any users that we recently followed.

- Unfollow auto followed users (also those following us back) after a certain number of days.

- The code automatically stops when reaching 100 follow/unfollows per hour or 700 per 24hr. Can be configured.

See [index.js](https://github.com/mifi/instauto/blob/master/index.js) for available options.
