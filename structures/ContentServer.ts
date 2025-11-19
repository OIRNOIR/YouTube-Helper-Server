import { isNumeric } from "@oirnoir/util";
import type { BunRequest } from "bun";
import FuzzySearch from "fuse.js";
import type { ConfigFile } from "../constants.ts";
import {
	type PrismaClient,
	type Video,
	VideoType
} from "../prisma/generated/prisma/client.ts";

function logRequest(request: Bun.BunRequest | Request, notFound = false) {
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
	private server: Bun.Server<void>;
	//private config: ConfigFile;

	constructor(
		prisma: PrismaClient,
		config: ConfigFile,
		logUncaughtException: (arg0: unknown) => Promise<number>
	) {
		//this.models = models;
		//this.config = config;
		this.server = Bun.serve({
			port: config.port,
			development: false,
			routes: {
				"/api/feed": async (req: BunRequest<"/api/feed">) => {
					logRequest(req);

					if (
						req.headers.get("Authorization") !== config.expectedServerAuthorization
					) {
						return new Response(null, { status: 401 });
					}
					const url = new URL(req.url);
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
						!isNumeric(pageParam, { allowNegative: false, allowDecimal: false }) ||
						Number(pageParam) < 2
							? 1
							: Number(pageParam);
					const limit =
						limitParam == null ||
						!isNumeric(limitParam, { allowNegative: false, allowDecimal: false })
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
					return Response.json({
						success: true,
						documents: documents.map((d) =>
							Object.fromEntries(
								Object.entries(d).filter((e) => !e[0].startsWith("_"))
							)
						)
					});
				},
				"/api/read": {
					PATCH: async (req: BunRequest<"/api/read">) => {
						logRequest(req);

						if (
							req.headers.get("Authorization") !== config.expectedServerAuthorization
						) {
							return new Response(null, { status: 401 });
						}
						const requestData = (await req.json()) as {
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
						return Response.json({ modifiedCount });
					}
				}
			},
			error: async (error) => {
				const timestamp = await logUncaughtException(error);
				return Response.json(
					{ message: "Internal Server Error", timestamp },
					{
						status: 500
					}
				);
			},
			fetch: (req) => {
				logRequest(req, true);

				return new Response(null, { status: 404 });
			}
		});
	}

	public stop(closeActiveConnections = false): Promise<void> {
		return this.server.stop(closeActiveConnections);
	}
}
