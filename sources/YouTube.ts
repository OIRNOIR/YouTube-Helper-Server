import fs from "node:fs";
import {
	NEW_UNREAD_THRESHOLD,
	OLD_VIDEO_ERROR_THRESHOLD,
	TMP_DIR,
	VIDEOS_PER_CHANNEL_SCRAPE_LIMIT
} from "../constants.ts";
import type { PrismaClient, Video } from "../prisma/generated/prisma/client.ts";
import { Source } from "../Source.ts";
import type { Channels } from "../structures/Channels.ts";
import { execAsync, getFullVideoSponsorBlockSegments } from "../util.ts";

interface FullVideoData {
	id: string;
	title: string;
	description?: string; // FULL
	duration: null | number; // null for live streams, in seconds
	url: string; // Use for determining video type
	timestamp: number; // The timestamp (seconds) the video was posted
}

interface VideoData {
	id: string;
	title: string;
	description?: string; // Absent for shorts
	live_status?: "is_live" | "was_live" | "is_upcoming";
	availability?: null | "subscriber_only" | "premium_only";
	duration?: null | number; // Undefined for shorts, null for live streams, in seconds
	url: string; // Use for determining video type
}

interface PlaylistData {
	channel: string; // Pretty username
	channel_id: string;
	uploader_id: string; // @UserName
	entries: VideoData[];
	webpage_url: string; // The exact url this data was downloaded from. Check if ends with /videos, /stream, or /shorts if need to, this is the only reliable place
}

interface ChannelData {
	channel: string; // Pretty username
	channel_id: string;
	uploader_id: string; // @UserName
	entries: PlaylistData[];
	webpage_url: string; // Determine if this is /videos, /stream, or /shorts! If so, this is actually PlaylistData
}

// TODO: Pagination
// A list of lists (videos, shorts, streams) of a channel can be found at yt-dlp -J --flat-playlist -I 0:2 "https://www.youtube.com/@halfasinteresting" | jq ".entries | map(.webpage_url)"
// Check if this is still true for channels with only one list

export default class YouTube extends Source {
	override identifyURL(url: string): boolean {
		return url.startsWith("yt://");
	}

