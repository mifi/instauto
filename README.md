![](logo.png)

instauto is an Instagram automation/bot library written in modern, clean javascript using Google's Puppeteer. Goal is to be very easy to set up, use, and extend, and obey instagram's limits. Heavily inspired by [InstaPy](https://github.com/timgrossmann/InstaPy), but I thought it was way too heavy and hard to setup.

**NEW! 🎉**
Now there is a GUI application for those who don't want to code: [SimpleInstaBot](https://mifi.github.io/SimpleInstaBot/)


## Setup

- First install [Node.js](https://nodejs.org/en/) 8 or newer.

- Create a new directory with a file like [example.js](https://github.com/mifi/instauto/blob/master/example.js)

- Adjust your `example.js` to your needs. If you want to see how it would work without doing any invasive actions, use the `dryRun: true` option. Toggle `headless` to see it in action.

- Open a terminal in the directory

- Run `npm i -g yarn`

- Run `yarn add puppeteer instauto`

- Run `node example`

You can run this code for example once every day using cron or pm2 or similar

See [index.js](https://github.com/mifi/instauto/blob/master/index.js) for available options.

## Supported functionality

- Follow the followers of some particular users. (e.g. celebrities.) Parameters like max/min ratio for followers/following can be set.

- Unfollow users that don't follow us back. Will not unfollow any users that we recently followed.

- Unfollow auto followed users (also those following us back) after a certain number of days.

- The code automatically prevents breaching 100 follow/unfollows per hour or 700 per 24hr, to prevent bans. This can be configured.

See [example.js](https://github.com/mifi/instauto/blob/master/example.js) for example of features

## Data management

The data are stored in json files by default using the `file-db.adapter` internally.
If you need to override the default behavior you can either choose to use the other adapter provided which is using 
[lokijs](https://github.com/techfort/LokiJS) or you could create your own adapter to pass to `instauto`.

### Creating your own adapter

To create your own adapter you can have a look to [loki-db.adapter.ts](https://github.com/mifi/instauto/tree/master/src/db_adapters/loki-db.adapter.ts).
Basically you need to create a class that extend the [AbstractDbAdapter](https://github.com/mifi/instauto/tree/master/src/db_adapters/abstract-db.adapter.ts) 
such as :

```typescript
export class MyAdapter extends AbstractDbAdapter {
  constructor(private readonly instance: YourInstanceType, private readonly logger: Logger) {
    super();
  }

  addLikedPhoto({ username, href, time }: LikedPhoto): Promise<void> {
    // ... You code goes here ...
  }

  addPrevFollowedUser(follower: Follower): Promise<void> {
    // ... You code goes here ...  
  }

  addPrevUnfollowedUser(unfollower: UnFollower): Promise<void> {
    // ... You code goes here ...
  }

  getFollowedLastTimeUnit(timeUnit: number): Promise<Follower[]> {
    // ... You code goes here ...
  }

  getLikedPhotosLastTimeUnit(timeUnit: number): Promise<LikedPhoto[]> {
    // ... You code goes here ...
  }

  getPrevFollowedUser(username: string): Promise<Follower> {
    // ... You code goes here ...
  }

  getUnfollowedLastTimeUnit(timeUnit: number): Promise<UnFollower[]> {
    // ... You code goes here ...
  }
}
```

To see how to use you own adapter you can have a look to the [example-loki.js](https://github.com/mifi/instauto/blob/master/example-loki.js)

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
