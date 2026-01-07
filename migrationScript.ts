import path from "node:path";
import process from "node:process";
import { PrismaPg } from "@prisma/adapter-pg";
import { config as envConfig } from "dotenv";
import { PrismaClient } from "./prisma/generated/prisma/client.ts";

const __dirname = path.dirname(new URL(import.meta.url).pathname);

envConfig({ quiet: true, path: path.join(__dirname, ".env") });

const prismaAdapter = new PrismaPg({
	connectionString: process.env.DATABASE_URL
});

const prisma = new PrismaClient({
	adapter: prismaAdapter
});

await prisma.video.updateMany({
	where: {
		platform_old: "YouTube"
	},
	data: {
		platform: "YouTube"
	}
});
await prisma.video.updateMany({
	where: {
		platform_old: "PeerTube"
	},
	data: {
		platform: "PeerTube"
	}
});
