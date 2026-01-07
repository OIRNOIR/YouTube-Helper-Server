import {
	NEW_UNREAD_THRESHOLD,
	OLD_VIDEO_ERROR_THRESHOLD,
	VIDEOS_PER_CHANNEL_SCRAPE_LIMIT
} from "../constants.ts";
import type { PrismaClient, Video } from "../prisma/generated/prisma/client.ts";
import { Source } from "../Source.ts";
import type { Channels } from "../structures/Channels.ts";

interface VideoListing {
	id: number;
	uuid: string;
	url: string;
	name: string;
	publishedAt: string;
	duration: number; // in seconds
	isLive: boolean;
	channel: {
		name: string;
		displayName: string;
	};
}

interface VideoData {
	uuid: string;
	description: string;
	url: string;
	name: string;
	publishedAt: string;
	duration: number; // in seconds
	state: {
		id: number;
	};
	isLive: boolean;
	channel: {
		name: string;
		displayName: string;
	};
}

interface ChannelData {
	total: number;
	data: VideoListing[];
}

// TODO: Pagination

export default class PeerTube extends Source {
	override identifyURL(url: string): boolean {
		return url.startsWith("peertube://");
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
		const parts = channelURI.replace("peertube://", "").split("/");
		const hostname = parts[0];
		const channelName = parts[1];
		if (hostname == undefined) {
			throw new Error(`Hostname could not be parsed from url ${channelURI}`);
		}
		if (channelName == undefined) {
			throw new Error(`Channel name could not be parsed from url ${channelURI}`);
		}
		const channelId = `${channelName}@${hostname}`;
		const dataRes = await fetch(
			`https://${hostname}/api/v1/video-channels/${channelName}/videos?count=100&includeScheduledLive=false`
		);
		if (!dataRes.ok) {
			const text = await dataRes.text();
			console.error(text);
			console.error(dataRes.statusText);
			throw new Error(
				"PeerTube channel data scrape error; check console for details"
			);
		}
		const text = await dataRes.text();
		const data: ChannelData = JSON.parse(text) as ChannelData;

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
			for (const video of data.data) {
				const existingVideo = existingVideoMap.get(video.uuid);
				if (video.duration == null) {
					// Video is either broken or still processing
					if (existingVideo != undefined) {
						await tx.video.delete({ where: { videoId: video.uuid } });
					}
					continue;
				}
				if (existingVideo == undefined) {
					newVideos.push(video);
				} else if (!video.isLive && existingVideo.isCurrentlyLive) {
					// Existing livestream should be updated!
					await tx.video.update({
						where: { videoId: video.uuid },
						data: {
							title: video.name,
							duration: video.duration,
							isCurrentlyLive: false
						}
					});
				} else if (
					video.name != existingVideo.title ||
					(video.duration != null && video.duration != existingVideo.duration)
				) {
					// Update title and duration
					const updateArgs: {
						where: { videoId: string };
						data: Partial<Video>;
					} = {
						where: { videoId: video.uuid },
						data: {
							title: video.name
						}
					};
					if (video.duration != null) updateArgs.data.duration = video.duration;
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
				}/${subscriptionsCount}) [${index}/${newVideos.length}] Extracting extended attributes from new video ${video.uuid}...`
			);
			// Literally the only thing we care about from this massive amount of data is the description...
			const videoDataRes = await fetch(
				`https://${hostname}/api/v1/videos/${video.id}`
			);
			if (!videoDataRes.ok) {
				const text = await videoDataRes.text();
				console.error(text);
				console.error(videoDataRes.statusText);
				throw new Error(
					"PeerTube video data scrape error; check console for details"
				);
			}
			const text = await videoDataRes.text();
			const directVideoData = JSON.parse(text) as VideoData;
			if (directVideoData.state.id != 1) {
				// Skip for now
				console.log(
					`(${
						i + 1
					}/${subscriptionsCount}) [${index}/${newVideos.length}] Video ${video.uuid} was still processing.`
				);
				await channels.infoWebhook.send({
					content: `Video ${video.uuid} was still processing.`
				});
				console.error(
					`(${
						i + 1
					}/${subscriptionsCount}) [${index}/${newVideos.length}] Skipping ${video.uuid}...`
				);
				continue;
			}
			const timestampMS = new Date(video.publishedAt).getTime();
			if (timestampMS < OLD_VIDEO_ERROR_THRESHOLD) {
				// This timestamp might not be right! Throw an error to make sure a human reviews it
				console.error(
					`WARNING: Received timestamp ${timestampMS} for video ${video.uuid}, which is older than expected! Skipping this video for now.`
				);
				await channels.infoWebhook.send({
					content: `WARNING: Received timestamp ${timestampMS} for video ${video.uuid}, which is older than expected! Skipping this video for now.`
				});
				console.error(
					`(${
						i + 1
					}/${subscriptionsCount}) [${index}/${newVideos.length}] Skipping ${video.uuid}...`
				);
				continue;
			}
			console.log(
				`(${
					i + 1
				}/${subscriptionsCount}) [${index}/${newVideos.length}] Done extracting extended attributes from new video ${video.uuid}!`
			);
			const newVideoDocument: Video = {
				videoId: video.uuid,
				platform: "PeerTube",
				type: video.isLive ? "stream" : "video",
				duration: directVideoData.duration ?? video.duration ?? null,
				title: video.name,
				description: directVideoData.description ?? null,
				displayName: video.channel.displayName,
				username: video.channel.name,
				channelId: channelId,
				date: new Date(timestampMS),
				isCurrentlyLive: video.isLive,
				// Mark as read if the newly imported video is a week old
				unread: Date.now() - timestampMS < NEW_UNREAD_THRESHOLD,
				sponsorBlockStatus: null,
				url: video.url
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
		(await prisma.video.findMany({ where: { platform: "PeerTube" } })).map(
			(v) => v.channelId
		)
	);
	for (const channel of allChannels) {
		const splitChannel = channel.split("@");
		const hostname = splitChannel[1];
		const channelName = splitChannel[0];
		const unsubscribed =
			subscriptions.findIndex(
				(s) => s.replace("peertube://", "") == `${hostname}/${channelName}`
			) == -1;
		if (unsubscribed) {
			const channelVideo = await prisma.video.findFirst({
				where: {
					platform: "PeerTube",
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
				where: { platform: "PeerTube", channelId: channel }
			});
		}
	}
	console.log("Done checking for unsubscribed channels!");
}
