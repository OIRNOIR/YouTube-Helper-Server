import path from "node:path";

export const TMP_DIR = path.join("/tmp", "youtube-helper");

export type ConfigFile = {
	errorWebhook: string;
	infoWebhook: string;
	expectedServerAuthorization: string;
	errorPingUser: string;
	port: number;
};

export const VIDEOS_PER_CHANNEL_SCRAPE_LIMIT = 10;
export const NEW_UNREAD_THRESHOLD = 7 * 24 * 60 * 60 * 1000; // Newly scraped videos will not be marked unread if older than this threshold

export const OLD_VIDEO_ERROR_THRESHOLD = 1072944000000; // JAN 01 2004
