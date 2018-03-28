# insta-js

insta-js is an Instagram automation library written in modern, clean javascript using Google's Puppeteer. Goal is to be very easy to set up, use, and extend. Heavily inspired by [InstaPy](https://github.com/CharlesCCC/InstaPy).

## Setup

- First install [Node.js](https://nodejs.org/en/) 8 or newer.

- Create a new directory with a file like [example.js](https://github.com/mifi/insta-js/blob/master/example.js)

- Adjust your `example.js` to your needs. If you want to see how it would work without doing any actual actions, use the `dryRun: true` option.

- Open a terminal in the directory

- Run cmd `npm install puppeteer insta-js`

## Usage

- In the directory with `example.js`, run `node example`

## Supported functionality

- Follow the followers of some particular users. Parameters like max/min ratio for followers/following can be set.

- Unfollow users that don't follow us back. Will not unfollow any users that we recently followed.

See [index.js](https://github.com/mifi/insta-js/blob/master/index.js) for available options.
