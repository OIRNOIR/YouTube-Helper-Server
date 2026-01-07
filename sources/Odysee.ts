import {
	NEW_UNREAD_THRESHOLD,
	OLD_VIDEO_ERROR_THRESHOLD,
	VIDEOS_PER_CHANNEL_SCRAPE_LIMIT
} from "../constants.ts";
import type { PrismaClient, Video } from "../prisma/generated/prisma/client.ts";
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
			})
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
		_isShortsWhitelisted: boolean
	) {
		const splitUrl = channelURI.replace("odysee://", "").split("/");
		const expectedChannelID = splitUrl[0];
		const initialSearch = splitUrl[1];
		const initialSearchRes = await requestBackend("resolve", {
			urls: [initialSearch]
		});
		const initialSearchText = await initialSearchRes.text();
		if (!initialSearchRes.ok) {
			console.error(initialSearchText);
			console.error(initialSearchRes.statusText);
			throw new Error(
				"Odysee channel data scrape error; check console for details"
			);
		}
		const initialSearchJSON = JSON.parse(
			initialSearchText
		) as AccountLookupResponse<typeof initialSearch>;
		const channelInfo = initialSearchJSON.result[initialSearch];
		const PAGE_SIZE = 50;
		const dataRes = await requestBackend("claim_search", {
			channel_ids: [channelInfo.claim_id],
			no_totals: true,
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
				}/${subscriptionsCount}) [${index}/${newVideos.length}] Extracting extended attributes from new video ${video.claim_id}...`
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
			console.log(
				`(${
					i + 1
				}/${subscriptionsCount}) [${index}/${newVideos.length}] Done extracting extended attributes from new video ${video.claim_id}!`
			);
			const newVideoDocument: Video = {
				videoId: video.claim_id,
				platform: "Odysee",
				type: video.value.video?.duration == undefined ? "stream" : "video",
				duration: video.value.video?.duration ?? null,
				title: video.value.title,
				description: video.value.description,
				displayName: channelInfo.value.title,
				username: channelInfo.name,
				channelId: channelId,
				date: new Date(timestampMS),
				isCurrentlyLive: video.value.video?.duration == undefined,
				// Mark as read if the newly imported video is a week old
				unread: Date.now() - timestampMS < NEW_UNREAD_THRESHOLD,
				sponsorBlockStatus: null,
				/** cspell: disable-next-line */
				url: video.permanent_url.replace("lbry://", "https://odysee.com/")
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
		subscriptions: string[],
		_shortsWhitelist: string[]
	): Promise<void> {
		await purgeUnsubscribed(prisma, subscriptions);
	}
}

async function purgeUnsubscribed(
	prisma: PrismaClient,
	subscriptions: string[]
) {
	console.log("Checking for unsubscribed channels...");
	const allChannels = new Set(
		(await prisma.video.findMany({ where: { platform: "Odysee" } })).map(
			(v) => v.channelId
		)
	);
	for (const channel of allChannels) {
		const unsubscribed =
			subscriptions.findIndex(
				(s) => s.replace("odysee://", "").split("/")[0] == channel
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
					`Channel ${channel} (${channelVideo.username} / ${channelVideo.displayName}) has been unsubscribed. Purging from DB.`
				);
			} else {
				console.log(
					`Channel ${channel} (unknown) has been unsubscribed. Purging from DB.`
				);
			}
			await prisma.video.deleteMany({
				where: { platform: "Odysee", channelId: channel }
			});
		}
	}
	console.log("Done checking for unsubscribed channels!");
}
