# YouTube Helper Server

This is the server for a simple self-hosted client/server setup for YouTube subscriptions.

<img width="1554" height="1054" alt="A view of the YouTube Helper TUI" src="https://github.com/user-attachments/assets/d35599af-aeb0-41bd-8cd7-9c22f8310f9f" />

This image displays the official [TUI Client](https://github.com/OIRNOIR/YouTube-Helper-Client).

This project started in July 2025 because I got tired of using YouTube's official UI.

---

## Installation: Linux

This assumes you would like to use Discord for error reporting and info logs.

1. Clone this repository into a directory somewhere on your server, then cd to it.

2. Install dependencies:
    - [Bun](https://bun.sh/)
    - [yt-dlp](https://github.com/yt-dlp/yt-dlp/)
        - This project currently assumes you install the linux binary version, not via a package manager.
    - [FFmpeg](https://ffmpeg.org/)

3. Install Bun packages:
    - `bun install`

4. Create config files
    - `cp -r config.example config`
    - `cd config`
    - Edit `config.json`
        - Replace `DISCORD_WEBHOOK_FOR_ERRORS` with a Discord webhook you'd like to use to report errors to yourself.
        - Replace `DISCORD_WEBHOOK_FOR_INFO_LOGS` with a Discord webhook you'd like to use for informational messages.
        - Replace `INSERT_AUTHORIZATION_TOKEN_HERE` with an authorization token. Probably use a randomized value and keep this safe, you will need this to set up a client.
        - Replace `INSERT_YOUR_DISCORD_USER_ID_HERE` with your Discord user ID. You will be pinged when an error occurs.
        - Set the `port` to the port you wish to use.
    - Add subscriptions to `subscriptions.json`
        - The format is `yt://CHANNEL_ID/@username`
        - Add channels you wish to see shorts from to `shorts-whitelist.json`
        - As an example, the valid channel `@rossmanngroup` is in the file by default. This is used as an example for the
            format of the config file, and no promotion is intended.
    - If you wish to allow videos that require login, export a cookies.txt to `cookies.txt`.
        - This can be done via browser extension
            - One option for Chrome: [Get cookies.txt LOCALLY](https://chrome.google.com/webstore/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc)
            - One option for Firefox: [cookies.txt](https://addons.mozilla.org/en-US/firefox/addon/cookies-txt/)
            - Please be careful with what you install. Extension impersonators are a known problem with obtaining cookies.txt.

## Running

Start the server with:

```bash
bun run ./index.ts
```

I typically run this with [PM2](https://github.com/Unitech/pm2/). However, there are any number of ways
to daemonize a bun.js project. It can also be configured with a reverse-proxy like `nginx`
to forward requests to the server to the desired port. It should be configured so that a hostname
you control can reach the backend port.

## Client

Once you have configured this, you should configure a supported client.

Currently, the only supported client is:
- [YouTube Helper Client](https://github.com/OIRNOIR/YouTube-Helper-Client)

## Contributing

Feel free to leave issues or pull requests. AI-generated contributions will not be accepted.