	override async scrapeChannel(
		prisma: PrismaClient,
		channels: Channels,
		channelURI: string,
		i: number,
		subscriptionsCount: number,
		cookiesPath: string,
		isShortsWhitelisted: boolean
	) {
		const parts = channelURI.replace("yt://", "").split("/");
		const channelId = parts[0];
		const expectedUploaderId = parts[1];
		if (channelId == undefined) {
			throw new Error(`Channel ID could not be parsed from url ${channelURI}`);
		}
		if (expectedUploaderId == undefined) {
			throw new Error(
				`Expected Uploader ID could not be parsed from url ${channelURI}`
			);
		}
		const dataResFile = `${TMP_DIR}/${Date.now()}.txt`;
		const dataRes = await execAsync(
			`yt-dlp -J --flat-playlist -I 0:100 "https://www.youtube.com/channel/${channelId}" > ${dataResFile}`
		);
		if (
			(dataRes.stderr.length > 0 && dataRes.stderr.includes("ERROR: ")) ||
			dataRes.error != null
		) {
			if (dataRes.stderr.includes("This account has been terminated")) {
				await channels.infoWebhook.send({
					content: `Channel \`${channelURI}\` has been terminated.`
				});
				console.error(`Channel ${channelURI} has been terminated.`);
				return;
			}
			console.error(dataRes.stderr);
			console.error(dataRes.error);
			throw new Error(
				"yt-dlp channel data scrape error; check console for details"
			);
		}
		if (dataRes.stderr.length > 0) {
			console.error(dataRes.stderr);
		}
		const rawData = JSON.parse(fs.readFileSync(dataResFile, "utf8"));
		fs.rmSync(dataResFile);
		let data: ChannelData = rawData as ChannelData;

		// Sometimes, yt-dlp will just return a single playlist, rather than a meta-playlist, if a channel has only one of the three tabs.
		if (
			data.webpage_url.endsWith("/videos") ||
			data.webpage_url.endsWith("/shorts") ||
			data.webpage_url.endsWith("/streams")
		) {
			const dp = rawData as PlaylistData;
			data = {
				channel: dp.channel,
				channel_id: dp.channel_id,
				uploader_id: dp.uploader_id,
				entries: [dp],
				webpage_url: dp.webpage_url
			};
		}

		if (data.uploader_id != expectedUploaderId) {
			await channels.infoWebhook.send({
				content: `WARNING: Channel \`${channelId}\`, previously \`${expectedUploaderId}\`, is now \`${data.uploader_id}\``
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

		const newVideos: VideoData[] = [];

		// Update changed videos
		await prisma.$transaction(async (tx) => {
			for (const playlist of data.entries) {
				for (const video of playlist.entries) {
					if (
						video.availability == "subscriber_only" ||
						video.availability == "premium_only" ||
						video.live_status == "is_upcoming"
					) {
						// yt-dlp -J seemingly errors for all of these
						// so we can't collect additional info just yet
						continue;
					}
					const existingVideo = existingVideoMap.get(video.id);
					if (video.live_status == "was_live" && video.duration == null) {
						// Video is either broken or still processing
						if (existingVideo != undefined) {
							await tx.video.delete({ where: { videoId: video.id } });
						}
						continue;
					}
					if (!isShortsWhitelisted && video.url.includes("/shorts/")) {
						// This channel is not shorts whitelisted
						continue;
					}
					if (existingVideo == undefined) {
						newVideos.push(video);
					} else if (
						video.live_status != "is_live" &&
						existingVideo.isCurrentlyLive
					) {
						// Existing livestream should be updated!
						await tx.video.update({
							where: { videoId: video.id },
							data: {
								title: video.title,
								duration: video.duration,
								isCurrentlyLive: false
							}
						});
					} else if (
						video.title != existingVideo.title ||
						(video.duration != null && video.duration != existingVideo.duration)
					) {
						// Update title and duration
						const updateArgs: {
							where: { videoId: string };
							data: Partial<Video>;
						} = {
							where: { videoId: video.id },
							data: {
								title: video.title
							}
						};
						if (video.duration != null) updateArgs.data.duration = video.duration;
						await tx.video.update(updateArgs);
					}
				}
			}
		});

		let index = 0;
		for (const video of newVideos) {
			index++;
			const [result, sbStatus] = await Promise.all([
				(async () => {
					console.log(
						`(${
							i + 1
						}/${subscriptionsCount}) [${index}/${newVideos.length}] Extracting extended attributes from new video ${video.id}...`
					);
					// Literally the only thing we care about from this massive amount of data is the release date...
					const videoDataResFile = `${TMP_DIR}/${Date.now()}.txt`;
					let videoDataRes = await execAsync(
						`yt-dlp -J --no-check-formats "https://www.youtube.com/watch?v=${video.id}" > ${videoDataResFile}`
					);
					if (videoDataRes.stderr.length > 0 || videoDataRes.error != null) {
						console.error(videoDataRes.stderr);
						console.error(videoDataRes.error);
						if (
							videoDataRes.stderr.includes(
								"Sign in to confirm your age. This video may be inappropriate for some users."
							) &&
							fs.existsSync(cookiesPath)
						) {
							// Try again with authentication
							console.log(
								`(${
									i + 1
								}/${subscriptionsCount}) [${index}/${newVideos.length}] Retrying video ${video.id} with authentication...`
							);
							const attempt2res = await execAsync(
								`yt-dlp -J --cookies ${cookiesPath} "https://www.youtube.com/watch?v=${video.id}" > ${videoDataResFile}`
							);
							if (attempt2res.stderr.length > 0 || attempt2res.error != null) {
								console.error(attempt2res.stderr);
								console.error(attempt2res.error);
								throw new Error(
									"yt-dlp video data scrape error; check console for details"
								);
							}
							videoDataRes = attempt2res;
						} else if (
							videoDataRes.stderr.includes(
								"We're processing this video. Check back later."
							)
						) {
							// Skip for now
							console.log(
								`(${
									i + 1
								}/${subscriptionsCount}) [${index}/${newVideos.length}] Video ${video.id} was still processing.`
							);
							await channels.infoWebhook.send({
								content: `Video ${video.id} was still processing.`
							});
							return "SKIP";
						} else if (
							videoDataRes.stderr.includes(
								"Join this channel to get access to members-only content like this video, and other exclusive perks."
							) ||
							videoDataRes.stderr.includes(
								"Join this channel to get access to members-only content and other exclusive perks."
							) ||
							videoDataRes.stderr.includes("This video requires payment to watch")
						) {
							// There is a low chance that the initial --flat-playlist
							// will fail to return availability information.
							// Handle this case here.
							console.log(video);
							console.log(
								`(${
									i + 1
								}/${subscriptionsCount}) [${index}/${newVideos.length}] Flat playlist fetch failed to retrieve availability information. Video ${video.id} required payment.`
							);
							return "SKIP";
						} else if (
							videoDataRes.stderr.includes("This live event will begin in")
						) {
							// There is a low chance that the initial --flat-playlist
							// will fail to return availability information.
							// Handle this case here.
							console.log(video);
							console.log(
								`(${
									i + 1
								}/${subscriptionsCount}) [${index}/${newVideos.length}] Flat playlist fetch failed to retrieve availability information. Video ${video.id} is a pending livestream.`
							);
							return "SKIP";
						} else if (videoDataRes.stderr.includes("ERROR: ")) {
							throw new Error(
								"yt-dlp video data scrape error; check console for details"
							);
						} else {
							const timestamp = (
								JSON.parse(fs.readFileSync(videoDataResFile, "utf8")) as FullVideoData
							).timestamp;
							console.log(
								`(${
									i + 1
								}/${subscriptionsCount}) [${index}/${newVideos.length}] There were warnings on this request. Make sure ${timestamp} is the right timestamp for ${video.id}.`
							);
							await channels.infoWebhook.send({
								content: `There were warnings on this request. Make sure ${timestamp} is the right timestamp for ${video.id}.`
							});
						}
					}
					const directVideoData = JSON.parse(
						fs.readFileSync(videoDataResFile, "utf8")
					) as FullVideoData;
					fs.rmSync(videoDataResFile);
					const timestampMS = directVideoData.timestamp * 1000;
					if (timestampMS < OLD_VIDEO_ERROR_THRESHOLD) {
						// This timestamp might not be right! Throw an error to make sure a human reviews it
						console.error(
							`WARNING: Received timestamp ${timestampMS} for video ${video.id}, which is older than expected! Skipping this video for now.`
						);
						await channels.infoWebhook.send({
							content: `WARNING: Received timestamp ${timestampMS} for video ${video.id}, which is older than expected! Skipping this video for now.`
						});
						return "SKIP";
					}
					console.log(
						`(${
							i + 1
						}/${subscriptionsCount}) [${index}/${newVideos.length}] Done extracting extended attributes from new video ${video.id}!`
					);
					return { directVideoData, timestampMS };
				})(),
				(async () => {
					console.log(
						`(${
							i + 1
						}/${subscriptionsCount}) [${index}/${newVideos.length}] Fetching full-video SponsorBlock segments from new video ${video.id}...`
					);
					const res = await getFullVideoSponsorBlockSegments(video.id);
					if (res.success) {
						console.log(
							`(${
								i + 1
							}/${subscriptionsCount}) [${index}/${newVideos.length}] Done fetching full-video SponsorBlock segments from new video ${video.id}!`
						);
						return res.sponsorBlock;
					}
					console.error(
						`WARNING: Error fetching SponsorBlock segments for video ${video.id} with status ${res.status}! Skipping this video for now.`
					);
					await channels.infoWebhook.send({
						content: `WARNING: Error fetching SponsorBlock segments for video ${video.id}! Skipping this video for now.`
					});
					return "SKIP";
				})()
			]);
			if (result == "SKIP" || sbStatus == "SKIP") {
				console.error(
					`(${
						i + 1
					}/${subscriptionsCount}) [${index}/${newVideos.length}] Skipping ${video.id}...`
				);
				continue;
			}
			const { timestampMS, directVideoData } = result;
			const newVideoDocument: Video = {
				videoId: video.id,
				platform: "YouTube",
				type:
					video.live_status != undefined
						? "stream"
						: video.url.includes("/shorts/")
							? "short"
							: "video",
				duration: directVideoData.duration ?? video.duration ?? null,
				title: video.title,
				description: directVideoData.description ?? video.description ?? null,
				displayName: data.channel,
				username: data.uploader_id,
				channelId: data.channel_id,
				date: new Date(timestampMS),
				isCurrentlyLive: video.live_status == "is_live",
				// Mark as read if the newly imported video is a week old
				unread: Date.now() - timestampMS < NEW_UNREAD_THRESHOLD,
				sponsorBlockStatus: sbStatus,
				url: `https://youtu.be/${video.id}`
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
		shortsWhitelist: string[]
	): Promise<void> {
		await purgeUnsubscribed(prisma, subscriptions, shortsWhitelist);
		await checkSponsorBlock(prisma);
	}
}

async function purgeUnsubscribed(
	prisma: PrismaClient,
	subscriptions: string[],
	shortsWhitelist: string[]
) {
	console.log("Checking for unsubscribed channels...");
	const allChannels = new Set(
		(await prisma.video.findMany({ where: { platform: "YouTube" } })).map(
			(v) => v.channelId
		)
	);
	for (const channel of allChannels) {
		const unsubscribed =
			subscriptions.findIndex(
				(s) => s.replace("yt://", "").split("/")[0] == channel
			) == -1;
		if (unsubscribed) {
			const channelVideo = await prisma.video.findFirst({
				where: {
					platform: "YouTube",
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
				where: { platform: "YouTube", channelId: channel }
			});
		}
	}
	console.log("Done checking for unsubscribed channels!");
	console.log("Checking for shorts un-whitelisted channels...");
	const allShortsChannels = new Set(
		(
			await prisma.video.findMany({
				where: { platform: "YouTube", type: "short" }
			})
		).map((v) => v.channelId)
	);
	for (const channel of allShortsChannels) {
		const unWhitelisted =
			shortsWhitelist.findIndex(
				(s) => s.replace("yt://", "").split("/")[0] == channel
			) == -1;
		if (unWhitelisted) {
			const channelVideo = await prisma.video.findFirst({
				where: {
					platform: "YouTube",
					channelId: channel
				},
				orderBy: { date: "desc" }
			});
			if (channelVideo != null) {
				console.log(
					`Channel ${channel} (${channelVideo.username} / ${channelVideo.displayName}) has been removed from the Shorts whitelist. Purging shorts from DB.`
				);
			} else {
				console.log(
					`Channel ${channel} (unknown) has been removed from the Shorts whitelist. Purging shorts from DB.`
				);
			}
			await prisma.video.deleteMany({
				where: {
					platform: "YouTube",
					channelId: channel,
					type: "short"
				}
			});
		}
	}
	console.log("Done checking for shorts un-whitelisted channels!");
}

async function checkSponsorBlock(prisma: PrismaClient) {
	console.log("Checking SponsorBlock information...");
	const recentOrUnreadPosts = await prisma.video.findMany({
		where: {
			OR: [
				{
					date: { gt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
					platform: "YouTube"
				},
				{ unread: true, platform: "YouTube" }
			]
		}
	});
	let index = 1;
	for (const post of recentOrUnreadPosts) {
		console.log(
			`Checking video ${index}/${recentOrUnreadPosts.length} (${post.videoId})...`
		);
		const sbStatus = await getFullVideoSponsorBlockSegments(post.videoId);
		if (sbStatus.success) {
			if (sbStatus.sponsorBlock != post.sponsorBlockStatus) {
				await prisma.video.update({
					where: { videoId: post.videoId },
					data: { sponsorBlockStatus: sbStatus.sponsorBlock }
				});
			}
		} else {
			console.log(
				`Failed to fetch SponsorBlock status for video ${post.videoId} with code ${sbStatus.status}`
			);
		}
		index++;
	}
	console.log("Done checking SponsorBlock information!");
}
