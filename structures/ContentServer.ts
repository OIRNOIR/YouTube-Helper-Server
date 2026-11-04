import { isNumeric } from "@oirnoir/util";
import Fastify from "fastify";
import FuzzySearch from "fuse.js";
import type { ConfigFile } from "../constants.ts";
import {
	type PrismaClient,
	type Video,
	VideoType
} from "../prisma/generated/prisma/client.ts";
import type { VideoAvailability } from "../prisma/generated/prisma/enums.ts";

function toURL(request: Fastify.FastifyRequest) {
	return new URL(`${request.protocol}://${request.host}${request.url}`);
}

function logRequest(request: Fastify.FastifyRequest, notFound = false) {
	const url = toURL(request);
	console.log(
		JSON.stringify({
			time: Date.now(),
			method: request.method,
			url: url.toString(),
			path: url.pathname,
			parameters: "params" in request ? request.params : null,
			connectingIp: request.headers["cf-connecting-ip"],
			notFound
		})
	);
}

export class ContentServer {
	//private models: Models;
	private server: Fastify.FastifyInstance;
	//private config: ConfigFile;

	constructor(
		prisma: PrismaClient,
		config: ConfigFile,
		logUncaughtException: (arg0: unknown) => Promise<number>
	) {
		this.server = Fastify({ logger: true });

		this.server.get<{
			Querystring: {
				page?: string;
				limit?: string;
				unread?: string;
				type?: string;
				search?: string;
			};
		}>("/api/feed", async (req, res) => {
			logRequest(req);

			if (req.headers.authorization !== config.expectedServerAuthorization) {
				res.status(401).send();
				return;
			}
			const pageParam = req.query.page;
			const limitParam = req.query.limit;
			const unreadParam = req.query.unread;
			const typesPre = req.query.type?.split(",") ?? [];
			const searchQuery = req.query.search;
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
			const filter: {
				AND?: {
					unread?: boolean;
					type?: { in: VideoType[] };
				};
				NOT?: { availability?: VideoAvailability };
			} = {};
			if (unreadParam?.toLowerCase() == "true") {
				filter.AND = {
					unread: true
				};
			}
			if (types.length > 0) {
				if (filter.AND != undefined) {
					filter.AND.type = { in: types };
				} else {
					filter.AND = {
						type: {
							in: types
						}
					};
				}
			}
			if (!config.showSubscriberOnly) {
				filter.NOT = {
					availability: "subscriber_only"
				};
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
				return {
					...d,
					timestampMS: d.date.getTime(),
					releaseTimestampMS: d.releaseDate?.getTime() ?? null
				};
			});
			res.status(200).send({
				success: true,
				documents: documents.map((d) =>
					Object.fromEntries(Object.entries(d).filter((e) => !e[0].startsWith("_")))
				)
			});
		});

		this.server.patch<{ Body: { read?: string[]; unread?: string[] } }>(
			"/api/read",
			async (req, res) => {
				logRequest(req);

				if (req.headers.authorization !== config.expectedServerAuthorization) {
					res.status(401).send();
					return;
				}
				const requestData = req.body;
				let modifiedCount = 0;
				if (requestData.read != undefined && requestData.read.length > 0) {
					if (requestData.read.length == 1) {
						await prisma.video.update({
							where: { videoId: requestData.read[0] },
							data: { unread: false }
						});
						modifiedCount++;
					} else {
						const result = await prisma.video.updateMany({
							where: { videoId: { in: requestData.read } },
							data: { unread: false }
						});
						modifiedCount += result.count;
					}
				}
				if (requestData.unread != undefined && requestData.unread.length > 0) {
					if (requestData.unread.length == 1) {
						await prisma.video.update({
							where: { videoId: requestData.unread[0] },
							data: { unread: true }
						});
						modifiedCount++;
					} else {
						const result = await prisma.video.updateMany({
							where: { videoId: { in: requestData.unread } },
							data: { unread: true }
						});
						modifiedCount += result.count;
					}
				}
				res.status(200).send({ modifiedCount });
				return;
			}
		);

		this.server.setErrorHandler((error, _request, reply) => {
			console.error(error);
			logUncaughtException(error);
			reply.status(500).send("Internal Server Error");
		});

		this.server.setNotFoundHandler((req, reply) => {
			logRequest(req, true);
			reply.status(404).send();
		});

		this.server.listen(
			{ port: config.port, host: config.listenHostname },
			(err) => {
				if (err) {
					logUncaughtException(err);
					return;
				}
				console.log(
					`Fastify Server successfully listening on port ${config.port}.`
				);
			}
		);
	}
}
