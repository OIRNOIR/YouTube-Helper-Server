import type { VideoTypeSelector } from "./constants.ts";
import type { PrismaClient } from "./prisma/generated/prisma/client.ts";
import type { Channels } from "./structures/Channels.ts";

export abstract class Source {
	abstract identifyURL(url: string): boolean;

	abstract scrapeChannel(
		prisma: PrismaClient,
		channels: Channels,
		channelURI: string,
		i: number,
		subscriptionsCount: number,
		cookiesPath: string,
		allowedTypes: VideoTypeSelector
	): Promise<void>;

	abstract postRunTasks(
		prisma: PrismaClient,
		subscriptions: { channel: string; types: VideoTypeSelector }[]
	): Promise<void>;
}
