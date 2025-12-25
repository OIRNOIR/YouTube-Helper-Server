import type { Buffer } from "node:buffer";
import { type ExecException, type ExecOptions, exec } from "node:child_process";
import { subtle as subtleCrypto } from "node:crypto";

export function execAsync(
	command: string,
	settings?: ExecOptions
): Promise<{
	error: ExecException | null;
	stdout: string | Buffer<ArrayBufferLike>;
	stderr: string | Buffer<ArrayBufferLike>;
}> {
	return new Promise((resolve) => {
		exec(command, settings, (error, stdout, stderr) => {
			resolve({ error, stdout, stderr });
		});
	});
}

function sleep(ms: number) {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

export function shuffle<T>(array: T[]): T[] {
	let currentIndex = array.length;
	let randomIndex: number;

	// While there remain elements to shuffle.
	while (currentIndex != 0) {
		// Pick a remaining element.
		randomIndex = Math.floor(Math.random() * currentIndex);
		currentIndex--;

		// And swap it with the current element.
		const temp = array[randomIndex];
		const current = array[currentIndex];
		if (temp == undefined || current == undefined) {
			throw new Error("Stuff didn't work");
		}
		array[randomIndex] = current;
		array[currentIndex] = temp;
	}

	return array;
}

export async function getSHA256Hash(input: string) {
	const textAsBuffer = new TextEncoder().encode(input);
	const hashBuffer = await subtleCrypto.digest("SHA-256", textAsBuffer);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	const hash = hashArray
		.map((item) => item.toString(16).padStart(2, "0"))
		.join("");
	return hash;
}

export async function getFullVideoSponsorBlockSegments(
	videoId: string,
	recurseIfError = true
): Promise<null | "sponsor" | "selfpromo" | "exclusive_access"> {
	const hash = await getSHA256Hash(videoId);
	const url = `https://sponsor.ajay.app/api/skipSegments/${hash.slice(
		0,
		4
	)}?categories=["sponsor","selfpromo","exclusive_access"]&actionType=full`;
	const res = await fetch(url);
	if (res.status == 404) {
		// Absolutely no segments were found with this hash, don't even need to parse the response
		return null;
	}
	const text = await res.text();
	if (!res.ok) {
		console.error(url);
		console.error(text);
		if (recurseIfError) {
			await sleep(5000);
			return await getFullVideoSponsorBlockSegments(videoId, false);
		}
		throw new Error(`SponsorBlock request error with code ${res.status}`);
	}
	const json = JSON.parse(text) as {
		videoID: string;
		segments: {
			category: "sponsor" | "selfpromo" | "exclusive_access";
			votes: number;
		}[];
	}[];
	const thisVideo = json.find((v) => v.videoID == videoId);
	return (
		thisVideo?.segments.sort((a, b) => b.votes - a.votes).at(0)?.category ?? null
	);
}
