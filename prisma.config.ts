import path from "node:path";
import "dotenv/config";
import { defineConfig, env } from "prisma/config";

function getDummyConfig() {
	console.warn("Using dummy config!");
	return "postgresql://127.0.0.1/dummy";
}

export default defineConfig({
	schema: path.join("prisma", "schema"),
	migrations: {
		path: path.join("prisma", "migrations")
	},
	views: {
		path: path.join("prisma", "views")
	},
	typedSql: {
		path: path.join("prisma", "queries")
	},
	datasource: {
		url: env("DATABASE_URL")// ?? getDummyConfig()
	}
});
