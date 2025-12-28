import { Application } from "@oak/oak/application";
import type { Request } from "@oak/oak/request";
import { Router } from "@oak/oak/router";
import { isNumeric } from "@oirnoir/util";
import FuzzySearch from "fuse.js";
import type { ConfigFile } from "../constants.ts";
import {
	type PrismaClient,
	type Video,
	VideoType
} from "../prisma/generated/prisma/client.ts";

function logRequest(request: Request, notFound = false) {
	console.log(
		JSON.stringify({
			time: Date.now(),
			method: request.method,
			url: request.url,
			path: new URL(request.url).pathname,
			parameters: "params" in request ? request.params : null,
			connectingIp: request.headers.get("cf-connecting-ip"),
			notFound
		})
	);
}

export class ContentServer {
	//private models: Models;
	private server: Application;
	//private config: ConfigFile;

	constructor(
		prisma: PrismaClient,
		config: ConfigFile,
		_logUncaughtException: (arg0: unknown) => Promise<number>
	) {
		const router = new Router();
		router.get("/api/feed", async (ctx) => {
			logRequest(ctx.request);

			if (
				ctx.request.headers.get("Authorization") !==
				config.expectedServerAuthorization
			) {
				ctx.response.status = 401;
				return;
			}
			const url = new URL(ctx.request.url);
			const pageParam = url.searchParams.get("page");
			const limitParam = url.searchParams.get("limit");
			const unreadParam = url.searchParams.get("unread");
			const typesPre = url.searchParams.get("type")?.split(",") ?? [];
			const searchQuery = url.searchParams.get("search");
			const types: VideoType[] = [];
			for (const type of typesPre) {
				if (type in VideoType) {
					types.push(type as VideoType);
				}
			}
			const page =
				pageParam == null ||
				!isNumeric(pageParam, {
					allowNegative: false,
					allowDecimal: false
				}) ||
				Number(pageParam) < 2
					? 1
					: Number(pageParam);
			const limit =
				limitParam == null ||
				!isNumeric(limitParam, {
					allowNegative: false,
					allowDecimal: false
				})
					? 25
					: Math.min(1000, Math.max(1, Number(limitParam)));
			const filter: { unread?: boolean; type?: { in: VideoType[] } } = {};
			if (unreadParam?.toLowerCase() == "true") {
				filter.unread = true;
			}
			if (types.length > 0) {
				filter.type = { in: types };
			}
			let documentsRaw: Video[];
			if (searchQuery == null) {
				// More efficient to do pagination this way if there is no search query
				documentsRaw = await prisma.video.findMany({
					where: filter,
					skip: (page - 1) * limit,
					take: limit,
					orderBy: { date: "desc" }
				});
			} else {
				const allVideos = await prisma.video.findMany({
					where: filter,
					orderBy: { date: "desc" }
				});
				const searcher = new FuzzySearch(allVideos, {
					keys: ["title", "displayName", "username"]
				});
				const results = searcher.search(searchQuery);
				const skip = (page - 1) * limit;
				documentsRaw = results.slice(skip, skip + limit).map((i) => i.item);
			}
			const documents = documentsRaw.map((d) => {
				return { ...d, timestampMS: d.date?.getTime() };
			});
			ctx.response.headers.set("Content-Type", "application/json");
			ctx.response.body = JSON.stringify({
				success: true,
				documents: documents.map((d) =>
					Object.fromEntries(Object.entries(d).filter((e) => !e[0].startsWith("_")))
				)
			});
		});

		router.patch("/api/read", async (ctx) => {
			logRequest(ctx.request);

			if (
				ctx.request.headers.get("Authorization") !==
				config.expectedServerAuthorization
			) {
				ctx.response.status = 401;
				return;
			}
			const requestData = (await ctx.request.body.json()) as {
				read?: string[];
				unread?: string[];
			};
			let modifiedCount = 0;
			if (requestData.read != undefined) {
				const result = await prisma.video.updateMany({
					where: { videoId: { in: requestData.read } },
					data: { unread: false }
				});
				modifiedCount += result.count;
			}
			if (requestData.unread != undefined) {
				const result = await prisma.video.updateMany({
					where: { videoId: { in: requestData.unread } },
					data: { unread: true }
				});
				modifiedCount += result.count;
			}
			ctx.response.headers.set("Content-Type", "application/json");
			ctx.response.body = JSON.stringify({ modifiedCount });
			return;
		});

		this.server = new Application();
		this.server.use(router.routes());
		this.server.use(router.allowedMethods());

		this.server.listen({ port: config.port });
	}
}
