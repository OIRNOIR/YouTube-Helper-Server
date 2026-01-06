import fs from "node:fs";
import path from "node:path";
import process from "node:process";
/* cspell: disable-next-line */
import { msToShort, splitMessage } from "@oirnoir/util";
import { PrismaPg } from "@prisma/adapter-pg";
import { config as envConfig } from "dotenv";
import { type ConfigFile, TMP_DIR } from "./constants.ts";
import { PrismaClient } from "./prisma/generated/prisma/client.ts";
import { Source } from "./Source.ts";
import { Channels } from "./structures/Channels.ts";
import { ContentServer } from "./structures/ContentServer.ts";
import { execAsync, shuffle } from "./util.ts";

const __dirname = path.dirname(new URL(import.meta.url).pathname);

envConfig({ quiet: true, path: path.join(__dirname, ".env") });

const prismaAdapter = new PrismaPg({
	connectionString: process.env.DATABASE_URL
});

const prisma = new PrismaClient({
	adapter: prismaAdapter
});

const configFile: ConfigFile = JSON.parse(
	fs.readFileSync(path.join(__dirname, "config", "config.json"), "utf8")
);

const channels = new Channels(configFile);
let currentlyFetching = false;

let subscriptions: string[] = [];
let shortsWhitelist: string[] = JSON.parse(
	fs.readFileSync(
		path.join(__dirname, "config", "shorts-whitelist.json"),
		"utf-8"
	)
) as string[];

async function updateFeeds(): Promise<void> {
	const alreadyFetching = currentlyFetching;
	try {
		if (currentlyFetching) {
			console.log("YouTube Helper: Not fetching because it is already fetching");
			return;
		}
		currentlyFetching = true;
		subscriptions = JSON.parse(
			fs.readFileSync(
				path.join(__dirname, "config", "subscriptions.json"),
				"utf-8"
			)
		) as string[];
		shortsWhitelist = JSON.parse(
			fs.readFileSync(
				path.join(__dirname, "config", "shorts-whitelist.json"),
				"utf-8"
			)
		) as string[];
		console.log("Updating yt-dlp");
		const updateOut = await execAsync("yt-dlp -U");
		console.log(updateOut.stdout.toString().trim());
		if (updateOut.stderr.length > 0) {
			console.error(updateOut.stderr);
			console.error(updateOut.error);
			throw new Error("yt-dlp update error; check console for details");
		}
		shuffle(subscriptions);
		const cookiesPath = path.join(__dirname, "config", "cookies.txt");
		console.log("Loading sources");
		const sources: Source[] = [];
		for (const file of fs
			.readdirSync(path.join(__dirname, "sources"))
			.filter((f) => f.endsWith(".ts"))) {
			const imported = await import(path.join(__dirname, "sources", file));
			const source = new imported.default();
			if (!(source instanceof Source))
				throw new Error("Incorrect class constructed");
			sources.push(source);
		}
		console.log("Starting the timer");
		const start = Date.now();
		for (let i = 0; i < subscriptions.length; i++) {
			const channelURI = subscriptions[i];
			if (channelURI == undefined) throw new Error("Array doesn't work");
			console.log(
				`(${i + 1}/${subscriptions.length}) Fetching channel ${channelURI}...`
			);
			if (fs.existsSync(TMP_DIR)) {
				fs.rmSync(TMP_DIR, { recursive: true });
			}
			fs.mkdirSync(TMP_DIR);
			const source = sources.find((s) => s.identifyURL(channelURI));
			if (source == undefined)
				throw new Error(`No source found for ${channelURI}`);
			await source.scrapeChannel(
				prisma,
				channels,
				channelURI,
				i,
				subscriptions.length,
				cookiesPath,
				shortsWhitelist.find((i) => i == channelURI) != null
			);
		}
		console.log(
			`Done! Fetching all channels took ${msToShort(
				Date.now() - start
			)}. See you soon!`
		);
		for (const source of sources) {
			await source.postRunTasks(prisma, subscriptions, shortsWhitelist);
		}
	} finally {
		if (fs.existsSync(TMP_DIR)) {
			fs.rmSync(TMP_DIR, { recursive: true });
		}
		if (!alreadyFetching) {
			currentlyFetching = false;
		}
	}
}

function feedInterval() {
	Deno.unrefTimer(
		setTimeout(
			() => {
				feedInterval();
			},
			Math.trunc(Math.random() * 300000 + 900000)
		)
	); // Minimum of 15 minutes, maximum of 20 minutes
	updateFeeds(); // No await because we give zero shits about its result or waiting for it to finish
}

function main() {
	new ContentServer(prisma, configFile, logUncaughtException);
	feedInterval();
}

void main();

async function logUncaughtException(err: unknown): Promise<number> {
	const ts = Date.now();
	console.error("UNCAUGHT (YouTube Helper)");
	console.error(err);
	const stack = (err as Error).stack;
	if (process.env.NODE_ENV == "production") {
		let ping = `<@${configFile.errorPingUser}>`;
		if (stack?.includes("Unknown interaction")) {
			ping = "";
		}
		const text = `${ping} UNCAUGHT (YouTube Helper)\`\`\`Stack:\n${String(
			stack
		)}\n\nInspected:\n${Deno.inspect(err)}\n\`\`\``;
		const msgs = splitMessage(text, { prepend: "```\n", append: "\n```" });
		for (const msg of msgs) {
			await channels.errWebhook.send(msg);
		}
	}
	return ts;
}

process.on("uncaughtException", (err) => {
	logUncaughtException(err);
});

process.on("unhandledRejection", (err) => {
	logUncaughtException(err);
});

process.on("message", async (message) => {
	if (message == "shutdown") {
		console.log("Shutdown: signal");
		await prisma.$disconnect();
		return process.exit(0);
	}
});
