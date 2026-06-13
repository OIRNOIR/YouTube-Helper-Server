import { sleep } from "@oirnoir/util";
import {
	NEW_UNREAD_THRESHOLD,
	OLD_VIDEO_ERROR_THRESHOLD,
	VIDEOS_PER_CHANNEL_SCRAPE_LIMIT,
	type VideoTypeSelector
} from "../constants.ts";
import type {
	PrismaClient,
	Video,
	VideoType
} from "../prisma/generated/prisma/client.ts";
import { Source } from "../Source.ts";
import type { Channels } from "../structures/Channels.ts";

interface VideoListResponse {
	result: {
		page: number;
		page_size: number;
		items: VideoListing[];
	};
}

interface AccountLookupResponse<Name extends string> {
	result: Record<
		Name,
		{
			claim_id: string;
			name: string;
			normalized_name: string;
			permanent_url: string;
			value: {
				description: string;
				title: string;
			};
		}
	>;
}

interface VideoListing {
	claim_id: string;
	permanent_url: string;
	value: {
		description: string;
		release_time: string; // Seconds!
		title: string;
		video?: {
			duration: number; // Seconds
			height: number; // Pixels
			width: number; // Pixels
		};
	};
}

async function requestBackend(
	method: string,
	params: unknown
): Promise<Response> {
	return await fetch(
		`https://api.na-backend.odysee.com/api/v1/proxy?m=${method}`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Referer: "https://odysee.com/"
			},
			body: JSON.stringify({
				id: Date.now(),
				method,
				params
			}),
			signal: AbortSignal.timeout(5 * 60 * 1000)
		}
	);
}

// TODO: Pagination

export default class Odysee extends Source {
	override identifyURL(url: string): boolean {
		return url.startsWith("odysee://");
	}

	override async scrapeChannel(
		prisma: PrismaClient,
		channels: Channels,
		channelURI: string,
		i: number,
		subscriptionsCount: number,
		_cookiesPath: string,
		allowedTypes: VideoTypeSelector
	) {
		const splitUrl = channelURI.replace("odysee://", "").split("/");
		const expectedChannelID = splitUrl[0];
		let initialSearchText: string | null = null;
		const initialSearch = `lbry://${splitUrl[1]}`;
		for (let i = 0; i < 5; i++) {
			const initialSearchRes = await requestBackend("resolve", {
				urls: [initialSearch]
			});
			initialSearchText = await initialSearchRes.text();
			if (initialSearchRes.ok) break;
			if (initialSearchRes.status == 524) {
				console.log(
					`(${i + 1}/${subscriptionsCount}) Retrying initial fetch (${i + 1}/5)...`
				);
				if (i < 4) await sleep(10000);
			} else {
				console.error(initialSearchText);
				console.error(initialSearchRes.statusText);
				throw new Error(
					"Odysee channel data scrape error; check console for details"
				);
			}
		}
		if (initialSearchText == null) {
			throw new Error("Odysee channel data scrape error (ran out of tries)");
		}
		const initialSearchJSON = JSON.parse(
			initialSearchText
		) as AccountLookupResponse<typeof initialSearch>;
		const channelInfo = initialSearchJSON.result[initialSearch];
		const PAGE_SIZE = 50;
		const dataRes = await requestBackend("claim_search", {
			channel_ids: [channelInfo.claim_id],
			no_totals: true,
			has_source: true,
			claim_type: ["stream"],
			order_by: ["release_time"],
			page: 1,
			page_size: PAGE_SIZE
		});
		if (!dataRes.ok) {
			const text = await dataRes.text();
			console.error(text);
			console.error(dataRes.statusText);
			throw new Error(
				"Odysee channel data scrape error; check console for details"
			);
		}
		const text = await dataRes.text();
		const videoList = JSON.parse(text) as VideoListResponse;
		const channelId = channelInfo.claim_id;
		if (channelId != expectedChannelID) {
			await channels.infoWebhook.send({
				content: `WARNING: Odysee channel \`${initialSearch}\`, previously \`${expectedChannelID}\`, is now \`${channelId}\``
			});
		}

		const existingVideos = await prisma.video.findMany({
			where: {
				channelId
			}
		});

		const existingVideoMap = new Map<string, Video>();

		for (const video of existingVideos) {
			existingVideoMap.set(video.videoId, video);
		}

		const newVideos: VideoListing[] = [];

		// Update changed videos
		await prisma.$transaction(async (tx) => {
			for (const video of videoList.result.items) {
				const existingVideo = existingVideoMap.get(video.claim_id);
				if (existingVideo == undefined) {
					newVideos.push(video);
				} else if (
					video.value.video?.duration != undefined &&
					existingVideo.isCurrentlyLive
				) {
					// Existing livestream should be updated!
					await tx.video.update({
						where: { videoId: video.claim_id },
						data: {
							title: video.value.title,
							duration: video.value.video.duration,
							isCurrentlyLive: false
						}
					});
				} else if (
					video.value.title != existingVideo.title ||
					(video.value.video?.duration != null &&
						video.value.video.duration != existingVideo.duration)
				) {
					// Update title and duration
					const updateArgs: {
						where: { videoId: string };
						data: Partial<Video>;
					} = {
						where: { videoId: video.claim_id },
						data: {
							title: video.value.title
						}
					};
					if (video.value.video?.duration != null)
						updateArgs.data.duration = video.value.video.duration;
					await tx.video.update(updateArgs);
				}
			}
		});

		let index = 0;
		for (const video of newVideos) {
			index++;
			console.log(
				`(${
					i + 1
				}/${subscriptionsCount}) [${index}/${newVideos.length}] Checking video ${video.claim_id}...`
			);
			const timestampMS = Number(video.value.release_time) * 1000;
			if (timestampMS < OLD_VIDEO_ERROR_THRESHOLD) {
				// This timestamp might not be right! Throw an error to make sure a human reviews it
				console.error(
					`WARNING: Received timestamp ${timestampMS} for video ${video.claim_id}, which is older than expected! Skipping this video for now.`
				);
				await channels.infoWebhook.send({
					content: `WARNING: Received timestamp ${timestampMS} for video ${video.claim_id}, which is older than expected! Skipping this video for now.`
				});
				console.error(
					`(${
						i + 1
					}/${subscriptionsCount}) [${index}/${newVideos.length}] Skipping ${video.claim_id}...`
				);
				continue;
			}
			const aspectRatio =
				video.value.video == undefined
					? undefined
					: video.value.video.width / video.value.video.height;
			const isShort =
				video.value.video != undefined &&
				aspectRatio != undefined &&
				aspectRatio <= 0.8 &&
				video.value.video?.duration <= 180;
			const type =
				video.value.video?.duration == undefined
					? "stream"
					: isShort
						? "short"
						: "video";
			if (
				(!allowedTypes.shorts && type == "short") ||
				(!allowedTypes.streams && type == "stream") ||
				(!allowedTypes.videos && type == "video")
			) {
				// This type is blacklisted
				continue;
			}
			const newVideoDocument: Video = {
				videoId: video.claim_id,
				platform: "Odysee",
				type,
				duration: video.value.video?.duration ?? null,
				title: video.value.title,
				description: video.value.description,
				displayName: channelInfo.value.title,
				username: channelInfo.name,
				channelId: channelId,
				date: new Date(timestampMS),
				releaseDate: null,
				isCurrentlyLive: video.value.video?.duration == undefined,
				// Mark as read if the newly imported video is a week old
				unread: Date.now() - timestampMS < NEW_UNREAD_THRESHOLD,
				sponsorBlockStatus: null,
				/** cspell: disable-next-line */
				url: video.permanent_url.replace("lbry://", "https://odysee.com/"),
				availability: "public"
			};
			await prisma.video.create({ data: newVideoDocument });
			if (index >= VIDEOS_PER_CHANNEL_SCRAPE_LIMIT) {
				console.log(
					`(${
						i + 1
					}/${subscriptionsCount}) Skipping the rest of the new videos because there is a ${VIDEOS_PER_CHANNEL_SCRAPE_LIMIT} video limit per channel on new videos per scrape.`
				);
				break;
			}
		}
	}

