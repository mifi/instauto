![](logo.png)

[![Discord](https://img.shields.io/discord/986052713425027072)](https://discord.gg/Rh3KT9zyhj) [![PayPal](https://img.shields.io/badge/Donate-PayPal-green.svg)](https://paypal.me/mifino/usd)

instauto is an Instagram automation/bot library (API) written in modern, clean javascript using Google's Puppeteer. Goal is to be very easy to set up, use, and extend, and obey instagram's limits. Heavily inspired by [InstaPy](https://github.com/timgrossmann/InstaPy), but I thought it was way too heavy and hard to setup.

There is also a GUI application for those who don't want to code: [SimpleInstaBot](https://mifi.github.io/SimpleInstaBot/)


## Setup

- First install [Node.js](https://nodejs.org/en/) 8 or newer.
  - On MacOS, it's recommended to use [homebrew](https://brew.sh/): `brew install node`

- Create a new directory with a file like [example.js](https://github.com/mifi/instauto/blob/master/example.js)

- Adjust your `example.js` to your needs. If you want to see how it would work without doing any invasive actions, use the `dryRun: true` option. Toggle `headless` to see it in action.

- Open a terminal in the directory

- Run `npm i -g yarn`

- Run `yarn add puppeteer instauto`

- Run `node example`

You can run this code for example once every day using cron or pm2 or similar

See [index.js](https://github.com/mifi/instauto/blob/master/src/index.js) for available options.

## Supported functionality

- Follow the followers of some particular users. (e.g. celebrities.) Parameters like max/min ratio for followers/following can be set.

- Unfollow users that don't follow us back. Will not unfollow any users that we recently followed.

- Unfollow auto followed users (also those following us back) after a certain number of days.

- The code automatically prevents breaching 100 follow/unfollows per hour or 700 per 24hr, to prevent bans. This can be configured.

See [example.js](https://github.com/mifi/instauto/blob/master/example.js) for example of features

## Tips
- Run this on a machine with a non-cloud IP to avoid being banned

## Troubleshooting

- If it doesn't work, make sure your instagram language is set to english

## Running on Raspberry Pi

Because puppeteer chrome binaries are not provided for RPi, you need to first install chromium using apt.

Then replace your puppeteer launch code:

```js
browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium-browser',
    headless: true,
    args: ['--disable-features=VizDisplayCompositor'],
});
```

See also:
- https://github.com/GoogleChrome/puppeteer/issues/550
- https://github.com/GoogleChrome/puppeteer/issues/3774

Also you might want to install the more lightweight package `puppeteer-core` instead of `puppeteer`.

## Running with pm2
First install [pm2](https://github.com/Unitech/pm2). (`npm i -g pm2`) Then copy [instabot.yml](https://github.com/mifi/instauto/blob/master/instabot.yml) into the same dir as `example.js` and run:

```bash
pm2 start instabot.yml
pm2 save
pm2 startup
```

Now it will run automatically on reboot! 🙌

## Donate 🙈

This project is maintained by me alone. The project will always remain free and open source, but if it's useful for you, consider supporting me. :) It will give me extra motivation to improve it.

[Paypal](https://paypal.me/mifino/usd) | [crypto](https://mifi.no/thanks)

## Credits

- Icons made by [smalllikeart](https://www.flaticon.com/authors/smalllikeart) & [Freepik](https://www.flaticon.com/authors/freepik) from [www.flaticon.com](https://www.flaticon.com/)

---

Made with ❤️ in 🇳🇴

[More apps by mifi.no](https://mifi.no/)

Follow me on [GitHub](https://github.com/mifi/), [YouTube](https://www.youtube.com/channel/UC6XlvVH63g0H54HSJubURQA), [IG](https://www.instagram.com/mifi.no/), [Twitter](https://twitter.com/mifi_no) for more awesome content!
