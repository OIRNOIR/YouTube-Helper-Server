import { WebhookClient } from "discord.js";
import type { ConfigFile } from "../constants.ts";

export class Channels {
	errWebhook: WebhookClient;
	infoWebhook: WebhookClient;

	constructor(configFile: ConfigFile) {
		this.errWebhook = new WebhookClient(
			{ url: configFile.errorWebhook },
			{ rest: { globalRequestsPerSecond: 1 } }
		);
		this.infoWebhook = new WebhookClient(
			{ url: configFile.infoWebhook },
			{ rest: { globalRequestsPerSecond: 1 } }
		);
	}
}