	override async postRunTasks(
		prisma: PrismaClient,
		subscriptions: { channel: string; types: VideoTypeSelector }[],
		doPurgeUnsubscribed: boolean
	): Promise<void> {
		if (doPurgeUnsubscribed) {
			await purgeUnsubscribed(prisma, subscriptions);
		}
	}
}

async function purgeUnsubscribed(
	prisma: PrismaClient,
	subscriptions: { channel: string; types: VideoTypeSelector }[]
) {
	console.log("[Odysee] Checking for unsubscribed channels...");
	const allChannels = new Set(
		(await prisma.video.findMany({ where: { platform: "Odysee" } })).map(
			(v) => v.channelId
		)
	);
	for (const channel of allChannels) {
		const unsubscribed =
			subscriptions.findIndex(
				(s) => s.channel.replace("odysee://", "").split("/")[0] == channel
			) == -1;
		if (unsubscribed) {
			const channelVideo = await prisma.video.findFirst({
				where: {
					platform: "Odysee",
					channelId: channel
				},
				orderBy: { date: "desc" }
			});
			if (channelVideo != null) {
				console.log(
					`[Odysee] Channel ${channel} (${channelVideo.username} / ${channelVideo.displayName}) has been unsubscribed. Purging from DB.`
				);
			} else {
				console.log(
					`[Odysee] Channel ${channel} (unknown) has been unsubscribed. Purging from DB.`
				);
			}
			await prisma.video.deleteMany({
				where: { platform: "Odysee", channelId: channel }
			});
		}
	}
	console.log("[Odysee] Done checking for unsubscribed channels!");
	console.log("[Odysee] Checking for un-whitelisted channels...");
	for (const channel of allChannels) {
		const typesAllowed: VideoTypeSelector | undefined = subscriptions.find((k) =>
			k.channel.startsWith(`odysee://${channel}`)
		)?.types;
		if (typesAllowed == undefined) throw new Error("Could not find this channel");
		for (const [t] of Object.entries(typesAllowed).filter(
			([_, v]) => v == false
		)) {
			const videoType: VideoType | undefined =
				t == "videos"
					? "video"
					: t == "streams"
						? "stream"
						: t == "shorts"
							? "short"
							: undefined;
			if (videoType == undefined) {
				throw new Error(`Invalid type ${t}`);
			}
			const channelVideo = await prisma.video.findFirst({
				where: {
					platform: "Odysee",
					channelId: channel,
					type: videoType
				},
				orderBy: { date: "desc" }
			});
			if (channelVideo != null) {
				console.log(
					`[Odysee] Channel ${channel} (${channelVideo.username} / ${channelVideo.displayName}) has been removed from the ${t} whitelist. Purging ${t} from DB.`
				);
				const deleted = await prisma.video.deleteMany({
					where: {
						platform: "Odysee",
						channelId: channel,
						type: videoType
					}
				});
				console.log(
					`[Odysee] Deleted ${deleted.count} ${t} from ${channelVideo.username}`
				);
			}
		}
	}
	console.log("[Odysee] Done checking for un-whitelisted channels!");
}
